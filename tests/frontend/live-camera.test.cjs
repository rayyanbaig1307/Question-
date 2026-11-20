const test = require('node:test');
const assert = require('node:assert/strict');
const { React, renderer, loadScreen, act, unmount, host, textOf, liveAccessMock, livesMock } = require('./harness.cjs');

// 🔴 Going live from the camera:
// - the Go live bubble sits right after Guess Who on the home camera, only when this download can do lives and
//   the server doesn't say "never for you" (testers only, off, banned, restricted) – never in a chat's camera;
//   the order of everything else is unchanged;
// - in live mode the shutter opens the Go live sheet (no photo, no gallery), and the camera never runs the real
//   LiveKit check (only the Go live button does);
// - while a live uses the camera, the camera page shows no camera and says it let go;
// - the Go live sheet: each "not yet" reason, the consent lines (never "Nobody records"), the camera and
//   microphone step, and the order of what Go live does.

const plain = (value) => JSON.parse(JSON.stringify(value));
const reanimated = {
  __esModule: true,
  default: { View: host('AnimatedView') },
  useSharedValue: (initial) => React.useRef({ value: initial, get() { return this.value; }, set(value) { this.value = value; } }).current,
  useAnimatedStyle: (callback) => callback(),
  withRepeat: (value) => value,
  withSequence: (...values) => values[0],
  withTiming: (value) => value,
  cancelAnimation() {},
  Easing: { linear: 'linear' },
};

function loadDial() {
  return loadScreen('src/components/home/ModeDial.tsx', {
    'expo-linear-gradient': { LinearGradient: host('LinearGradient') },
    '@/components/Bouncy': { Bouncy: host('Bouncy') },
    '@/lib/drop': { formatClock: () => '', lateLabel: () => '' },
    '@/lib/faceLens': { FACE_LENS_AVAILABLE: true },
    '@/lib/faceMesh': { FACE_MESH_AVAILABLE: false },
    'react-native-reanimated': reanimated,
  });
}

test('the 🔴 bubble comes right after Guess Who – only when `live` is on, and never in a chat camera', async () => {
  const screen = loadDial();
  const { CAMERA_MODES, homeModes, LIVE_MODE } = screen.exports;
  // The list made when the app starts never has it (nothing about lives runs at start-up).
  assert.deepEqual(plain(CAMERA_MODES.map((m) => m.key)), ['dare', 'guess', 'googly']);
  assert.deepEqual(plain(homeModes(true).map((m) => m.key)), ['dare', 'guess', 'live', 'googly']);
  assert.deepEqual(plain(homeModes(false).map((m) => m.key)), ['dare', 'guess', 'googly']);
  assert.equal(LIVE_MODE.emoji, '🔴');

  const render = async (props) => {
    let tree;
    await act(async () => { tree = renderer.create(React.createElement(screen.exports.ModeDial, { mode: 'photo', onChange() {}, ...props })); });
    const labels = tree.root.findAllByType('Pressable').map((node) => node.props.accessibilityLabel);
    await unmount(tree);
    return labels;
  };
  assert.deepEqual(await render({ live: true }), ['Plain camera', 'Dare mode', 'Guess Who mode', 'Go live mode', 'Googly mode']);
  assert.deepEqual(await render({ live: false }), ['Plain camera', 'Dare mode', 'Guess Who mode', 'Googly mode']);
  assert.deepEqual(await render({ live: true, lensesOnly: true }), ['Plain camera', 'Googly mode']);
});

