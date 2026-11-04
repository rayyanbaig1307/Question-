import { expect, it, vi } from 'vitest';
import { FunctionsClient } from '@supabase/functions-js';
import { loadLibrary } from './libHarness.mjs';
class Cancelled extends Error {}
function client(user) {
  const apple = vi.fn(async () => 'test-apple-code');
  const invoke = vi.fn(async () => ({ data: { deleted: true }, error: null }));
  const getSession = vi.fn(async () => ({ data: { session: user ? { user: { id: 'A', ...user } } : null }, error: null }));
  const lib = loadLibrary('profiles', {
    supabase: { auth: { getSession }, functions: { invoke } },
    mocks: { './socialAuth': { appleCodeForDeleting: apple, SignInCancelled: Cancelled } },
  });
  return { lib, apple, invoke, getSession };
}

it('a cancelled Apple deletion confirmation never reaches the delete server', async () => {
  const { lib, apple, invoke } = client({ app_metadata: { provider: 'apple' } });
  apple.mockRejectedValue(new Cancelled());
  await expect(lib.deleteMyAccount()).rejects.toThrow('confirm it with Apple first');
  expect(invoke).not.toHaveBeenCalled();
});

it('Apple confirmation is sent for linked Apple accounts as well as the primary provider', async () => {
  const { lib, apple, invoke } = client({ app_metadata: { provider: 'email' }, identities: [{ provider: 'email' }, { provider: 'apple' }] });
  await lib.deleteMyAccount();
  expect(apple).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith('delete-account', { method: 'POST', body: { expected_user_id: 'A', apple_code: 'test-apple-code' } });
});

it('an unavailable saved session stops deletion before the destructive request', async () => {
  const { lib, invoke, getSession } = client(null);
  getSession.mockResolvedValue({ data: { session: null }, error: { message: 'Could not read the login' } });
  await expect(lib.deleteMyAccount()).rejects.toMatchObject({ message: 'Could not read the login' });
  expect(invoke).not.toHaveBeenCalled();
});

it('a logged-out client cannot submit a deletion request', async () => {
  const { lib, invoke } = client(null);
  await expect(lib.deleteMyAccount()).rejects.toThrow('Please log in again');
  expect(invoke).not.toHaveBeenCalled();
});

it('a stale deletion confirmation for A cannot delete the newly logged-in B', async () => {
  const { lib, invoke } = client({ id: 'B', app_metadata: { provider: 'email' } });
  await expect(lib.deleteMyAccount('A')).rejects.toThrow('signed-in account changed');
  expect(invoke).not.toHaveBeenCalled();
});

it('changing accounts during Apple confirmation stops deletion before invoking the server', async () => {
  const { lib, apple, getSession, invoke } = client({ id: 'A', app_metadata: { provider: 'apple' } });
  apple.mockImplementation(async () => {
    getSession.mockResolvedValue({ data: { session: { user: { id: 'B' } } }, error: null });
    return 'test-code';
  });
  await expect(lib.deleteMyAccount('A')).rejects.toThrow('signed-in account changed');
  expect(invoke).not.toHaveBeenCalled();
});

// The server's own reasons (409 / 503 ...) must reach the person. These use the real supabase
// functions client, so the error looks exactly like it does in the app (data is null, the reply
// is kept on error.context).
function realInvoke(reply) {
  const functions = new FunctionsClient('http://127.0.0.1/functions/v1', { customFetch: async () => reply() });
  return (name, options) => functions.invoke(name, options);
}
const jsonReply = (status, body) => () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

it('a 409 from the delete server shows the server’s own words, not the library’s', async () => {
  const { lib, invoke } = client({ app_metadata: { provider: 'email' } });
  invoke.mockImplementation(realInvoke(jsonReply(409, { error: 'The signed-in account changed. Open Settings and try again.' })));
  await expect(lib.deleteMyAccount('A')).rejects.toThrow('The signed-in account changed. Open Settings and try again.');
  await expect(lib.deleteMyAccount('A')).rejects.not.toThrow('non-2xx');
});

it('a 503 from the delete server tells the person to try again', async () => {
  const { lib, invoke } = client({ app_metadata: { provider: 'email' } });
  invoke.mockImplementation(realInvoke(jsonReply(503, { error: 'Could not finish deleting your account. Please try again.' })));
  await expect(lib.deleteMyAccount('A')).rejects.toThrow('Could not finish deleting your account. Please try again.');
});

it('an error reply that is not JSON falls back to a plain, friendly message', async () => {
  const { lib, invoke } = client({ app_metadata: { provider: 'email' } });
  invoke.mockImplementation(realInvoke(() => new Response('<html>Bad gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } })));
  const error = await lib.deleteMyAccount('A').catch((e) => e);
  expect(error.message).toBe('Could not delete your account. Please try again.');
});

it('an error reply with no message text falls back to a plain, friendly message', async () => {
  const { lib, invoke } = client({ app_metadata: { provider: 'email' } });
  invoke.mockImplementation(realInvoke(jsonReply(500, { error: { code: 42 } })));
  const error = await lib.deleteMyAccount('A').catch((e) => e);
  expect(error.message).toBe('Could not delete your account. Please try again.');
});

it('no connection to the delete server gives a plain connection message', async () => {
  const { lib, invoke } = client({ app_metadata: { provider: 'email' } });
  invoke.mockImplementation(realInvoke(() => { throw new TypeError('Network request failed'); }));
  const error = await lib.deleteMyAccount('A').catch((e) => e);
  expect(error.message).not.toContain('Edge Function');
  expect(error.message).toMatch(/connection/i);
});

it('a successful reply through the real client still counts as deleted', async () => {
  const { lib, invoke } = client({ app_metadata: { provider: 'email' } });
  invoke.mockImplementation(realInvoke(jsonReply(200, { deleted: true })));
  await expect(lib.deleteMyAccount('A')).resolves.toBeUndefined();
});
