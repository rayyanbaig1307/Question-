import { expect, it, vi } from 'vitest';
import { loadEdge, query, request } from './edgeHarness.mjs';

// Review follow-up for the delete-account Edge Function (Apple subject check).
// A phone can only make an Apple code for the Apple ID it is signed into. If that is not the Apple ID
// linked to the Peekaboo account, the real owner must still be able to delete their account –
// we just skip the Apple disconnect, and never cancel anyone's Apple login.

const idToken = (sub) => `test.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.test`;

function service({ identities, provider = 'email', tokenReply, userId = 'user-A' }) {
  const deleteUser = vi.fn(async () => ({ error: null }));
  const remove = vi.fn(async () => ({ data: [], error: null }));
  const rpc = vi.fn((name) => query({ data: name === 'account_mystery_files' ? [{ path: 'mystery/a-file.jpg' }] : [], error: null }));
  const admin = {
    auth: {
      getUser: async () => ({ data: { user: { id: userId, identities, app_metadata: { provider } } }, error: null }),
      admin: { deleteUser },
    },
    from: () => query({ data: [], error: null }),
    rpc,
    storage: { from: () => ({ list: async () => ({ data: [], error: null }), remove }) },
  };
  const fetch = vi.fn(async (url) => url.endsWith('/token')
    ? new Response(JSON.stringify(tokenReply), { status: 200 })
    : new Response('', { status: 200 }));
  const handler = loadEdge('delete-account', admin, undefined, {
    fetch, env: { APPLE_KEY_ID: 'test-key-id', APPLE_PRIVATE_KEY: 'test-private-key' },
  });
  return { handler, fetch, deleteUser, remove, rpc };
}

const linkedApple = [{ provider: 'email', id: 'user-A' }, { provider: 'apple', id: 'apple-X', identity_data: { sub: 'apple-X' } }];
const revokeCalls = (fetch) => fetch.mock.calls.filter(([url]) => String(url).endsWith('/revoke'));

it('a real owner whose iPhone uses a different Apple ID can still delete their account', async () => {
  const { handler, fetch, deleteUser, remove, rpc } = service({
    identities: linkedApple, tokenReply: { refresh_token: 'rt-for-Z', id_token: idToken('apple-Z') },
  });
  const response = await handler(request({ expected_user_id: 'user-A', apple_code: 'code-from-this-iphone' }, { token: 'valid-A' }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ deleted: true });
  // Only the code swap was sent to Apple – no Apple login (X or Z) was cancelled.
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe('https://appleid.apple.com/auth/token');
  expect(revokeCalls(fetch)).toHaveLength(0);
  // The verified caller's files and login were removed.
  expect(rpc).toHaveBeenCalledWith('begin_account_media_deletion', { account: 'user-A' });
  expect(remove).toHaveBeenCalledWith(['mystery/a-file.jpg']);
  expect(deleteUser).toHaveBeenCalledExactlyOnceWith('user-A');
});

// A first try can fail after the Apple step (a storage or login hiccup). Asking again with a new Apple
// code from the same iPhone must then work – the Apple ID mismatch must never block the second try.
it.each([
  ['the file removal', 0, (svc) => svc.remove.mockResolvedValueOnce({ data: null, error: { message: 'storage is down' } })],
  ['the login removal', 1, (svc) => svc.deleteUser.mockResolvedValueOnce({ error: { message: 'auth is down' } })],
])('retrying from the same iPhone keeps working (no permanent block) after %s failed', async (_step, loginRemovalsOnFirstTry, breakOnce) => {
  const svc = service({
    identities: linkedApple, tokenReply: { refresh_token: 'rt-for-Z', id_token: idToken('apple-Z') },
  });
  breakOnce(svc);
  const { handler, fetch, deleteUser } = svc;

  const first = await handler(request({ expected_user_id: 'user-A', apple_code: 'code-1' }, { token: 'valid-A' }));
  expect(first.status).toBe(503);
  expect(await first.json()).toEqual({ error: 'Could not finish deleting your account. Please try again.' });
  expect(deleteUser).toHaveBeenCalledTimes(loginRemovalsOnFirstTry);

  const second = await handler(request({ expected_user_id: 'user-A', apple_code: 'code-2' }, { token: 'valid-A' }));
  expect(second.status).toBe(200);
  expect(await second.json()).toEqual({ deleted: true });
  expect(deleteUser).toHaveBeenCalledTimes(loginRemovalsOnFirstTry + 1);
  expect(deleteUser).toHaveBeenLastCalledWith('user-A');
  // Each try swapped its own new code with Apple, and nobody's Apple login was cancelled.
  const codes = fetch.mock.calls.filter(([url]) => String(url).endsWith('/token'))
    .map(([, init]) => new URLSearchParams(init.body).get('code'));
  expect(codes).toEqual(['code-1', 'code-2']);
  expect(revokeCalls(fetch)).toHaveLength(0);
});

it('an Apple-first account on a phone with another Apple ID is deleted without cancelling any Apple login', async () => {
  const { handler, fetch, deleteUser } = service({
    identities: [{ provider: 'apple', id: 'apple-X', identity_data: { sub: 'apple-X' } }],
    provider: 'apple',
    tokenReply: { access_token: 'at-for-Z', id_token: idToken('apple-Z') },
  });
  const response = await handler(request({ expected_user_id: 'user-A', apple_code: 'code-for-Z' }, { token: 'valid-A' }));
  expect(response.status).toBe(200);
  expect(revokeCalls(fetch)).toHaveLength(0);
  expect(deleteUser).toHaveBeenCalledExactlyOnceWith('user-A');
});

