import AsyncStorage from '@react-native-async-storage/async-storage';

import { allDareOverrides, setDareOverride, todayDareDay } from './dares';
import { supabase } from './supabase';
import type { Profile } from './types';

// ---------------------------------------------------------------------------
// Community dares 💡: suggest a dare and vote 🔥. The owner reads ideas with enough votes and approves the safe
// ones. Only then can the top idea become everyone's dare, with your name on it
// (supabase/migrations/20261220000000_launch_safety.sql).
// ---------------------------------------------------------------------------

export const MIN_VOTES = 3;
export const IDEA_MIN = 10;
export const IDEA_MAX = 120;

export type DareIdea = {
  id: string;
  user_id: string;
  text: string;
  votes: number;
  hidden: boolean;
  used_on: string | null;
  // When the owner approved it (empty = not approved yet). Only approved ideas can become everyone's dare.
  approved_at: string | null;
  created_at: string;
  author: Profile;
  // Filled in by the app: did I vote for it?
  mine: boolean;
};

export async function fetchIdeas(me: string, sort: 'top' | 'new'): Promise<DareIdea[]> {
  const [ideas, votes] = await Promise.all([
    supabase
      .from('dare_ideas')
      .select('*, author:profiles!dare_ideas_user_id_fkey(*)')
      .is('used_on', null)
      .order(sort === 'top' ? 'votes' : 'created_at', { ascending: false })
      .order('created_at', { ascending: sort === 'top' })
      .limit(100),
    supabase.from('dare_votes').select('idea_id').eq('user_id', me),
  ]);
  if (ideas.error) throw ideas.error;
  if (votes.error) throw votes.error;
  const voted = new Set((votes.data ?? []).map((row) => row.idea_id as string));
  // If the writer blocked you, their profile is hidden from you, so their idea comes back with no author.
  // Leave those ideas out (the list can't show an idea without its writer).
  return ((ideas.data ?? []) as (Omit<DareIdea, 'mine' | 'author'> & { author: Profile | null })[])
    .filter((idea): idea is Omit<DareIdea, 'mine'> => idea.author !== null)
    .map((idea) => ({ ...idea, mine: voted.has(idea.id) }));
}

// Suggest a dare (one a day). The database says no to unsafe words.
export async function submitIdea(text: string): Promise<void> {
  const { error } = await supabase.from('dare_ideas').insert({ text: text.trim() });
  if (error) throw error;
}

export async function deleteIdea(id: string): Promise<void> {
  const { error } = await supabase.from('dare_ideas').delete().eq('id', id);
  if (error) throw error;
}

export async function voteIdea(id: string, on: boolean): Promise<void> {
  const { error } = on
    ? await supabase.from('dare_votes').insert({ idea_id: id })
    : await supabase.from('dare_votes').delete().eq('idea_id', id);
  if (error) throw error;
}

export async function reportIdea(id: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('report_dare_idea', { idea: id, reason });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Which community dare ran on which day
// ---------------------------------------------------------------------------

const CACHE_KEY = 'peekaboo-community-dares';

type Ran = { day: string; text: string; username: string; display_name: string | null };

function remember(rows: Ran[]) {
  for (const row of rows) setDareOverride(row.day, { text: row.text, author: `@${row.username}` });
  AsyncStorage.setItem(CACHE_KEY, JSON.stringify(allDareOverrides())).catch(() => {});
}

// Today's dare: asks the database (which picks the winner the first time anyone asks after 10:00 UTC),
// plus the last month's winners so older dare posts show the right words. Safe to call often.
export async function syncCommunityDares(): Promise<void> {
  // What this phone already knows, so screens are right straight away.
  try {
    const cached = JSON.parse((await AsyncStorage.getItem(CACHE_KEY)) ?? '{}') as Record<string, { text: string; author: string }>;
    for (const [day, dare] of Object.entries(cached)) setDareOverride(day, dare);
  } catch {
    // nothing cached yet
  }
  const [today, recent] = await Promise.all([
    supabase.rpc('pick_daily_dare', { for_day: todayDareDay() }),
    supabase.rpc('recent_daily_dares', { days: 30 }),
  ]);
  if (today.error) throw today.error;
  if (recent.error) throw recent.error;
  remember([...((recent.data ?? []) as Ran[]), ...((today.data ?? []) as Ran[])]);
}
