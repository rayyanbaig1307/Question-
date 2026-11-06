// Right after buying Peekaboo+, the App Store knows at once but the server (which decides who sees the names
// in Profile views, Screenshots and who gets a Guess Who hint) only hears a few seconds later. These screens
// must then say "Unlocking your Peekaboo+…" instead of asking you to buy it again, ask the server again when
// they open or when you pull down to refresh, and show the Plus parts as soon as the server knows.
// (Peek-a-Save and Drop rewind are tested in plus-extras.test.cjs; the buying itself in
// tests/unit/plus-purchases.test.mjs.)
const test = require('node:test');
const assert = require('node:assert/strict');
const { React, loadScreen, renderScreen, act, textOf, button, unmount, host } = require('./harness.cjs');

const UNLOCKING = '⏳ Unlocking your Peekaboo+…';

// A pretend '@/lib/plus' whose answers can change while a screen is open (like the real one).
// `store` = the App Store says you have Plus; `server` = the server knows it.
// `serverKnowsAfterAsking`: asking the server again finds your Plus (the webhook has arrived).
function plusState({ store = false, server = false, serverKnowsAfterAsking = false } = {}) {
  const watchers = new Set();
  const state = { store, server, serverKnowsAfterAsking, refreshes: 0 };
  const subscribe = (watcher) => { watchers.add(watcher); return () => watchers.delete(watcher); };
  const set = (change) => { Object.assign(state, change); watchers.forEach((watcher) => watcher()); };
  const mock = {
    usePlus: () => React.useSyncExternalStore(subscribe, () => state.store || state.server),
    useStorePlus: () => React.useSyncExternalStore(subscribe, () => state.store),
    useServerPlus: () => React.useSyncExternalStore(subscribe, () => state.server),
    refreshServerPlus: async () => {
      state.refreshes++;
      if (state.serverKnowsAfterAsking) set({ server: true });
    },
  };
  return { state, set, mock };
}

// expo-router: `routes` records where the screen sends you; the focus effect runs like on a screen that is open.
const router = (routes = []) => ({
  router: { push: (to) => routes.push(to), back() {} },
  useFocusEffect: (callback) => React.useEffect(callback, [callback]),
});
const texts = (tree) => tree.root.findAllByType('Text').map(textOf);
const pull = (tree) => tree.root.findByType('FlatList').props.onRefresh();

// --- 👀 Profile views ---------------------------------------------------------------------------------------

const VIEWER = { profile: { id: 'bob', username: 'bob', display_name: 'Bob' }, lastViewedAt: '2026-11-06T10:00:00Z', visits: 2 };
const views = (plus) => ({ sharing: true, plus, people: 1, visits: 2, viewers: plus ? [VIEWER] : [] });

function profileViews(plus, { serverPlus, routes } = {}) {
  const loads = { count: 0 };
  // What the server answers: names only once it knows about your Plus.
  const fetchMyProfileViews = async () => { loads.count++; return views(serverPlus ? serverPlus() : false); };
  const screen = loadScreen('src/app/(app)/profile-views.tsx', {
    'expo-router': router(routes),
    '@/components/HiddenPersonRow': { HiddenPersonRow: host('HiddenPersonRow') },
    '@/components/PersonRow': { PersonRow: host('PersonRow') },
    '@/lib/insights': { fetchMyProfileViews },
    '@/lib/plus': plus.mock,
    '@/lib/time': { timeAgo: () => '1h' },
  });
  return { screen, loads };
}

test('Profile views right after buying: "Unlocking…" instead of the buy button, and the server is asked again', async () => {
  const plus = plusState({ store: true, server: false });
  const { screen } = profileViews(plus);
  const tree = await renderScreen(screen);
  try {
    assert.ok(texts(tree).includes(UNLOCKING));
    assert.ok(texts(tree).includes('This takes a few seconds. Pull down to refresh.'));
    assert.equal(button(tree, 'See who with Peekaboo+ ⭐'), undefined, 'never asked to buy it again');
    assert.equal(tree.root.findAllByType('HiddenPersonRow').length, 1, 'the faces stay hidden until the server knows');
    assert.equal(plus.state.refreshes, 1, 'opening the screen asks the server again');
  } finally { await unmount(tree); }
});

