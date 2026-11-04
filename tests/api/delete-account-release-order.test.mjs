import { expect, it, vi } from 'vitest';
import { loadEdge, query, request } from './edgeHarness.mjs';

// Release order safety for the delete-account Edge Function (review finding COMPAT-1).
// The safest release step is to deploy this new function just BEFORE the database migrations.
// Until the migrations run, public.begin_account_media_deletion does not exist yet, so the function
// must stop with "try again" and change nothing at all: no files, no login, and no Apple disconnect.
// (The old live function, run against the new database, would instead leave the photo files behind.)

const idToken = (sub) => `test.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.test`;
const missingFunction = {
  code: 'PGRST202',
  message: 'Could not find the function public.begin_account_media_deletion(account) in the schema cache',
};

function service({ rpcReply = () => ({ data: [], error: null }) } = {}) {
  const steps = [];
  const deleteUser = vi.fn(async (id) => { steps.push(`deleteUser:${id}`); return { error: null }; });
  const remove = vi.fn(async () => { steps.push('remove'); return { data: [], error: null }; });
  const list = vi.fn(async (prefix) => { steps.push(`list:${prefix}`); return { data: [], error: null }; });
  const rpc = vi.fn((name) => { steps.push(`rpc:${name}`); return query(rpcReply(name)); });
  const admin = {
    auth: {
      getUser: async () => ({
        data: { user: { id: 'user-A', identities: [{ provider: 'apple', id: 'apple-A', identity_data: { sub: 'apple-A' } }], app_metadata: { provider: 'apple' } } },
        error: null,
      }),
      admin: { deleteUser },
    },
    from: () => query({ data: [], error: null }),
    rpc,
    storage: { from: () => ({ list, remove }) },
  };
  const fetch = vi.fn(async (url) => {
    steps.push(`apple:${String(url).split('/').pop()}`);
    return String(url).endsWith('/token')
      ? new Response(JSON.stringify({ refresh_token: 'rt-A', id_token: idToken('apple-A') }), { status: 200 })
      : new Response('', { status: 200 });
  });
  const handler = loadEdge('delete-account', admin, undefined, {
    fetch, env: { APPLE_KEY_ID: 'test-key-id', APPLE_PRIVATE_KEY: 'test-private-key' },
  });
  return { handler, fetch, deleteUser, remove, list, rpc, steps };
}

it('deployed before the database update, it changes nothing – not even the Apple link', async () => {
  const { handler, fetch, deleteUser, remove, list } = service({
    rpcReply: (name) => (name === 'begin_account_media_deletion' ? { data: null, error: missingFunction } : { data: [], error: null }),
  });
  const response = await handler(request({ expected_user_id: 'user-A', apple_code: 'one-time-apple-code' }, { token: 'valid-A' }));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'Could not finish deleting your account. Please try again.' });
  // The account is not deleted, so its Apple link must stay connected too.
  expect(fetch).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(deleteUser).not.toHaveBeenCalled();
});

it('does not disconnect Apple when the anonymous file list cannot be loaded', async () => {
  const { handler, fetch, deleteUser, remove } = service({
    rpcReply: (name) => (name === 'account_mystery_files' ? { data: null, error: { message: 'storage metadata offline' } } : { data: [], error: null }),
  });
  const response = await handler(request({ expected_user_id: 'user-A', apple_code: 'one-time-apple-code' }, { token: 'valid-A' }));
  expect(response.status).toBe(503);
  expect(fetch).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(deleteUser).not.toHaveBeenCalled();
});

it('on the new database it opens the deletion first, then disconnects Apple, then removes files and the login', async () => {
  const { handler, fetch, deleteUser, steps } = service();
  const response = await handler(request({ expected_user_id: 'user-A', apple_code: 'one-time-apple-code' }, { token: 'valid-A' }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ deleted: true });
  // The matching Apple login is still cancelled, exactly as before.
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    'https://appleid.apple.com/auth/token', 'https://appleid.apple.com/auth/revoke',
  ]);
  expect(deleteUser).toHaveBeenCalledExactlyOnceWith('user-A');
  const at = (step) => steps.indexOf(step);
  expect(at('rpc:begin_account_media_deletion')).toBeGreaterThanOrEqual(0);
  expect(at('rpc:begin_account_media_deletion')).toBeLessThan(at('apple:token'));
  expect(at('rpc:account_mystery_files')).toBeLessThan(at('apple:token'));
  expect(at('apple:revoke')).toBeLessThan(at('list:user-A'));
  expect(at('apple:revoke')).toBeLessThan(at('deleteUser:user-A'));
});
