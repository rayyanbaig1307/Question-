import { todayDareDay } from './dares';
import { timeZoneOffsetMinutes } from './drop';
import { deleteMedia, makeBlurPreview, mediaFiles, uploadCapture, uploadMedia, type Capture } from './media';
import { supabase } from './supabase';
import type { Audience, Post, PostWithAuthor, Story } from './types';

// `dare: true` tags the post as your answer to today's Daily Dare.
// `drop: true` makes it your Peekaboo drop for today (the database works out if it was on time).
export async function createPost(
  userId: string,
  capture: Capture,
  caption: string,
  options: { dare?: boolean; drop?: boolean; forfeit?: string; audience?: Audience } = {},
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
      audience: options.audience ?? 'everyone',
      ...(options.dare ? { dare_day: todayDareDay() } : {}),
      ...(options.drop ? { drop_offset_minutes: timeZoneOffsetMinutes(), blur_path: blurPath } : {}),
      ...(options.forfeit ? { forfeit_id: options.forfeit } : {}),
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
    .select('*, group_hold')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Post[];
}

export async function fetchPost(postId: string): Promise<PostWithAuthor | null> {
  const { data, error } = await supabase
    .from('posts')
    .select('*, group_hold, peek_stats, dare_verdict, author:profiles!posts_user_id_fkey(*)')
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
    const target = `${userId}/posts/${path.split('/').pop()}`;
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
    await deleteMedia(copied);
    throw error;
  }
}
