// Username accounts: log in with a username and password. Older accounts made with just a username (no email) have a
// stand-in address that can never receive mail (".invalid" is reserved for exactly that). Logging in by username
// looks the account up here on the server, so nobody's email is ever shown to the app.
// Making NEW accounts here is switched off (26 Nov 2026): new accounts are made only with "Continue with Apple"
// (iPhone) or "Continue with Google" (Android). A sign-up request gets a plain "no" and nothing else happens:
// no account, no counters, no name check. Old app downloads that still show a sign-up form show that message.
import { createClient } from 'npm:@supabase/supabase-js@2';

const url = Deno.env.get('SUPABASE_URL')!;
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const USERNAME = /^[a-z0-9_.]{3,20}$/;

// What a sign-up request gets now. Old downloads show this sentence under their old sign-up form.
const SIGNUP_CLOSED = 'New accounts are made with the Apple or Google button now – get the newest Peekaboo to make one.';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Limits (QA review). Only failed logins count: a correct login gives its try back.
//  - 8 wrong tries per username from one address every 15 minutes (the main limit)
//  - 40 wrong tries per username from all addresses together (so a guesser with a few addresses still stops)
//  - 30 wrong tries from one address across all usernames (so nobody can try one password on many accounts)
const LOGIN_WINDOW_MINUTES = 15;
const LOGIN_LIMITS = { pair: 8, username: 40, address: 30 };

// The caller's internet address, used to keep one person's tries apart from everyone else's.
//  - cf-connecting-ip is set by Cloudflare, which sits in front of the hosted project; an app cannot change it.
//  - If it is missing, X-Forwarded-For is read from the END. An app can put anything at the START of that list,
//    but each proxy on the way adds the address it got the request from at the end. So we walk back from the end,
//    skip our own proxies (private network and Cloudflare addresses) and use the first address that is left.
//  (Check on the hosted project which header carries the real address – see the QA notes.)
// One IPv6 home or phone connection owns a whole block of addresses (a "/64": the first half of the address)
// and can pick a new address for every request, so a whole /64 block counts as one address.
// An IPv4 address written the IPv6 way (::ffff:1.2.3.4) counts as the plain IPv4 address.
function clientAddress(req: Request): string {
  const platform = req.headers.get('cf-connecting-ip');
  if (platform !== null) {
    const bytes = parseAddress(platform);
    return bytes ? addressKey(bytes) : 'unknown';
  }
  const entries = (req.headers.get('x-forwarded-for') ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  for (let i = entries.length - 1; i >= 0; i--) {
    const bytes = parseAddress(entries[i]);
    // Something we can't read: don't trust it or anything written before it.
    if (!bytes) return 'unknown';
    if (!isProxyAddress(bytes)) return addressKey(bytes);
  }
  // No entries, or only private/Cloudflare ones (for example a local test): use the nearest one.
  const nearest = entries.length ? parseAddress(entries[entries.length - 1]) : null;
  return nearest ? addressKey(nearest) : 'unknown';
}

// Turns an address into its bytes (4 for IPv4, 16 for IPv6), or null if it isn't a proper address.
// An IPv4 address written the IPv6 way comes back as the 4 IPv4 bytes.
function parseAddress(value: string): number[] | null {
  const text = value.trim().toLowerCase();
  if (text.length > 45) return null;
  if (!text.includes(':')) return parseIPv4(text);
  let rest = text;
  const lastColon = rest.lastIndexOf(':');
  if (rest.slice(lastColon + 1).includes('.')) {
    // IPv6 may end in an IPv4 address (::ffff:1.2.3.4): write it as the last two groups instead.
    const four = parseIPv4(rest.slice(lastColon + 1));
    if (!four) return null;
    rest = `${rest.slice(0, lastColon + 1)}${((four[0] << 8) | four[1]).toString(16)}:${((four[2] << 8) | four[3]).toString(16)}`;
  }
  // '::' stands for a run of zero groups and may appear once.
  const halves = rest.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (part: string) => (part === '' ? [] : part.split(':'));
  const head = groupsOf(halves[0]);
  const end = halves.length === 2 ? groupsOf(halves[1]) : [];
  if (![...head, ...end].every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  const missing = 8 - head.length - end.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array(missing).fill('0'), ...end].map((group) => parseInt(group, 16));
  const bytes = all.flatMap((group) => [group >> 8, group & 255]);
  const mapped = bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 255 && bytes[11] === 255;
  return mapped ? bytes.slice(12) : bytes;
}

function parseIPv4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4 || !parts.every((part) => /^[0-9]{1,3}$/.test(part))) return null;
  const bytes = parts.map(Number);
  return bytes.every((b) => b <= 255) ? bytes : null;
}

