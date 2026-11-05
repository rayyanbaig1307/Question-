// Username login and sign-up limits (QA review: throttling).
// Runs the real username-auth handler. Its limit checks run the real SQL functions from every migration in a
// local, in-memory PostgreSQL (PGlite); the login service and the profiles lookup are small fakes.
// Nothing here talks to a live project.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEdge, request } from './edgeHarness.mjs';
import { asUser, createLocalDatabase } from '../database/local-db.mjs';

const WRONG = { error: 'Wrong username or password' };
const OUTAGE = { error: 'Could not reach the login service. Please try again.' };
const SIGNUP_CAP = 5; // new username accounts per address per hour
const SITE_SIGNUP_CAP = 100; // new username accounts per hour, everyone together

let db;
beforeAll(async () => { db = await createLocalDatabase(); }, 60_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => { await db.exec('truncate public.username_auth_log restart identity;'); });

const logRows = async (pattern = '%') =>
  (await db.query('select kind, key from public.username_auth_log where key like $1 order by id', [pattern])).rows;

// A fake Supabase service: accounts live in a Map, the limit functions run in PGlite as the server role.
function service() {
  const accounts = new Map([['owner', { id: 'id-owner', email: 'owner@noemail.peekaboo.invalid', password: 'right1password' }]]);
  const byId = (id) => [...accounts.values()].find((a) => a.id === id);
  const rpc = vi.fn(async (fn, args) => {
    if (fn === 'public_name_allowed') return { data: true, error: null };
    const names = Object.keys(args);
    try {
      const { rows } = await asUser(db, null, (tx) => tx.query(
        `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as result`, names.map((n) => args[n])), 'service_role');
      return { data: rows[0].result, error: null };
    } catch (error) {
      return { data: null, error: { message: error.message } };
    }
  });
  const profileLookup = vi.fn(async (username) => ({ data: accounts.has(username) ? { id: accounts.get(username).id } : null, error: null }));
  const from = vi.fn((table) => {
    if (table !== 'profiles') throw new Error(`Unexpected table ${table}`);
    let username;
    const chain = { select: () => chain, eq: (_c, v) => { username = v; return chain; }, maybeSingle: () => profileLookup(username) };
    return chain;
  });
  const createUser = vi.fn(async ({ email, password, user_metadata }) => {
    const id = `id-${user_metadata.username}`;
    accounts.set(user_metadata.username, { id, email, password });
    return { data: { user: { id } }, error: null };
  });
  const getUserById = vi.fn(async (id) => ({ data: { user: byId(id) ? { email: byId(id).email } : null }, error: null }));
  const login = vi.fn(async ({ email, password }) => {
    const found = [...accounts.values()].find((a) => a.email === email);
    return found && found.password === password
      ? { data: { session: { access_token: `access-${found.id}`, refresh_token: 'refresh' } }, error: null }
      : { data: { session: null }, error: { name: 'AuthApiError', message: 'Invalid login credentials', status: 400, code: 'invalid_credentials' } };
  });
  const admin = { rpc, from, auth: { admin: { createUser, getUserById } } };
  const handler = loadEdge('username-auth', admin, login);
  return { handler, rpc, from, profileLookup, createUser, getUserById, login, accounts };
}

const platform = (address, forwarded) => ({ 'cf-connecting-ip': address, ...(forwarded ? { 'x-forwarded-for': forwarded } : {}) });
const signin = (handler, username, password, headers = {}) => handler(request({ action: 'signin', username, password }, { headers }));
const signup = (handler, username, headers = {}) => handler(request({ action: 'signup', username, password: 'test12345' }, { headers }));
const statuses = (responses) => responses.map((r) => r.status);

