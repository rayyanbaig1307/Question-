const test = require('node:test');
const assert = require('node:assert/strict');
const { React, renderer, loadScreen, act, unmount, host, textOf, liveAccessMock, livesMock } = require('./harness.cjs');

// 🔴 Friends who are live, on Home (src/components/home/HomePage.tsx and StoryRow.tsx), and the "Friends going
// live" switch in Settings:
// - live circles sit between My Story and Guess Who: a pink ring, a LIVE tag, the host's name, and the co-host's
//   face in the corner; tapping one opens the live;
// - a friend who is live counts as "something to show" (the welcome message doesn't hide the circle);
// - only downloads that can do lives ask the server who's live (and Home never runs the real LiveKit check);
// - Home asks again every 30 seconds while it's on screen, and when a "… is live" notification arrives;
// - the settings switch only shows on downloads that can do lives.

const LIVE_A = '11111111-2222-4333-8444-555555555555';
const LIVE_B = '22222222-3333-4444-8555-666666666666';

function friendLive(overrides = {}) {
  return {
    live_id: LIVE_A, host_id: 'sam', host_username: 'sam', host_name: 'Sam', host_avatar: null,
    cohost_id: null, cohost_username: null, cohost_avatar: null, started_at: '2026-11-20T10:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The circles
// ---------------------------------------------------------------------------

function loadRow() {
  const routes = [];
  const screen = loadScreen('src/components/home/StoryRow.tsx', {
    'expo-linear-gradient': { LinearGradient: host('LinearGradient') },
    'expo-router': { router: { push: (to) => routes.push(to) } },
    '@/components/Bouncy': { Bouncy: host('Bouncy') },
    '@/lib/invite': { inviteFriends() {} },
    '@/theme': { colors: {}, font: {}, gradients: {}, space: {} },
  });
  return { screen, routes };
}

test('live circles: between My Story and Guess Who, with a LIVE tag and the co-host in the corner; a tap opens the live', async () => {
  const { screen, routes } = loadRow();
  const lives = [friendLive(), friendLive({ live_id: LIVE_B, host_id: 'bea', host_username: 'bea', host_name: '', cohost_id: 'ayaan', cohost_username: 'ayaan' })];
  let tree;
  await act(async () => {
    tree = renderer.create(React.createElement(screen.exports.StoryRow, { rings: { mine: null, friends: [] }, toGuess: 0, lives, onCamera() {} }));
  });
  try {
    const labels = tree.root.findAllByType('Pressable').map((p) => p.props.accessibilityLabel).filter(Boolean);
    // My Story first, then the two lives, then Guess Who.
    assert.deepEqual(labels.slice(0, 4), ['Add to my story', 'Sam is live. Watch', 'bea is live with @ayaan. Watch', 'Guess Who']);
    const text = textOf(tree.toJSON());
    assert.equal(text.match(/LIVE/g).length, 2);
    // The co-host's face in the corner, named for VoiceOver.
    const corner = tree.root.findAll((node) => node.type === 'View' && node.props.accessibilityLabel === '@ayaan');
    assert.equal(corner.length, 1);
    await act(() => tree.root.findAllByType('Pressable').find((p) => p.props.accessibilityLabel === 'Sam is live. Watch').props.onPress());
    assert.deepEqual(JSON.parse(JSON.stringify(routes)), [{ pathname: '/live/[id]', params: { id: LIVE_A } }]);
  } finally { await unmount(tree); }

  // Nobody live: the row is as before.
  await act(async () => {
    tree = renderer.create(React.createElement(screen.exports.StoryRow, { rings: { mine: null, friends: [] }, toGuess: 0, onCamera() {} }));
  });
  try {
    assert.equal(textOf(tree.toJSON()).includes('LIVE'), false);
  } finally { await unmount(tree); }
});

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

function loadHome({ available, lives = [] }) {
  const asked = { lives: 0 };
  const arrived = new Map();
  const access = liveAccessMock(available);
  const screen = loadScreen('src/components/home/HomePage.tsx', {
    '@/components/FeedCard': { FeedCard: host('FeedCard') },
    '@/components/Overlays': { useOverlays: () => ({ showToast() {}, showOptions() {} }) },
    '@/lib/drop': { fetchMyDrops: async () => ({ days: new Set(), windows: [] }), NO_DROPS: { days: new Set(), windows: [] }, useDropKeyOpen: () => false, useMyDropPosts: () => 0, useWithMyNewDrop: (_me, mine) => mine, postMedia: () => ({ still: null, video: null, overlay: null, locked: false }) },
    '@/lib/feed': { fetchDiscover: async () => ({ posts: [], next: null }), setLiked: async () => {} },
    '@/lib/guess': { countUnguessed: async () => 0 },
    '@/lib/invite': { inviteFriends() {}, prefetchInviteCode() {} },
    '@/lib/liveAccess': access,
    '@/lib/lives': livesMock({ fetchFriendsLiveNow: async () => { asked.lives++; return lives; } }),
    '@/lib/notifications': { onNotificationArrived: (type, run) => { arrived.set(type, run); return () => arrived.delete(type); } },
    '@/lib/peeks': { noteDropSeen() {} },
    '@/lib/media': { useMediaUrls: () => ({}) },
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
  return { screen, asked, arrived, access };
}

async function renderHome(setup, visible = true) {
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(setup.screen.exports.HomePage, { visible, onCamera() {} })); });
  await act(async () => {});
  return tree;
}

test('a friend who is live shows on Home even when there are no stories or posts yet (no welcome message instead)', async () => {
  const setup = loadHome({ available: true, lives: [friendLive()] });
  const tree = await renderHome(setup);
  try {
    const row = tree.root.findAllByType('StoryRow');
    assert.equal(row.length, 1, 'the circles show');
    assert.deepEqual(row[0].props.lives.map((l) => l.live_id), [LIVE_A]);
    assert.equal(tree.root.findAllByType('EmptyState').some((e) => e.props.title === 'Welcome to Peekaboo!'), false);
    assert.equal(setup.access.calls.isLiveAvailable, 0, 'Home never runs the real LiveKit check');
  } finally { await unmount(tree); }

  // Nothing at all (no lives either): the welcome message, as before.
  const empty = loadHome({ available: true, lives: [] });
  const tree2 = await renderHome(empty);
  try {
    assert.equal(tree2.root.findAllByType('StoryRow').length, 0);
    assert.equal(tree2.root.findAllByType('EmptyState')[0].props.title, 'Welcome to Peekaboo!');
  } finally { await unmount(tree2); }
});

test('older downloads never ask who is live; newer ones ask again every 30 seconds and when a "… is live" notification arrives', async () => {
  const old = loadHome({ available: false, lives: [friendLive()] });
  let tree = await renderHome(old);
  try {
    assert.equal(old.asked.lives, 0);
    assert.equal(old.screen.calls.intervals.size, 0);
    assert.equal(old.arrived.has('live'), false);
  } finally { await unmount(tree); }

  const setup = loadHome({ available: true, lives: [friendLive()] });
  tree = await renderHome(setup);
  try {
    assert.equal(setup.asked.lives, 1);
    // The 30-second check.
    const [poll] = [...setup.screen.calls.intervals.values()];
    await act(async () => { poll(); });
    assert.equal(setup.asked.lives, 2);
    // A "Sam is live" notification while Home is open.
    await act(async () => { setup.arrived.get('live')(); });
    assert.equal(setup.asked.lives, 3);
  } finally { await unmount(tree); }
  assert.equal(setup.arrived.has('live'), false, 'stops listening when Home closes');
  assert.equal(setup.screen.calls.intervals.size, 0, 'stops checking when Home closes');
});

// ---------------------------------------------------------------------------
// Settings → Notifications → "Friends going live 🔴"
// ---------------------------------------------------------------------------

function loadSettings(available) {
  const saved = [];
  const screen = loadScreen('src/app/(app)/settings.tsx', {
    expo: { reloadAppAsync: async () => {}, requireOptionalNativeModule: () => null },
    'expo-constants': { __esModule: true, default: { expoConfig: {}, executionEnvironment: 'standalone' }, ExecutionEnvironment: { Bare: 'bare', Standalone: 'standalone', StoreClient: 'storeClient' } },
    'expo-router': { router: { push() {} }, useFocusEffect: (callback) => React.useEffect(callback, [callback]) },
    '@/components/BirthdayForm': { formatBirthday: (value) => value },
    '@/components/Overlays': { useOverlays: () => ({ showToast() {}, showOptions() {} }) },
    '@/lib/auth': { useMe: () => ({ userId: 'alice', profile: { id: 'alice', username: 'alice', display_name: 'Alice', is_private: true, location_sharing: false, hit_ups_from: 'everyone' }, setProfile() {}, signOut: async () => {}, currentUserId: () => 'alice', refreshProfile: async () => ({}) }) },
    '@/lib/birthday': { fetchMyBirthday: async () => null },
    '@/lib/invite': { prefetchInviteCode() {} },
    '@/lib/legal': { contactEmail: () => null },
    '@/lib/legalDocs': { LEGAL_DOCS: { terms: '' } },
    '@/lib/liveAccess': liveAccessMock(available),
    '@/lib/location': { setLocationSharing: async () => ({}) },
    '@/lib/notificationPrefs': {
      ALL_ON: { messages: true, friend_requests: true, likes: true, comments: true, drops: true, lives: true },
      fetchNotificationPrefs: async () => ({ messages: true, friend_requests: true, likes: true, comments: true, drops: true, lives: true }),
      saveNotificationPrefs: async (_me, prefs) => { saved.push(prefs); },
    },
    '@/lib/notifications': { scheduleDropNotifications: async () => {} },
    '@/lib/preferences': { useScratchToReveal: () => [true, () => {}] },
    '@/lib/profiles': { deleteMyAccount: async () => {}, updateMyProfile: async () => ({}) },
    '@/lib/plus': { usePlus: () => false, useStorePlus: () => false, MANAGE_SUBSCRIPTION_URL: '', openManageSubscription: async () => {} },
  });
  screen.modules['react-native'].Linking = { openURL: async () => {} };
  return { screen, saved };
}

test('Settings shows "Friends going live 🔴" only on downloads that can do lives, and saves it', async () => {
  let setup = loadSettings(false);
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(setup.screen.Component)); });
  try {
    assert.equal(textOf(tree.toJSON()).includes('Friends going live'), false);
  } finally { await unmount(tree); }

  setup = loadSettings(true);
  await act(async () => { tree = renderer.create(React.createElement(setup.screen.Component)); });
  await act(async () => {});
  try {
    assert.ok(textOf(tree.toJSON()).includes('Friends going live 🔴'));
    const row = tree.root.findAll((node) => node.props?.title === 'Friends going live 🔴')[0];
    const toggle = row.findAllByType('Switch')[0];
    assert.equal(toggle.props.value, true);
    await act(() => toggle.props.onValueChange(false));
    assert.equal(setup.saved.at(-1).lives, false);
  } finally { await unmount(tree); }
});
