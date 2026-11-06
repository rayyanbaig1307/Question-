import type { Session } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import { unregisterPush } from './notifications';
import { fetchProfile } from './profiles';
import { supabase } from './supabase';
import type { Profile } from './types';

type AuthContextValue = {
  session: Session | null;
  userId: string | null;
  profile: Profile | null;
  initializing: boolean;
  // Loads your profile again. Gives back what it loaded, or null if it couldn't.
  refreshProfile: () => Promise<Profile | null>;
  setProfile: (profile: Profile) => void;
  signOut: (expectedUserId?: string) => Promise<void>;
  // Who is logged in at this very moment (also works after the screen that asks has closed).
  currentUserId: () => string | null;
};

const AuthContext = createContext<AuthContextValue | null>(null);

// Keeps track of who is logged in, and their profile, for the whole app.
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [initializing, setInitializing] = useState(true);
  const sessionUser = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let authChanged = false;
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      authChanged = true;
      sessionUser.current = newSession?.user.id ?? null;
      if (!cancelled) setSession(newSession);
    });
    supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (error) throw error;
        // A logout or account change that happened while loading is newer than this saved login.
        if (!cancelled && !authChanged) {
          sessionUser.current = data.session?.user.id ?? null;
          setSession(data.session);
        }
      })
      .catch((error) => console.warn('Could not read your saved login', error))
      .finally(() => { if (!cancelled) setInitializing(false); });

    return () => { cancelled = true; listener.subscription.unsubscribe(); };
  }, []);

  const userId = session?.user.id ?? null;

  const refreshProfile = useCallback(async () => {
    if (!userId) return null;
    try {
      const loaded = await fetchProfile(userId);
      // Someone else may have logged in while this was loading: never show this profile for them.
      if (sessionUser.current === userId) setProfile(loaded);
      return loaded;
    } catch (error) {
      console.warn('Could not load your profile', error);
      return null;
    }
  }, [userId]);

  const currentUserId = useCallback(() => sessionUser.current, []);

  // Load the profile whenever someone logs in.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    fetchProfile(userId)
      .then((loaded) => {
        if (!cancelled) setProfile(loaded);
      })
      .catch((error) => console.warn('Could not load your profile', error));
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const signOut = useCallback(async (expectedUserId?: string) => {
    const target = expectedUserId ?? sessionUser.current;
    const checkAccount = async () => {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      if (!target || data.session?.user.id !== target || sessionUser.current !== target) {
        throw new Error('The signed-in account changed. Open Settings and try again.');
      }
    };
    await checkAccount();
    // Stop sending this account's notifications to this phone.
    await unregisterPush().catch(() => {});
    await checkAccount();
    const { error } = await supabase.auth.signOut();
    // If the server can't be reached, Supabase still removes the login from this phone (and then reports
    // the error). Only say "could not log out" when this account really is still logged in here.
    if (error && (await stillLoggedIn(target))) throw error;
    // A newer login event must not be overwritten by this older operation finishing.
    if (sessionUser.current !== null && sessionUser.current !== target) return;
    sessionUser.current = null;
    setSession(null);
    setProfile(null);
    // Let other parts of the app tidy up too (Peekaboo+ payments stop using this account on this phone).
    // A problem there never stops the logout.
    if (target) {
      afterSignOut.forEach((step) => {
        try {
          step(target);
        } catch (error) {
          console.warn('Could not tidy up after logging out', error);
        }
      });
    }
  }, []);

  // Never show the previous person's profile after switching accounts.
  const currentProfile = profile && profile.id === userId ? profile : null;

  return (
    <AuthContext.Provider
      value={{ session, userId, profile: currentProfile, initializing, refreshProfile, setProfile, signOut, currentUserId }}>
      {children}
    </AuthContext.Provider>
  );
}

// Things to do after someone logs out on this phone. lib/plus.ts adds one: RevenueCat (Peekaboo+ payments)
// logs out of that account too, so the next person's purchase can never go to them. It's added from there
// (instead of this file importing plus.ts), so the two files don't import each other.
const afterSignOut = new Set<(userId: string) => void>();

export function runAfterSignOut(step: (userId: string) => void): () => void {
  afterSignOut.add(step);
  return () => {
    afterSignOut.delete(step);
  };
}

// Is this account still logged in on the phone? If we can't even tell, we say yes (to be safe).
async function stillLoggedIn(userId: string | null): Promise<boolean> {
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) return true;
    return data.session?.user.id === userId;
  } catch {
    return true;
  }
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}

// For screens that only show up when logged in.
export function useMe(): { userId: string; profile: Profile | null } & AuthContextValue {
  const auth = useAuth();
  if (!auth.userId) throw new Error('useMe used while logged out');
  return { ...auth, userId: auth.userId };
}
