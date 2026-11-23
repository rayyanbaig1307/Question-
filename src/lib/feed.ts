import { serverFailure } from './errors';
import { fetchFriendIds } from './friends';
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

// Where Discover is up to: first your friends' posts (and yours), then everyone else's public posts. `circle` is you
// and your friends (found once for the first page and kept for "load more").
export type DiscoverCursor = { phase: 'friends' | 'everyone'; before?: string; circle?: string[] };
export type DiscoverPost = FeedPost & { fromEveryone: boolean };

const POST_FIELDS = '*, group_hold, peek_stats, dare_hype, author:profiles!posts_user_id_fkey(*), likes(count), comments(count)';
// The same, plus your own like on each post (`my_like`, filtered to just you), so the likes don't need a request
// of their own after the posts have arrived.
const POST_FIELDS_WITH_MY_LIKE = `${POST_FIELDS}, my_like:likes(user_id)`;

// If the server ever says it can't do the like-inside request, the likes are asked for separately (as before) for
// the rest of the time the app is open. A lost answer or no internet never counts as that.
let likesInside = true;
function cantDoLikesInside(error: { code?: string } | null, status: number): boolean {
  return !!error && (status === 400 || /^PGRST/.test(error.code ?? '') || error.code === '42703');
}

type PostRowWithMyLike = PostRow & { my_like?: { user_id: string }[] | null };

// One page of posts: your circle's (friends and you), or everyone else's.
async function postsPage(me: string, circle: string[], everyone: boolean, before?: string): Promise<DiscoverPost[]> {
  const ask = (fields: string) => {
    let query = supabase.from('posts').select(fields).order('created_at', { ascending: false }).limit(FEED_PAGE_SIZE);
    query = everyone ? query.not('user_id', 'in', `(${circle.join(',')})`) : query.in('user_id', circle);
    if (before) query = query.lt('created_at', before);
    return query;
  };
  let rows: FeedPost[] | null = null;
  if (likesInside) {
    const { data, error, status } = await ask(POST_FIELDS_WITH_MY_LIKE).eq('my_like.user_id', me);
    if (!error) {
      rows = ((data ?? []) as unknown as PostRowWithMyLike[]).map(({ likes, comments, my_like, ...post }) => ({
        ...post,
        likeCount: likes?.[0]?.count ?? 0,
        commentCount: comments?.[0]?.count ?? 0,
        // (Checked by person too, so even a server that ignored the filter can't mark someone else's like as yours.)
        likedByMe: (my_like ?? []).some((like) => like.user_id === me),
      }));
    } else if (cantDoLikesInside(error, status)) {
      likesInside = false;
    } else {
      throw error;
    }
  }
  if (!rows) {
    const { data, error } = await ask(POST_FIELDS);
    if (error) throw error;
    rows = await withLikes(me, (data ?? []) as unknown as PostRow[]);
  }
  return rows.map((post) => ({ ...post, fromEveryone: everyone }));
}

// Did your friends' posts run out on the first page last time (per person)? Then the first page asks for
// everyone's posts at the same time as your friends' (one round trip instead of two). With plenty of friends'
// posts, it doesn't (no wasted download).
let shortLastTime: { me: string; short: boolean } | null = null;

// Discover, Instagram-style: your friends' posts and yours, newest first – and when those run out,
// everyone else on Peekaboo. (The database leaves out private accounts you're not friends with, and anyone
// blocked.) Returns the next cursor, or null when there's nothing more.
export async function fetchDiscover(
  me: string,
  cursor: DiscoverCursor = { phase: 'friends' },
): Promise<{ posts: DiscoverPost[]; next: DiscoverCursor | null }> {
  // Just the ids of your friends (a small request), once per first page.
  const circle = cursor.circle ?? [me, ...(await fetchFriendIds(me))];
  const nextAfter = (posts: DiscoverPost[], phase: DiscoverCursor['phase']): DiscoverCursor | null =>
    posts.length === FEED_PAGE_SIZE ? { phase, before: posts[posts.length - 1].created_at, circle } : null;

  if (cursor.phase === 'everyone') {
    const posts = await postsPage(me, circle, true, cursor.before);
    return { posts, next: nextAfter(posts, 'everyone') };
  }

  const firstPage = !cursor.before;
  const askEveryoneNow = firstPage && (shortLastTime?.me !== me || shortLastTime.short);
  const everyoneNow = askEveryoneNow ? postsPage(me, circle, true) : null;
  // (If it isn't needed after all, a failure there is no problem.)
  everyoneNow?.catch(() => {});
  const friendsPosts = await postsPage(me, circle, false, cursor.before);
  if (firstPage) shortLastTime = { me, short: friendsPosts.length < FEED_PAGE_SIZE };
  if (friendsPosts.length === FEED_PAGE_SIZE) return { posts: friendsPosts, next: nextAfter(friendsPosts, 'friends') };
  // Your friends' posts ran out: carry straight on with everyone else's.
  const rest = await (everyoneNow ?? postsPage(me, circle, true));
  return { posts: [...friendsPosts, ...rest], next: nextAfter(rest, 'everyone') };
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

// Saves a comment with the id given – for the outbox (lib/outbox.ts).
export async function insertComment(
  me: string,
  comment: { id: string; postId: string; body: string; parentId: string | null },
): Promise<Comment> {
  const { data, error, status } = await supabase
    .from('comments')
    .insert({ id: comment.id, post_id: comment.postId, user_id: me, body: comment.body.trim(), parent_id: comment.parentId })
    .select(COMMENT_FIELDS)
    .single();
  if (error) throw serverFailure(error, status);
  const { comment_likes: _ignored, ...saved } = data as CommentRow;
  return { ...saved, likeCount: 0, likedByMe: false };
}

// A comment by id (null if it isn't there).
export async function findComment(commentId: string): Promise<Comment | null> {
  const { data, error, status } = await supabase.from('comments').select(COMMENT_FIELDS).eq('id', commentId).maybeSingle();
  if (error) throw serverFailure(error, status);
  if (!data) return null;
  const { comment_likes, ...saved } = data as CommentRow;
  return { ...saved, likeCount: comment_likes?.[0]?.count ?? 0, likedByMe: false };
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
