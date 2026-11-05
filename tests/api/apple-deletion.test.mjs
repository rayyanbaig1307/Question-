import { afterEach, expect, it, vi } from 'vitest';
import { loadEdge, query, request } from './edgeHarness.mjs';
afterEach(() => vi.useRealTimers());
const idToken = (sub) => `test.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.test`;
function appleService(sub = 'apple-A') {
  const deleteUser = vi.fn(async () => ({ error: null }));
  const remove = vi.fn(async () => ({ data: [], error: null }));
  const admin = {
    auth: { getUser: async () => ({ data: { user: { id: 'user-A', identities: [{ provider: 'apple', id: 'apple-A', identity_data: { sub: 'apple-A' } }], app_metadata: { provider: 'apple' } } }, error: null }), admin: { deleteUser } },
    from: () => query({ data: [], error: null }),
    rpc: () => query({ data: [], error: null }),
    storage: { from: () => ({ list: async () => ({ data: [], error: null }), remove }) },
  };
  const fetch = vi.fn(async (url) => url.endsWith('/token')
    ? new Response(JSON.stringify({ refresh_token: 'test-refresh-token', id_token: idToken(sub) }), { status: 200 })
    : new Response('', { status: 200 }));
  const options = { fetch, env: { APPLE_KEY_ID: 'test-key-id', APPLE_PRIVATE_KEY: 'test-private-key' } };
  return { admin, options, fetch, deleteUser, remove };
}

it('deleting account A cannot revoke a code belonging to Apple identity B', async () => {
  const { admin, options, fetch, deleteUser } = appleService('apple-B');
  const response = await loadEdge('delete-account', admin, undefined, options)(request({ apple_code: 'code-for-B' }, { token: 'valid-A' }));
  // B's Apple login is never cancelled: only the code swap reaches Apple, never /revoke.
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe('https://appleid.apple.com/auth/token');
  // The Apple step is skipped, not a hard stop (a real owner on a phone with another Apple ID must
  // still be able to delete). Only the verified caller A is ever deleted.
  expect(response.status).toBe(200);
  expect(deleteUser).toHaveBeenCalledExactlyOnceWith('user-A');
});

it('a matching Apple code is revoked without trusting a subject supplied in the body', async () => {
  const { admin, options, fetch, deleteUser } = appleService();
  const response = await loadEdge('delete-account', admin, undefined, options)(request({ apple_code: 'code-for-A', sub: 'apple-B', userId: 'user-B' }, { token: 'valid-A' }));
  expect(response.status).toBe(200);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1][0]).toBe('https://appleid.apple.com/auth/revoke');
  expect(deleteUser).toHaveBeenCalledExactlyOnceWith('user-A');
});

it('a password-only user cannot submit another Apple account’s code for revocation', async () => {
  const { admin, options, fetch, deleteUser } = appleService();
  admin.auth.getUser = async () => ({ data: { user: { id: 'password-user', identities: [{ provider: 'email' }], app_metadata: { provider: 'email' } } }, error: null });
  const response = await loadEdge('delete-account', admin, undefined, options)(request({ apple_code: 'someone-elses-code' }, { token: 'valid' }));
  // The code never reaches Apple (no swap, no revoke). Like every other Apple problem, this only skips
  // the Apple step: the verified caller's own account is still deleted, and nobody else's.
  expect(fetch).not.toHaveBeenCalled();
  expect(response.status).toBe(200);
  expect(deleteUser).toHaveBeenCalledExactlyOnceWith('password-user');
});

it('an Apple network stall has a deadline and does not prevent deleting the caller’s account forever', async () => {
  vi.useFakeTimers();
  const { admin, options, deleteUser } = appleService();
  options.fetch = (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('Aborted'))));
  const pending = loadEdge('delete-account', admin, undefined, options)(request({ apple_code: 'test-code' }, { token: 'valid' }));
  await vi.advanceTimersByTimeAsync(10_000);
  expect((await pending).status).toBe(200);
  expect(deleteUser).toHaveBeenCalledExactlyOnceWith('user-A');
});

it('a huge Apple code is rejected before any external or destructive request', async () => {
  const { admin, options, fetch, deleteUser } = appleService();
  const response = await loadEdge('delete-account', admin, undefined, options)(request({ apple_code: 'a'.repeat(100_000) }, { token: 'valid-A' }));
  expect(response.status).toBe(413);
  expect(fetch).not.toHaveBeenCalled();
  expect(deleteUser).not.toHaveBeenCalled();
});

it('an expected-account mismatch stops before contacting Apple or opening deletion scope', async () => {
  const { admin, options, fetch, deleteUser } = appleService();
  admin.rpc = vi.fn(() => query({ data: [], error: null }));
  const response = await loadEdge('delete-account', admin, undefined, options)(request({ expected_user_id: 'old-account', apple_code: 'valid-code' }, { token: 'valid' }));
  expect(response.status).toBe(409);
  expect(fetch).not.toHaveBeenCalled();
  expect(admin.rpc).not.toHaveBeenCalled();
  expect(deleteUser).not.toHaveBeenCalled();
});

it.each([null, 123, {}, []])('an expected account of the wrong type is rejected before side effects', async (expected_user_id) => {
  const { admin, options, fetch, deleteUser } = appleService();
  admin.rpc = vi.fn(() => query({ data: [], error: null }));
  const response = await loadEdge('delete-account', admin, undefined, options)(request({ expected_user_id }, { token: 'valid' }));
  expect(response.status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
  expect(admin.rpc).not.toHaveBeenCalled();
  expect(deleteUser).not.toHaveBeenCalled();
});
