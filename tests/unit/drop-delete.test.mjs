import { expect, it, vi } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

// Deleting your own drop (src/lib/posts.ts deletePost → forgetMyDrop in src/lib/drop.ts). The drop you just posted
// is remembered on the phone so your friends' drops unlock the moment it's saved. Before this fix, deleting it
// didn't forget it: the app kept every drop "open" while the server locked them again (they showed as empty cards,
// not the blurry "post your drop" ones), and the camera and Home disagreed until the app was restarted.

// The app's hooks, run without React: a hook just gives its current answer, and we keep its "tell me when it
// changes" function so the test can listen too.
function setup({ deleteError = null } = {}) {
  const subscribers = [];
  const react = {
    useSyncExternalStore: (subscribe, get) => { subscribers.push(subscribe); return get(); },
    useMemo: (make) => make(),
    useEffect() {},
    useState: (start) => [typeof start === 'function' ? start() : start, () => {}],
  };
  const drop = loadLibrary('drop', { mocks: { react } });
  const deleted = [];
  const supabase = {
    from: (table) => ({
      delete: () => ({
        eq: (_column, id) => ({
          then: (resolve, reject) => {
            if (!deleteError) deleted.push([table, id]);
            return Promise.resolve({ error: deleteError }).then(resolve, reject);
          },
        }),
      }),
    }),
  };
  const posts = loadLibrary('posts', {
    supabase,
    mocks: {
      './drop': drop,
      './dares': { todayDareDay: () => '2026-11-23' },
      './errors': { serverFailure: () => null },
      './media': { deleteMedia: async () => {}, mediaFiles: (row) => [row.media_path] },
    },
  });
  const listen = (listener) => {
    drop.useMyDropPosts();
    return subscribers.at(-1)(listener);
  };
  return { drop, posts, deleted, listen };
}

const myDrop = (day) => ({ id: `drop-${day}`, user_id: 'me', drop_day: day, media_path: `me/posts/${day}.jpg`, media_type: 'photo', poster_path: null, overlay_path: null, blur_path: `me/blurs/${day}.jpg` });
const friendsDrop = (day) => ({ ...myDrop(day), id: `friend-${day}`, user_id: 'friend', media_path: `friend/posts/${day}.jpg`, blur_path: `friend/blurs/${day}.jpg` });

it('deleting the drop you just posted forgets it at once: friends\' drops lock again, the camera offers the drop again, screens load again', async () => {
  const { drop, posts, deleted, listen } = setup();
  const today = drop.localDay();
  drop.noteMyDropPosted('me', { drop_day: today, drop_offset_minutes: drop.timeZoneOffsetMinutes() });
  // Home's own load (from before you posted) has no drop: the one you just posted opens everything.
  const mine = () => drop.useWithMyNewDrop('me', drop.NO_DROPS);
  expect(drop.dropKeyOpen(mine())).toBe(true);
  expect(drop.postMedia(friendsDrop(today), 'me', mine())).toMatchObject({ locked: false, still: `friend/posts/${today}.jpg` });
  expect(drop.useDropDone('me', false)).toBe(true);
  const loadsBefore = drop.useMyDropPosts();
  const told = vi.fn();
  listen(told);

  await posts.deletePost(myDrop(today));

  expect(deleted).toEqual([['posts', `drop-${today}`]]);
  expect(drop.dropKeyOpen(mine())).toBe(false);
  expect(mine().days.has(today)).toBe(false);
  // A friend's drop gets its blurry preview again (the server won't show you the real one any more).
  expect(drop.postMedia(friendsDrop(today), 'me', mine())).toMatchObject({ locked: true, lock: 'drop', still: `friend/blurs/${today}.jpg` });
  // The camera offers the drop again, and screens that loaded your drops before load them again.
  expect(drop.useDropDone('me', false)).toBe(false);
  expect(drop.useMyDropPosts()).toBe(loadsBefore + 1);
  expect(told).toHaveBeenCalled();
});

it('deleting an older drop, a normal post, or a delete that fails leaves the drop you just posted alone', async () => {
  const { drop, posts, listen } = setup();
  const today = drop.localDay();
  drop.noteMyDropPosted('me', { drop_day: today, drop_offset_minutes: drop.timeZoneOffsetMinutes() });
  const mine = () => drop.useWithMyNewDrop('me', drop.NO_DROPS);
  const told = vi.fn();
  listen(told);

  await posts.deletePost({ ...myDrop(today), id: 'normal', drop_day: null });
  expect(told).not.toHaveBeenCalled();
  expect(drop.dropKeyOpen(mine())).toBe(true);

  await posts.deletePost(myDrop('2026-01-01'));
  expect(drop.dropKeyOpen(mine())).toBe(true);
  expect(drop.useDropDone('me', false)).toBe(true);

  const failing = setup({ deleteError: { message: 'Network request failed' } });
  failing.drop.noteMyDropPosted('me', { drop_day: today, drop_offset_minutes: failing.drop.timeZoneOffsetMinutes() });
  await expect(failing.posts.deletePost(myDrop(today))).rejects.toMatchObject({ message: 'Network request failed' });
  expect(failing.drop.dropKeyOpen(failing.drop.useWithMyNewDrop('me', failing.drop.NO_DROPS))).toBe(true);
  expect(failing.drop.useDropDone('me', false)).toBe(true);
});

