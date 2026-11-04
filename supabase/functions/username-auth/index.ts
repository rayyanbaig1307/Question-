// Username accounts: sign up with just a username and password (no email), and log in with a username.
// Accounts made without an email get a stand-in address that can never receive mail (".invalid" is reserved for
// exactly that), so nobody else can ever get their password-reset emails. Logging in by username looks the
// account up here on the server, so nobody's email is ever shown to the app.
import { createClient } from 'npm:@supabase/supabase-js@2';

const url = Deno.env.get('SUPABASE_URL')!;
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const USERNAME = /^[a-z0-9_.]{3,20}$/;
const NO_EMAIL_DOMAIN = 'noemail.peekaboo.invalid';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Reserve a try before checking credentials. The database locks this counter so simultaneous requests
// cannot all slip through; if the counter is unavailable, don't continue without protection.
async function reserveAttempt(kind: 'signup' | 'fail', key: string, max: number, minutes: number): Promise<boolean> {
  const { data, error } = await admin.rpc('reserve_username_auth_attempt', {
    attempt_kind: kind, attempt_key: key, max_attempts: max, window_minutes: minutes,
  });
  if (error || typeof data !== 'boolean') throw error ?? new Error('Could not check the attempt limit');
  return data;
}

// Logs in like the app would, and hands back the login so the app can use it.
async function logIn(email: string, password: string) {
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) return null;
  return { access_token: data.session.access_token, refresh_token: data.session.refresh_token };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  // Read at most 4 KB, including requests that leave out Content-Length.
  const reader = req.body?.getReader();
  if (!reader) return json({ error: 'Check the details and try again' }, 400);
  let length = 0;
  const chunks: Uint8Array[] = [];
  let body: Record<string, unknown>;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 4096) {
        await reader.cancel();
        return json({ error: 'That request is too large' }, 413);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return json({ error: 'Check the details and try again' }, 400);
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ error: 'Something went wrong – try again' }, 400);
  } finally {
    reader.releaseLock();
  }
  if (typeof body.username !== 'string' || typeof body.password !== 'string' ||
      (body.display_name !== undefined && typeof body.display_name !== 'string') ||
      (body.terms_version !== undefined && typeof body.terms_version !== 'string')) {
    return json({ error: 'Check the details and try again' }, 400);
  }
  const username = body.username.trim().toLowerCase().replace(/^@/, '');
  const password = body.password;

  try {
    if (body.action === 'signup') {
      if (!USERNAME.test(username)) {
        return json({ error: 'Usernames are 3–20 characters: lowercase letters, numbers, dots and underscores' }, 400);
      }
      // Same rule as the app: 8+ characters with a letter and a number.
      if (password.length < 8 || password.length > 72 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
        return json({ error: 'Your password needs at least 8 characters, with a letter and a number' }, 400);
      }
      const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
      if (!(await reserveAttempt('signup', ip, 5, 60))) {
        return json({ error: 'Lots of new accounts from here already – try again in an hour' }, 429);
      }
      const { data: taken, error: lookupError } = await admin.from('profiles').select('id').eq('username', username).maybeSingle();
      if (lookupError) throw lookupError;
      if (taken) return json({ error: 'That username is already taken. Try another one!' }, 409);

      const email = `${crypto.randomUUID()}@${NO_EMAIL_DOMAIN}`;
      const { error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          username,
          display_name: String(body.display_name ?? '').trim().slice(0, 40) || username,
          terms_version: String(body.terms_version ?? ''),
          no_email: true,
        },
      });
      if (error) {
        console.error('createUser failed', error.message);
        return json({ error: 'Could not make your account – try again' }, 400);
      }
      const session = await logIn(email, password);
      return session ? json({ session }) : json({ error: 'Your account is ready – log in with your username' }, 500);
    }

    if (body.action === 'signin') {
      if (!USERNAME.test(username) || !password || password.length > 72) return json({ error: 'Wrong username or password' }, 401);
      if (!(await reserveAttempt('fail', username, 8, 15))) {
        return json({ error: 'Lots of login tries for this username – wait 15 minutes and try again' }, 429);
      }
      const { data: profile, error: lookupError } = await admin.from('profiles').select('id').eq('username', username).maybeSingle();
      if (lookupError) throw lookupError;
      const found = profile ? (await admin.auth.admin.getUserById(profile.id)).data.user : null;
      const session = found?.email ? await logIn(found.email, password) : null;
      if (!session) {
        return json({ error: 'Wrong username or password' }, 401);
      }
      return json({ session });
    }

    return json({ error: 'Something went wrong – try again' }, 400);
  } catch (error) {
    console.error('Username authentication could not finish', error);
    return json({ error: 'Could not reach the login service. Please try again.' }, 503);
  }
});
