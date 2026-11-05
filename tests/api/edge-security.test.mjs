import { describe, expect, it, vi } from 'vitest';
import { loadEdge, query, request } from './edgeHarness.mjs';
import { loadLibrary } from '../unit/libHarness.mjs';

function deletionService(overrides = {}) {
  const list = vi.fn(async () => ({ data: [], error: null }));
  const remove = vi.fn(async () => ({ error: null }));
  const deleteUser = vi.fn(async () => ({ error: null }));
  const admin = {
    auth: { getUser: vi.fn(async (token) => token === 'valid-A' ? { data: { user: { id: 'user-A' } }, error: null } : { data: { user: null }, error: { message: 'Expired or invalid' } }), admin: { deleteUser } },
    from: vi.fn(() => query({ data: [], error: null })),
    rpc: vi.fn(() => query({ data: [], error: null })),
    storage: { from: vi.fn(() => ({ list, remove })) },
  };
  Object.assign(admin, overrides);
  return { admin, list, remove, deleteUser };
}

describe('delete-account real handler', () => {
  it.each([undefined, 'expired', 'forged', 'valid-B'])('rejects missing, expired and forged tokens: %s', async (token) => {
    const { admin, deleteUser } = deletionService();
    const response = await loadEdge('delete-account', admin)(request({}, { token }));
    expect(response.status).toBe(401);
    expect(deleteUser).not.toHaveBeenCalled();
    expect(admin.storage.from).not.toHaveBeenCalled();
  });

  it('never trusts a user ID from the request body', async () => {
    const { admin, deleteUser } = deletionService();
    const response = await loadEdge('delete-account', admin)(request({ userId: 'victim-B' }, { token: 'valid-A' }));
    expect(response.status).toBe(200);
    expect(deleteUser).toHaveBeenCalledExactlyOnceWith('user-A');
  });

  it('rejects unsupported methods before touching data', async () => {
    const { admin, deleteUser } = deletionService();
    const response = await loadEdge('delete-account', admin)(request(undefined, { method: 'GET' }));
    expect(response.status).toBe(405);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('keeps the account retryable if the mystery-file query fails', async () => {
    const { admin, deleteUser } = deletionService({ from: () => query({ data: null, error: { message: 'database unavailable' } }) });
    const response = await loadEdge('delete-account', admin)(request({}, { token: 'valid-A' }));
    expect(response.status).toBe(503);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('keeps the account retryable if file listing fails', async () => {
    const { admin, list, deleteUser } = deletionService();
    list.mockResolvedValue({ data: null, error: { message: 'storage unavailable' } });
    const response = await loadEdge('delete-account', admin)(request({}, { token: 'valid-A' }));
    expect(response.status).toBe(503);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('keeps the account retryable if a file removal fails', async () => {
    const { admin, list, remove, deleteUser } = deletionService();
    list.mockResolvedValueOnce({ data: [{ id: 'file', name: 'image.jpg' }], error: null });
    remove.mockResolvedValue({ error: { message: 'storage unavailable' } });
    const response = await loadEdge('delete-account', admin)(request({}, { token: 'valid-A' }));
    expect(response.status).toBe(503);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('removes all pages and nested files, not just the first 1000', async () => {
    const { admin, list, remove } = deletionService();
    list.mockImplementation(async (prefix, options = {}) => {
      if (prefix === 'user-A' && !options.offset) return { data: Array.from({ length: 1000 }, (_, i) => ({ id: `f-${i}`, name: `file-${i}.jpg` })), error: null };
      if (prefix === 'user-A' && options.offset === 1000) return { data: [{ id: 'last', name: 'last.jpg' }, { id: null, name: 'nested' }], error: null };
      if (prefix === 'user-A/nested') return { data: [{ id: 'inside', name: 'inside.jpg' }], error: null };
      return { data: [], error: null };
    });
    const response = await loadEdge('delete-account', admin)(request({}, { token: 'valid-A' }));
    expect(response.status).toBe(200);
    const removed = remove.mock.calls.flatMap(([paths]) => paths);
    expect(removed).toContain('user-A/last.jpg');
    expect(removed).toContain('user-A/nested/inside.jpg');
    expect(remove.mock.calls.every(([paths]) => paths.length <= 100)).toBe(true);
  });

  it('does not expose internal auth deletion errors', async () => {
    const { admin, deleteUser } = deletionService();
    deleteUser.mockResolvedValue({ error: { message: 'internal database detail secret' } });
    const response = await loadEdge('delete-account', admin)(request({}, { token: 'valid-A' }));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('secret');
  });

  it('collects every page of anonymous post files before deleting the account', async () => {
    const { admin, remove, deleteUser } = deletionService();
    const pages = [];
    admin.from.mockImplementation(() => {
      let offset = 0;
      const chain = query(() => ({ data: offset === 0
        ? Array.from({ length: 1000 }, (_, i) => ({ media_path: `mystery/${i}.jpg`, poster_path: null, overlay_path: null }))
        : [{ media_path: 'mystery/last.jpg', poster_path: 'mystery/last-poster.jpg', overlay_path: null }], error: null }));
      chain.range = (from, to) => { offset = from; pages.push([from, to]); return chain; };
      return chain;
    });
    const response = await loadEdge('delete-account', admin)(request({}, { token: 'valid-A' }));
    expect(response.status).toBe(200);
    expect(pages).toEqual([[0, 999], [1000, 1999]]);
    expect(remove.mock.calls.flatMap(([paths]) => paths)).toContain('mystery/last.jpg');
    expect(remove.mock.calls.flatMap(([paths]) => paths)).toContain('mystery/last-poster.jpg');
    expect(deleteUser).toHaveBeenCalledTimes(1);
  });

  it('also removes anonymous files whose post row was already deleted', async () => {
    const { admin, remove } = deletionService();
    admin.rpc.mockReturnValue(query({ data: [{ path: 'mystery/old-orphan.jpg' }], error: null }));
    const response = await loadEdge('delete-account', admin)(request({ userId: 'victim' }, { token: 'valid-A' }));
    expect(response.status).toBe(200);
    expect(admin.rpc).toHaveBeenCalledWith('account_mystery_files', { account: 'user-A' });
    expect(remove.mock.calls.flatMap(([paths]) => paths)).toContain('mystery/old-orphan.jpg');
  });

  it('preserves the account if the owned anonymous file list cannot be loaded', async () => {
    const { admin, deleteUser } = deletionService();
    admin.rpc.mockImplementation((name) => query(name === 'account_mystery_files'
      ? { data: null, error: { message: 'storage metadata offline' } }
      : { data: null, error: null }));
    const response = await loadEdge('delete-account', admin)(request({}, { token: 'valid-A' }));
    expect(response.status).toBe(503);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('opens file deletion scope only for the verified caller', async () => {
    const { admin } = deletionService();
    const response = await loadEdge('delete-account', admin)(request({ userId: 'victim-B' }, { token: 'valid-A' }));
    expect(response.status).toBe(200);
    expect(admin.rpc).toHaveBeenCalledWith('begin_account_media_deletion', { account: 'user-A' });
  });

  it('does not remove files if account-deletion scope cannot be opened', async () => {
    const { admin, remove, deleteUser } = deletionService();
    admin.rpc.mockImplementation((name) => query(name === 'begin_account_media_deletion'
      ? { data: null, error: { message: 'unavailable' } } : { data: [], error: null }));
    const response = await loadEdge('delete-account', admin)(request({}, { token: 'valid-A' }));
    expect(response.status).toBe(503);
    expect(remove).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('a changed JWT subject cannot delete an account chosen by an earlier confirmation', async () => {
    const { admin, remove, deleteUser } = deletionService();
    const response = await loadEdge('delete-account', admin)(request({ expected_user_id: 'old-confirmed-user' }, { token: 'valid-A' }));
    expect(response.status).toBe(409);
    expect(admin.rpc).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });
});

function usernameService() {
  const attempts = new Map();
  const createUser = vi.fn(async () => ({ data: { user: { id: 'new-user' } }, error: null }));
  const login = vi.fn(async () => ({ data: { session: null }, error: { message: 'invalid credentials' } }));
  const rpc = vi.fn(async (_fn, args) => {
    const key = `${args.attempt_kind}:${args.attempt_key}`;
    const previous = attempts.get(key) ?? 0;
    if (previous >= args.max_attempts) return { data: false, error: null };
    attempts.set(key, previous + 1);
    return { data: true, error: null };
  });
  const admin = {
    rpc,
    from: vi.fn((table) => table === 'profiles' ? query({ data: { id: 'known-A' }, error: null }) : query({ data: null, count: 0, error: null })),
    auth: { admin: { createUser, getUserById: vi.fn(async () => ({ data: { user: { email: 'a@example.invalid' } }, error: null })) } },
  };
  return { admin, login, rpc, createUser };
}

describe('username-auth real handler', () => {
  it('rejects unsupported HTTP methods', async () => {
    const { admin, login } = usernameService();
    const response = await loadEdge('username-auth', admin, login)(request(undefined, { method: 'GET' }));
    expect(response.status).toBe(405);
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON and unknown actions', async () => {
    const { admin, login } = usernameService();
    const handler = loadEdge('username-auth', admin, login);
    expect((await handler(request('{broken'))).status).toBe(400);
    expect((await handler(request({ action: 'remove-all', username: 'alice', password: 'test12345' }))).status).toBe(400);
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('returns only session credentials after a correct username login', async () => {
    const { admin, login } = usernameService();
    login.mockResolvedValue({ data: { session: { access_token: 'test-access', refresh_token: 'test-refresh', user: { email: 'private@example.invalid' } } }, error: null });
    const response = await loadEdge('username-auth', admin, login)(request({ action: 'signin', username: ' @Alice ', password: 'test12345' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ session: { access_token: 'test-access', refresh_token: 'test-refresh' } });
    expect(login).toHaveBeenCalledExactlyOnceWith({ email: 'a@example.invalid', password: 'test12345' });
  });

  it('refuses duplicate signups without creating an auth account', async () => {
    const { admin, login, createUser } = usernameService();
    const response = await loadEdge('username-auth', admin, login)(request({ action: 'signup', username: 'alice', password: 'test12345' }));
    expect(response.status).toBe(409);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('creates a username account with an unreceivable email and returns its session', async () => {
    const { admin, login, createUser } = usernameService();
    admin.from.mockReturnValue(query({ data: null, error: null }));
    login.mockResolvedValue({ data: { session: { access_token: 'test-access', refresh_token: 'test-refresh' } }, error: null });
    const response = await loadEdge('username-auth', admin, login)(request({ action: 'signup', username: 'alice', password: 'test12345', display_name: 'Alice 👀', terms_version: '2026-11-04' }));
    expect(response.status).toBe(200);
    const created = createUser.mock.calls[0][0];
    expect(created.email).toMatch(/@noemail\.peekaboo\.invalid$/);
    expect(created.user_metadata).toEqual({ username: 'alice', display_name: 'Alice 👀', terms_version: '2026-11-04', no_email: true });
  });

  it('caps simultaneous signup requests at five per network address', async () => {
    const { admin, login, createUser } = usernameService();
    admin.from.mockReturnValue(query({ data: null, error: null }));
    const handler = loadEdge('username-auth', admin, login);
    const responses = await Promise.all(Array.from({ length: 30 }, (_, i) => handler(request({ action: 'signup', username: `newuser${i}`, password: 'test12345' }, { headers: { 'x-forwarded-for': '192.0.2.44' } }))));
    expect(createUser).toHaveBeenCalledTimes(5);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(25);
  });

  it('returns a service error without creating an account when username lookup fails', async () => {
    const { admin, login, createUser } = usernameService();
    admin.from.mockReturnValue(query({ data: null, error: { message: 'connection timeout' } }));
    const response = await loadEdge('username-auth', admin, login)(request({ action: 'signup', username: 'alice', password: 'test12345' }));
    expect(response.status).toBe(503);
    expect(createUser).not.toHaveBeenCalled();
  });

  it.each([null, [], 3, true, '"hello"'])('returns a controlled client error for JSON of the wrong shape: %j', async (body) => {
    const { admin, login } = usernameService();
    const response = await loadEdge('username-auth', admin, login)(request(body));
    expect(response.status).toBe(400);
    expect(login).not.toHaveBeenCalled();
  });

  it.each([{}, [], 123456789, true])('refuses a password with the wrong data type: %j', async (password) => {
    const { admin, login } = usernameService();
    const response = await loadEdge('username-auth', admin, login)(request({ action: 'signin', username: 'alice', password }));
    expect(response.status).toBe(400);
    expect(login).not.toHaveBeenCalled();
  });

  it('rejects a huge request before checking credentials', async () => {
    const { admin, login } = usernameService();
    const response = await loadEdge('username-auth', admin, login)(request({ action: 'signin', username: 'alice', password: 'a1'.repeat(100_000) }));
    expect(response.status).toBe(413);
    expect(login).not.toHaveBeenCalled();
  });

  it('fails closed when the rate limiter database fails', async () => {
    const { admin, login, rpc } = usernameService();
    rpc.mockResolvedValue({ data: null, error: { message: 'offline' } });
    admin.from.mockImplementation(() => query({ data: null, count: null, error: { message: 'offline' } }));
    const response = await loadEdge('username-auth', admin, login)(request({ action: 'signin', username: 'alice', password: 'wrong1password' }));
    expect(response.status).toBe(503);
    expect(login).not.toHaveBeenCalled();
  });

  it('allows at most 8 sign-in checks during 100 simultaneous guesses', async () => {
    const { admin, login } = usernameService();
    const handler = loadEdge('username-auth', admin, login);
    const responses = await Promise.all(Array.from({ length: 100 }, () => handler(request({ action: 'signin', username: 'alice', password: 'wrong1password' }))));
    expect(responses.filter((r) => r.status === 401)).toHaveLength(8);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(92);
    expect(login).toHaveBeenCalledTimes(8);
  });

  it.each(['', '😈😈😈', "a' OR 1=1--", '<script>alert(1)</script>', 'a'.repeat(1000)])('rejects invalid username %s', async (username) => {
    const { admin, login } = usernameService();
    const response = await loadEdge('username-auth', admin, login)(request({ action: 'signup', username, password: 'test12345' }));
    expect(response.status).toBe(400);
    expect(admin.auth.admin.createUser).not.toHaveBeenCalled();
  });

  it.each(['', 'short1', 'abcdefgh', '12345678', 'a1'.repeat(37)])('refuses invalid signup password %s', async (password) => {
    const { admin, login, createUser } = usernameService();
    const response = await loadEdge('username-auth', admin, login)(request({ action: 'signup', username: 'alice', password }));
    expect(response.status).toBe(400);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('returns the same error for missing accounts and incorrect passwords', async () => {
    const { admin, login } = usernameService();
    const handler = loadEdge('username-auth', admin, login);
    const wrong = await handler(request({ action: 'signin', username: 'alice', password: 'wrong12345' }));
    admin.from.mockReturnValue(query({ data: null, error: null }));
    const missing = await handler(request({ action: 'signin', username: 'nobody', password: 'wrong12345' }));
    expect(wrong.status).toBe(missing.status);
    expect(await wrong.json()).toEqual(await missing.json());
  });
});

// OPEN-01: names chosen at username sign-up go through the same word filter before any account is made.
// The owner's choice: the username can't have swearing or slurs; the display name may swear, but no slurs.
// The fake database answers with the app's own filter in those places; tests/unit/word-filter-parity.test.mjs
// proves the real database function (public_name_allowed) gives the same answers.
describe('username-auth sign-up word filter', () => {
  const NAME_NOT_ALLOWED = "Let's keep it clean – that word can't be in a username or name.";
  const WORD_NOT_ALLOWED = "That word isn't allowed on Peekaboo.";
  function filteredService() {
    const service = usernameService();
    const { findBlockedWord } = loadLibrary('cleanWords');
    const limiter = service.rpc.getMockImplementation();
    service.rpc.mockImplementation(async (fn, args) => {
      if (fn !== 'public_name_allowed') return limiter(fn, args);
      return { data: !findBlockedWord(args.username, 'name') && !findBlockedWord(args.display_name, 'content'), error: null };
    });
    service.admin.from.mockReturnValue(query({ data: null, error: null }));
    service.login.mockResolvedValue({ data: { session: { access_token: 'test-access', refresh_token: 'test-refresh' } }, error: null });
    return service;
  }
  const signup = (handler, extra) => handler(request({ action: 'signup', password: 'test12345', ...extra }));
  const reserved = (rpc) => rpc.mock.calls.filter(([fn]) => fn === 'reserve_username_auth_attempt');

  it.each(['f.u.c.k', 'fuckboy', 'n1gg3r', 'sh1t_head'])('rejects the blocked username %s with a clear message and no account', async (username) => {
    const { admin, login, rpc, createUser } = filteredService();
    const response = await signup(loadEdge('username-auth', admin, login), { username, display_name: 'Alex' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: NAME_NOT_ALLOWED });
    expect(createUser).not.toHaveBeenCalled();
    // A refused name doesn't use up one of the sign-up tries.
    expect(reserved(rpc)).toHaveLength(0);
  });

  it.each(['big dick', 'F U C K', 'ｆｕｃｋ', 'Total Bitch', 'Fuck Off', 'Shït Happens'])('lets a display name with swearing through: %s', async (display_name) => {
    const { admin, login, rpc, createUser } = filteredService();
    const response = await signup(loadEdge('username-auth', admin, login), { username: 'alex', display_name });
    expect(response.status).toBe(200);
    expect(createUser).toHaveBeenCalledOnce();
    expect(createUser.mock.calls[0][0].user_metadata.display_name).toBe(display_name);
    expect(rpc).toHaveBeenCalledWith('public_name_allowed', { username: 'alex', display_name });
  });

  // Numbers for letters, dots and spaces, fancy letters, an invisible character, a look-alike letter, accents.
  it.each(['n1gg3r', 'F.A.G.G.O.T', 'K I K E', 'ｒｅｔａｒｄ', 'ki\u200Bke', '\u0441hink', 'Wétbáck', 'Big Sp1c'])('rejects a display name with a slur: %s', async (display_name) => {
    const { admin, login, rpc, createUser } = filteredService();
    const response = await signup(loadEdge('username-auth', admin, login), { username: 'alex', display_name });
    expect(response.status).toBe(400);
    // The same message the app and the database give for a slur in a display name.
    expect(await response.json()).toEqual({ error: WORD_NOT_ALLOWED });
    expect(createUser).not.toHaveBeenCalled();
    expect(reserved(rpc)).toHaveLength(0);
  });

  it('still rejects a username with swearing when the display name is fine to swear in', async () => {
    const { admin, login, createUser } = filteredService();
    const response = await signup(loadEdge('username-auth', admin, login), { username: 'sh1t_head', display_name: 'Shit Head' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: NAME_NOT_ALLOWED });
    expect(createUser).not.toHaveBeenCalled();
  });

  it('gives the username message when both the username and the display name break the rules', async () => {
    const { admin, login, rpc, createUser } = filteredService();
    const response = await signup(loadEdge('username-auth', admin, login), { username: 'sh1t_head', display_name: 'n1gg3r' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: NAME_NOT_ALLOWED });
    expect(createUser).not.toHaveBeenCalled();
    expect(reserved(rpc)).toHaveLength(0);
  });

  it.each(['Moby Dick', 'Alex Cock', 'Scunthorpe', 'Nazir'])('lets the real name %s through', async (display_name) => {
    const { admin, login, rpc, createUser } = filteredService();
    const response = await signup(loadEdge('username-auth', admin, login), { username: 'alex', display_name });
    expect(response.status).toBe(200);
    expect(createUser.mock.calls[0][0].user_metadata.display_name).toBe(display_name);
    expect(rpc).toHaveBeenCalledWith('public_name_allowed', { username: 'alex', display_name });
  });

  it('checks the display name that will really be saved (the username when it is left empty)', async () => {
    const { admin, login, rpc } = filteredService();
    await signup(loadEdge('username-auth', admin, login), { username: 'alex', display_name: '   ' });
    expect(rpc).toHaveBeenCalledWith('public_name_allowed', { username: 'alex', display_name: 'alex' });
  });

  it.each([
    ['the check fails', { data: null, error: { message: 'offline' } }],
    ['the check gives a strange answer', { data: 'yes', error: null }],
  ])('makes no account when %s', async (_why, answer) => {
    const { admin, login, rpc, createUser } = filteredService();
    const limiter = rpc.getMockImplementation();
    rpc.mockImplementation(async (fn, args) => (fn === 'public_name_allowed' ? answer : limiter(fn, args)));
    const response = await signup(loadEdge('username-auth', admin, login), { username: 'alex', display_name: 'Alex' });
    expect(response.status).toBe(503);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('does not run the name check when logging in', async () => {
    const { admin, login, rpc } = filteredService();
    await loadEdge('username-auth', admin, login)(request({ action: 'signin', username: 'alex', password: 'test12345' }));
    expect(rpc.mock.calls.filter(([fn]) => fn === 'public_name_allowed')).toHaveLength(0);
  });
});
