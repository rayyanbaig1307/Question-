import { FunctionsHttpError } from '@supabase/supabase-js';

import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// Accounts without an email: sign up with just a username and password, and log in with your username.
// The "username-auth" server helper (supabase/functions/username-auth) does the checking and hands back a login.
// Without an email there's no way to reset a forgotten password – the sign-up screen says so.
// ---------------------------------------------------------------------------

type Login = { access_token: string; refresh_token: string };

async function call(body: Record<string, string>): Promise<void> {
  const { data, error } = await supabase.functions.invoke<{ session?: Login; error?: string }>('username-auth', {
    method: 'POST',
    body,
  });
  if (error) {
    // The helper explains what went wrong ("Wrong username or password", "That username is already taken"…).
    const reply = error instanceof FunctionsHttpError ? await error.context.json().catch(() => null) : null;
    throw new Error(reply?.error ?? error.message);
  }
  if (!data?.session) throw new Error(data?.error ?? 'Something went wrong – try again');
  // Logged in: the app switches to the camera by itself.
  const { error: sessionError } = await supabase.auth.setSession(data.session);
  if (sessionError) throw sessionError;
}

export function signUpWithUsername(username: string, password: string, displayName: string, termsVersion: string) {
  return call({ action: 'signup', username, password, display_name: displayName, terms_version: termsVersion });
}

export function logInWithUsername(username: string, password: string) {
  return call({ action: 'signin', username: username.replace(/^@/, '').toLowerCase(), password });
}