describe('username login limits', () => {
  it('a stranger guessing from their own address cannot lock the owner out', async () => {
    const { handler } = service();
    for (let i = 0; i < 8; i++) expect((await signin(handler, 'owner', `guess${i}abc`, platform('203.0.113.66'))).status).toBe(401);
    expect((await signin(handler, 'owner', 'guess9abc', platform('203.0.113.66'))).status).toBe(429);
    const owner = await signin(handler, 'owner', 'right1password', platform('198.51.100.7'));
    expect(owner.status).toBe(200);
    expect((await owner.json()).session.access_token).toBe('access-id-owner');
  });

  it('correct logins never use up the wrong-password allowance', async () => {
    const { handler } = service();
    for (let i = 0; i < 20; i++) expect((await signin(handler, ' @Owner ', 'right1password', platform('198.51.100.7'))).status).toBe(200);
    expect(await logRows()).toEqual([]);
    const wrong = [];
    for (let i = 0; i < 9; i++) wrong.push(await signin(handler, 'owner', 'wrong1password', platform('198.51.100.7')));
    expect(statuses(wrong)).toEqual([401, 401, 401, 401, 401, 401, 401, 401, 429]);
  });

  it('allows at most 8 checks during 100 simultaneous wrong guesses from one address', async () => {
    const { handler, login } = service();
    const all = await Promise.all(Array.from({ length: 100 }, () => signin(handler, 'owner', 'wrong1password', platform('203.0.113.66'))));
    expect(all.filter((r) => r.status === 401)).toHaveLength(8);
    expect(all.filter((r) => r.status === 429)).toHaveLength(92);
    expect(login).toHaveBeenCalledTimes(8);
  });

  it('a missing account counts like a wrong password and gives the same answer', async () => {
    const { handler } = service();
    const first = await signin(handler, 'nobody_here', 'wrong1password', platform('203.0.113.66'));
    expect(first.status).toBe(401);
    expect(await first.json()).toEqual(WRONG);
    for (let i = 0; i < 7; i++) await signin(handler, 'nobody_here', 'wrong1password', platform('203.0.113.66'));
    expect((await signin(handler, 'nobody_here', 'wrong1password', platform('203.0.113.66'))).status).toBe(429);
  });

  it('caps wrong guesses for one username across all addresses at 40 per 15 minutes', async () => {
    const { handler } = service();
    const guesses = [];
    for (let a = 1; a <= 5; a++) for (let i = 0; i < 8; i++) guesses.push(await signin(handler, 'owner', 'wrong1password', platform(`203.0.113.${a}`)));
    expect(guesses.every((r) => r.status === 401)).toBe(true);
    expect((await signin(handler, 'owner', 'wrong1password', platform('203.0.113.6'))).status).toBe(429);
    // The trade-off that is left (see the notes): someone with many addresses can still hold the
    // name-wide cap full, and then even the right password must wait.
    expect((await signin(handler, 'owner', 'right1password', platform('198.51.100.7'))).status).toBe(429);
    // A refused try leaves no rows behind for the address or the address + name pair.
    expect(await logRows('%198.51.100.7%')).toEqual([]);
  });

  it('one address cannot try wrong passwords across many usernames (30 per 15 minutes)', async () => {
    const { handler } = service();
    for (let i = 0; i < 30; i++) expect((await signin(handler, `name_${i}`, 'wrong1password', platform('203.0.113.66'))).status).toBe(401);
    const blocked = await signin(handler, 'name_30', 'wrong1password', platform('203.0.113.66'));
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error).toMatch(/from here/);
    // The refused try did not count against that username, and other addresses still work.
    expect(await logRows('user:name_30')).toEqual([]);
    expect((await signin(handler, 'owner', 'right1password', platform('198.51.100.7'))).status).toBe(200);
  });

  it.each([
    ['the account lookup fails', (s) => s.getUserById.mockResolvedValue({ data: { user: null }, error: { message: 'db down', status: 500 } })],
    ['the login service has an error', (s) => s.login.mockResolvedValue({ data: { session: null }, error: { name: 'AuthApiError', message: 'Internal error', status: 500 } })],
    ['the login service is busy', (s) => s.login.mockResolvedValue({ data: { session: null }, error: { name: 'AuthApiError', message: 'Too many requests', status: 429, code: 'over_request_rate_limit' } })],
    ['the login service cannot be reached', (s) => s.login.mockResolvedValue({ data: { session: null }, error: { name: 'AuthRetryableFetchError', message: 'fetch failed', status: 0 } })],
    ['the login call throws', (s) => s.login.mockRejectedValue(new Error('socket hang up'))],
    ['the profiles lookup fails', (s) => s.profileLookup.mockResolvedValue({ data: null, error: { message: 'timeout' } })],
  ])('an outage (%s) says "try again" and does not use up a try', async (_why, breakIt) => {
    const s = service();
    breakIt(s);
    for (let i = 0; i < 12; i++) {
      const response = await signin(s.handler, 'owner', 'right1password', platform('198.51.100.7'));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual(OUTAGE);
    }
    expect(await logRows()).toEqual([]);
    vi.restoreAllMocks();
    const fresh = service();
    expect((await signin(fresh.handler, 'owner', 'right1password', platform('198.51.100.7'))).status).toBe(200);
  });

  it('a correct login still works when giving the try back fails', async () => {
    const s = service();
    const real = s.rpc.getMockImplementation();
    s.rpc.mockImplementation(async (fn, args) => (fn === 'refund_username_auth_attempt' ? { data: null, error: { message: 'offline' } } : real(fn, args)));
    expect((await signin(s.handler, 'owner', 'right1password', platform('198.51.100.7'))).status).toBe(200);
  });

  it('a limiter outage after the first counter gives back the counters already taken', async () => {
    const s = service();
    const real = s.rpc.getMockImplementation();
    // The first counter (name + address) works; the second one (the name from all addresses) is down.
    s.rpc.mockImplementation(async (fn, args) =>
      fn === 'reserve_username_auth_attempt' && String(args.attempt_key).startsWith('user:')
        ? { data: null, error: { message: 'offline' } }
        : real(fn, args));
    for (let i = 0; i < 10; i++) expect((await signin(s.handler, 'owner', 'right1password', platform('198.51.100.7'))).status).toBe(503);
    expect(s.login).not.toHaveBeenCalled();
    expect(await logRows()).toEqual([]);
    s.rpc.mockImplementation(real);
    expect((await signin(s.handler, 'owner', 'right1password', platform('198.51.100.7'))).status).toBe(200);
  });

  it('a limiter outage after the first counter during sign-up gives that counter back', async () => {
    const s = service();
    const real = s.rpc.getMockImplementation();
    s.rpc.mockImplementation(async (fn, args) =>
      fn === 'reserve_username_auth_attempt' && args.attempt_key === 'all' ? { data: null, error: { message: 'offline' } } : real(fn, args));
    for (let i = 0; i < 8; i++) expect((await signup(s.handler, `try_${i}`, platform('198.51.100.7'))).status).toBe(503);
    expect(s.createUser).not.toHaveBeenCalled();
    expect(await logRows()).toEqual([]);
  });

  it('fails closed when the limit check cannot run', async () => {
    const s = service();
    s.rpc.mockResolvedValue({ data: null, error: { message: 'offline' } });
    expect((await signin(s.handler, 'owner', 'right1password', platform('198.51.100.7'))).status).toBe(503);
    expect(s.login).not.toHaveBeenCalled();
  });
});

