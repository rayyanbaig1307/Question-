import type { Session } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

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
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

// Keeps track of who is logged in, and their profile, for the whole app.
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    supabase.auth
      .getSession()
      .then(({ data }) => setSession(data.session))
      .finally(() => setInitializing(false));

    const { data } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => data.subscription.unsubscribe();
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

  const signOut = useCallback(async () => {
    // Stop sending this account's notifications to this phone.
    await unregisterPush().catch(() => {});
    await supabase.auth.signOut();
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
