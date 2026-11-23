import { expect, it } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

// Speed fix 4: Home's feed (src/lib/feed.ts fetchDiscover) in 1–2 round trips instead of 3–6 in a row.
// Before: your full friend list (with profiles) → your friends' posts → which of them you liked → (fewer than 15?)
// your friend list AGAIN → everyone's posts → which of those you liked. Each step waited for the one before.
// Now: just your friends' ids (a small request) → your friends' posts and everyone's posts at the same time, each
// with your own like inside (no extra request for likes). "Load more" reuses the ids.
// Also the Guess Who number on Home (src/lib/guess.ts countUnguessed) no longer downloads profiles it never shows.

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// A pretend Supabase that writes down every request. Answers come from `answer(table, request)`; `hold` keeps the
// posts requests waiting until the test lets them go (to see which ones were asked at the same time).
function fakeServer(answer, { hold = false } = {}) {
  const requests = [];
  const waiting = [];
  const supabase = {
    from(table) {
      const request = { table, calls: [] };
      const chain = {};
      for (const method of ['select', 'or', 'order', 'eq', 'in', 'not', 'lt', 'limit']) {
        chain[method] = (...args) => { request.calls.push([method, ...args]); return chain; };
      }
      chain.then = (resolve, reject) => {
        const reply = () => Promise.resolve(answer(table, request)).then(resolve, reject);
        if (hold && table === 'posts') waiting.push(reply);
        else reply();
      };
      requests.push(request);
      return chain;
    },
    rpc: async (name) => { requests.push({ table: `rpc:${name}`, calls: [] }); return answer(`rpc:${name}`, null); },
  };
  return { supabase, requests, release: () => waiting.splice(0).forEach((reply) => reply()) };
}

const has = (request, ...call) => request.calls.some((entry) => JSON.stringify(entry.slice(0, call.length)) === JSON.stringify(call));
const isEveryone = (request) => request.calls.some(([method]) => method === 'not');
const post = (id, user, { liked = false, at = `2026-11-22T10:${String(60 - Number(id.replace(/\D/g, '') || 0)).padStart(2, '0')}:00Z` } = {}) => ({
  id, user_id: user, created_at: at, drop_day: null, media_path: `${user}/posts/${id}.jpg`, media_type: 'photo',
  author: { id: user, username: user }, likes: [{ count: 3 }], comments: [{ count: 1 }],
  my_like: liked ? [{ user_id: 'me' }] : [],
});
const page = (prefix, user, count) => Array.from({ length: count }, (_, n) => post(`${prefix}${n + 1}`, user));

function friendsAndEveryone({ friendsPosts, everyonePosts, onLikes }) {
  return (table, request) => {
    if (table === 'friendships') return { data: [{ requester_id: 'me', addressee_id: 'ray' }, { requester_id: 'sam', addressee_id: 'me' }], error: null };
    if (table === 'posts') return { data: isEveryone(request) ? everyonePosts : friendsPosts, error: null, status: 200 };
    if (table === 'likes') { onLikes?.(); return { data: [], error: null }; }
    return { data: [], error: null };
  };
}

it('first page: a light friend-id request, then your friends\' posts and everyone\'s posts at the same time, likes inside', async () => {
  const server = fakeServer(friendsAndEveryone({
    friendsPosts: [post('f1', 'ray', { liked: true }), post('f2', 'me')],
    everyonePosts: [post('e1', 'zed')],
  }), { hold: true });
  const feed = loadLibrary('feed', { supabase: server.supabase });
  const loading = feed.fetchDiscover('me');
  await flush();
  const friendships = server.requests.filter((r) => r.table === 'friendships');
  expect(friendships).toHaveLength(1);
  const [, columns] = friendships[0].calls.find(([method]) => method === 'select');
  expect(columns).not.toMatch(/profiles/);
  // Both posts requests are on their way before either has answered.
  const posts = server.requests.filter((r) => r.table === 'posts');
  expect(posts).toHaveLength(2);
  expect(posts.every((r) => has(r, 'eq', 'my_like.user_id', 'me'))).toBe(true);
  expect(posts.find((r) => !isEveryone(r)).calls).toContainEqual(['in', 'user_id', ['me', 'ray', 'sam']]);
  expect(posts.find(isEveryone).calls).toContainEqual(['not', 'user_id', 'in', '(me,ray,sam)']);
  server.release();
  const result = await loading;
  expect(result.posts.map((p) => [p.id, p.fromEveryone, p.likedByMe, p.likeCount, p.commentCount])).toEqual([
    ['f1', false, true, 3, 1],
    ['f2', false, false, 3, 1],
    ['e1', true, false, 3, 1],
  ]);
  expect(result.posts[0]).not.toHaveProperty('my_like');
  expect(result.next).toBe(null);
  // No separate likes request, and the friend list was asked for once.
  expect(server.requests.filter((r) => r.table === 'likes')).toHaveLength(0);
  expect(server.requests.map((r) => r.table)).toEqual(['friendships', 'posts', 'posts']);
});

