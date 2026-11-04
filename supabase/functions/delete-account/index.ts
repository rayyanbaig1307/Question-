// Delete account: permanently deletes the person calling it – their photo files, then their login.
// Deleting the login also removes their profile, posts, stories, chats, friends, likes and comments
// (the database's "on delete cascade" links do that part).
import { createClient } from 'npm:@supabase/supabase-js@2';
import { decodeJwt, importPKCS8, SignJWT } from 'npm:jose@5.9.6';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Every file in a folder (and its sub-folders) of a storage bucket.
async function listAll(bucket: string, prefix: string): Promise<string[]> {
  const paths: string[] = [];
  const limit = 1000;
  for (let offset = 0; ; offset += limit) {
    const { data, error } = await admin.storage.from(bucket).list(prefix, {
      limit, offset, sortBy: { column: 'name', order: 'asc' },
    });
    if (error || !data) throw error ?? new Error('Could not list your files');
    for (const item of data) {
      const path = `${prefix}/${item.name}`;
      if (item.id) paths.push(path);
      else paths.push(...(await listAll(bucket, path))); // a sub-folder
    }
    if (data.length < limit) break;
  }
  return paths;
}

async function mysteryFiles(userId: string): Promise<string[]> {
  const paths: string[] = [];
  const limit = 1000;
  for (let offset = 0; ; offset += limit) {
    const { data, error } = await admin.from('mystery_posts')
      .select('media_path, poster_path, overlay_path').eq('user_id', userId)
      .order('id').range(offset, offset + limit - 1);
    if (error || !data) throw error ?? new Error('Could not list your anonymous posts');
    for (const row of data) {
      for (const path of [row.media_path, row.poster_path, row.overlay_path]) if (path) paths.push(path);
    }
    if (data.length < limit) break;
  }
  // The storage owner is still known if an older failed cleanup already removed the post row.
  for (let offset = 0; ; offset += limit) {
    const { data, error } = await admin.rpc('account_mystery_files', { account: userId })
      .range(offset, offset + limit - 1);
    if (error || !data) throw error ?? new Error('Could not list your anonymous files');
    for (const row of data) paths.push(row.path);
    if (data.length < limit) break;
  }
  return [...new Set(paths)];
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

class AppleIdentityMismatch extends Error {}

async function readDeleteBody(req: Request): Promise<Record<string, unknown> | Response> {
  const reader = req.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 4096) { await reader.cancel(); return json({ error: 'That request is too large' }, 413); }
      chunks.push(value);
    }
    if (length === 0) return {};
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Check the request and try again' }, 400);
    return body as Record<string, unknown>;
  } catch { return json({ error: 'Check the request and try again' }, 400); }
  finally { reader.releaseLock(); }
}

async function disconnectFromApple(code: string, allowedSubjects: string[]): Promise<void> {
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
  const post = async (path: 'token' | 'revoke', fields: Record<string, string>) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`https://appleid.apple.com/auth/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields),
        signal: controller.signal,
      });
      const body = path === 'token' ? await response.json().catch(() => ({})) : {};
      return { response, body };
    } finally { clearTimeout(timer); }
  };

  const { response: tokens, body } = await post('token', {
    grant_type: 'authorization_code',
    code,
    client_id: APPLE_CLIENT_ID,
    client_secret: clientSecret,
  });
  const token = body.refresh_token ?? body.access_token;
  if (!tokens.ok || !token) {
    console.warn('Apple did not accept the code', tokens.status, body.error);
    return;
  }
  // This JWT came directly from Apple's HTTPS token endpoint. Compare its subject to the identities
  // Supabase verified for the caller, never to user-editable profile metadata or request fields.
  if (typeof body.id_token !== 'string' || !allowedSubjects.includes(String(decodeJwt(body.id_token).sub ?? ''))) {
    throw new AppleIdentityMismatch('The Apple confirmation belongs to another account');
  }
  const { response: revoked } = await post('revoke', {
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
  const token = req.headers.get('Authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return json({ error: 'Not logged in' }, 401);
  try {
    const { data: who, error: whoError } = await admin.auth.getUser(token);
    if (whoError || !who.user) return json({ error: 'Not logged in' }, 401);
    const userId = who.user.id;

    // Apple confirmation is handled before any files or account records are removed.
    const body = await readDeleteBody(req);
    if (body instanceof Response) return body;
    if (body.expected_user_id !== undefined && typeof body.expected_user_id !== 'string') {
      return json({ error: 'Check the account confirmation and try again.' }, 400);
    }
    if (body.expected_user_id !== undefined && body.expected_user_id !== userId) {
      return json({ error: 'The signed-in account changed. Open Settings and try again.' }, 409);
    }
    const appleCode = body.apple_code;
    if (appleCode !== undefined && (typeof appleCode !== 'string' || appleCode.length > 2048)) return json({ error: 'Check the Apple confirmation and try again' }, typeof appleCode === 'string' ? 413 : 400);
    if (typeof appleCode === 'string' && appleCode) {
      const subjects = (who.user.identities ?? []).filter((identity) => identity.provider === 'apple').map((identity) => identity.identity_data?.sub ?? identity.id).filter((subject): subject is string => typeof subject === 'string' && subject.length > 0);
      if (subjects.length === 0) return json({ error: 'This account has no Apple login to disconnect' }, 400);
      try { await disconnectFromApple(appleCode, subjects); }
      catch (error) {
        if (error instanceof AppleIdentityMismatch) return json({ error: 'Choose the same Apple account you use for Peekaboo' }, 409);
        console.warn('Apple disconnect could not finish', error);
      }
    }

    // Intentional account deletion takes precedence over a temporary cleanup-retention claim.
    const { error: deletionScopeError } = await admin.rpc('begin_account_media_deletion', { account: userId });
    if (deletionScopeError) throw deletionScopeError;

    // 1. Their photo files – in their own folders, plus their Guess Who files (kept in a shared "mystery"
    // folder so the file names don't give away who posted them).
    const sharedFolderPaths = await mysteryFiles(userId);
    for (const bucket of ['media', 'avatars']) {
      const paths = [...(await listAll(bucket, userId)), ...(bucket === 'media' ? sharedFolderPaths : [])];
      for (let i = 0; i < paths.length; i += 100) {
        const { error } = await admin.storage.from(bucket).remove(paths.slice(i, i + 100));
        if (error) throw error;
      }
    }

    // 2. Their login – and with it everything else.
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) throw error;
    return json({ deleted: true });
  } catch (error) {
    console.error('Account deletion could not finish', error);
    // Keep the login and its file references until file removal finishes, so the person can retry.
    return json({ error: 'Could not finish deleting your account. Please try again.' }, 503);
  }
});
