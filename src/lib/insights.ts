import { useCallback } from 'react';

import { useScreenshotDetector } from './screenshots';
import { markStorySeen } from './stories';
import { supabase } from './supabase';
import type { Profile } from './types';

// ---------------------------------------------------------------------------
// Peekaboo+ ⭐ insights: who viewed your profile, who rewatched your story, who screenshotted your story
// or post.
//
// The server decides who may see names (only Peekaboo+ members). Everyone gets the counts.
// If the database isn't updated yet (or there's no internet), these quietly return nothing instead of
// crashing – the screens then just don't show the insight.
// ---------------------------------------------------------------------------

// Profiles for a list of ids, in no particular order. Missing ones (deleted accounts) are left out.
async function profilesById(ids: string[]): Promise<Map<string, Profile>> {
  const found = new Map<string, Profile>();
  if (ids.length === 0) return found;
  const { data, error } = await supabase.from('profiles').select('*').in('id', ids);
  if (error) throw error;
  for (const profile of (data ?? []) as Profile[]) found.set(profile.id, profile);
  return found;
}

// ---------------------------------------------------------------------------
// 👀 Profile views
// ---------------------------------------------------------------------------

// Opened someone else's profile. The server saves at most one visit an hour, skips your own profile,
// blocks, and people who turned "Show me in Profile views" off.
export async function recordProfileView(target: string): Promise<void> {
  try {
    await supabase.rpc('record_profile_view', { target });
  } catch {
    // Not important enough to bother anyone.
  }
}

export type ProfileViewer = { profile: Profile; visits: number; lastViewedAt: string };

export type ProfileViews = {
  // false = you turned "Show me in Profile views" off, so you can't see your viewers either.
  sharing: boolean;
  // The server says you have Peekaboo+ (so `viewers` is filled in).
  plus: boolean;
  // How many different people, and how many visits in all (last 30 days).
  people: number;
  visits: number;
  // Newest first. Empty without Peekaboo+.
  viewers: ProfileViewer[];
};

// Your profile views for the last 30 days, or null if they can't be loaded right now.
export async function fetchMyProfileViews(): Promise<ProfileViews | null> {
  try {
    const { data, error } = await supabase.rpc('my_profile_views');
    if (error || !data) return null;
    const raw = data as {
      sharing?: boolean;
      plus?: boolean;
      people?: number;
      visits?: number;
      viewers?: { viewer_id: string; visits: number; last_viewed_at: string }[];
    };
    const rows = raw.viewers ?? [];
    const profiles = await profilesById(rows.map((row) => row.viewer_id));
    const viewers: ProfileViewer[] = [];
    for (const row of rows) {
      const profile = profiles.get(row.viewer_id);
      if (profile) viewers.push({ profile, visits: row.visits, lastViewedAt: row.last_viewed_at });
    }
    return {
      sharing: raw.sharing !== false,
      plus: !!raw.plus,
      people: raw.people ?? 0,
      visits: raw.visits ?? 0,
      viewers,
    };
  } catch {
    return null;
  }
}

// Your "Show me in Profile views" setting: true (the default) or false. null = can't tell right now.
export async function fetchShowInProfileViews(me: string): Promise<boolean | null> {
  try {
    const { data, error } = await supabase
      .from('insight_prefs')
      .select('show_in_profile_views')
      .eq('user_id', me)
      .maybeSingle();
    if (error) return null;
    return data ? data.show_in_profile_views !== false : true;
  } catch {
    return null;
  }
}

// Turn "Show me in Profile views" on or off. Throws if it couldn't be saved (Settings explains why).
export async function setShowInProfileViews(show: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_show_in_profile_views', { show });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// 🔁 Story rewatches
// ---------------------------------------------------------------------------

// Opened a friend's story: marks it seen and counts the view (each re-open counts again).
// Before the database is updated this falls back to the old "seen" mark.
export async function recordStoryView(me: string, storyId: string): Promise<void> {
  try {
    const { error } = await supabase.rpc('record_story_view', { story: storyId });
    if (!error) return;
  } catch {
    // fall back below
  }
  await markStorySeen(me, storyId).catch(() => {});
}

export type StoryInsights = {
  plus: boolean;
  // How many people opened it more than once, and how many screenshotted it.
  rewatchers: number;
  screenshotters: number;
  // Only with Peekaboo+: person id → how many times they opened it, and how many screenshots.
  people: Map<string, { views: number; screenshots: number }>;
};

// For one of your own stories, or null if it can't be loaded right now.
export async function fetchStoryInsights(storyId: string): Promise<StoryInsights | null> {
  try {
    const { data, error } = await supabase.rpc('story_insights', { story: storyId });
    if (error || !data) return null;
    const raw = data as {
      plus?: boolean;
      rewatchers?: number;
      screenshotters?: number;
      people?: { viewer_id: string; views: number; screenshots: number }[];
    };
    return {
      plus: !!raw.plus,
      rewatchers: raw.rewatchers ?? 0,
      screenshotters: raw.screenshotters ?? 0,
      people: new Map((raw.people ?? []).map((row) => [row.viewer_id, { views: row.views, screenshots: row.screenshots }])),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 📸 Screenshots of stories and posts
// ---------------------------------------------------------------------------

export type ScreenshotKind = 'story' | 'post';

// You took a screenshot of someone else's story or post. The owner gets a push ("📸 Someone
// screenshotted your story") – the server never says who in it.
export async function recordScreenshot(kind: ScreenshotKind, target: string): Promise<void> {
  try {
    await supabase.rpc('record_screenshot', { kind, target });
  } catch {
    // Not important enough to bother anyone.
  }
}

// While `enabled`, a screenshot of this story or post is recorded. (Skipped where the phone can't detect
// screenshots – see screenshots.ts.)
export function useContentScreenshots(kind: ScreenshotKind, target: string | null | undefined, enabled: boolean) {
  const onScreenshot = useCallback(() => {
    if (target) recordScreenshot(kind, target);
  }, [kind, target]);
  useScreenshotDetector(enabled && !!target, onScreenshot);
}

export type PostScreenshotTaker = { profile: Profile; times: number; lastAt: string };

export type PostScreenshots = {
  plus: boolean;
  // How many different people, and how many screenshots in all.
  people: number;
  screenshots: number;
  // Newest first. Empty without Peekaboo+.
  takers: PostScreenshotTaker[];
};

// For one of your own posts, or null if it can't be loaded right now.
export async function fetchPostScreenshots(postId: string): Promise<PostScreenshots | null> {
  try {
    const { data, error } = await supabase.rpc('post_screenshots', { post: postId });
    if (error || !data) return null;
    const raw = data as {
      plus?: boolean;
      people?: number;
      screenshots?: number;
      takers?: { taker_id: string; times: number; last_at: string }[];
    };
    const rows = raw.takers ?? [];
    const profiles = await profilesById(rows.map((row) => row.taker_id));
    const takers: PostScreenshotTaker[] = [];
    for (const row of rows) {
      const profile = profiles.get(row.taker_id);
      if (profile) takers.push({ profile, times: row.times, lastAt: row.last_at });
    }
    return { plus: !!raw.plus, people: raw.people ?? 0, screenshots: raw.screenshots ?? 0, takers };
  } catch {
    return null;
  }
}
