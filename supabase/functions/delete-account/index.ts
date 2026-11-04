// Delete account: permanently deletes the person calling it – their photo files, then their login.
// Deleting the login also removes their profile, posts, stories, chats, friends, likes and comments
// (the database's "on delete cascade" links do that part).
import { createClient } from 'npm:@supabase/supabase-js@2';
import { importPKCS8, SignJWT } from 'npm:jose@5.9.6';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Every file in a folder (and its sub-folders) of a storage bucket.
async function listAll(bucket: string, prefix: string): Promise<string[]> {
  const { data, error } = await admin.storage.from(bucket).list(prefix, { limit: 1000 });
  if (error || !data) return [];
  const paths: string[] = [];
  for (const item of data) {
    const path = `${prefix}/${item.name}`;
    if (item.id) paths.push(path);
    else paths.push(...(await listAll(bucket, path))); // a sub-folder
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Accounts made with "Sign in with Apple": Apple's rules say deleting the account must also disconnect the
// app from the person's Apple ID. The app sends a fresh one-time code from Apple; we swap it for a login
// token and tell Apple to cancel it. Needs these Edge Function secrets (Supabase → Edge Functions → Secrets):
//   APPLE_KEY_ID       – the Key ID of a "Sign in with Apple" key (Apple Developer → Keys)
//   APPLE_PRIVATE_KEY  – the text inside that key's .p8 file
// Without them (or if Apple says no) the account is still deleted – this part is best effort.
// ---------------------------------------------------------------------------
const APPLE_TEAM_ID = Deno.env.get('APPLE_TEAM_ID') ?? 'TMFHJ8D3H5';
const APPLE_CLIENT_ID = Deno.env.get('APPLE_CLIENT_ID') ?? 'com.rbaig18.peekaboo';

async function disconnectFromApple(code: string): Promise<void> {
  const keyId = Deno.env.get('APPLE_KEY_ID');
  const privateKey = Deno.env.get('APPLE_PRIVATE_KEY')?.replace(/\\n/g, '\n');
  if (!keyId || !privateKey) {
    console.warn('Apple key secrets are not set – skipping the Apple disconnect');
    return;
  }
  // Apple's "client secret": a short-lived note signed with our Apple key.
  const clientSecret = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: keyId })
    .setIssuer(APPLE_TEAM_ID)
    .setSubject(APPLE_CLIENT_ID)
    .setAudience('https://appleid.apple.com')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(await importPKCS8(privateKey, 'ES256'));
  const post = (path: 'token' | 'revoke', fields: Record<string, string>) =>
    fetch(`https://appleid.apple.com/auth/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    });

  const tokens = await post('token', {
    grant_type: 'authorization_code',
    code,
    client_id: APPLE_CLIENT_ID,
    client_secret: clientSecret,
  });
  const body = await tokens.json().catch(() => ({}));
  const token = body.refresh_token ?? body.access_token;
  if (!tokens.ok || !token) {
    console.warn('Apple did not accept the code', tokens.status, body.error);
    return;
  }
  const revoked = await post('revoke', {
    client_id: APPLE_CLIENT_ID,
    client_secret: clientSecret,
    token,
    token_type_hint: body.refresh_token ? 'refresh_token' : 'access_token',
  });
  if (!revoked.ok) console.warn('Apple did not cancel the token', revoked.status);
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);

  // Who is asking? Only ever delete the logged-in person themselves.
  const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Not logged in' }, 401);
  const { data: who, error: whoError } = await admin.auth.getUser(token);
  if (whoError || !who.user) return json({ error: 'Not logged in' }, 401);
  const userId = who.user.id;

  // 0. Made with Apple? Disconnect Peekaboo from their Apple ID.
  const { apple_code: appleCode } = ((await req.json().catch(() => null)) ?? {}) as { apple_code?: unknown };
  if (typeof appleCode === 'string' && appleCode) {
    await disconnectFromApple(appleCode).catch((error) => console.warn('Apple disconnect failed', error));
  }

  // 1. Their photo files – in their own folders, plus their Guess Who files (kept in a shared "mystery"
  // folder so the file names don't give away who posted them).
  const { data: mystery } = await admin
    .from('mystery_posts')
    .select('media_path, poster_path, overlay_path')
    .eq('user_id', userId);
  const sharedFolderPaths = (mystery ?? [])
    .flatMap((row) => [row.media_path, row.poster_path, row.overlay_path])
    .filter((path): path is string => !!path);
  for (const bucket of ['media', 'avatars']) {
    const paths = [...(await listAll(bucket, userId)), ...(bucket === 'media' ? sharedFolderPaths : [])];
    for (let i = 0; i < paths.length; i += 100) {
      await admin.storage.from(bucket).remove(paths.slice(i, i + 100));
    }
  }

  // 2. Their login – and with it everything else.
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) return json({ error: error.message }, 500);
  return json({ deleted: true });
});
