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
  refreshProfile: () => Promise<void>;
  setProfile: (profile: Profile) => void;
  signOut: (expectedUserId?: string) => Promise<void>;
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
    if (!userId) return;
    try {
      setProfile(await fetchProfile(userId));
    } catch (error) {
      console.warn('Could not load your profile', error);
    }
  }, [userId]);

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
    if (error) throw error;
    // A newer login event must not be overwritten by this older operation finishing.
    if (sessionUser.current !== null && sessionUser.current !== target) return;
    sessionUser.current = null;
    setSession(null);
    setProfile(null);
  }, []);

  // Never show the previous person's profile after switching accounts.
  const currentProfile = profile && profile.id === userId ? profile : null;

  return (
    <AuthContext.Provider
      value={{ session, userId, profile: currentProfile, initializing, refreshProfile, setProfile, signOut }}>
      {children}
    </AuthContext.Provider>
  );
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