test('Profile views: pulling down asks the server again, and the names show once it knows', async () => {
  const plus = plusState({ store: true, server: false, serverKnowsAfterAsking: true });
  const { screen, loads } = profileViews(plus, { serverPlus: () => plus.state.server });
  const tree = await renderScreen(screen);
  try {
    plus.state.refreshes = 0;
    const before = loads.count;
    await act(() => pull(tree));
    assert.ok(plus.state.refreshes >= 1, 'pulling down asks the server about your Plus');
    assert.ok(loads.count > before, 'and loads the views again');
    assert.equal(tree.root.findAllByType('PersonRow').length, 1, 'the names are there now');
    assert.ok(!texts(tree).includes(UNLOCKING));
  } finally { await unmount(tree); }
});

test('Profile views: when the server hears about your Plus by itself, the names show without pulling', async () => {
  const plus = plusState({ store: true, server: false });
  const { screen } = profileViews(plus, { serverPlus: () => plus.state.server });
  const tree = await renderScreen(screen);
  try {
    assert.ok(texts(tree).includes(UNLOCKING));
    // The checks a few seconds after buying find it (src/lib/plus.ts).
    await act(async () => { plus.set({ server: true }); });
    assert.equal(tree.root.findAllByType('PersonRow').length, 1);
    assert.ok(!texts(tree).includes(UNLOCKING));
  } finally { await unmount(tree); }
});

test('Profile views without Peekaboo+: the buy button, and no extra questions to the server', async () => {
  const plus = plusState();
  const routes = [];
  const { screen } = profileViews(plus, { routes });
  const tree = await renderScreen(screen);
  try {
    assert.ok(!texts(tree).includes(UNLOCKING));
    await act(() => button(tree, 'See who with Peekaboo+ ⭐').props.onPress());
    assert.deepEqual(routes, ['/plus']);
    assert.equal(plus.state.refreshes, 0);
  } finally { await unmount(tree); }
});

// --- 📸 Who screenshotted your post ----------------------------------------------------------------------------

function postScreenshots(plus) {
  const TAKER = { profile: { id: 'bob', username: 'bob', display_name: 'Bob' }, lastAt: '2026-11-06T10:00:00Z', times: 1 };
  const screen = loadScreen('src/app/(app)/screenshots/[id].tsx', {
    'expo-router': { ...router(), useLocalSearchParams: () => ({ id: 'post-1' }) },
    '@/components/HiddenPersonRow': { HiddenPersonRow: host('HiddenPersonRow') },
    '@/components/PersonRow': { PersonRow: host('PersonRow') },
    '@/lib/insights': {
      fetchPostScreenshots: async () => (plus.state.server
        ? { plus: true, people: 1, screenshots: 1, takers: [TAKER] }
        : { plus: false, people: 1, screenshots: 1, takers: [] }),
    },
    '@/lib/plus': plus.mock,
    '@/lib/time': { timeAgo: () => '1h' },
  });
  return screen;
}

test('Screenshots right after buying: "Unlocking…", and pulling down shows the names once the server knows', async () => {
  const plus = plusState({ store: true, server: false, serverKnowsAfterAsking: true });
  const tree = await renderScreen(postScreenshots(plus));
  try {
    // Opening the screen already asked the server again, and it knew: the names are there.
    assert.equal(plus.state.refreshes, 1);
    assert.equal(tree.root.findAllByType('PersonRow').length, 1);
  } finally { await unmount(tree); }

  const slow = plusState({ store: true, server: false });
  const slowTree = await renderScreen(postScreenshots(slow));
  try {
    assert.ok(texts(slowTree).includes(UNLOCKING));
    assert.equal(button(slowTree, 'See who with Peekaboo+ ⭐'), undefined);
    slow.state.serverKnowsAfterAsking = true; // the webhook arrives
    await act(() => pull(slowTree));
    assert.equal(slowTree.root.findAllByType('PersonRow').length, 1);
    assert.ok(!texts(slowTree).includes(UNLOCKING));
  } finally { await unmount(slowTree); }

  const free = plusState();
  const freeTree = await renderScreen(postScreenshots(free));
  try {
    assert.ok(button(freeTree, 'See who with Peekaboo+ ⭐'));
    assert.ok(!texts(freeTree).includes(UNLOCKING));
  } finally { await unmount(freeTree); }
});

