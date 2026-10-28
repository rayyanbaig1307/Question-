import { deleteMedia, uploadMedia } from './media';
import { supabase } from './supabase';
import type { Profile, Story } from './types';

export type StoryWithAuthor = Story & { author: Profile | null };

// Everyone's stories you can see right now (yours + friends'), grouped by person.
export type StoryRing = {
  author: Profile;
  stories: Story[]; // oldest first
  seenIds: Set<string>;
  allSeen: boolean;
  latestAt: string;
};

export async function createStory(userId: string, photoUri: string): Promise<Story> {
  const mediaPath = await uploadMedia(userId, 'stories', photoUri);
  const { data, error } = await supabase
    .from('stories')
    .insert({ user_id: userId, media_path: mediaPath })
    .select('*')
    .single();
  if (error) {
    await deleteMedia([mediaPath]);
    throw error;
  }
  return data as Story;
}

export async function deleteStory(story: Story): Promise<void> {
  const { error } = await supabase.from('stories').delete().eq('id', story.id);
  if (error) throw error;
  await deleteMedia([story.media_path]);
}

// Stories that haven't expired yet. The privacy rules only return yours and your friends'.
async function fetchVisibleStories(onlyUser?: string): Promise<StoryWithAuthor[]> {
  let query = supabase
    .from('stories')
    .select('*, author:profiles(*)')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: true });
  if (onlyUser) query = query.eq('user_id', onlyUser);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as StoryWithAuthor[];
}

async function fetchSeenIds(me: string, storyIds: string[]): Promise<Set<string>> {
  if (storyIds.length === 0) return new Set();
  const { data, error } = await supabase
    .from('story_views')
    .select('story_id')
    .eq('viewer_id', me)
    .in('story_id', storyIds);
  if (error) throw error;
  return new Set((data ?? []).map((row) => row.story_id as string));
}

function groupIntoRings(stories: StoryWithAuthor[], seen: Set<string>): StoryRing[] {
  const byUser = new Map<string, StoryRing>();
  for (const story of stories) {
    if (!story.author) continue;
    const ring = byUser.get(story.user_id) ?? {
      author: story.author,
      stories: [],
      seenIds: seen,
      allSeen: true,
      latestAt: story.created_at,
    };
    ring.stories.push(story);
    ring.latestAt = story.created_at;
    if (!seen.has(story.id)) ring.allSeen = false;
    byUser.set(story.user_id, ring);
  }
  return [...byUser.values()];
}

// For the Stories page: your own ring, then friends (new stories first).
export async function fetchStoryRings(me: string): Promise<{ mine: StoryRing | null; friends: StoryRing[] }> {
  const stories = await fetchVisibleStories();
  const seen = await fetchSeenIds(
    me,
    stories.filter((s) => s.user_id !== me).map((s) => s.id),
  );
  const rings = groupIntoRings(stories, seen);
  const friends = rings
    .filter((ring) => ring.author.id !== me)
    .sort((a, b) => Number(a.allSeen) - Number(b.allSeen) || b.latestAt.localeCompare(a.latestAt));
  return { mine: rings.find((ring) => ring.author.id === me) ?? null, friends };
}

// One person's stories, for the story viewer.
export async function fetchStoryRing(me: string, userId: string): Promise<StoryRing | null> {
  const stories = await fetchVisibleStories(userId);
  const seen = userId === me ? new Set<string>() : await fetchSeenIds(me, stories.map((s) => s.id));
  return groupIntoRings(stories, seen)[0] ?? null;
}

export async function markStorySeen(me: string, storyId: string): Promise<void> {
  await supabase
    .from('story_views')
    .upsert({ story_id: storyId, viewer_id: me }, { onConflict: 'story_id,viewer_id', ignoreDuplicates: true });
}

// Who watched one of your stories.
export async function fetchStoryViewers(storyId: string): Promise<Profile[]> {
  const { data, error } = await supabase
    .from('story_views')
    .select('viewed_at, viewer:profiles!story_views_viewer_id_fkey(*)')
    .eq('story_id', storyId)
    .order('viewed_at', { ascending: false });
  if (error) throw error;
  return (data ?? [])
    .map((row) => (row as unknown as { viewer: Profile | null }).viewer)
    .filter((viewer): viewer is Profile => viewer !== null);
}