// The key for an address: IPv4 as written, IPv6 as its /64 block.
function addressKey(bytes: number[]): string {
  if (bytes.length === 4) return bytes.join('.');
  const groups = [0, 2, 4, 6].map((i) => ((bytes[i] << 8) | bytes[i + 1]).toString(16));
  return `${groups.join(':')}::/64`;
}

// Private network addresses and Cloudflare's own addresses (from cloudflare.com/ips). These belong to the proxies
// between the app and this function, never to a person's phone.
const PROXY_RANGES: [string, number][] = [
  ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8], ['169.254.0.0', 16], ['100.64.0.0', 10], ['0.0.0.0', 8],
  ['::1', 128], ['::', 128], ['fc00::', 7], ['fe80::', 10],
  ['173.245.48.0', 20], ['103.21.244.0', 22], ['103.22.200.0', 22], ['103.31.4.0', 22], ['141.101.64.0', 18],
  ['108.162.192.0', 18], ['190.93.240.0', 20], ['188.114.96.0', 20], ['197.234.240.0', 22], ['198.41.128.0', 17],
  ['162.158.0.0', 15], ['104.16.0.0', 13], ['104.24.0.0', 14], ['172.64.0.0', 13], ['131.0.72.0', 22],
  ['2400:cb00::', 32], ['2606:4700::', 32], ['2803:f800::', 32], ['2405:b500::', 32], ['2405:8100::', 32],
  ['2a06:98c0::', 29], ['2c0f:f248::', 32],
];
function isProxyAddress(bytes: number[]): boolean {
  return PROXY_RANGES.some(([base, bits]) => {
    const start = parseAddress(base);
    if (!start || start.length !== bytes.length) return false;
    for (let bit = 0; bit < bits; bit++) {
      const mask = 128 >> (bit % 8);
      if ((start[bit >> 3] & mask) !== (bytes[bit >> 3] & mask)) return false;
    }
    return true;
  });
}

// Reserve a try before checking credentials. The database locks each counter so simultaneous requests
// cannot all slip through; if the counter is unavailable, don't continue without protection.
// Every try of one request carries the same request id, so they can all be given back together.
async function reserveAttempt(kind: 'fail', key: string, max: number, minutes: number, attemptId: string): Promise<boolean> {
  const { data, error } = await admin.rpc('reserve_username_auth_attempt', {
    attempt_kind: kind, attempt_key: key, max_attempts: max, window_minutes: minutes, attempt_id: attemptId,
  });
  if (error || typeof data !== 'boolean') throw error ?? new Error('Could not check the attempt limit');
  return data;
}

// Reserve several counters in order. If one is full, give back the ones already taken and say which was full.
async function reserveAll(kind: 'fail', counters: [string, string, number][], minutes: number, attemptId: string): Promise<string | null> {
  for (const [name, key, max] of counters) {
    if (!(await reserveAttempt(kind, key, max, minutes, attemptId))) {
      await refundAttempt(attemptId);
      return name;
    }
  }
  return null;
}