it('an Apple reply without an id_token is never revoked, and the caller is still deleted', async () => {
  const { handler, fetch, deleteUser } = service({ identities: linkedApple, tokenReply: { refresh_token: 'rt-unknown' } });
  const response = await handler(request({ expected_user_id: 'user-A', apple_code: 'code' }, { token: 'valid-A' }));
  expect(response.status).toBe(200);
  expect(revokeCalls(fetch)).toHaveLength(0);
  expect(deleteUser).toHaveBeenCalledExactlyOnceWith('user-A');
});

it('a code for someone else plus a forged subject in the body still never revokes them and only deletes the caller', async () => {
  const { handler, fetch, deleteUser } = service({
    identities: linkedApple, tokenReply: { refresh_token: 'rt-for-B', id_token: idToken('apple-B') },
  });
  const response = await handler(request({ expected_user_id: 'user-A', apple_code: 'code-for-B', sub: 'apple-B', userId: 'user-B' }, { token: 'valid-A' }));
  expect(response.status).toBe(200);
  expect(revokeCalls(fetch)).toHaveLength(0);
  expect(deleteUser).toHaveBeenCalledExactlyOnceWith('user-A');
  expect(deleteUser).not.toHaveBeenCalledWith('user-B');
});

it('a matching Apple ID on the phone is still disconnected from Peekaboo', async () => {
  const { handler, fetch, deleteUser } = service({
    identities: linkedApple, tokenReply: { refresh_token: 'rt-for-X', id_token: idToken('apple-X') },
  });
  const response = await handler(request({ expected_user_id: 'user-A', apple_code: 'code-for-X' }, { token: 'valid-A' }));
  expect(response.status).toBe(200);
  expect(revokeCalls(fetch)).toHaveLength(1);
  expect(new URLSearchParams(revokeCalls(fetch)[0][1].body).get('token')).toBe('rt-for-X');
  expect(deleteUser).toHaveBeenCalledExactlyOnceWith('user-A');
});

// Apple's reply must carry its Apple ID as plain text. Anything else (a number, a list, an object) is
// treated as "not your Apple ID": we skip the Apple step and still delete the caller.
it.each([
  ['a list', ['apple-X']],
  ['a number', 12345],
  ['an object', { id: 'apple-X' }],
  ['empty text', ''],
])('an Apple subject given as %s is never revoked, and the caller is still deleted', async (_kind, sub) => {
  const { handler, fetch, deleteUser } = service({
    identities: [...linkedApple, { provider: 'apple', id: 'apple-num', identity_data: { sub: '12345' } }],
    tokenReply: { refresh_token: 'rt-odd', id_token: idToken(sub) },
  });
  const response = await handler(request({ expected_user_id: 'user-A', apple_code: 'code' }, { token: 'valid-A' }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ deleted: true });
  expect(revokeCalls(fetch)).toHaveLength(0);
  expect(deleteUser).toHaveBeenCalledExactlyOnceWith('user-A');
});

it('an Apple code from an account with no Apple login is skipped, never sent to Apple, and the account is still deleted', async () => {
  const { handler, fetch, deleteUser, rpc } = service({
    identities: [{ provider: 'email', id: 'user-A' }],
    provider: 'apple', // the app thinks this is an Apple account, but no Apple login is linked any more
    tokenReply: { refresh_token: 'rt-for-B', id_token: idToken('apple-B') },
  });
  const response = await handler(request({ expected_user_id: 'user-A', apple_code: 'someone-elses-code' }, { token: 'valid-A' }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ deleted: true });
  expect(fetch).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenCalledWith('begin_account_media_deletion', { account: 'user-A' });
  expect(deleteUser).toHaveBeenCalledExactlyOnceWith('user-A');
});

it('an Apple login saved with an empty Apple ID falls back to its identity id', async () => {
  const { handler, fetch, deleteUser } = service({
    identities: [{ provider: 'apple', id: 'apple-X', identity_data: { sub: '' } }],
    provider: 'apple',
    tokenReply: { refresh_token: 'rt-for-X', id_token: idToken('apple-X') },
  });
  const response = await handler(request({ expected_user_id: 'user-A', apple_code: 'code-for-X' }, { token: 'valid-A' }));
  expect(response.status).toBe(200);
  expect(revokeCalls(fetch)).toHaveLength(1);
  expect(new URLSearchParams(revokeCalls(fetch)[0][1].body).get('token')).toBe('rt-for-X');
  expect(deleteUser).toHaveBeenCalledExactlyOnceWith('user-A');
});

it('an empty Apple ID on the login never lets an empty subject from Apple match', async () => {
  const { handler, fetch, deleteUser } = service({
    identities: [{ provider: 'apple', id: '', identity_data: { sub: '' } }],
    provider: 'apple',
    tokenReply: { refresh_token: 'rt-empty', id_token: idToken('') },
  });
  const response = await handler(request({ expected_user_id: 'user-A', apple_code: 'code' }, { token: 'valid-A' }));
  expect(response.status).toBe(200);
  expect(fetch).not.toHaveBeenCalled();
  expect(revokeCalls(fetch)).toHaveLength(0);
  expect(deleteUser).toHaveBeenCalledExactlyOnceWith('user-A');
});
