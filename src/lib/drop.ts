import { useEffect, useState } from 'react';

import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// The Peekaboo Drop: once a day, at the same clock time for everyone (somewhere between 10am and 10pm,
// in your own time zone), you get 2 minutes to show what you're doing.
// The time is worked out from the date with the same formula as the database
// (private.drop_minute in supabase/migrations/20261101000000_peekaboo_drop.sql) – keep them in sync.
// ---------------------------------------------------------------------------

export const DROP_WINDOW_MS = 2 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Your local date, like "2026-10-28".
export function localDay(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Minute of the day (600 = 10:00 … 1319 = 21:59) when that day's drop happens.
export function dropMinute(day: string): number {
  // Scramble the day number (a standard "hash" recipe) so the times look random from day to day.
  let h = Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return 600 + (h % 720);
}

// The moment of a day's drop, in your time zone.
export function dropAt(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 0, dropMinute(day));
}

// Where today's drop is at: still to come, live (2 minutes to post), or over (you can still post, but late).
// `now` is the moment this was worked out (so screens can show "1:42 left").
export type DropStatus =
  | { kind: 'waiting'; at: Date; now: number }
  | { kind: 'live'; endsAt: Date; now: number }
  | { kind: 'late'; at: Date; now: number };

export function dropStatus(date = new Date()): DropStatus {
  const now = date.getTime();
  const at = dropAt(localDay(date));
  if (now < at.getTime()) return { kind: 'waiting', at, now };
  const endsAt = new Date(at.getTime() + DROP_WINDOW_MS);
  if (now < endsAt.getTime()) return { kind: 'live', endsAt, now };
  return { kind: 'late', at, now };
}

// The same, updated every second.
export function useDropStatus(): DropStatus {
  const [status, setStatus] = useState(() => dropStatus());
  useEffect(() => {
    const timer = setInterval(() => setStatus(dropStatus()), 1000);
    return () => clearInterval(timer);
  }, []);
  return status;
}

// "On time" if posted within the 2 minutes, otherwise "Late by 3h" / "Late by 25m" / "Late by 40s".
export function lateLabel(lateSeconds: number): { onTime: boolean; text: string } {
  if (lateSeconds <= DROP_WINDOW_MS / 1000) return { onTime: true, text: 'On time' };
  if (lateSeconds >= 3600) return { onTime: false, text: `Late by ${Math.floor(lateSeconds / 3600)}h` };
  if (lateSeconds >= 60) return { onTime: false, text: `Late by ${Math.floor(lateSeconds / 60)}m` };
  return { onTime: false, text: `Late by ${lateSeconds}s` };
}

// "1:42"
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// Your time zone, in minutes ahead of UTC (sent with a drop post so the database can work out how late it was).
export function timeZoneOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}

// The days you've posted a drop for. Friends' drops from those days are unlocked for you ("peek to see").
export async function fetchMyDropDays(me: string): Promise<Set<string>> {
  const { data, error } = await supabase.from('posts').select('drop_day').eq('user_id', me).not('drop_day', 'is', null);
  if (error) throw error;
  return new Set((data ?? []).map((row) => row.drop_day as string));
}

// Have I posted today's drop? Checked whenever `enabled` turns on. `null` = still checking.
export function useDropDone(me: string, enabled: boolean): boolean | null {
  const [done, setDone] = useState<{ day: string; done: boolean } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const day = localDay();
    supabase
      .from('posts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', me)
      .eq('drop_day', day)
      .then(({ count, error }) => {
        if (!error) setDone({ day, done: (count ?? 0) > 0 });
      });
  }, [me, enabled]);
  return done?.day === localDay() ? done.done : null;
}

// Peek to see: a friend's drop photo stays blurred until you've posted your own drop that day.
// (The database enforces this too – it won't hand out the real photo before then.)
export function isDropLocked(
  post: { drop_day: string | null; user_id: string },
  me: string,
  myDropDays: Set<string> | null,
): boolean {
  return post.drop_day !== null && post.user_id !== me && !(myDropDays?.has(post.drop_day) ?? false);
}

type PostFiles = {
  drop_day: string | null;
  user_id: string;
  media_path: string;
  media_type: 'photo' | 'video';
  poster_path: string | null;
  overlay_path: string | null;
  blur_path: string | null;
};

// Which files to load for a post:
// - locked drop → only the tiny blurry preview;
// - photo → the photo;
// - video → its still picture, the video, and its text/sticker layer.
export function postMedia(post: PostFiles, me: string, myDropDays: Set<string> | null) {
  const locked = isDropLocked(post, me, myDropDays);
  if (locked) return { locked, still: post.blur_path, video: null, overlay: null };
  const isVideo = post.media_type === 'video';
  return {
    locked,
    still: isVideo ? post.poster_path : post.media_path,
    video: isVideo ? post.media_path : null,
    overlay: isVideo ? post.overlay_path : null,
  };
}

// The picture to show for a post in grids and previews (blurry preview / photo / video's still picture).
export function visiblePath(post: PostFiles, me: string, myDropDays: Set<string> | null): string | null {
  return postMedia(post, me, myDropDays).still;
}

// The days you've posted a drop for, loaded again whenever `refreshKey` changes. `null` = still loading
// (until then, friends' drops count as locked).
export function useMyDropDays(me: string, refreshKey: unknown): Set<string> | null {
  const [days, setDays] = useState<Set<string> | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchMyDropDays(me)
      .then((loaded) => !cancelled && setDays(loaded))
      .catch(() => !cancelled && setDays(new Set()));
    return () => {
      cancelled = true;
    };
  }, [me, refreshKey]);
  return days;
}
