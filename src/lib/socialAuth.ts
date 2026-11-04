import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Crypto from 'expo-crypto';
import { requireOptionalNativeModule } from 'expo';
import { Platform, TurboModuleRegistry } from 'react-native';

import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// New accounts are made with "Sign in with Apple" (iPhone) or "Sign in with Google" (Android). Apple and
// Google have already checked the person is real, so there's no password and no confirmation email.
// Older accounts still log in with their username or email and password (sign-in.tsx).
//
// Both need native parts that only the newest Peekaboo download has. Expo Go and older downloads don't,
// so the buttons are simply hidden there.
// ---------------------------------------------------------------------------

// The "Web client ID" from Google Cloud (APIs & Services → Credentials). It's not a secret: it is built into
// every copy of the app. The same ID goes in Supabase → Authentication → Sign In / Providers → Google.
const GOOGLE_WEB_CLIENT_ID =
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ||
  '687778288055-dt3jvvbqbtstek2im0ceoc1tav1g78i6.apps.googleusercontent.com';

const inExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

// Asking first, because these libraries crash if they're loaded without their native parts.
export const Apple: typeof import('expo-apple-authentication') | null =
  Platform.OS === 'ios' && !inExpoGo && requireOptionalNativeModule('ExpoAppleAuthentication')
    ? // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('expo-apple-authentication')
    : null;

const Google: typeof import('@react-native-google-signin/google-signin') | null =
  Platform.OS === 'android' && !inExpoGo && GOOGLE_WEB_CLIENT_ID && TurboModuleRegistry.get('RNGoogleSignin')
    ? // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@react-native-google-signin/google-signin')
    : null;

export const APPLE_SIGN_IN_AVAILABLE = Apple !== null;
export const GOOGLE_SIGN_IN_AVAILABLE = Google !== null;

// Closing the Apple or Google window isn't an error – nothing happens.
export class SignInCancelled extends Error {
  constructor() {
    super('Sign in cancelled');
  }
}

// Apple's sign-in window. The "nonce" is a one-time code that proves the login was made just now, for this
// app: Apple gets a scrambled copy, Supabase gets the original and checks they match.
async function askApple() {
  if (!Apple) throw new Error('Sign in with Apple needs the newest Peekaboo download.');
  const nonce = Crypto.randomUUID();
  const hashedNonce = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, nonce);
  try {
    const credential = await Apple.signInAsync({
      requestedScopes: [Apple.AppleAuthenticationScope.FULL_NAME, Apple.AppleAuthenticationScope.EMAIL],
      nonce: hashedNonce,
    });
    return { credential, nonce };
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_REQUEST_CANCELED') throw new SignInCancelled();
    throw error;
  }
}

// The name Apple or Google shared at sign-in. Apple only shares it the very first time, so the setup screen
// (components/ProfileSetup.tsx) uses it to fill in "Your name".
export let sharedName: string | null = null;

// Sign in (or sign up – it's the same thing) with Apple.
export async function signInWithApple(): Promise<void> {
  const { credential, nonce } = await askApple();
  if (!credential.identityToken) throw new Error('Apple did not send a login. Please try again.');
  const { error } = await supabase.auth.signInWithIdToken({
    provider: 'apple',
    token: credential.identityToken,
    nonce,
  });
  if (error) throw error;
  const name = [credential.fullName?.givenName, credential.fullName?.familyName].filter(Boolean).join(' ').trim();
  if (name) sharedName = name;
}

// Deleting an account that was made with Apple: Apple asks us to disconnect Peekaboo from the person's Apple
// ID too. That needs a fresh "yes" from Apple (Face ID), which gives a one-time code for the server.
export async function appleCodeForDeleting(): Promise<string | null> {
  if (!Apple) return null;
  const { credential } = await askApple();
  return credential.authorizationCode ?? null;
}

// Sign in (or sign up) with Google, on Android.
export async function signInWithGoogle(): Promise<void> {
  if (!Google) throw new Error('Sign in with Google needs the newest Peekaboo download.');
  const { GoogleSignin, isSuccessResponse } = Google;
  GoogleSignin.configure({ webClientId: GOOGLE_WEB_CLIENT_ID });
  await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  // Always show the account picker, so people with two Google accounts can choose.
  await GoogleSignin.signOut().catch(() => {});
  const response = await GoogleSignin.signIn();
  if (!isSuccessResponse(response)) throw new SignInCancelled();
  const idToken = response.data.idToken;
  if (!idToken) throw new Error('Google did not send a login. Please try again.');
  const { error } = await supabase.auth.signInWithIdToken({ provider: 'google', token: idToken });
  if (error) throw error;
  sharedName = response.data.user.name ?? null;
}

// Was this account made with Apple or Google (rather than a username or email)?
export function madeWithAppleOrGoogle(provider: unknown): boolean {
  return provider === 'apple' || provider === 'google';
}
