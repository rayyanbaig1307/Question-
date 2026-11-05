import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// Peekaboo+ ⭐ extras: 🙈 Peek-a-Save, ⏰ drop rewind and the 🕵️ Guess Who hint.
// The server checks everything (Plus, the 24 hours, the monthly / weekly allowance): see
// supabase/migrations/20261218000000_plus_extras.sql. Until that migration is in, every call here fails, and
// the screens simply hide these buttons.
// ---------------------------------------------------------------------------

export type StreakKind = 'daily_dare' | 'chat_dare';

// A streak with a friend that broke less than 24 hours ago and can still be saved.
export type BrokenStreak = {
  kind: StreakKind;
  friend_id: string;
  // How long it was (days for the daily dare, dares for chat).
  streak: number;
  broke_at: string;
  save_until: string;
};

// How many Peek-a-Saves and drop rewinds you have left, and when they come back.
export type PlusAllowances = {
  // What the server says about your Plus (it checks this itself).
  plus: boolean;
  savesLeft: number;
  saveResetsAt: string;
  rewindsLeft: number;
  rewindResetsAt: string;
};

export async function fetchPlusAllowances(): Promise<PlusAllowances> {
  const { data, error } = await supabase.rpc('plus_allowances');
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as
    | { plus: boolean; saves_left: number; save_resets_at: string; rewinds_left: number; rewind_resets_at: string }
    | undefined;
  if (!row) throw new Error('Please log in again');
  return {
    plus: row.plus,
    savesLeft: row.saves_left,
    saveResetsAt: row.save_resets_at,
    rewindsLeft: row.rewinds_left,
    rewindResetsAt: row.rewind_resets_at,
  };
}

// Your streaks that broke in the last 24 hours, biggest first.
export async function fetchBrokenStreaks(): Promise<BrokenStreak[]> {
  const { data, error } = await supabase.rpc('my_broken_streaks');
  if (error) throw error;
  return ((data ?? []) as BrokenStreak[]).sort((a, b) => b.streak - a.streak);
}

// Use your Peek-a-Save on a broken streak. Returns the streak that's back.
export async function peekASave(kind: StreakKind, friendId: string): Promise<number> {
  const { data, error } = await supabase.rpc('peek_a_save', { streak_type: kind, friend_user: friendId });
  if (error) throw error;
  return (data as number) ?? 0;
}

// Broken streaks plus your allowances, or null when the server doesn't have Peek-a-Save yet.
export async function fetchPeekASaves(): Promise<{ streaks: BrokenStreak[]; allowances: PlusAllowances } | null> {
  try {
    const [streaks, allowances] = await Promise.all([fetchBrokenStreaks(), fetchPlusAllowances()]);
    return { streaks, allowances };
  } catch {
    return null;
  }
}

// "Your 12-day streak with Ayaan broke 😱" / "Your 5-dare streak with Ayaan broke 😱"
export function brokenStreakText(streak: Pick<BrokenStreak, 'kind' | 'streak'>, name: string): string {
  const size = streak.kind === 'daily_dare' ? `${streak.streak}-day` : `${streak.streak}-dare`;
  return `Your ${size} streak with ${name} broke 😱`;
}

// "1 Dec" – when your next Peek-a-Save or rewind arrives.
export function shortDate(iso: string): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const date = new Date(iso);
  return `${date.getDate()} ${months[date.getMonth()]}`;
}

// "5h left" to save it.
export function hoursLeft(iso: string, now = Date.now()): string {
  const ms = Math.max(0, Date.parse(iso) - now);
  const h = Math.floor(ms / 3_600_000);
  return h > 0 ? `${h}h left` : `${Math.max(1, Math.floor(ms / 60_000))}m left`;
}

// ---------------------------------------------------------------------------
// 🕵️ Guess Who hints
// ---------------------------------------------------------------------------

// The hints you already got (post id → hint), or null when the server doesn't have hints yet.
export async function fetchMysteryHints(): Promise<Map<string, string> | null> {
  try {
    const { data, error } = await supabase.from('mystery_hints').select('post_id, hint');
    if (error) return null;
    return new Map(((data ?? []) as { post_id: string; hint: string }[]).map((row) => [row.post_id, row.hint]));
  } catch {
    return null;
  }
}

// Get your one hint for a Guess Who post (asking again gives the same one).
export async function getMysteryHint(postId: string): Promise<string> {
  const { data, error } = await supabase.rpc('mystery_hint', { post: postId });
  if (error) throw error;
  return data as string;
}