function loadCamera({ bubble = true, access = liveAccessMock(true) } = {}) {
  const noop = () => {};
  const bubbleCalls = [];
  class CameraView extends React.Component {
    async takePictureAsync() { return { uri: 'file:///qa.jpg' }; }
    render() { return React.createElement('CameraView', this.props); }
  }
  const screen = loadScreen('src/components/home/CameraPage.tsx', {
    'expo-camera': { CameraView, useCameraPermissions: () => [{ granted: true }, noop], useMicrophonePermissions: () => [{ granted: true }, noop] },
    'expo-image-picker': { launchImageLibraryAsync: async () => ({ canceled: true, assets: [] }) },
    'expo-router': { router: { push: noop, back: noop } },
    'react-native-reanimated': reanimated,
    'react-native-gesture-handler': { GestureDetector: host('GestureDetector'), usePinchGesture: () => ({}), useSimultaneousGestures: () => ({}), useTapGesture: () => ({}) },
    'react-native-worklets': { scheduleOnRN: noop },
    '@/theme': { colors: { white: '#fff', live: '#FF3D7F', red: '#f00', blue: '#00f', yellow: '#ff0', orange: '#f80', pink: '#f0f', purple: '#80f', green: '#0f0', accent: '#f0f' }, font: {}, radius: {}, space: {} },
    '@/components/Bouncy': { Bouncy: host('Bouncy') },
    '@/components/DareBanner': { DareBanner: host('DareBanner'), DarePill: host('DarePill') },
    '@/components/DropPill': { DropPill: host('DropPill'), DropTimer: host('DropTimer') },
    '@/components/IconButton': { IconButton: host('IconButton') },
    '@/components/SafeEdge': { SafeEdge: host('SafeEdge') },
    '@/lib/dares': { todayDareDay: () => '2026-11-20', useDareDone: () => null },
    '@/lib/drop': { useDropDone: () => null, useDropStatus: () => ({ kind: 'waiting' }) },
    '@/lib/faceLens': { FACE_LENS_AVAILABLE: false },
    '@/lib/faceMesh': { FACE_MESH_AVAILABLE: false },
    '@/lib/friends': { useIncomingRequestCount: () => 0 },
    '@/lib/plus': { usePlus: () => false, usePlusAnswer: () => 'no' },
    '@/lib/screenFlash': { brightenScreen: async () => async () => {}, SCREEN_FLASH_COLOR: 'white', SCREEN_FLASH_WARMUP_MS: 0 },
    '@/lib/videoLimits': { checkPickedVideo: () => 'ok', FREE_VIDEO_SECONDS: 30, PLUS_VIDEO_SECONDS: 60, maxVideoSeconds: () => 30, TOO_BIG_VIDEO: 'Too big' },
    '@/lib/liveAccess': access,
    '@/lib/lives': livesMock({ useLiveBubble: (focused) => { bubbleCalls.push(focused); return bubble; } }),
    './HomeTabBar': { TAB_BAR_HEIGHT: 60 },
    './ModeDial': { ModeDial: host('ModeDial'), GroupGuessCaption: host('GroupGuessCaption') },
  });
  return { screen, access, bubbleCalls };
}

async function renderCamera(options, props = {}) {
  const { screen, access, bubbleCalls } = loadCamera(options);
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(screen.exports.CameraPage, { active: true, ...props })); });
  return {
    tree, access, bubbleCalls,
    dial: () => tree.root.findByType('ModeDial'),
    shutter: () => tree.root.findByType('Bouncy'),
    sheet: () => tree.root.findAllByType('GoLiveSheet')[0] ?? null,
    icons: () => tree.root.findAllByType('IconButton').map((node) => node.props.label),
  };
}

test('live mode: the shutter opens the Go live sheet (no photo, no gallery), and the camera never runs the real check', async () => {
  const camera = await renderCamera();
  try {
    assert.equal(camera.dial().props.live, true);
    assert.deepEqual(camera.bubbleCalls.slice(0, 1), [true], 'asked while the camera is on screen');
    await act(() => camera.dial().props.onChange('live'));
    assert.equal(camera.shutter().props.accessibilityLabel, 'Go live');
    assert.equal(camera.shutter().props.style[1].borderColor, '#FF3D7F');
    assert.equal(camera.icons().includes('Pick from gallery'), false);
    assert.equal(camera.sheet().props.visible, false);
    await act(() => camera.shutter().props.onPress());
    assert.equal(camera.sheet().props.visible, true);
    assert.equal(camera.sheet().props.facing, 'front', 'going live starts on the selfie camera');
    // Holding the shutter does the same (no video in live mode).
    await act(() => camera.sheet().props.onClose());
    await act(() => camera.shutter().props.onLongPress());
    assert.equal(camera.sheet().props.visible, true);
    assert.equal(camera.access.calls.isLiveAvailable, 0);
  } finally { await unmount(camera.tree); }
});