// Give back every try of one request (a correct login, or an outage).
// If this fails the try simply keeps counting, which is the safe side, so it never stops the request.
async function refundAttempt(attemptId: string): Promise<void> {
  try {
    const { error } = await admin.rpc('refund_username_auth_attempt', { attempt_id: attemptId });
    if (error) console.error('Could not give the try back', error.message);
  } catch (error) {
    console.error('Could not give the try back', error);
  }
}

// The login service itself had a problem (it is down, overloaded or rate limited) – not a wrong password.
class LoginServiceError extends Error {}

// Logs in like the app would, and hands back the login so the app can use it.
// A wrong password gives null. Any other problem (the login service is down, busy or unreachable) throws,
// so the person sees "try again" instead of "wrong password".
async function logIn(email: string, password: string) {
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    const status = typeof error.status === 'number' ? error.status : undefined;
    if (error.name === 'AuthRetryableFetchError' || status === 0 || status === 429 || (status !== undefined && status >= 500) ||
        error.code === 'over_request_rate_limit') {
      throw new LoginServiceError(`Login service problem: ${error.message}`);
    }
    return null;
  }
  return data.session ? { access_token: data.session.access_token, refresh_token: data.session.refresh_token } : null;
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
  // Sign-ups are switched off: answer straight away, before anything is checked, counted or looked up.
  // 410 ("gone") so these show up clearly in the function's logs.
  if (body.action === 'signup') return json({ error: SIGNUP_CLOSED }, 410);
  // The same checks as before sign-ups were switched off, so logging in answers exactly as it did.
  if (typeof body.username !== 'string' || typeof body.password !== 'string' ||
      (body.display_name !== undefined && typeof body.display_name !== 'string') ||
      (body.terms_version !== undefined && typeof body.terms_version !== 'string')) {
    return json({ error: 'Check the details and try again' }, 400);
  }
  const username = body.username.trim().toLowerCase().replace(/^@/, '');
  const password = body.password;

  // One id for every try this request reserves, so they can all be given back together.
  const attemptId = crypto.randomUUID();
  // True while this request holds tries that must be given back if something breaks (an outage).
  let giveBackOnError = false;
  try {
    if (body.action === 'signin') {
      if (!USERNAME.test(username) || !password || password.length > 72) return json({ error: 'Wrong username or password' }, 401);
      const address = clientAddress(req);
      // Set before reserving: if the limiter breaks partway, the counters already taken are given back.
      giveBackOnError = true;
      const full = await reserveAll('fail', [
        ['pair', `pair:${username}@${address}`, LOGIN_LIMITS.pair],
        ['username', `user:${username}`, LOGIN_LIMITS.username],
        ['address', `ip:${address}`, LOGIN_LIMITS.address],
      ], LOGIN_WINDOW_MINUTES, attemptId);
      if (full === 'address') return json({ error: 'Lots of login tries from here – wait 15 minutes and try again' }, 429);
      if (full) return json({ error: 'Lots of login tries for this username – wait 15 minutes and try again' }, 429);
      const { data: profile, error: lookupError } = await admin.from('profiles').select('id').eq('username', username).maybeSingle();
      if (lookupError) throw lookupError;
      let email: string | undefined;
      if (profile) {
        const { data: found, error: userError } = await admin.auth.admin.getUserById(profile.id);
        if (userError) throw userError;
        email = found.user?.email;
      }
      const session = email ? await logIn(email, password) : null;
      // From here the answer is real: a wrong password (or no such account) keeps its try.
      giveBackOnError = false;
      if (!session) {
        return json({ error: 'Wrong username or password' }, 401);
      }
      // A correct login is not a failed try, so give it back.
      await refundAttempt(attemptId);
      return json({ session });
    }

    return json({ error: 'Something went wrong – try again' }, 400);
  } catch (error) {
    console.error('Username authentication could not finish', error);
    // An outage is not the person's fault, so it doesn't use up a try.
    if (giveBackOnError) await refundAttempt(attemptId);
    return json({ error: 'Could not reach the login service. Please try again.' }, 503);
  }
});