// SPEED-2 (second review): the delete reached the server and your drop was gone, but its answer got lost (a weak
// signal: the 20 second limit ran out). The app said "Could not delete" and kept remembering the drop you had just
// posted, and put it back onto every later load of your drops: your friends' drops stayed "open" on the phone while
// the server locked them (empty cards) until the app was restarted. Now the drop you just posted only counts for
// loads asked before it was saved; a load asked after it comes from the server, which knows best.
function withServer({ deleteAnswer }) {
  const react = {
    useSyncExternalStore: (_subscribe, get) => get(),
    useMemo: (make) => make(),
    useEffect() {},
    useState: (start) => [typeof start === 'function' ? start() : start, () => {}],
  };
  const server = { mine: [], gate: null };
  const supabase = {
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        not: () => query,
        // "Which drops have I posted?" – answered with what the server has at the moment it answers (`gate` holds the
        // answer back, like a slow signal).
        then: (resolve, reject) =>
          Promise.resolve(server.gate)
            .then(() => ({ data: server.mine.map((row) => ({ ...row })), error: null }))
            .then(resolve, reject),
        delete: () => ({ eq: () => ({ then: (resolve, reject) => Promise.resolve(deleteAnswer(server)).then(resolve, reject) }) }),
      };
      return query;
    },
  };
  const drop = loadLibrary('drop', { supabase, mocks: { react } });
  const posts = loadLibrary('posts', {
    supabase,
    mocks: {
      './drop': drop,
      './dares': { todayDareDay: () => '2026-11-23' },
      './errors': { serverFailure: () => null },
      './media': { deleteMedia: async () => {}, mediaFiles: (row) => [row.media_path] },
    },
  });
  return { drop, posts, server };
}

it('a delete whose answer got lost: the next load of your drops locks your friends\' drops again', async () => {
  const { drop, posts, server } = withServer({
    // The server deletes it, but the phone never hears back.
    deleteAnswer: (s) => { s.mine = []; return { error: { name: 'AbortError', message: 'The request took too long' } }; },
  });
  const today = drop.localDay();
  const row = { drop_day: today, drop_offset_minutes: drop.timeZoneOffsetMinutes() };
  // Home asked for your drops just before your drop was saved; the answer (without it) arrives just after.
  let answer;
  server.gate = new Promise((resolve) => { answer = resolve; });
  const before = drop.fetchMyDrops('me');
  server.mine = [];
  drop.noteMyDropPosted('me', row);
  answer();
  const askedBefore = await before;
  server.gate = null;
  expect(drop.dropKeyOpen(drop.useWithMyNewDrop('me', askedBefore))).toBe(true);
  // The server has your drop now, and Home loads again.
  server.mine = [row];
  expect(drop.dropKeyOpen(drop.useWithMyNewDrop('me', await drop.fetchMyDrops('me')))).toBe(true);

  await expect(posts.deletePost(myDrop(today))).rejects.toMatchObject({ message: 'The request took too long' });
  expect(server.mine).toEqual([]);

  // Home loads again (pull down, or coming back to it): the server has no drop of yours, so drops lock again.
  const loaded = await drop.fetchMyDrops('me');
  const mine = drop.useWithMyNewDrop('me', loaded);
  expect(drop.dropKeyOpen(mine)).toBe(false);
  expect(drop.postMedia(friendsDrop(today), 'me', mine)).toMatchObject({ locked: true, lock: 'drop', still: `friend/blurs/${today}.jpg` });
  // A load that was asked before your drop was saved still counts it (it's only the server's later word that wins).
  expect(drop.dropKeyOpen(drop.useWithMyNewDrop('me', askedBefore))).toBe(true);
});

it('a delete that really failed (the server still has your drop): your friends\' drops stay open after the next load', async () => {
  const { drop, posts, server } = withServer({ deleteAnswer: () => ({ error: { message: 'Network request failed' } }) });
  const today = drop.localDay();
  const row = { drop_day: today, drop_offset_minutes: drop.timeZoneOffsetMinutes() };
  server.mine = [row];
  drop.noteMyDropPosted('me', row);
  await expect(posts.deletePost(myDrop(today))).rejects.toMatchObject({ message: 'Network request failed' });
  const mine = drop.useWithMyNewDrop('me', await drop.fetchMyDrops('me'));
  expect(drop.dropKeyOpen(mine)).toBe(true);
  expect(drop.postMedia(friendsDrop(today), 'me', mine)).toMatchObject({ locked: false, still: `friend/posts/${today}.jpg` });
  // No signal at all: the load fails too, and the drop you just posted still counts.
  expect(drop.dropKeyOpen(drop.useWithMyNewDrop('me', drop.NO_DROPS))).toBe(true);
});
