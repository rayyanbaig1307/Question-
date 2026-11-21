const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { React, renderer, loadScreen, act, unmount, host, textOf, liveAccessMock, livesMock } = require('./harness.cjs');

// "Give a peek to get a peek" on Home and on profiles, with the app's real drop rules (src/lib/drop.ts).
// The owner posted his drop, but a friend's older drop still said "Post your Peekaboo drop to see Prab's":
// a drop only opened if you had posted your own drop that SAME day. Now posting your drop opens every drop
// (friends' and everyone's, old ones too) until the next day's drop goes off (drops from your drop's day and
// before: an hour longer, for the clocks going back). The database has the same rule
// (supabase/migrations/20261228000000_drop_unlock.sql, tested in tests/database/drop-unlock.test.mjs).

const DAY_MS = 24 * 60 * 60 * 1000;
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// The real src/lib/drop.ts, with a pretend clock and pretend timers, and a stand-in database that answers
// "which drops have I posted?" with `state.mine`.
function loadDrop(state) {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/lib/drop.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  class ClockDate extends Date {
    constructor(...args) { if (args.length === 0) super(state.now); else super(...args); }
    static now() { return state.now; }
  }
  const query = {
    select() { return query; }, eq() { return query; },
    not() { return Promise.resolve({ data: state.mine.map((row) => ({ ...row })), error: null }); },
  };
  const supabase = { from: (table) => { assert.equal(table, 'posts'); return query; } };
  const module = { exports: {} };
  vm.runInContext(compiled, vm.createContext({
    module, exports: module.exports, console, Date: ClockDate,
    setTimeout: (callback, ms) => { state.timers.push({ callback, at: state.now + ms }); return state.timers.length; },
    clearTimeout: (id) => { if (state.timers[id - 1]) state.timers[id - 1].cleared = true; },
    setInterval: () => 0, clearInterval: () => {},
    require: (id) => {
      if (id === 'react') return React;
      if (id === './supabase') return { supabase };
      throw new Error(`drop.ts must not import ${id}`);
    },
  }), { filename: 'src/lib/drop.ts' });
  return module.exports;
}

function newState({ mine = [] } = {}) {
  return { now: Date.now(), mine, timers: [] };
}

// Moves the pretend clock on and runs the timers that are due.
async function advance(state, ms) {
  state.now += ms;
  await act(async () => {
    for (const timer of state.timers) {
      if (!timer.cleared && !timer.done && timer.at <= state.now) { timer.done = true; timer.callback(); }
    }
  });
}

function dropPost(id, user, day, extra = {}) {
  return {
    id, user_id: user, drop_day: day, drop_late_seconds: 0, media_path: `${user}/posts/${id}.jpg`, media_type: 'photo',
    poster_path: null, overlay_path: null, blur_path: `${user}/blurs/${id}.jpg`, group_hold: false,
    created_at: '2026-11-20T20:00:00Z', likeCount: 0, commentCount: 0, likedByMe: false, fromEveryone: false,
    author: { id: user, username: user, display_name: user }, ...extra,
  };
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

function loadHome(state, posts) {
  const toasts = [];
  const drop = loadDrop(state);
  const screen = loadScreen('src/components/home/HomePage.tsx', {
    '@/components/FeedCard': { FeedCard: host('FeedCard') },
    '@/components/Overlays': { useOverlays: () => ({ showToast: (text) => toasts.push(text), showOptions() {} }) },
    '@/lib/drop': drop,
    '@/lib/feed': { fetchDiscover: async () => ({ posts, next: null }), setLiked: async () => {} },
    '@/lib/guess': { countUnguessed: async () => 0 },
    '@/lib/invite': { inviteFriends() {}, prefetchInviteCode() {} },
    '@/lib/liveAccess': liveAccessMock(false),
    '@/lib/lives': livesMock(),
    '@/lib/notifications': { onNotificationArrived: () => () => {} },
    '@/lib/peeks': { noteDropSeen() {} },
    '@/lib/media': { useMediaUrls: (paths) => Object.fromEntries(paths.map((p) => [p, `https://example.invalid/${p}`])) },
    '@/lib/posts': { deletePost: async () => {} },
    '@/lib/preferences': { useScratchToReveal: () => [false, () => {}] },
    '@/lib/stories': { fetchStoryRings: async () => ({ mine: null, friends: [] }) },
    '@/lib/storyRings': { setStoryRings() {}, storyRingsTicket: () => 1 },
    '@/lib/useSafetyActions': { useSafetyActions: () => ({ report() {}, confirmBlock() {} }) },
    '@/theme': { colors: {}, font: {}, space: {}, pageBackground: {} },
    './HomeTabBar': { useTabBarSpace: () => 0 },
    './PageHeader': { PageHeader: host('PageHeader') },
    './StoryRow': { StoryRow: host('StoryRow') },
  });
  return { screen, toasts, drop };
}

async function renderHome(setup) {
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(setup.screen.exports.HomePage, { visible: true, onCamera() {} })); });
  await act(async () => {});
  return tree;
}

