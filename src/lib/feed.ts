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
  // The comment this one replies to (replies are only ever one level deep).
  parent_id: string | null;
  author: Profile | null;
  likeCount: number;
  likedByMe: boolean;
};

type CommentRow = Omit<Comment, 'likeCount' | 'likedByMe'> & { comment_likes: { count: number }[] };
const COMMENT_FIELDS = '*, author:profiles!comments_user_id_fkey(*), comment_likes(count)';

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

// Where Discover is up to: first your friends' posts (and yours), then everyone else's public posts.
export type DiscoverCursor = { phase: 'friends' | 'everyone'; before?: string };
export type DiscoverPost = FeedPost & { fromEveryone: boolean };

const POST_FIELDS = '*, group_hold, peek_stats, dare_verdict, author:profiles!posts_user_id_fkey(*), likes(count), comments(count)';

// Discover, Instagram-style: your friends' posts and yours, newest first – and when those run out,
// everyone else on Peekaboo. (The database leaves out private accounts you're not friends with, and anyone
// blocked.) Returns the next cursor, or null when there's nothing more.
export async function fetchDiscover(
  me: string,
  cursor: DiscoverCursor = { phase: 'friends' },
): Promise<{ posts: DiscoverPost[]; next: DiscoverCursor | null }> {
  const friends = await fetchFriends(me);
  const circle = [me, ...friends.map((friend) => friend.id)];
  const everyone = cursor.phase === 'everyone';

  let query = supabase.from('posts').select(POST_FIELDS).order('created_at', { ascending: false }).limit(FEED_PAGE_SIZE);
  query = everyone ? query.not('user_id', 'in', `(${circle.join(',')})`) : query.in('user_id', circle);
  if (cursor.before) query = query.lt('created_at', cursor.before);
  const { data, error } = await query;
  if (error) throw error;

  const page = (await withLikes(me, (data ?? []) as PostRow[])).map((post) => ({ ...post, fromEveryone: everyone }));
  if (page.length === FEED_PAGE_SIZE) {
    return { posts: page, next: { phase: cursor.phase, before: page[page.length - 1].created_at } };
  }
  if (everyone) return { posts: page, next: null };
  // Friends' posts ran out: carry straight on with everyone else's.
  const rest = await fetchDiscover(me, { phase: 'everyone' });
  return { posts: [...page, ...rest.posts], next: rest.next };
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

// All comments on a post (oldest first), with their likes.
export async function fetchComments(me: string, postId: string): Promise<Comment[]> {
  const { data, error } = await supabase
    .from('comments')
    .select(COMMENT_FIELDS)
    .eq('post_id', postId)
    .order('created_at', { ascending: true })
    .limit(300);
  if (error) throw error;
  const rows = (data ?? []) as CommentRow[];
  const liked = new Set<string>();
  if (rows.length > 0) {
    const { data: mine, error: likesError } = await supabase
      .from('comment_likes')
      .select('comment_id')
      .eq('user_id', me)
      .in('comment_id', rows.map((row) => row.id));
    if (likesError) throw likesError;
    for (const row of mine ?? []) liked.add(row.comment_id as string);
  }
  return rows.map(({ comment_likes, ...comment }) => ({
    ...comment,
    likeCount: comment_likes?.[0]?.count ?? 0,
    likedByMe: liked.has(comment.id),
  }));
}

// Add a comment – or, with `replyTo`, a reply to another comment.
export async function addComment(me: string, postId: string, body: string, replyTo?: string | null): Promise<Comment> {
  const { data, error } = await supabase
    .from('comments')
    .insert({ post_id: postId, user_id: me, body: body.trim(), parent_id: replyTo ?? null })
    .select(COMMENT_FIELDS)
    .single();
  if (error) throw error;
  const { comment_likes: _ignored, ...comment } = data as CommentRow;
  return { ...comment, likeCount: 0, likedByMe: false };
}

export async function setCommentLiked(me: string, commentId: string, liked: boolean): Promise<void> {
  const { error } = liked
    ? await supabase
        .from('comment_likes')
        .upsert({ comment_id: commentId, user_id: me }, { onConflict: 'comment_id,user_id', ignoreDuplicates: true })
    : await supabase.from('comment_likes').delete().eq('comment_id', commentId).eq('user_id', me);
  if (error) throw error;
}

export async function deleteComment(commentId: string): Promise<void> {
  const { error } = await supabase.from('comments').delete().eq('id', commentId);
  if (error) throw error;
}