test('no bubble (testers only, off, an older download): no 🔴 on the row, and the gallery is back', async () => {
  const camera = await renderCamera({ bubble: false });
  try {
    assert.equal(camera.dial().props.live, false);
    assert.equal(camera.sheet(), null);
    assert.ok(camera.icons().includes('Pick from gallery'));
    assert.equal(camera.access.calls.isLiveAvailable, 0);
  } finally { await unmount(camera.tree); }
});

test('the chat camera never shows the 🔴 bubble', async () => {
  const camera = await renderCamera({}, { sendTo: 'friend-1' });
  try {
    assert.equal(camera.dial().props.live, undefined);
    assert.equal(camera.dial().props.lensesOnly, true);
  } finally { await unmount(camera.tree); }
});

test('while a live uses the camera, the camera page shows no camera at all and says it let go', async () => {
  const access = liveAccessMock(true);
  const camera = await renderCamera({ access });
  try {
    assert.equal(camera.tree.root.findAllByType('CameraView').length, 1);
    await act(() => access.holdCameraForLive());
    assert.equal(camera.tree.root.findAllByType('CameraView').length, 0);
    assert.equal(access.calls.released, 1);
    await act(() => access.releaseCameraFromLive());
    assert.equal(camera.tree.root.findAllByType('CameraView').length, 1);
  } finally { await unmount(camera.tree); }
});

// ---------------------------------------------------------------------------
// The Go live sheet
// ---------------------------------------------------------------------------

function loadSheet({ state, permission = 'ok', available = true }) {
  const log = [];
  const access = liveAccessMock(available);
  const tracked = {
    ...access,
    isLiveAvailable: () => { log.push('isLiveAvailable'); return access.isLiveAvailable(); },
    setLiveNow: (role) => { log.push(`setLiveNow:${role}`); access.setLiveNow(role); },
    holdCameraForLive: () => { log.push('holdCamera'); access.holdCameraForLive(); },
  };
  const screen = loadScreen('src/components/live/GoLiveSheet.tsx', {
    'expo-router': { router: { push: (to) => log.push(['push', to]) } },
    '@/components/SafeEdge': { SafeEdge: host('SafeEdge') },
    '@/components/live/LiveRulesSheet': { LiveRulesSheet: host('LiveRulesSheet'), LiveRulesCard: host('LiveRulesCard') },
    '@/lib/liveAccess': tracked,
    '@/lib/livePermissions': {
      ensureLivePermissions: async () => { log.push(`permissions:${permission}`); return permission; },
      openPhoneSettings: () => log.push('settings'),
      LIVE_PERMISSION_WORDS: 'Peekaboo needs your camera and microphone so friends can see and hear you',
    },
    '@/lib/lives': livesMock({ fetchLiveState: async () => ({ can_go_live: !state.why_not, my_live: null, max_minutes: 60, lives_left_today: 3, rules_accepted: true, ...state }) }),
  });
  return { screen, log, access };
}

async function renderSheet(options) {
  const { screen, log, access } = loadSheet(options);
  const closed = [];
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(screen.exports.GoLiveSheet, { visible: true, facing: 'back', onClose: () => closed.push(true) })); });
  await act(async () => {});
  const text = () => textOf(tree.root.findAllByType('Modal')[0] ? tree.root.findAllByType('Modal')[0] : tree.toJSON());
  const button = (title) => tree.root.findAllByType('Button').find((b) => b.props.title === title);
  return { tree, log, access, closed, text, button };
}

