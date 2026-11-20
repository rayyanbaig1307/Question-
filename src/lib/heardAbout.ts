import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// "How did you hear about Peekaboo?" – one question for new accounts, right after sign-up.
// The answers are private: only the owner sees them (Supabase → Table Editor → heard_about).
// The server decides who's asked (new accounts that haven't answered): supabase/migrations/20261227000000_heard_about.sql.
// ---------------------------------------------------------------------------

export type HeardAboutSource = 'tiktok' | 'instagram' | 'snapchat' | 'youtube' | 'friend' | 'app_store' | 'google' | 'other';

export const HEARD_ABOUT_OPTIONS: { source: HeardAboutSource; emoji: string; label: string }[] = [
  { source: 'friend', emoji: '👯', label: 'A friend' },
  { source: 'tiktok', emoji: '🎵', label: 'TikTok' },
  { source: 'instagram', emoji: '📸', label: 'Instagram' },
  { source: 'snapchat', emoji: '👻', label: 'Snapchat' },
  { source: 'youtube', emoji: '▶️', label: 'YouTube' },
  { source: 'app_store', emoji: '🔎', label: 'App Store' },
  { source: 'google', emoji: '🌐', label: 'Google' },
  { source: 'other', emoji: '✨', label: 'Something else' },
];

// Never hold anyone up: if the server is slow or says no, the question is just skipped.
const CHECK_TIME_LIMIT_MS = 4000;
const askedKey = (me: string) => `peekaboo-heard-about:${me}`;

// Should we ask this person? null while checking, then true or false.
export function useNeedsHeardAbout(userId: string | null | undefined): [boolean | null, () => void] {
  const [answer, setAnswer] = useState<{ user: string; needed: boolean } | null>(null);
  useEffect(() => {
    if (!userId) return;
    let done = false;
    const finish = (needed: boolean) => {
      if (done) return;
      done = true;
      setAnswer({ user: userId, needed });
    };
    const timer = setTimeout(() => finish(false), CHECK_TIME_LIMIT_MS);
    (async () => {
      // Answered or skipped on this phone already: don't even ask the server.
      if ((await AsyncStorage.getItem(askedKey(userId)).catch(() => null)) === 'yes') return false;
      const { data, error } = await supabase.rpc('needs_heard_about');
      return !error && data === true;
    })()
      .catch(() => false)
      .then((needed) => {
        clearTimeout(timer);
        finish(needed);
      });
    return () => {
      done = true;
      clearTimeout(timer);
    };
  }, [userId]);
  const needed = !userId ? false : answer?.user === userId ? answer.needed : null;
  const close = () => {
    if (userId) setAnswer({ user: userId, needed: false });
  };
  return [needed, close];
}

// Saves the answer ('skipped' for Skip). If it can't be saved, it's dropped – the person still carries on.
export async function saveHeardAbout(me: string, source: HeardAboutSource | 'skipped', other?: string): Promise<void> {
  AsyncStorage.setItem(askedKey(me), 'yes').catch(() => {});
  const { error } = await supabase.rpc('save_heard_about', {
    answer: source,
    other_text: source === 'other' ? (other ?? '').trim() || null : null,
  });
  if (error) console.warn('Could not save how they heard about Peekaboo', error);
}
