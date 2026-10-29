import AsyncStorage from '@react-native-async-storage/async-storage';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { File, Paths } from 'expo-file-system';
import { useCallback, useEffect, useState } from 'react';

import { fetchLikesForMe, fetchMatches } from './dating';
import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// Peek Match: Peekaboo's separate, 18+ dating mode. Off until you turn it on yourself.
// Joining takes two steps: your birthday (under 18 = never allowed in), then an ID + selfie age check by
// Stripe Identity (run by the "peek-match" Edge Function, so no keys live in the app).
// ---------------------------------------------------------------------------

export type AgeCheck = {
  birthday: string;
  verified_birthday: string | null;
  blocked: boolean;
  check_state: 'not_started' | 'pending' | 'verified' | 'failed';
  check_error: string | null;
  verified_at: string | null;
};

export type DatingMembership = { dating_id: string; hidden: boolean; joined_at: string };

export type PeekMatchStatus = { ageCheck: AgeCheck | null; member: DatingMembership | null };

export async function fetchPeekMatchStatus(me: string): Promise<PeekMatchStatus> {
  const [ageCheck, member] = await Promise.all([
    supabase.from('age_checks').select('*').eq('user_id', me).maybeSingle(),
    supabase.from('dating_members').select('dating_id, hidden, joined_at').eq('user_id', me).maybeSingle(),
  ]);
  if (ageCheck.error) throw ageCheck.error;
  if (member.error) throw member.error;
  return { ageCheck: ageCheck.data as AgeCheck | null, member: member.data as DatingMembership | null };
}

// The Match tab only exists for people whose saved birthday says they're 18 or older.
// No birthday yet, or under 18 → no tab, and Peek Match is never mentioned.
export const canSeePeekMatch = (status: PeekMatchStatus) => !!status.ageCheck && !status.ageCheck.blocked;

// This phone remembers who can see the Match tab, so it's there the moment Peekaboo opens.
const MATCH_TAB_FILE = 'peekaboo-match-tab.txt';

export function rememberedMatchTab(me: string): boolean {
  try {
    const file = new File(Paths.document, MATCH_TAB_FILE);
    return file.exists && file.textSync().trim() === me;
  } catch {
    return false;
  }
}

function rememberMatchTab(me: string, on: boolean) {
  try {
    const file = new File(Paths.document, MATCH_TAB_FILE);
    if (!file.exists) file.create();
    file.writeSync(on ? me : '');
  } catch {
    // Not remembered – the tab just shows up a moment later next time.
  }
}

// Your Peek Match status, fetched each time `active` turns on. `news` = likes waiting for you + chats with
// unread messages (for the dot on the Match tab).
export function usePeekMatchStatus(me: string, active: boolean) {
  const [status, setStatus] = useState<PeekMatchStatus | null>(null);
  const [news, setNews] = useState(0);

  const reload = useCallback(
    () =>
      fetchPeekMatchStatus(me)
        .then((loaded) => {
          setStatus(loaded);
          rememberMatchTab(me, canSeePeekMatch(loaded));
          if (!loaded.member) return 0;
          return Promise.all([fetchLikesForMe(), fetchMatches()]).then(
            ([likes, matches]) => likes.length + matches.filter((match) => match.unread > 0).length,
          );
        })
        .then(setNews)
        .catch((error) => console.warn('Could not load Peek Match', error)),
    [me],
  );

  useEffect(() => {
    if (active) reload();
  }, [active, reload]);

  return { status, news, reload };
}

// Your saved birthday ('YYYY-MM-DD'), or null if you haven't added it.
export async function fetchMyBirthday(me: string): Promise<string | null> {
  const { data, error } = await supabase.from('age_checks').select('birthday').eq('user_id', me).maybeSingle();
  if (error) throw error;
  return data?.birthday ?? null;
}

// We ask for your birthday once when you open Peekaboo (you can also add it in Settings).
const birthdayAskedKey = (me: string) => `peekaboo-birthday-asked:${me}`;

export async function wasAskedForBirthday(me: string): Promise<boolean> {
  return (await AsyncStorage.getItem(birthdayAskedKey(me)).catch(() => null)) === 'yes';
}

export function markAskedForBirthday(me: string) {
  AsyncStorage.setItem(birthdayAskedKey(me), 'yes').catch(() => {});
}

// Saves your birthday (once, for good). Returns 'blocked' if you're under 18.
export async function setBirthday(day: string): Promise<'ok' | 'blocked'> {
  const { data, error } = await supabase.rpc('peek_match_set_birthday', { day });
  if (error) throw error;
  return data as 'ok' | 'blocked';
}

// The age check isn't switched on yet (no Stripe key added in Supabase).
export class AgeCheckNotSetUp extends Error {
  constructor() {
    super("Age checks aren't switched on yet");
  }
}

async function callPeekMatch<T>(action: string): Promise<T> {
  const { data, error } = await supabase.functions.invoke('peek-match', { method: 'POST', body: { action } });
  if (error) {
    // The helper says what went wrong in its reply.
    const reply = error instanceof FunctionsHttpError ? await error.context.json().catch(() => null) : null;
    if (reply?.error === 'not_set_up') throw new AgeCheckNotSetUp();
    throw new Error(reply?.error ?? error.message);
  }
  return data as T;
}

// Starts an age check. Returns the Stripe page to open (or nothing if you're already verified).
export async function startAgeCheck(): Promise<string | null> {
  const reply = await callPeekMatch<{ url?: string }>('start-age-check');
  return reply.url ?? null;
}

// Asks Stripe how your age check went.
export function checkAge(): Promise<{ state: AgeCheck['check_state']; blocked: boolean; error?: string | null }> {
  return callPeekMatch('check-age');
}

export async function joinPeekMatch(): Promise<void> {
  const { error } = await supabase.rpc('peek_match_join');
  if (error) throw error;
}

export async function setDatingHidden(hide: boolean): Promise<void> {
  const { error } = await supabase.rpc('peek_match_set_hidden', { hide });
  if (error) throw error;
}

// Leaves Peek Match: deletes your dating profile, photos, likes, matches and chats. (Your age check is kept.)
export async function leavePeekMatch(): Promise<void> {
  await callPeekMatch('leave');
}