describe('client address', () => {
  it('uses the address the platform adds and ignores a forged X-Forwarded-For', async () => {
    const { handler } = service();
    await signin(handler, 'owner', 'wrong1password', platform('203.0.113.5', '10.9.9.9, 203.0.113.5'));
    const keys = (await logRows()).map((r) => r.key);
    expect(keys).toContain('pair:owner@203.0.113.5');
    expect(keys.join(' ')).not.toContain('10.9.9.9');
  });

  it('falls back to X-Forwarded-For when the platform header is missing', async () => {
    const { handler } = service();
    await signin(handler, 'owner', 'wrong1password', { 'x-forwarded-for': '198.51.100.20, 10.0.0.1' });
    expect((await logRows()).map((r) => r.key)).toContain('pair:owner@198.51.100.20');
  });

  it('ignores forged X-Forwarded-For entries: without the platform header it uses the entry the proxies added', async () => {
    const { handler } = service();
    // The app can put anything at the start; the proxies add the real address (and their own) at the end.
    await signin(handler, 'owner', 'wrong1password', { 'x-forwarded-for': '1.2.3.4, 198.51.100.20, 172.64.1.9, 10.0.0.1' });
    const keys = (await logRows()).map((r) => r.key);
    expect(keys).toContain('pair:owner@198.51.100.20');
    expect(keys.join(' ')).not.toContain('1.2.3.4');
  });

  it('rotating forged X-Forwarded-For values without the platform header still stops at five sign-ups', async () => {
    const { handler, createUser } = service();
    const all = [];
    for (let i = 0; i < 12; i++) all.push(await signup(handler, `forged${i}`, { 'x-forwarded-for': `9.9.${i}.9, 203.0.113.9, 172.64.1.9` }));
    expect(createUser).toHaveBeenCalledTimes(SIGNUP_CAP);
    expect(all.filter((r) => r.status === 429)).toHaveLength(12 - SIGNUP_CAP);
  });

  it('counts a whole IPv6 /64 block as one address', async () => {
    const { handler } = service();
    await signin(handler, 'owner', 'wrong1password', platform('2001:0DB8:0001:0002:0000:0000:0000:0001'));
    await signin(handler, 'owner', 'wrong1password', platform('2001:db8:1:2:ffff::7'));
    const keys = (await logRows('pair:%')).map((r) => r.key);
    expect(keys).toEqual(['pair:owner@2001:db8:1:2::/64', 'pair:owner@2001:db8:1:2::/64']);
  });

  it('counts an IPv4 address written the IPv6 way as the same address', async () => {
    const { handler } = service();
    await signin(handler, 'owner', 'wrong1password', platform('::ffff:203.0.113.1'));
    await signin(handler, 'owner', 'wrong1password', platform('::FFFF:cb00:7101'));
    await signin(handler, 'owner', 'wrong1password', platform('203.0.113.1'));
    expect((await logRows('pair:%')).map((r) => r.key)).toEqual(Array(3).fill('pair:owner@203.0.113.1'));
  });

  it('rotating addresses inside one IPv6 /64 gets no extra tries', async () => {
    const { handler, createUser } = service();
    const block = (i) => platform(`2001:db8:1:2::${(i + 1).toString(16)}`);
    // Wrong passwords for one name: 8 checks, then refused.
    const guesses = [];
    for (let i = 0; i < 40; i++) guesses.push(await signin(handler, 'owner', 'wrong1password', block(i)));
    expect(guesses.filter((r) => r.status === 401)).toHaveLength(8);
    expect(guesses.filter((r) => r.status === 429)).toHaveLength(32);
    // So one IPv6 block cannot fill the name-wide cap: the owner still gets in from elsewhere.
    expect((await signin(handler, 'owner', 'right1password', platform('198.51.100.7'))).status).toBe(200);
    // Spraying many names: 30 more checks would pass the 30 cap only if the block were many addresses.
    const spray = [];
    for (let i = 0; i < 60; i++) spray.push(await signin(handler, `victim_${i}`, 'wrong1password', block(100 + i)));
    expect(spray.filter((r) => r.status === 401)).toHaveLength(30 - 8);
    // Sign-ups: five per block.
    for (let i = 0; i < 20; i++) await signup(handler, `sixfour${i}`, block(200 + i));
    expect(createUser).toHaveBeenCalledTimes(SIGNUP_CAP);
  });

  it('keeps different IPv6 /64 blocks apart', async () => {
    const { handler } = service();
    for (let i = 0; i < 8; i++) await signin(handler, 'owner', 'wrong1password', platform('2001:db8:1:2::1'));
    expect((await signin(handler, 'owner', 'wrong1password', platform('2001:db8:1:2::2'))).status).toBe(429);
    expect((await signin(handler, 'owner', 'wrong1password', platform('2001:db8:1:3::1'))).status).toBe(401);
  });

  it.each([['999.1.1.1'], ['1.2.3'], ['2001:db8::1::2'], ['12345::1'], ['::ffff:1.2.3.400'], ['1:2:3:4:5:6:7:8:9']])(
    'treats the broken address %s as "unknown"', async (value) => {
      const { handler } = service();
      await signin(handler, 'owner', 'wrong1password', platform(value));
      expect((await logRows('pair:%')).map((r) => r.key)).toEqual(['pair:owner@unknown']);
    });

  it('treats a value that is not an address as "unknown"', async () => {
    const { handler } = service();
    await signin(handler, 'owner', 'wrong1password', { 'x-forwarded-for': `<script>${'x'.repeat(400)}` });
    expect((await logRows()).map((r) => r.key)).toContain('pair:owner@unknown');
  });
});

