import { expect, it, vi } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

function appleHarness(credentials) {
  const appleSignIn = vi.fn(async () => credentials.shift());
  const signIn = vi.fn(async () => ({ error: null }));
  const lib = loadLibrary('socialAuth', {
    supabase: { auth: { signInWithIdToken: signIn } },
    mocks: {
      'expo-constants': { __esModule: true, default: { executionEnvironment: 'standalone' }, ExecutionEnvironment: { StoreClient: 'store-client' } },
      'react-native': { Platform: { OS: 'ios' }, TurboModuleRegistry: { get: () => null } },
      expo: { requireOptionalNativeModule: () => ({}) },
      'expo-crypto': { randomUUID: () => 'one-time-nonce', CryptoDigestAlgorithm: { SHA256: 'sha256' }, digestStringAsync: async (_kind, nonce) => `hashed:${nonce}` },
      'expo-apple-authentication': { signInAsync: appleSignIn, AppleAuthenticationScope: { FULL_NAME: 'name', EMAIL: 'email' } },
    },
  });
  return { lib, appleSignIn, signIn };
}

it('the social setup name is available when Apple sign-in opens the authenticated app', async () => {
  const { lib, signIn } = appleHarness([{ identityToken: 'apple-id-token', fullName: { givenName: 'Alice', familyName: 'Example' } }]);
  let nameWhenSessionOpens;
  signIn.mockImplementation(async () => { nameWhenSessionOpens = lib.sharedName; return { error: null }; });
  await lib.signInWithApple();
  expect(nameWhenSessionOpens).toBe('Alice Example');
});

it('a second Apple account without a shared name never inherits the previous user’s name', async () => {
  const { lib } = appleHarness([
    { identityToken: 'apple-A', fullName: { givenName: 'Private Alice' } },
    { identityToken: 'apple-B', fullName: null },
  ]);
  await lib.signInWithApple();
  await lib.signInWithApple();
  expect(lib.sharedName).toBeNull();
});

it('Apple receives only the nonce hash and Supabase receives the original nonce', async () => {
  const { lib, appleSignIn, signIn } = appleHarness([{ identityToken: 'apple-token', fullName: null }]);
  await lib.signInWithApple();
  expect(appleSignIn.mock.calls[0][0].nonce).toBe('hashed:one-time-nonce');
  expect(signIn).toHaveBeenCalledExactlyOnceWith({ provider: 'apple', token: 'apple-token', nonce: 'one-time-nonce' });
});

it('an Apple reply without an identity token never reaches Supabase auth', async () => {
  const { lib, signIn } = appleHarness([{ identityToken: null, fullName: null }]);
  await expect(lib.signInWithApple()).rejects.toThrow('Apple did not send a login');
  expect(signIn).not.toHaveBeenCalled();
});

it('Apple cancellation is distinguishable from a service failure', async () => {
  const { lib, appleSignIn, signIn } = appleHarness([]);
  appleSignIn.mockRejectedValue({ code: 'ERR_REQUEST_CANCELED' });
  await expect(lib.signInWithApple()).rejects.toBeInstanceOf(lib.SignInCancelled);
  expect(signIn).not.toHaveBeenCalled();
});

it('Expo Go safely hides unavailable native sign-in providers', async () => {
  const lib = loadLibrary('socialAuth');
  expect(lib.APPLE_SIGN_IN_AVAILABLE).toBe(false);
  expect(lib.GOOGLE_SIGN_IN_AVAILABLE).toBe(false);
  await expect(lib.signInWithApple()).rejects.toThrow('newest Peekaboo download');
  await expect(lib.signInWithGoogle()).rejects.toThrow('newest Peekaboo download');
});

it('Google sets the setup name before its auth event can open the app', async () => {
  let lib, nameWhenSessionOpens;
  const signIn = vi.fn(async () => { nameWhenSessionOpens = lib.sharedName; return { error: null }; });
  lib = loadLibrary('socialAuth', {
    supabase: { auth: { signInWithIdToken: signIn } },
    mocks: {
      'expo-constants': { __esModule: true, default: { executionEnvironment: 'standalone' }, ExecutionEnvironment: { StoreClient: 'store-client' } },
      'react-native': { Platform: { OS: 'android' }, TurboModuleRegistry: { get: () => ({}) } },
      '@react-native-google-signin/google-signin': {
        isSuccessResponse: () => true,
        GoogleSignin: { configure() {}, hasPlayServices: async () => {}, signOut: async () => {}, signIn: async () => ({ data: { idToken: 'google-token', user: { name: 'Google Alice' } } }) },
      },
    },
  });
  await lib.signInWithGoogle();
  expect(nameWhenSessionOpens).toBe('Google Alice');
  expect(signIn).toHaveBeenCalledExactlyOnceWith({ provider: 'google', token: 'google-token' });
});

it('a failed provider login does not keep its name for another account', async () => {
  const { lib, signIn } = appleHarness([{ identityToken: 'apple-token', fullName: { givenName: 'Private Alice' } }]);
  signIn.mockResolvedValue({ error: new Error('Auth is unavailable') });
  await expect(lib.signInWithApple()).rejects.toThrow('Auth is unavailable');
  expect(lib.sharedName).toBeNull();
});
