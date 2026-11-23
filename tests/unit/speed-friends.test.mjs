import { expect, it } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

// Speed fix 1 (src/lib/friends.ts): your friend list is asked for once, not once per screen. The logs showed the
// friendships table read up to 6 times when the app opened (Home's feed, Chat, the badges, "Send to…"…), each one
// waiting its turn on a weak signal. Screens asking at the same moment now share the request that's already on its
// way, and "Send to…" starts from the last list it knows.

// A pretend Supabase: every friendships request waits until the test answers it.
function fakeServer() {
  const requests = [];
  const rpcs = [];
  const supabase = {
    from(table) {
      const request = { table, calls: [] };
      const chain = {};
      for (const method of ['select', 'or', 'order', 'eq', 'delete', 'in']) {
        chain[method] = (...args) => { request.calls.push([method, ...args]); return chain; };
      }
      let answer;
      const done = new Promise((resolve) => { answer = resolve; });
      request.answer = (data, error = null) => answer({ data, error });
      chain.then = (resolve, reject) => done.then(resolve, reject);
      requests.push(request);
      return chain;
    },
    rpc: async (name, args) => { rpcs.push([name, args]); return { data: 'pending', error: null }; },
  };
  return { supabase, requests, rpcs };
}

const person = (id, name) => ({ id, username: id, display_name: name, avatar_path: null });
const link = (id, requester, addressee, status = 'accepted') => ({
  id, requester_id: requester, addressee_id: addressee, status, created_at: '2026-11-20T10:00:00Z',
  requester: person(requester, requester.toUpperCase()), addressee: person(addressee, addressee.toUpperCase()),
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

it('screens asking for your friends at the same moment share one request', async () => {
  const server = fakeServer();
  const lib = loadLibrary('friends', { supabase: server.supabase });
  const first = lib.fetchFriends('me');
  const second = lib.fetchFriends('me');
  const links = lib.fetchMyFriendLinks('me');
  expect(server.requests.length).toBe(1);
  server.requests[0].answer([link('l1', 'me', 'ray'), link('l2', 'sam', 'me', 'pending')]);
  expect((await first).map((f) => f.id)).toEqual(['ray']);
  expect((await second).map((f) => f.id)).toEqual(['ray']);
  expect((await links).length).toBe(2);
  // Once it's in, the next ask is a fresh request (the list may have changed since).
  lib.fetchFriends('me');
  expect(server.requests.length).toBe(2);
});

it('a different person never shares the request or the list of the one before', async () => {
  const server = fakeServer();
  const lib = loadLibrary('friends', { supabase: server.supabase });
  const mine = lib.fetchFriends('me');
  const theirs = lib.fetchFriends('other');
  expect(server.requests.length).toBe(2);
  server.requests[0].answer([link('l1', 'me', 'ray')]);
  await mine;
  expect(lib.cachedFriends('me').map((f) => f.id)).toEqual(['ray']);
  expect(lib.cachedFriends('other')).toBe(null);
  server.requests[1].answer([link('l9', 'other', 'zed')]);
  await theirs;
  // Only the last person's list is kept: a login change leaves nothing of the one before.
  expect(lib.cachedFriends('other').map((f) => f.id)).toEqual(['zed']);
  expect(lib.cachedFriends('me')).toBe(null);
});

it('a failed request is not kept: the next ask tries again', async () => {
  const server = fakeServer();
  const lib = loadLibrary('friends', { supabase: server.supabase });
  const failed = lib.fetchFriends('me');
  server.requests[0].answer(null, { message: 'Network request failed' });
  await expect(failed).rejects.toMatchObject({ message: 'Network request failed' });
  const again = lib.fetchFriends('me');
  expect(server.requests.length).toBe(2);
  server.requests[1].answer([link('l1', 'me', 'ray')]);
  expect((await again).map((f) => f.id)).toEqual(['ray']);
});

it('after you add, answer or remove someone, the next load never reuses a request from before the change', async () => {
  for (const change of [
    (lib) => lib.sendFriendRequest('zed'),
    (lib) => lib.respondToRequest('l2', true),
    (lib) => lib.removeFriendLink('l1'),
  ]) {
    const server = fakeServer();
    const lib = loadLibrary('friends', { supabase: server.supabase });
    const before = lib.fetchMyFriendLinks('me');
    const changing = change(lib);
    // removeFriendLink is a delete on the friendships table: answer it.
    const deleteRequest = server.requests.find((request) => request.calls.some(([method]) => method === 'delete'));
    deleteRequest?.answer(null);
    await changing;
    lib.fetchMyFriendLinks('me');
    const loads = server.requests.filter((request) => request.calls.some(([method]) => method === 'select'));
    expect(loads.length).toBe(2);
    loads.forEach((request) => request.answer([]));
    await before;
  }
});

it('your friend ids for the feed come from a light request (no profiles), shared the same way', async () => {
  const server = fakeServer();
  const lib = loadLibrary('friends', { supabase: server.supabase });
  const ids = lib.fetchFriendIds('me');
  const again = lib.fetchFriendIds('me');
  expect(server.requests.length).toBe(1);
  const [, columns] = server.requests[0].calls.find(([method]) => method === 'select');
  expect(columns).not.toMatch(/profiles/);
  expect(server.requests[0].calls).toContainEqual(['eq', 'status', 'accepted']);
  server.requests[0].answer([
    { requester_id: 'me', addressee_id: 'ray' },
    { requester_id: 'sam', addressee_id: 'me' },
  ]);
  expect(await ids).toEqual(['ray', 'sam']);
  expect(await again).toEqual(['ray', 'sam']);
  await flush();
});

it('a moment after the app opens, the friend list is loaded once in the background (only if this phone has none yet)', async () => {
  const server = fakeServer();
  const lib = loadLibrary('friends', { supabase: server.supabase });
  lib.warmFriends('me');
  expect(server.requests.length).toBe(1);
  server.requests[0].answer([link('l1', 'me', 'ray')]);
  await flush();
  expect(lib.cachedFriends('me').map((f) => f.id)).toEqual(['ray']);
  lib.warmFriends('me');
  expect(server.requests.length).toBe(1);
});
