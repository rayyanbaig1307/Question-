import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

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

// Before today's drop has gone off (from midnight until the notification): the time it goes off, like "5:13 PM".
// null once it has. Nobody can post a drop in that time – yesterday's is over and today's hasn't happened – so
// screens say when it is instead of offering the camera.
export function dropNotYetAt(date = new Date()): string | null {
  const status = dropStatus(date);
  return status.kind === 'waiting' ? status.at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;
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

// The moment the drop AFTER `day` goes off, for someone whose time zone is `offsetMinutes` ahead of UTC
// (milliseconds, like Date.now()). Same formula as private.next_drop_at in
// supabase/migrations/20261228000000_drop_unlock.sql – keep them in sync.
export function nextDropAt(day: string, offsetMinutes: number | null): number {
  const [y, m, d] = day.split('-').map(Number);
  const nextDay = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return Date.UTC(y, m - 1, d + 1, 0, dropMinute(nextDay) - (offsetMinutes ?? 0));
}

// After the next drop goes off, drops from the day of your drop and before stay open this much longer (an hour).
// The time a drop goes off is worked out in the time zone you posted your drop from. When the clocks go back in
// autumn (or you fly west) the new drop goes off later than that, and without this your older drops would lock
// before you could even post the new one. Brand-new drops from the next day still lock right on time – that's
// the "give a peek to get a peek" moment. Same as private.drop_open_for in
// supabase/migrations/20261228000000_drop_unlock.sql – keep them in sync.
export const OLDER_DROPS_EXTRA_MS = 60 * 60 * 1000;

// Your own drops, for "give a peek to get a peek":
// - `days`: the days you posted a drop (drops from those days are always open for you);
// - `windows`: for each drop you posted, its day and when the next drop goes off after it (in the time zone you
//   posted from). Until then it opens every drop; drops from its day and before stay open an hour longer.
//   Drops whose window ended long ago are left out.
export type DropWindow = { day: string; until: number };
export type MyDrops = { days: Set<string>; windows: DropWindow[] };

export const NO_DROPS: MyDrops = { days: new Set(), windows: [] };

export async function fetchMyDrops(me: string): Promise<MyDrops> {
  // How many drops this phone had saved when it asked (see withPostedDrop).
  const asked = dropsNoted;
  const { data, error } = await supabase
    .from('posts')
    .select('drop_day, drop_offset_minutes')
    .eq('user_id', me)
    .not('drop_day', 'is', null);
  if (error) throw error;
  const days = new Set<string>();
  const windows: DropWindow[] = [];
  const now = Date.now();
  for (const row of data ?? []) {
    const day = row.drop_day as string;
    days.add(day);
    const until = nextDropAt(day, row.drop_offset_minutes as number | null);
    if (until + OLDER_DROPS_EXTRA_MS > now) windows.push({ day, until });
  }
  const mine: MyDrops = { days, windows };
  dropsWhenAsked.set(mine, asked);
  return mine;
}

// Is your latest drop still the current one (so every drop is open for you)?
export function dropKeyOpen(mine: MyDrops | null, now = Date.now()): boolean {
  return !!mine && mine.windows.some((window) => now < window.until);
}

// Is a drop from `day` open for you? (Only whether your own drops unlock it – who may see it at all is decided
// by the database first.) Same rule as private.drop_open_for in the database.
export function dropDayOpen(mine: MyDrops | null, day: string, now = Date.now()): boolean {
  if (!mine) return false;
  if (mine.days.has(day)) return true;
  return mine.windows.some(
    (window) => now < window.until || (day <= window.day && now < window.until + OLDER_DROPS_EXTRA_MS),
  );
}

// The next moment a drop locks again (null = nothing left that can change).
export function nextDropLockAt(mine: MyDrops | null, now = Date.now()): number | null {
  let next: number | null = null;
  for (const window of mine?.windows ?? []) {
    for (const at of [window.until, window.until + OLDER_DROPS_EXTRA_MS]) {
      if (at > now && (next === null || at < next)) next = at;
    }
  }
  return next;
}

// dropKeyOpen, and the screen is drawn again each time a drop locks (when the next drop goes off, new drops lock
// until you post it; an hour later, older ones too).
export function useDropKeyOpen(mine: MyDrops | null): boolean {
  const [, redraw] = useState(0);
  const next = nextDropLockAt(mine);
  useEffect(() => {
    if (next === null) return;
    // A little extra, so the clock has surely passed the moment when it fires.
    const timer = setTimeout(() => redraw((n) => n + 1), Math.max(0, next - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [next]);
  return dropKeyOpen(mine);
}

// ---------------------------------------------------------------------------
// What this phone already knows about your own drops, shared by every screen while the app is open:
// - "have you posted the drop of day X?" (the server's last answer, or "yes" the moment your drop is saved);
// - the drop you just posted (lib/outbox.ts saves it in the background after "Send to…" has already closed).
// Screens use it straight away, so the camera never waits to know if it's in drop mode, and your friends' drops
// unlock the moment yours is saved – not after the screens have loaded everything again.
// ---------------------------------------------------------------------------
// `seq` counts the answers in the order they were saved (a clock could show the same time for two of them).
type DoneAnswer = { done: boolean; seq: number };
const doneAnswers = new Map<string, DoneAnswer>();
let answersSaved = 0;
// `noted`: which drop saved on this phone it was (1 = the first one since the app was opened).
export type PostedDrop = { me: string; day: string; offset: number | null; noted?: number };
let postedDrop: PostedDrop | null = null;
// How many drops were saved on this phone since the app was opened. Each load of your drops (fetchMyDrops)
// remembers how many there were when it asked: a load asked after your drop was saved comes from the server with it.
let dropsNoted = 0;
const dropsWhenAsked = new WeakMap<MyDrops, number>();
// How many times you posted or deleted a drop (Home loads again when this changes), and how many times you deleted
// one (screens with their own copy of your drops load it again).
let dropChanges = 0;
let dropsDeleted = 0;
const dropListeners = new Set<() => void>();

function tellDropListeners() {
  dropListeners.forEach((listener) => listener());
}

function listenToDrops(listener: () => void) {
  dropListeners.add(listener);
  return () => {
    dropListeners.delete(listener);
  };
}

const doneKey = (me: string, day: string) => `${me}|${day}`;

// Saves an answer, unless a newer one came in while this one was on its way (an answer to a question asked
// before your drop was saved must not say "not posted" after it was). `askedAfter` = how many answers were saved
// when the question was asked.
function rememberDone(me: string, day: string, done: boolean, askedAfter: number) {
  const key = doneKey(me, day);
  const known = doneAnswers.get(key);
  if (known && known.seq > askedAfter) return;
  doneAnswers.set(key, { done, seq: ++answersSaved });
  tellDropListeners();
}

// Have I posted today's drop? Asked again whenever `enabled` turns on; until the answer is in, the last answer this
// phone knows is used. `null` = not known yet.
// The question is tiny (no rows come back), and it's also what warms the drop camera up: it's the first request
// after the app was idle, so the connection is ready – and a login that was about to run out is refreshed – before
// you take the photo, not while you wait on Send.
export function useDropDone(me: string, enabled: boolean): boolean | null {
  const day = localDay();
  const known = useSyncExternalStore(
    listenToDrops,
    () => doneAnswers.get(doneKey(me, day)),
    () => doneAnswers.get(doneKey(me, day)),
  );
  useEffect(() => {
    if (!enabled) return;
    const today = localDay();
    const askedAfter = answersSaved;
    supabase
      .from('posts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', me)
      .eq('drop_day', today)
      .then(({ count, error }) => {
        if (!error) rememberDone(me, today, (count ?? 0) > 0, askedAfter);
      });
  }, [me, enabled]);
  return known?.done ?? null;
}

// Why someone else's drop photo is still blurred for you (the database enforces this too):
// - 'drop': you haven't posted a drop since the latest one went off ("give a peek to get a peek"). Posting it
//   opens every drop – friends' and everyone's, old ones too – until the next day's drop goes off (drops from
//   your drop's day and before: an hour longer). Drops from a day you posted your own drop always stay open.
// - 'group': you're in a Group Peek together and someone in it hasn't posted that day's drop yet.
// `mine` = null while your own drops are still loading (until then, drops count as locked).
export type DropLock = 'drop' | 'group' | null;

type DropPost = { drop_day: string | null; user_id: string; group_hold?: boolean | null };

export function dropLock(post: DropPost, me: string, mine: MyDrops | null, now = Date.now()): DropLock {
  if (post.drop_day === null || post.user_id === me) return null;
  if (!dropDayOpen(mine, post.drop_day, now)) return 'drop';
  return post.group_hold ? 'group' : null;
}

export function isDropLocked(post: DropPost, me: string, mine: MyDrops | null, now = Date.now()): boolean {
  return dropLock(post, me, mine, now) !== null;
}

type PostFiles = {
  drop_day: string | null;
  user_id: string;
  media_path: string;
  media_type: 'photo' | 'video';
  poster_path: string | null;
  overlay_path: string | null;
  blur_path: string | null;
  group_hold?: boolean | null;
};

// Which files to load for a post:
// - locked drop → only the tiny blurry preview;
// - photo → the photo;
// - video → its still picture, the video, and its text/sticker layer.
export function postMedia(post: PostFiles, me: string, mine: MyDrops | null, now = Date.now()) {
  const lock = dropLock(post, me, mine, now);
  const locked = lock !== null;
  if (locked) return { locked, lock, still: post.blur_path, video: null, overlay: null };
  const isVideo = post.media_type === 'video';
  return {
    locked,
    lock,
    still: isVideo ? post.poster_path : post.media_path,
    video: isVideo ? post.media_path : null,
    overlay: isVideo ? post.overlay_path : null,
  };
}

// The picture to show for a post in grids and previews (blurry preview / photo / video's still picture).
export function visiblePath(post: PostFiles, me: string, mine: MyDrops | null, now = Date.now()): string | null {
  return postMedia(post, me, mine, now).still;
}

// Your drop was just saved (by lib/outbox.ts). `post` is the saved row: it says which day the drop is for and the
// time zone it was posted from. Every screen knows at once: the camera stops offering the drop, and your friends'
// drops unlock on screen straight away.
export function noteMyDropPosted(
  me: string,
  post?: { drop_day?: string | null; drop_offset_minutes?: number | null } | null,
): void {
  const day = post?.drop_day ?? localDay();
  const offset = post?.drop_offset_minutes ?? timeZoneOffsetMinutes();
  postedDrop = { me, day, offset, noted: ++dropsNoted };
  doneAnswers.set(doneKey(me, day), { done: true, seq: ++answersSaved });
  dropChanges += 1;
  tellDropListeners();
}

// You deleted your drop of `day` (lib/posts.ts calls this once the delete is done). Every screen knows at once:
// your friends' drops lock again (the server stops showing them to you too), and the camera offers the drop again.
// Screens that loaded your drops before the delete load them again.
export function forgetMyDrop(me: string, day: string): void {
  if (postedDrop?.me === me && postedDrop.day === day) postedDrop = null;
  doneAnswers.set(doneKey(me, day), { done: false, seq: ++answersSaved });
  dropChanges += 1;
  dropsDeleted += 1;
  tellDropListeners();
}

// A number that goes up each time you post or delete a drop (use it to load things again).
export function useMyDropPosts(): number {
  return useSyncExternalStore(
    listenToDrops,
    () => dropChanges,
    () => dropChanges,
  );
}

// Your drops as loaded, plus the one you just posted if that load doesn't have it yet. (Exported for the tests.)
// Only for a load that was asked BEFORE your drop was saved. A load asked after it comes from the server with your
// drop: if it isn't there, you deleted it – also when the delete's answer got lost on a weak signal, and the app
// thought the delete hadn't worked. Then your friends' drops lock again, like the server does.
export function withPostedDrop(mine: MyDrops | null, me: string, posted: PostedDrop | null): MyDrops | null {
  if (!posted || posted.me !== me) return mine;
  if (mine && posted.noted !== undefined && (dropsWhenAsked.get(mine) ?? 0) >= posted.noted) return mine;
  const base = mine ?? NO_DROPS;
  const until = nextDropAt(posted.day, posted.offset);
  if (base.days.has(posted.day) && base.windows.some((window) => window.day === posted.day)) return base;
  const windows = until + OLDER_DROPS_EXTRA_MS > Date.now() ? [...base.windows, { day: posted.day, until }] : base.windows;
  return { days: new Set([...base.days, posted.day]), windows };
}

// The same, as a hook: the screen changes the moment your drop is saved.
export function useWithMyNewDrop(me: string, mine: MyDrops | null): MyDrops | null {
  const posted = useSyncExternalStore(
    listenToDrops,
    () => postedDrop,
    () => postedDrop,
  );
  return useMemo(() => withPostedDrop(mine, me, posted), [mine, me, posted]);
}

// Your own drops, loaded again whenever `refreshKey` changes, and when you delete a drop. `null` = still loading
// (until then, other people's drops count as locked). A drop you post meanwhile counts at once. Redraws the screen
// when the next drop goes off.
export function useMyDrops(me: string, refreshKey: unknown): MyDrops | null {
  const [loaded, setLoaded] = useState<MyDrops | null>(null);
  const deleted = useSyncExternalStore(
    listenToDrops,
    () => dropsDeleted,
    () => dropsDeleted,
  );
  useEffect(() => {
    let cancelled = false;
    fetchMyDrops(me)
      .then((drops) => !cancelled && setLoaded(drops))
      .catch(() => !cancelled && setLoaded(NO_DROPS));
    return () => {
      cancelled = true;
    };
  }, [me, refreshKey, deleted]);
  const mine = useWithMyNewDrop(me, loaded);
  useDropKeyOpen(mine);
  return mine;
}