test('each "not yet" reason has its own words (and the right button)', async () => {
  const cases = [
    ['birthday', 'Add your birthday to go live', 'Add my birthday'],
    ['no_friends', 'Add a friend to go live – only friends can watch.', null],
    ['new_account', 'Your account is a bit too new to go live – try again in a few days.', null],
    ['daily_limit', 'You’ve gone live 3 times today – try again tomorrow', null],
    ['month_limit', 'You’ve used your live time for this month – it resets on the 1st.', null],
    ['busy', 'Lives are busy right now – try again later', null],
  ];
  for (const [why, words, action] of cases) {
    const sheet = await renderSheet({ state: { why_not: why } });
    try {
      assert.ok(sheet.text().includes(words), `${why}: ${sheet.text()}`);
      assert.equal(sheet.button('Go live 🔴'), undefined);
      if (action) assert.ok(sheet.button(action));
    } finally { await unmount(sheet.tree); }
  }
  // Birthday: off to the birthday screen.
  const sheet = await renderSheet({ state: { why_not: 'birthday' } });
  try {
    await act(() => sheet.button('Add my birthday').props.onPress());
    assert.deepEqual(sheet.log.at(-1), ['push', '/birthday']);
  } finally { await unmount(sheet.tree); }
});

test('the Live rules open straight away when they are the next step – inside the same sheet (one pop-up at a time)', async () => {
  const sheet = await renderSheet({ state: { why_not: 'rules' } });
  try {
    const modals = sheet.tree.root.findAllByType('Modal');
    assert.equal(modals.length, 1);
    const card = modals[0].findByType('LiveRulesCard');
    // "Not now" goes back to the sheet ("Read the Live rules"); a link closes the whole sheet so the page shows.
    await act(() => card.props.onClose());
    assert.ok(sheet.button('Read the Live rules'));
    await act(() => sheet.button('Read the Live rules').props.onPress());
    await act(() => sheet.tree.root.findByType('LiveRulesCard').props.onOpenPage());
    assert.equal(sheet.closed.length, 1);
  } finally { await unmount(sheet.tree); }
});

test('ready: the consent lines (never "Nobody records"), then Go live: camera and mic → real check → live now → camera handed over → the live screen', async () => {
  const sheet = await renderSheet({ state: { why_not: null } });
  try {
    const text = sheet.text();
    assert.ok(text.includes('Only your friends can watch.'));
    assert.ok(text.includes('Friends with the newest Peekaboo get a notification (at most once every 2 hours).'));
    assert.ok(text.includes('Up to 60 minutes. We don’t record or save your live – but friends watching could screen-record it, so only share what you’re OK with.'));
    assert.equal(/nobody records/i.test(text), false);
    await act(async () => { await sheet.button('Go live 🔴').props.onPress(); });
    assert.deepEqual(plain(sheet.log.slice(0, 5)), ['permissions:ok', 'isLiveAvailable', 'setLiveNow:host', 'holdCamera', ['push', { pathname: '/go-live', params: { facing: 'back' } }]]);
    assert.equal(sheet.closed.length, 1);
  } finally { await unmount(sheet.tree); }
});

test('the microphone refused for good: the Open Settings line, and nothing starts', async () => {
  const sheet = await renderSheet({ state: { why_not: null }, permission: 'settings' });
  try {
    await act(async () => { await sheet.button('Go live 🔴').props.onPress(); });
    assert.ok(sheet.text().includes('Peekaboo needs your camera and microphone so friends can see and hear you'));
    assert.ok(sheet.button('Open Settings'));
    assert.deepEqual(sheet.log, ['permissions:settings']);
    assert.equal(sheet.access.liveNowRole(), null);
    await act(() => sheet.button('Open Settings').props.onPress());
    assert.equal(sheet.log.at(-1), 'settings');
  } finally { await unmount(sheet.tree); }
});

test('a phone whose LiveKit parts are missing: "Lives aren\'t working on this phone right now." and nothing starts', async () => {
  const sheet = await renderSheet({ state: { why_not: null }, available: false });
  try {
    await act(async () => { await sheet.button('Go live 🔴').props.onPress(); });
    assert.ok(sheet.text().includes("Lives aren't working on this phone right now."));
    assert.equal(sheet.access.liveNowRole(), null);
    assert.equal(sheet.log.includes('holdCamera'), false);
  } finally { await unmount(sheet.tree); }
});
