import { randomUUID } from 'expo-crypto';

import { todayDareDay } from './dares';
import { forgetMyDrop, timeZoneOffsetMinutes } from './drop';
import { serverFailure } from './errors';
import { deleteMedia, makeBlurPreview, mediaFiles, uploadCapture, uploadMedia, type Capture } from './media';
import { supabase } from './supabase';
import type { Audience, MediaFields, Post, PostWithAuthor, Story } from './types';

// What a new post row says (the photo or video is already uploaded). Used by createPost and by the outbox
// (lib/outbox.ts), which gives the post its id on the phone before the first try.
export type NewPost = {
  fields: MediaFields;
  blurPath?: string | null;
  caption: string;
  audience?: Audience;
  dare?: boolean;
  drop?: boolean;
  rewind?: boolean;
  forfeit?: string;
};

function postRow(userId: string, post: NewPost) {
  return {
    user_id: userId,
    ...post.fields,
    caption: post.caption.trim(),
    audience: post.audience ?? 'everyone',
    ...(post.dare ? { dare_day: todayDareDay() } : {}),
    ...(post.drop ? { drop_offset_minutes: timeZoneOffsetMinutes(), blur_path: post.blurPath ?? null } : {}),
    ...(post.drop && post.rewind ? { drop_rewound: true } : {}),
    ...(post.forfeit ? { forfeit_id: post.forfeit } : {}),
  };
}

// Saves a post with the id given. For a drop, the server stamps On time / Late at this very moment.
export async function insertPost(userId: string, post: NewPost & { id: string }): Promise<Post> {
  const { data, error, status } = await supabase
    .from('posts')
    .insert({ id: post.id, ...postRow(userId, post) })
    .select('*')
    .single();
  if (error) throw serverFailure(error, status);
  return data as Post;
}

// One of your posts by id (null if it isn't there).
export async function findPost(postId: string): Promise<Post | null> {
  const { data, error, status } = await supabase.from('posts').select('*').eq('id', postId).maybeSingle();
  if (error) throw serverFailure(error, status);
  return (data as Post | null) ?? null;
}

// `dare: true` tags the post as your answer to today's Daily Dare.
// `drop: true` makes it your Peekaboo drop for today (the database works out if it was on time).
export async function createPost(
  userId: string,
  capture: Capture,
  caption: string,
  // `rewind`: ⏰ Peekaboo+ drop rewind – ask the server to post this late drop without the "late" label
  // (it checks Plus and the weekly allowance itself; see post.drop_rewound for the answer).
  options: { dare?: boolean; drop?: boolean; rewind?: boolean; forfeit?: string; audience?: Audience } = {},
): Promise<Post> {
  const { fields, stillUri } = await uploadCapture(userId, 'posts', capture);
  let blurPath: string | null = null;
  try {
    if (options.drop && stillUri) blurPath = await uploadMedia(userId, 'blurs', await makeBlurPreview(stillUri));
    const { data, error } = await supabase
      .from('posts')
      .insert(postRow(userId, { fields, blurPath, caption, ...options }))
      .select('*')
      .single();
    if (error) throw error;
    return data as Post;
  } catch (error) {
    // Something went wrong after the photo/video was uploaded (the blurry preview, or saving the post):
    // remove the files again. If even that fails, you still see the real reason, not the clean-up problem.
    await deleteMedia(mediaFiles({ ...fields, blur_path: blurPath })).catch((cleanupError) => console.warn('Could not remove an unfinished upload', cleanupError));
    throw error;
  }
}

export async function fetchUserPosts(userId: string): Promise<Post[]> {
  const { data, error } = await supabase
    .from('posts')
    .select('*, group_hold')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Post[];
}

export async function fetchPost(postId: string): Promise<PostWithAuthor | null> {
  const { data, error } = await supabase
    .from('posts')
    .select('*, group_hold, peek_stats, dare_hype, author:profiles!posts_user_id_fkey(*)')
    .eq('id', postId)
    .maybeSingle();
  if (error) throw error;
  return data as PostWithAuthor | null;
}

export async function deletePost(post: Post): Promise<void> {
  const { error } = await supabase.from('posts').delete().eq('id', post.id);
  if (error) throw error;
  // It was your drop: every screen forgets it at once (your friends' drops lock again until you post a new one).
  if (post.drop_day) forgetMyDrop(post.user_id, post.drop_day);
  await deleteMedia(mediaFiles(post)).catch((cleanupError) => console.warn('Post removed; its files could not be cleaned up yet', cleanupError));
}

// Change the caption of one of your own posts (after it's posted).
export async function updatePostCaption(postId: string, caption: string): Promise<void> {
  const { error } = await supabase.from('posts').update({ caption: caption.trim() }).eq('id', postId);
  if (error) throw error;
}

// Put one of your stories on your profile grid for good: its photo/video is copied, so the post stays
// after the story disappears.
export async function postFromStory(userId: string, story: Story, caption: string, audience: Audience): Promise<Post> {
  const copied: string[] = [];
  const copy = async (path: string | null) => {
    if (!path) return null;
    const extension = path.match(/\.[a-z0-9]+$/i)?.[0] ?? '';
    const target = `${userId}/posts/${randomUUID()}${extension}`;
    const { error } = await supabase.storage.from('media').copy(path, target);
    if (error) throw error;
    copied.push(target);
    return target;
  };
  try {
    const fields = {
      media_path: (await copy(story.media_path)) as string,
      media_type: story.media_type,
      poster_path: await copy(story.poster_path),
      overlay_path: await copy(story.overlay_path),
    };
    const { data, error } = await supabase
      .from('posts')
      .insert({ user_id: userId, ...fields, caption: caption.trim(), audience })
      .select('*')
      .single();
    if (error) throw error;
    return data as Post;
  } catch (error) {
    // Undo the copies. If even that fails, you still see the real reason it couldn't be posted.
    await deleteMedia(copied).catch((cleanupError) => console.warn('Could not remove an unfinished upload', cleanupError));
    throw error;
  }
}
