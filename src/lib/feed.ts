import { fetchFriends } from './friends';
import { supabase } from './supabase';
import type { PostWithAuthor, Profile } from './types';

export type FeedPost = PostWithAuthor & {
  likeCount: number;
  commentCount: number;
  likedByMe: boolean;
};

export type Comment = {
  id: string;
  post_id: string;
  user_id: string;
  body: string;
  created_at: string;
  author: Profile | null;
};

export const FEED_PAGE_SIZE = 15;

export type PostStats = Pick<FeedPost, 'likeCount' | 'commentCount' | 'likedByMe'>;

type PostRow = PostWithAuthor & { likes: { count: number }[]; comments: { count: number }[] };

async function withLikes(me: string, rows: PostRow[]): Promise<FeedPost[]> {
  const ids = rows.map((row) => row.id);
  const liked = new Set<string>();
  if (ids.length > 0) {
    const { data, error } = await supabase.from('likes').select('post_id').eq('user_id', me).in('post_id', ids);
    if (error) throw error;
    for (const row of data ?? []) liked.add(row.post_id as string);
  }
  return rows.map(({ likes, comments, ...post }) => ({
    ...post,
    likeCount: likes?.[0]?.count ?? 0,
    commentCount: comments?.[0]?.count ?? 0,
    likedByMe: liked.has(post.id),
  }));
}

// Newest posts from you and your friends. Pass `before` (a date) to load older ones.
export async function fetchFeed(me: string, before?: string): Promise<FeedPost[]> {
  const friends = await fetchFriends(me);
  const authors = [me, ...friends.map((friend) => friend.id)];
  let query = supabase
    .from('posts')
    .select('*, author:profiles!posts_user_id_fkey(*), likes(count), comments(count)')
    .in('user_id', authors)
    .order('created_at', { ascending: false })
    .limit(FEED_PAGE_SIZE);
  if (before) query = query.lt('created_at', before);
  const { data, error } = await query;
  if (error) throw error;
  return withLikes(me, (data ?? []) as PostRow[]);
}

// Likes + comments for one post (used on the full-screen photo).
export async function fetchPostStats(me: string, postId: string): Promise<PostStats | null> {
  const { data, error } = await supabase
    .from('posts')
    .select('*, author:profiles!posts_user_id_fkey(*), likes(count), comments(count)')
    .eq('id', postId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const [post] = await withLikes(me, [data as PostRow]);
  return { likeCount: post.likeCount, commentCount: post.commentCount, likedByMe: post.likedByMe };
}

export async function setLiked(me: string, postId: string, liked: boolean): Promise<void> {
  const { error } = liked
    ? await supabase
        .from('likes')
        .upsert({ post_id: postId, user_id: me }, { onConflict: 'post_id,user_id', ignoreDuplicates: true })
    : await supabase.from('likes').delete().eq('post_id', postId).eq('user_id', me);
  if (error) throw error;
}

export async function fetchComments(postId: string): Promise<Comment[]> {
  const { data, error } = await supabase
    .from('comments')
    .select('*, author:profiles!comments_user_id_fkey(*)')
    .eq('post_id', postId)
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) throw error;
  return (data ?? []) as Comment[];
}

export async function addComment(me: string, postId: string, body: string): Promise<Comment> {
  const { data, error } = await supabase
    .from('comments')
    .insert({ post_id: postId, user_id: me, body: body.trim() })
    .select('*, author:profiles!comments_user_id_fkey(*)')
    .single();
  if (error) throw error;
  return data as Comment;
}

export async function deleteComment(commentId: string): Promise<void> {
  const { error } = await supabase.from('comments').delete().eq('id', commentId);
  if (error) throw error;
}
