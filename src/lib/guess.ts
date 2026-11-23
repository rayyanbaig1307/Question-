import { serverFailure } from './errors';
import { deleteMedia, mediaFiles, uploadCapture, type Capture } from './media';
import { supabase } from './supabase';
import type { MediaFields, Profile } from './types';

// ---------------------------------------------------------------------------
// Guess Who: a photo or video posted anonymously to your friends for 24 hours. Each friend picks who they
// think posted it from 4 names, then finds out. The database always knows who really posted it, but only
// tells you after you've guessed (see supabase/migrations/…_guess_who.sql).
// ---------------------------------------------------------------------------

export type MysteryPost = {
  id: string;
  media_path: string;
  media_type: 'photo' | 'video';
  poster_path: string | null;
  overlay_path: string | null;
  caption: string;
  created_at: string;
  expires_at: string;
  // You posted it.
  mine: boolean;
  // The names to pick from (someone else's post).
  options: string[] | null;
  // Who you picked, and who it really was – only filled in once you've guessed (or if it's yours).
  my_guess: string | null;
  poster: string | null;
  // Your own posts: how many friends guessed, and how many got it right.
  guess_count: number | null;
  right_count: number | null;
};

export type MysteryFeed = { posts: MysteryPost[]; people: Map<string, Profile> };

export const hasGuessed = (post: MysteryPost) => !post.mine && post.poster !== null;

export async function fetchMysteryFeed(): Promise<MysteryFeed> {
  const { data, error } = await supabase.rpc('mystery_feed');
  if (error) throw error;
  const posts = (data ?? []) as MysteryPost[];
  const ids = [...new Set(posts.flatMap((post) => [...(post.options ?? []), post.poster, post.my_guess]))].filter(
    (id): id is string => !!id,
  );
  const people = new Map<string, Profile>();
  if (ids.length > 0) {
    const { data: profiles, error: profileError } = await supabase.from('profiles').select('*').in('id', ids);
    if (profileError) throw profileError;
    for (const profile of (profiles ?? []) as Profile[]) people.set(profile.id, profile);
  }
  return { posts, people };
}

// How many Guess Who posts from friends you haven't guessed yet. (Just the list: the names to pick from aren't
// needed for a number, so no profiles are downloaded.)
export async function countUnguessed(): Promise<number> {
  const { data, error } = await supabase.rpc('mystery_feed');
  if (error) throw error;
  return ((data ?? []) as MysteryPost[]).filter((post) => !post.mine && post.poster === null).length;
}

export async function postMystery(userId: string, capture: Capture, caption: string): Promise<void> {
  const { fields } = await uploadCapture(userId, 'mystery', capture);
  const { error } = await supabase.from('mystery_posts').insert({ user_id: userId, ...fields, caption: caption.trim() });
  if (error) {
    // Remove the files we just uploaded. If that fails too, still show the real reason the post didn't work.
    await deleteMedia(mediaFiles(fields)).catch((cleanupError) => console.warn('Could not remove an unfinished upload', cleanupError));
    throw error;
  }
}

// Saves a Guess Who (already uploaded into the shared mystery/ folder) with the id given – for the outbox
// (lib/outbox.ts). With `groupId` it's a Guess Who in that group chat (see lib/groupGuess.ts).
export async function insertMystery(
  userId: string,
  post: { id: string; fields: MediaFields; caption: string; groupId?: string | null },
): Promise<{ id: string }> {
  const { error, status } = await supabase.from('mystery_posts').insert({
    id: post.id,
    user_id: userId,
    ...(post.groupId ? { group_id: post.groupId } : {}),
    ...post.fields,
    caption: post.caption.trim(),
  });
  if (error) throw serverFailure(error, status);
  return { id: post.id };
}

// Is your Guess Who with this id saved? (You can always see your own.)
export async function findMystery(postId: string): Promise<{ id: string } | null> {
  const { data, error, status } = await supabase.from('mystery_posts').select('id').eq('id', postId).maybeSingle();
  if (error) throw serverFailure(error, status);
  return (data as { id: string } | null) ?? null;
}

// Make your guess. Returns who really posted it.
export async function guessMystery(postId: string, guess: string): Promise<string> {
  const { data, error } = await supabase.rpc('guess_mystery', { post: postId, guess });
  if (error) throw error;
  return data as string;
}

export async function reportMystery(postId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('report_mystery', { post: postId, reason });
  if (error) throw error;
}

export async function blockMysteryPoster(postId: string): Promise<void> {
  const { error } = await supabase.rpc('block_mystery_poster', { post: postId });
  if (error) throw error;
}

export async function deleteMystery(post: MysteryPost): Promise<void> {
  const { error } = await supabase.from('mystery_posts').delete().eq('id', post.id);
  if (error) throw error;
  await deleteMedia(mediaFiles(post)).catch((cleanupError) => console.warn('Guess Who removed; its files could not be cleaned up yet', cleanupError));
}