// --- 🕵️ Guess Who hint -------------------------------------------------------------------------------------------

const POST = {
  id: 'post-1', media_path: 'p.jpg', media_type: 'photo', poster_path: null, overlay_path: null, caption: '',
  created_at: '2026-11-06T10:00:00Z', expires_at: '2026-11-07T10:00:00Z', mine: false, options: ['bob', 'cara'],
  my_guess: null, poster: null, guess_count: null, right_count: null,
};

function guessWho(plus) {
  const asked = [];
  const routes = [];
  const screen = loadScreen('src/app/(app)/guess.tsx', {
    'expo-image': { Image: host('Image') },
    'expo-router': router(routes),
    'react-native-reanimated': { __esModule: true, default: { View: host('AnimatedView'), Text: host('AnimatedText') } },
    '@/components/Bouncy': { Bouncy: host('Bouncy') },
    '@/components/ScreenHeader': { ScreenHeader: host('ScreenHeader'), RoundIconButton: host('RoundIconButton') },
    '@/components/Overlays': { useOverlays: () => ({ showOptions() {}, showToast: (...args) => screen.calls.toasts.push(args) }) },
    '@/lib/guess': {
      fetchMysteryFeed: async () => ({ posts: [POST], people: new Map() }),
      guessMystery: async () => 'bob', deleteMystery: async () => {}, reportMystery: async () => {}, blockMysteryPoster: async () => {},
    },
    '@/lib/media': { useMediaUrls: () => ({}) },
    '@/lib/plus': plus.mock,
    '@/lib/plusExtras': { fetchMysteryHints: async () => new Map(), getMysteryHint: async (id) => { asked.push(id); return 'They love cats'; } },
    '@/lib/safety': { REPORT_REASONS: [] },
    '@/lib/time': { timeAgo: () => '1h' },
  });
  return { screen, asked, routes };
}

const hintButton = (tree) => tree.root.findAllByType('Pressable').find((node) => /hint|Unlocking/i.test(node.props.accessibilityLabel ?? ''));

test('Guess Who hint right after buying: "Unlocking…", tapping asks the server again (never the Peekaboo+ screen)', async () => {
  const plus = plusState({ store: true, server: false });
  const { screen, asked, routes } = guessWho(plus);
  const tree = await renderScreen(screen);
  try {
    assert.equal(plus.state.refreshes, 1, 'opening Guess Who asks the server again');
    assert.equal(textOf(hintButton(tree)), '⏳ Unlocking Peekaboo+…');
    await act(() => hintButton(tree).props.onPress());
    assert.equal(plus.state.refreshes, 2);
    assert.match(screen.calls.toasts.at(-1)[0], /Unlocking your Peekaboo\+… pull down to refresh/);
    assert.deepEqual(routes, [], 'never sent to buy Peekaboo+ again');
    assert.deepEqual(asked, [], 'the server would still say no');

    // Pull down to refresh: the server knows now, and the hint works.
    plus.state.serverKnowsAfterAsking = true;
    await act(() => tree.root.findByType('FlatList').props.refreshControl.props.onRefresh());
    assert.equal(textOf(hintButton(tree)), '🕵️ Hint');
    await act(() => hintButton(tree).props.onPress());
    assert.deepEqual(asked, ['post-1']);
  } finally { await unmount(tree); }
});

test('Guess Who hint without Peekaboo+ goes to the Peekaboo+ screen', async () => {
  const plus = plusState();
  const { screen, asked, routes } = guessWho(plus);
  const tree = await renderScreen(screen);
  try {
    assert.equal(textOf(hintButton(tree)), '🕵️ Hint · Peekaboo+ ⭐');
    await act(() => hintButton(tree).props.onPress());
    assert.deepEqual(routes, ['/plus']);
    assert.deepEqual(asked, []);
    assert.equal(plus.state.refreshes, 0);
  } finally { await unmount(tree); }
});
