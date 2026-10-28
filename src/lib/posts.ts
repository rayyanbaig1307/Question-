import { todayDareDay } from './dares';
import { deleteMedia, uploadMedia } from './media';
import { supabase } from './supabase';
import type { Post, PostWithAuthor } from './types';

// `dare: true` tags the post as your answer to today's Daily Dare.
export async function createPost(
  userId: string,
  photoUri: string,
  caption: string,
  options: { dare?: boolean } = {},
): Promise<Post> {
  const mediaPath = await uploadMedia(userId, 'posts', photoUri);
  const { data, error } = await supabase
    .from('posts')
    .insert({
      user_id: userId,
      media_path: mediaPath,
      caption: caption.trim(),
      ...(options.dare ? { dare_day: todayDareDay() } : {}),
    })
    .select('*')
    .single();
  if (error) {
    await deleteMedia([mediaPath]);
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
  await deleteMedia([post.media_path]);
}
