import { useEffect, useState } from 'react';
import { Share } from 'react-native';

import { dareFor, todayDareDay } from './dares';
import { withAppLink } from './invite';
import { supabase } from './supabase';
import type { Profile } from './types';

// ---------------------------------------------------------------------------
// Dare chains: after you do today's dare, you dare up to 3 friends. They have 24 hours.
// ---------------------------------------------------------------------------

export const MAX_DARES_PER_DAY = 3;
export const DARE_HOURS = 24;

export type Nomination = {
  id: string;
  dare_day: string;
  from_user: string;
  to_user: string;
  post_id: string | null;
  created_at: string;
  expires_at: string;
  done_post_id: string | null;
  done_at: string | null;
  from: Profile;
  to: Profile;
};

export type NominationState = 'done' | 'open' | 'expired';

export function nominationState(nomination: Nomination, now = Date.now()): NominationState {
  if (nomination.done_at) return 'done';
  return Date.parse(nomination.expires_at) > now ? 'open' : 'expired';
}

// "5h left" / "40m left"
export function timeLeft(nomination: Nomination, now = Date.now()): string {
  const ms = Math.max(0, Date.parse(nomination.expires_at) - now);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h left` : `${m}m left`;
}

export type DareChain = { received: Nomination[]; sent: Nomination[] };

// The dares you were given and the ones you gave, for one day.
export async function fetchDareChain(me: string, day: string): Promise<DareChain> {
  const { data, error } = await supabase
    .from('dare_nominations')
    .select('*, from:profiles!dare_nominations_from_user_fkey(*), to:profiles!dare_nominations_to_user_fkey(*)')
    .eq('dare_day', day)
    .order('created_at', { ascending: true });
  if (error) throw error;
  const all = (data ?? []) as Nomination[];
  return {
    received: all.filter((n) => n.to_user === me),
    sent: all.filter((n) => n.from_user === me),
  };
}

// Dare these friends with today's dare. Returns how many were actually dared.
export async function dareFriends(targets: string[], sourcePost: string | null): Promise<number> {
  const { data, error } = await supabase.rpc('dare_friends', { targets, source_post: sourcePost });
  if (error) throw error;
  return (data as number) ?? 0;
}

// Dare someone who isn't on Peekaboo yet: a message with today's dare and the download links.
export async function inviteToDare(username?: string | null): Promise<void> {
  const dare = dareFor(todayDareDay());
  const who = username ? `@${username}` : 'a friend';
  await Share.share({
    message: withAppLink(`🎯 ${who} dares you: "${dare.text}"\nYou have 24 hours 😈 Do it on Peekaboo:`),
  });
}

// Open dares waiting for you today (for the little nudge on the camera). `null` = still checking.
export function useOpenDaresForMe(me: string, enabled: boolean): Nomination[] | null {
  const [open, setOpen] = useState<{ day: string; list: Nomination[] } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const day = todayDareDay();
    fetchDareChain(me, day)
      .then((chain) => setOpen({ day, list: chain.received.filter((n) => nominationState(n) === 'open') }))
      .catch(() => {});
  }, [me, enabled]);
  return open?.day === todayDareDay() ? open.list : null;
}