describe('username sign-up limits', () => {
  it('rotating forged X-Forwarded-For values does not give more sign-ups from one address', async () => {
    const { handler, createUser } = service();
    const all = [];
    for (let i = 0; i < 12; i++) all.push(await signup(handler, `newuser${i}`, platform('203.0.113.9', `10.0.${i}.1, 203.0.113.9`)));
    expect(createUser).toHaveBeenCalledTimes(SIGNUP_CAP);
    expect(all.filter((r) => r.status === 429)).toHaveLength(12 - SIGNUP_CAP);
  });

  it('without the platform header, rotating forged values still stop at the hourly cap for everyone', async () => {
    const { handler, createUser } = service();
    const all = [];
    for (let i = 0; i < SITE_SIGNUP_CAP + 10; i++) all.push(await signup(handler, `bot${i}`, { 'x-forwarded-for': `10.${i >> 8}.${i & 255}.1` }));
    expect(createUser).toHaveBeenCalledTimes(SITE_SIGNUP_CAP);
    const refused = all.filter((r) => r.status === 429);
    expect(refused).toHaveLength(10);
    expect((await refused[0].json()).error).toMatch(/right now/);
    // A refused sign-up leaves no row for its own address.
    expect(await logRows(`ip:10.0.${SITE_SIGNUP_CAP + 5}.1`)).toEqual([]);
  });

  it('a taken username gives the sign-up try back', async () => {
    const { handler, createUser, accounts } = service();
    accounts.set('taken_name', { id: 'id-taken', email: 'x@noemail.peekaboo.invalid', password: 'x1x1x1x1x' });
    for (let i = 0; i < 8; i++) expect((await signup(handler, 'taken_name', platform('198.51.100.7'))).status).toBe(409);
    expect((await signup(handler, 'free_name', platform('198.51.100.7'))).status).toBe(200);
    expect(createUser).toHaveBeenCalledTimes(1);
    expect(await logRows()).toEqual([{ kind: 'signup', key: 'ip:198.51.100.7' }, { kind: 'signup', key: 'all' }]);
  });

  it('a failed account creation gives the sign-up try back', async () => {
    const s = service();
    const real = s.createUser.getMockImplementation();
    s.createUser.mockResolvedValue({ data: { user: null }, error: { message: 'Database error creating new user' } });
    for (let i = 0; i < 8; i++) expect((await signup(s.handler, `try_${i}`, platform('198.51.100.7'))).status).toBe(400);
    s.createUser.mockImplementation(real);
    expect((await signup(s.handler, 'works_now', platform('198.51.100.7'))).status).toBe(200);
    expect(await logRows('ip:%')).toHaveLength(1);
  });

  it('an outage during sign-up gives the sign-up try back', async () => {
    const s = service();
    s.profileLookup.mockResolvedValue({ data: null, error: { message: 'timeout' } });
    for (let i = 0; i < 8; i++) expect((await signup(s.handler, `try_${i}`, platform('198.51.100.7'))).status).toBe(503);
    expect(await logRows()).toEqual([]);
    s.createUser.mockRejectedValueOnce(new Error('socket hang up'));
    s.profileLookup.mockImplementation(async () => ({ data: null, error: null }));
    expect((await signup(s.handler, 'try_x', platform('198.51.100.7'))).status).toBe(503);
    expect(await logRows()).toEqual([]);
  });

  it('only real new accounts count: five per address per hour', async () => {
    const { handler, createUser } = service();
    const all = await Promise.all(Array.from({ length: 30 }, (_, i) => signup(handler, `crowd${i}`, platform('192.0.2.44'))));
    expect(createUser).toHaveBeenCalledTimes(SIGNUP_CAP);
    expect(all.filter((r) => r.status === 429)).toHaveLength(30 - SIGNUP_CAP);
  });
});