it('a full page of friends\' posts: "load more" reuses the friend ids, and everyone\'s posts are only asked for when needed', async () => {
  const server = fakeServer(friendsAndEveryone({ friendsPosts: page('f', 'ray', 15), everyonePosts: [post('e1', 'zed')] }));
  const feed = loadLibrary('feed', { supabase: server.supabase });
  const first = await feed.fetchDiscover('me');
  expect(first.posts).toHaveLength(15);
  expect(first.next).toMatchObject({ phase: 'friends', before: first.posts[14].created_at });
  // Last time your friends had a full page: the next first page doesn't ask for everyone's at the same time.
  server.requests.length = 0;
  await feed.fetchDiscover('me');
  expect(server.requests.map((r) => r.table)).toEqual(['friendships', 'posts']);
  // Load more: no friend-id request.
  server.requests.length = 0;
  await feed.fetchDiscover('me', first.next);
  expect(server.requests.filter((r) => r.table === 'friendships')).toHaveLength(0);
  expect(server.requests[0].calls).toContainEqual(['lt', 'created_at', first.posts[14].created_at]);
});

it('a server that refuses the like-inside request still works: likes are asked for separately, from then on straight away', async () => {
  let likes = 0;
  const answer = (table, request) => {
    if (table === 'posts' && has(request, 'eq', 'my_like.user_id', 'me')) {
      return { data: null, error: { code: 'PGRST100', message: 'failed to parse filter' }, status: 400 };
    }
    if (table === 'likes') { likes++; return { data: [{ post_id: 'f1' }], error: null }; }
    const base = friendsAndEveryone({ friendsPosts: [post('f1', 'ray'), post('f2', 'ray')], everyonePosts: [] });
    const reply = base(table, request);
    if (table === 'posts') reply.data = reply.data.map(({ my_like: _gone, ...row }) => row);
    return reply;
  };
  const server = fakeServer(answer);
  const feed = loadLibrary('feed', { supabase: server.supabase });
  const result = await feed.fetchDiscover('me');
  expect(result.posts.map((p) => [p.id, p.likedByMe])).toEqual([['f1', true], ['f2', false]]);
  expect(likes).toBeGreaterThan(0);
  // Next time it doesn't try the refused way first.
  server.requests.length = 0;
  await feed.fetchDiscover('me');
  expect(server.requests.filter((r) => r.table === 'posts').every((r) => !has(r, 'eq', 'my_like.user_id', 'me'))).toBe(true);
});

it('a lost answer is never mistaken for "this server can\'t do likes inside"', async () => {
  let fail = true;
  const answer = (table, request) => {
    if (table === 'posts' && fail) return { data: null, error: { message: 'AbortError: Aborted', code: '' }, status: 0 };
    return friendsAndEveryone({ friendsPosts: [post('f1', 'ray', { liked: true })], everyonePosts: [] })(table, request);
  };
  const server = fakeServer(answer);
  const feed = loadLibrary('feed', { supabase: server.supabase });
  await expect(feed.fetchDiscover('me')).rejects.toBeTruthy();
  fail = false;
  server.requests.length = 0;
  const result = await feed.fetchDiscover('me');
  expect(result.posts[0].likedByMe).toBe(true);
  expect(server.requests.filter((r) => r.table === 'posts').every((r) => has(r, 'eq', 'my_like.user_id', 'me'))).toBe(true);
});

it('the Guess Who number only asks the Guess Who list (no profiles download)', async () => {
  const server = fakeServer((table) => (table === 'rpc:mystery_feed'
    ? { data: [
      { id: 'a', mine: false, poster: null, options: ['ray', 'sam'] },
      { id: 'b', mine: false, poster: 'sam', options: ['ray', 'sam'] },
      { id: 'c', mine: true, poster: 'me', options: null },
    ], error: null }
    : { data: [], error: null }));
  const guess = loadLibrary('guess', { supabase: server.supabase, mocks: { './media': {} } });
  expect(await guess.countUnguessed()).toBe(1);
  expect(server.requests.map((r) => r.table)).toEqual(['rpc:mystery_feed']);
});
