import { useEffect, useState } from 'react';
import { Share } from 'react-native';

import { dareFor, todayDareDay } from './dares';
import { fetchFriends } from './friends';
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

// ---------------------------------------------------------------------------
// Forfeits 💀: a dare that ran out of time → the friend who dared you picks one from a safe list.
// ---------------------------------------------------------------------------

export type ForfeitOption = { key: string; text: string; position: number };

export type Forfeit = {
  id: string;
  nomination_id: string;
  from_user: string;
  to_user: string;
  forfeit_key: string;
  forfeit_text: string;
  created_at: string;
  done_post_id: string | null;
  done_at: string | null;
  from: Profile;
  to: Profile;
};

export async function fetchForfeitOptions(): Promise<ForfeitOption[]> {
  const { data, error } = await supabase.from('forfeit_options').select('*').order('position');
  if (error) throw error;
  return (data ?? []) as ForfeitOption[];
}

// Forfeits you owe and forfeits you handed out (open ones first, then the last week's paid ones).
export async function fetchForfeits(): Promise<Forfeit[]> {
  const since = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
  const { data, error } = await supabase
    .from('forfeits')
    .select('*, from:profiles!forfeits_from_user_fkey(*), to:profiles!forfeits_to_user_fkey(*)')
    .or(`done_at.is.null,created_at.gte.${since}`)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Forfeit[];
}

// Pick a forfeit for a friend whose dare ran out of time.
export async function giveForfeit(nominationId: string, key: string): Promise<void> {
  const { error } = await supabase.rpc('give_forfeit', { nomination: nominationId, choice: key });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Dare streaks 🔥: you and a friend both do the daily dare, day after day.
// ---------------------------------------------------------------------------

export type Streak = {
  friend: Profile;
  // Days in a row you've both done the dare (counting today if you both have, else up to yesterday).
  streak: number;
  me_today: boolean;
  them_today: boolean;
};

// Streaks with every friend, biggest first (friends with no streak and nothing today are left out).
export async function fetchDareStreaks(me: string): Promise<Streak[]> {
  const [{ data, error }, friends] = await Promise.all([supabase.rpc('dare_streaks'), fetchFriends(me)]);
  if (error) throw error;
  const byId = new Map(friends.map((friend) => [friend.id, friend]));
  const rows = (data ?? []) as { friend_id: string; streak: number; me_today: boolean; them_today: boolean }[];
  return rows
    .flatMap((row) => {
      const friend = byId.get(row.friend_id);
      return friend ? [{ friend, streak: row.streak, me_today: row.me_today, them_today: row.them_today }] : [];
    })
    .filter((s) => s.streak > 0 || s.them_today)
    .sort((a, b) => b.streak - a.streak);
}

// A streak is "at risk" when it's alive from yesterday but you haven't done today's dare yet.
export const streakAtRisk = (s: Streak) => s.streak > 0 && !s.me_today;

// The best streak you're about to lose today, as a one-line nudge for the camera. `null` = nothing at risk.
export function useStreakNudge(me: string, enabled: boolean): string | null {
  const [nudge, setNudge] = useState<{ day: string; text: string | null } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const day = todayDareDay();
    fetchDareStreaks(me)
      .then((streaks) => {
        const best = streaks.find(streakAtRisk);
        setNudge({
          day,
          text: best ? `🔥 Keep your ${best.streak}-day streak with ${best.friend.display_name || best.friend.username}` : null,
        });
      })
      .catch(() => {});
  }, [me, enabled]);
  return nudge?.day === todayDareDay() ? nudge.text : null;
}
