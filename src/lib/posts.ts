import { todayDareDay } from './dares';
import { timeZoneOffsetMinutes } from './drop';
import { deleteMedia, makeBlurPreview, mediaFiles, uploadCapture, uploadMedia, type Capture } from './media';
import { supabase } from './supabase';
import type { Post, PostWithAuthor } from './types';

// `dare: true` tags the post as your answer to today's Daily Dare.
// `drop: true` makes it your Peekaboo drop for today (the database works out if it was on time).
export async function createPost(
  userId: string,
  capture: Capture,
  caption: string,
  options: { dare?: boolean; drop?: boolean } = {},
): Promise<Post> {
  const { fields, stillUri } = await uploadCapture(userId, 'posts', capture);
  const blurPath =
    options.drop && stillUri ? await uploadMedia(userId, 'blurs', await makeBlurPreview(stillUri)) : null;
  const { data, error } = await supabase
    .from('posts')
    .insert({
      user_id: userId,
      ...fields,
      caption: caption.trim(),
      ...(options.dare ? { dare_day: todayDareDay() } : {}),
      ...(options.drop ? { drop_offset_minutes: timeZoneOffsetMinutes(), blur_path: blurPath } : {}),
    })
    .select('*')
    .single();
  if (error) {
    await deleteMedia(mediaFiles({ ...fields, blur_path: blurPath }));
    throw error;
  }
  return data as Post;
}

export async function fetchUserPosts(userId: string): Promise<Post[]> {
  const { data, error } = await supabase
    .from('posts')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Post[];
}

export async function fetchPost(postId: string): Promise<PostWithAuthor | null> {
  const { data, error } = await supabase
    .from('posts')
    .select('*, author:profiles!posts_user_id_fkey(*)')
    .eq('id', postId)
    .maybeSingle();
  if (error) throw error;
  return data as PostWithAuthor | null;
}

export async function deletePost(post: Post): Promise<void> {
  const { error } = await supabase.from('posts').delete().eq('id', post.id);
  if (error) throw error;
  await deleteMedia(mediaFiles(post));
}
