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

// Has this happened `max` times in the last `minutes`? (New accounts per internet address, wrong passwords per name.)
async function tooMany(kind: 'signup' | 'fail', key: string, max: number, minutes: number): Promise<boolean> {
  const since = new Date(Date.now() - minutes * 60_000).toISOString();
  const { count } = await admin
    .from('username_auth_log')
    .select('id', { count: 'exact', head: true })
    .eq('kind', kind)
    .eq('key', key)
    .gte('created_at', since);
  return (count ?? 0) >= max;
}

async function remember(kind: 'signup' | 'fail', key: string) {
  await admin.from('username_auth_log').insert({ kind, key });
  // Old entries aren't needed any more.
  await admin.from('username_auth_log').delete().lt('created_at', new Date(Date.now() - 86_400_000).toISOString());
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
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Something went wrong – try again' }, 400);
  }
  const username = String(body.username ?? '').trim().toLowerCase().replace(/^@/, '');
  const password = String(body.password ?? '');

  if (body.action === 'signup') {
    if (!USERNAME.test(username)) {
      return json({ error: 'Usernames are 3–20 characters: lowercase letters, numbers, dots and underscores' }, 400);
    }
    // Same rule as the app: 8+ characters with a letter and a number.
    if (password.length < 8 || password.length > 72 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
      return json({ error: 'Your password needs at least 8 characters, with a letter and a number' }, 400);
    }
    const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
    if (await tooMany('signup', ip, 5, 60)) {
      return json({ error: 'Lots of new accounts from here already – try again in an hour' }, 429);
    }
    const { data: taken } = await admin.from('profiles').select('id').eq('username', username).maybeSingle();
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
    await remember('signup', ip);
    const session = await logIn(email, password);
    return session ? json({ session }) : json({ error: 'Your account is ready – log in with your username' }, 500);
  }

  if (body.action === 'signin') {
    if (!USERNAME.test(username) || !password) return json({ error: 'Wrong username or password' }, 401);
    if (await tooMany('fail', username, 8, 15)) {
      return json({ error: 'Lots of wrong passwords for this username – wait 15 minutes and try again' }, 429);
    }
    const { data: profile } = await admin.from('profiles').select('id').eq('username', username).maybeSingle();
    const found = profile ? (await admin.auth.admin.getUserById(profile.id)).data.user : null;
    const session = found?.email ? await logIn(found.email, password) : null;
    if (!session) {
      await remember('fail', username);
      return json({ error: 'Wrong username or password' }, 401);
    }
    return json({ session });
  }

  return json({ error: 'Something went wrong – try again' }, 400);
});