// Each card's lock ('drop' = the 🙈 "Give a peek to get a peek" card, 'group' = waiting on your group, null = open)
// and the picture it was given (a locked drop only ever gets its blurry preview).
const cards = (tree) => Object.fromEntries(tree.root.findAllByType('FeedCard').map((card) => [card.props.post.id, { lock: card.props.lock, url: card.props.url }]));
const pullToRefresh = (tree) => act(async () => { await tree.root.findByType('FlatList').props.refreshControl.props.onRefresh(); });

test('the owner\'s bug: after posting your drop, a friend\'s OLDER drop opens too (not just ones from the same day)', async () => {
  const state = newState();
  const today = utcDay(state.now);
  const posts = [
    dropPost('prab-today', 'prab', today),
    dropPost('prab-old', 'prab', utcDay(state.now - 4 * DAY_MS)),
    dropPost('stranger-old', 'stranger', utcDay(state.now - 8 * DAY_MS), { fromEveryone: true }),
    { ...dropPost('normal', 'prab', null), drop_day: null },
  ];
  const setup = loadHome(state, posts);
  const tree = await renderHome(setup);
  try {
    // No drop of your own yet: every drop is the 🙈 card with only its blurry preview; normal posts are open.
    let shown = cards(tree);
    for (const id of ['prab-today', 'prab-old', 'stranger-old']) {
      assert.equal(shown[id].lock, 'drop', id);
      assert.match(shown[id].url, /\/blurs\//, id);
    }
    assert.equal(shown.normal.lock, null);
    assert.deepEqual(setup.toasts, []);

    // You post today's drop (the database now has it) and come back to Home.
    state.mine = [{ drop_day: utcDay(state.now), drop_offset_minutes: 0 }];
    await pullToRefresh(tree);
    shown = cards(tree);
    for (const id of ['prab-today', 'prab-old', 'stranger-old']) {
      assert.equal(shown[id].lock, null, `${id} should be open`);
      assert.match(shown[id].url, /\/posts\//, id);
    }
    assert.deepEqual(setup.toasts, ['🔓 All drops unlocked!']);
  } finally { await unmount(tree); }
});

test('when the next drop goes off, the new day\'s drops lock on screen by themselves, older ones an hour later; same-day drops stay open', async () => {
  const state = newState();
  const yesterday = utcDay(state.now - DAY_MS);
  // Your drop from yesterday, posted in UTC: open until today's drop goes off.
  state.mine = [{ drop_day: yesterday, drop_offset_minutes: 0 }];
  const setup = loadHome(state, [
    dropPost('prab-yesterday', 'prab', yesterday),
    dropPost('prab-old', 'prab', utcDay(state.now - 6 * DAY_MS)),
    // A friend a few time zones ahead already posted the NEW day's drop.
    dropPost('ana-new', 'ana', utcDay(state.now)),
  ]);
  const until = setup.drop.nextDropAt(yesterday, 0);
  // (Run the test as if it were an hour before that.)
  state.now = until - 60 * 60 * 1000;
  const tree = await renderHome(setup);
  try {
    assert.deepEqual(Object.values(cards(tree)).map((c) => c.lock), [null, null, null]);
    // A minute before the new drop: still open.
    await advance(state, 59 * 60 * 1000);
    assert.equal(cards(tree)['ana-new'].lock, null);
    // The new drop goes off: the new day's drop locks by itself ("give a peek to get a peek")...
    await advance(state, 61 * 1000);
    assert.equal(cards(tree)['ana-new'].lock, 'drop');
    assert.match(cards(tree)['ana-new'].url, /\/blurs\//);
    // ...older drops get an hour more (so the clocks going back can't lock them before you can post)...
    assert.equal(cards(tree)['prab-old'].lock, null);
    await advance(state, 58 * 60 * 1000);
    assert.equal(cards(tree)['prab-old'].lock, null);
    // ...then they lock too; yesterday's (the day you posted) stays open.
    await advance(state, 2 * 60 * 1000);
    assert.equal(cards(tree)['prab-old'].lock, 'drop');
    assert.equal(cards(tree)['prab-yesterday'].lock, null);
    // You post the new drop: everything opens again, with the happy message.
    state.mine = [...state.mine, { drop_day: utcDay(state.now), drop_offset_minutes: 0 }];
    await pullToRefresh(tree);
    assert.equal(cards(tree)['prab-old'].lock, null);
    assert.equal(cards(tree)['ana-new'].lock, null);
    assert.deepEqual(setup.toasts, ['🔓 All drops unlocked!']);
  } finally { await unmount(tree); }
});

test('a Group Peek drop still waits for the group, even after you posted', async () => {
  const state = newState({ mine: [] });
  state.mine = [{ drop_day: utcDay(state.now), drop_offset_minutes: 0 }];
  const setup = loadHome(state, [dropPost('group-drop', 'prab', utcDay(state.now), { group_hold: true })]);
  const tree = await renderHome(setup);
  try {
    assert.equal(cards(tree)['group-drop'].lock, 'group');
    assert.match(cards(tree)['group-drop'].url, /\/blurs\//);
  } finally { await unmount(tree); }
});

// ---------------------------------------------------------------------------
// Profile grids (src/components/PostGrid.tsx) and the drop rule itself
// ---------------------------------------------------------------------------

test('profile grid: your drop opens every old drop on a friend\'s profile (no 🙈 tiles left)', async () => {
  const state = newState();
  const drop = loadDrop(state);
  const posts = [0, 2, 5, 9].map((n) => dropPost(`d${n}`, 'prab', utcDay(state.now - n * DAY_MS)));
  const screen = loadScreen('src/components/PostGrid.tsx', {
    'expo-image': { Image: host('ExpoImage') },
    'expo-router': { router: { push() {} } },
    '@/lib/drop': drop,
    '@/lib/media': { useMediaUrls: (paths) => Object.fromEntries(paths.map((p) => [p, `https://example.invalid/${p}`])) },
  });
  const render = async () => {
    let tree;
    await act(async () => {
      tree = renderer.create(React.createElement(screen.exports.PostGrid, { posts, header: null, refreshing: false, onRefresh() {} }));
    });
    await act(async () => {});
    return tree;
  };
  let tree = await render();
  try {
    assert.equal((textOf(tree.toJSON()).match(/🙈/g) ?? []).length, 4);
  } finally { await unmount(tree); }
  state.mine = [{ drop_day: utcDay(state.now), drop_offset_minutes: 0 }];
  tree = await render();
  try {
    assert.equal((textOf(tree.toJSON()).match(/🙈/g) ?? []).length, 0);
    const sources = tree.root.findAllByType('ExpoImage').map((image) => image.props.source.uri);
    assert.ok(sources.every((uri) => uri.includes('/posts/')), 'full photos, not blurry previews');
  } finally { await unmount(tree); }
});

test('the rule: never posted → locked; your drop opens other days until the next drop (older days: an hour more); your own posts and normal posts are never locked', () => {
  const state = newState();
  const drop = loadDrop(state);
  const theirs = (day) => ({ drop_day: day, user_id: 'prab', group_hold: false });
  const day = '2026-11-20';
  const until = drop.nextDropAt(day, -300); // posted in New York time
  const mine = { days: new Set([day]), windows: [{ day, until }] };
  const hour = 60 * 60 * 1000;
  assert.equal(drop.dropLock(theirs('2026-11-12'), 'me', null, until - 1), 'drop', 'still loading counts as locked');
  assert.equal(drop.dropLock(theirs('2026-11-12'), 'me', drop.NO_DROPS, until - 1), 'drop');
  assert.equal(drop.dropLock(theirs('2026-11-12'), 'me', mine, until - 1), null);
  assert.equal(drop.dropLock(theirs('2026-11-12'), 'me', mine, until + hour - 1), null, 'older drops: an hour more');
  assert.equal(drop.dropLock(theirs('2026-11-12'), 'me', mine, until + hour), 'drop');
  assert.equal(drop.dropLock(theirs('2026-11-21'), 'me', mine, until - 1), null);
  assert.equal(drop.dropLock(theirs('2026-11-21'), 'me', mine, until), 'drop', 'the new day\'s drops lock on time');
  assert.equal(drop.dropLock(theirs(day), 'me', mine, until + 7 * DAY_MS), null, 'a day you posted stays open');
  assert.equal(drop.dropLock({ ...theirs('2026-11-12'), group_hold: true }, 'me', mine, until - 1), 'group');
  assert.equal(drop.dropLock({ drop_day: '2026-11-12', user_id: 'me' }, 'me', null), null);
  assert.equal(drop.dropLock({ drop_day: null, user_id: 'prab' }, 'me', null), null);
  // 20 Nov 2026's next drop (21 Nov) is at 19:14 in New York = 00:14 UTC on 22 Nov.
  assert.equal(new Date(until).toISOString(), '2026-11-22T00:14:00.000Z');
});
