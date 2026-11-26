import { FunctionsHttpError } from '@supabase/supabase-js';

import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// Log in with your username and password (older accounts, including ones made with just a username).
// The "username-auth" server helper (supabase/functions/username-auth) does the checking and hands back a login.
// It no longer makes new accounts (26 Nov 2026): those are made with Apple or Google (lib/socialAuth.ts).
// ---------------------------------------------------------------------------

type Login = { access_token: string; refresh_token: string };

async function call(body: Record<string, string>): Promise<void> {
  const { data, error } = await supabase.functions.invoke<{ session?: Login; error?: string }>('username-auth', {
    method: 'POST',
    body,
  });
  if (error) {
    // The helper explains what went wrong ("Wrong username or password", "Lots of login tries…").
    const reply = error instanceof FunctionsHttpError ? await error.context.json().catch(() => null) : null;
    throw new Error(reply?.error ?? error.message);
  }
  if (!data?.session) throw new Error(data?.error ?? 'Something went wrong – try again');
  // Logged in: the app switches to the camera by itself.
  const { error: sessionError } = await supabase.auth.setSession(data.session);
  if (sessionError) throw sessionError;
}

export function logInWithUsername(username: string, password: string) {
  return call({ action: 'signin', username: username.replace(/^@/, '').toLowerCase(), password });
}
