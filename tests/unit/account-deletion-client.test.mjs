import { expect, it, vi } from 'vitest';
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
