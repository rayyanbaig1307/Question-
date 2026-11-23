const test = require('node:test');
const assert = require('node:assert/strict');
const { React, renderer, loadScreen, act, unmount, host } = require('./harness.cjs');

// Speed fix 4: Home (src/components/home/HomePage.tsx) shows each part as soon as it arrives. Before, the posts waited
// for the stories, your drops, the Guess Who number and the lives – the slowest one held up everything.

const later = () => { let settle; const promise = new Promise((resolve) => { settle = resolve; }); return { promise, settle }; };

function loadHome({ feed, rings, guess = Promise.resolve(0) }) {
  const screen = loadScreen('src/components/home/HomePage.tsx', {
    '@/components/FeedCard': { FeedCard: host('FeedCard') },
    '@/components/Overlays': { useOverlays: () => ({ showToast() {}, showOptions() {} }) },
    '@/lib/drop': {
      fetchMyDrops: async () => ({ days: new Set(), windows: [] }), NO_DROPS: { days: new Set(), windows: [] },
      useDropKeyOpen: () => false, useMyDropPosts: () => 0, useWithMyNewDrop: (_me, mine) => mine,
      postMedia: () => ({ still: null, video: null, overlay: null, locked: false, lock: null }),
    },
    '@/lib/feed': { fetchDiscover: () => feed, setLiked: async () => {} },
    '@/lib/guess': { countUnguessed: () => guess },
    '@/lib/invite': { inviteFriends() {} },
    '@/lib/notifications': { onNotificationArrived: () => () => {} },
    '@/lib/peeks': { noteDropSeen() {} },
    '@/lib/media': { useMediaUrls: () => ({}) },
    '@/lib/posts': { deletePost: async () => {} },
    '@/lib/preferences': { useScratchToReveal: () => [false, () => {}] },
    '@/lib/stories': { fetchStoryRings: () => rings },
    '@/lib/storyRings': { setStoryRings() {}, storyRingsTicket: () => 1 },
    '@/lib/useSafetyActions': { useSafetyActions: () => ({ report() {}, confirmBlock() {} }) },
    '@/theme': { colors: {}, font: {}, space: {}, pageBackground: {} },
    './HomeTabBar': { useTabBarSpace: () => 0 },
    './PageHeader': { PageHeader: host('PageHeader') },
    './StoryRow': { StoryRow: host('StoryRow') },
  });
  return screen;
}

async function render(screen) {
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(screen.exports.HomePage, { visible: true, onCamera() {} })); });
  await act(async () => {});
  return tree;
}

const post = (id) => ({
  id, user_id: 'ray', drop_day: null, media_type: 'photo', media_path: `ray/posts/${id}.jpg`, created_at: '2026-11-22T10:00:00Z',
  likeCount: 0, commentCount: 0, likedByMe: false, fromEveryone: false, author: { id: 'ray', username: 'ray' },
});

test('the posts show as soon as they arrive, while the stories are still loading', async () => {
  const rings = later();
  const screen = loadHome({ feed: Promise.resolve({ posts: [post('p1'), post('p2')], next: null }), rings: rings.promise });
  const tree = await render(screen);
  try {
    assert.equal(tree.root.findAllByType('FeedCard').length, 2);
    // The story circles come when the stories do.
    assert.equal(tree.root.findAllByType('StoryRow').length, 0);
    await act(async () => { rings.settle({ mine: null, friends: [] }); });
    assert.equal(tree.root.findAllByType('StoryRow').length, 1);
  } finally { await unmount(tree); }
});

test('the welcome message waits until both the posts and the stories are known', async () => {
  const rings = later();
  const screen = loadHome({ feed: Promise.resolve({ posts: [], next: null }), rings: rings.promise });
  const tree = await render(screen);
  try {
    assert.equal(tree.root.findAllByType('EmptyState').length, 0, 'no welcome yet: the stories may still have something');
    await act(async () => { rings.settle({ mine: null, friends: [] }); });
    const empty = tree.root.findAllByType('EmptyState');
    assert.equal(empty.length, 1);
    assert.equal(empty[0].props.title, 'Welcome to Peekaboo!');
  } finally { await unmount(tree); }
});

test('a slow Guess Who number never holds up the posts', async () => {
  const screen = loadHome({
    feed: Promise.resolve({ posts: [post('p1')], next: null }),
    rings: Promise.resolve({ mine: null, friends: [] }),
    guess: new Promise(() => {}),
  });
  const tree = await render(screen);
  try {
    assert.equal(tree.root.findAllByType('FeedCard').length, 1);
    assert.equal(tree.root.findAllByType('StoryRow').length, 1);
  } finally { await unmount(tree); }
});
