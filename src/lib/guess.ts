import { deleteMedia, mediaFiles, uploadCapture, type Capture } from './media';
import { supabase } from './supabase';
import type { Profile } from './types';

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

// How many Guess Who posts from friends you haven't guessed yet.
export async function countUnguessed(): Promise<number> {
  const { posts } = await fetchMysteryFeed();
  return posts.filter((post) => !post.mine && post.poster === null).length;
}

export async function postMystery(userId: string, capture: Capture, caption: string): Promise<void> {
  const { fields } = await uploadCapture(userId, 'mystery', capture);
  const { error } = await supabase.from('mystery_posts').insert({ user_id: userId, ...fields, caption: caption.trim() });
  if (error) {
    await deleteMedia(mediaFiles(fields));
    throw error;
  }
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
  await deleteMedia(mediaFiles(post));
}
