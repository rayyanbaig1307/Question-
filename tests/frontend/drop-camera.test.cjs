const test = require('node:test');
const assert = require('node:assert/strict');
const { React, renderer, loadScreen, act, unmount, host } = require('./harness.cjs');

// Speed fix 2: the drop camera (src/components/home/CameraPage.tsx). You get 2 minutes to post your drop, so the
// camera must never make you wait to find out whether it's in drop mode. Before, the home camera only switched to
// drop mode once the server had answered "you haven't posted today's drop" (on 1 bar that took seconds of the
// 2 minutes). Now it's in drop mode straight away unless we KNOW you've posted (a second drop is refused by the
// server anyway). The drop camera also asks that small question as soon as it opens, which warms up the
// connection (and the login) before the shutter, so your drop goes out on a ready connection.

const COLORS = {
  white: '#FFFFFF', black: '#000000', red: '#FF4D4D', blue: '#38B6FF', yellow: '#FFE14D', orange: '#FF8A3D',
  pink: '#FF4F9A', purple: '#9B5CFF', green: '#3DDC97', accent: '#FF4F9A', surface: '#111111', textMuted: '#999999',
};

// `done`: what "have you posted today's drop?" says (null = still asking). `status`: where today's drop is at.
// `sending`: your drop that's still on its way (its send's key), or null. `pushed`: the screens the camera opened.
function loadCamera({ done, status, sending = null }) {
  const asked = [];
  const pushed = [];
  const noop = () => {};
  class CameraView extends React.Component {
    async takePictureAsync() { return { uri: 'file:///qa-shot.jpg' }; }
    render() { return React.createElement('CameraView', this.props); }
  }
  const useShared = (initial) => React.useRef({ value: initial, get() { return this.value; }, set(value) { this.value = value; } }).current;
  const screen = loadScreen('src/components/home/CameraPage.tsx', {
    'expo-camera': { CameraView, useCameraPermissions: () => [{ granted: true }, noop], useMicrophonePermissions: () => [{ granted: true }, noop] },
    'expo-image-picker': { launchImageLibraryAsync: async () => ({ canceled: true, assets: [] }) },
    'expo-router': { router: { push: (to) => pushed.push(to), back: noop } },
    'react-native-reanimated': {
      __esModule: true, default: { View: host('AnimatedView') },
      cancelAnimation: noop, Easing: { linear: 'linear' }, useAnimatedStyle: (callback) => callback(), useSharedValue: useShared,
      withSequence: (...values) => values[0], withTiming: (value) => value,
    },
    'react-native-gesture-handler': {
      GestureDetector: host('GestureDetector'), usePinchGesture: () => ({}), useTapGesture: () => ({}), useSimultaneousGestures: () => ({}),
    },
    'react-native-worklets': { scheduleOnRN: (fn, ...args) => fn(...args) },
    '@/theme': { colors: COLORS, font: {}, radius: {}, space: {} },
    '@/components/Bouncy': { Bouncy: host('Bouncy') },
    '@/components/DareBanner': { DareBanner: host('DareBanner'), DarePill: host('DarePill') },
    '@/components/DropPill': { DropPill: host('DropPill'), DropTimer: host('DropTimer') },
    '@/components/IconButton': { IconButton: host('IconButton') },
    '@/components/SafeEdge': { SafeEdge: host('SafeEdge') },
    '@/lib/dares': { todayDareDay: () => '2026-11-22', useDareDone: () => null },
    '@/lib/drop': {
      useDropDone: (me, enabled) => { asked.push(enabled); return done; },
      useDropStatus: () => status,
    },
    '@/lib/outbox': { useDropSending: () => sending },
    '@/lib/faceLens': { FACE_LENS_AVAILABLE: false },
    '@/lib/faceMesh': { FACE_MESH_AVAILABLE: false },
    '@/lib/friends': { useIncomingRequestCount: () => 0 },
    '@/lib/plus': { usePlus: () => false, usePlusAnswer: () => 'no' },
    '@/lib/screenFlash': { brightenScreen: async () => async () => {}, SCREEN_FLASH_COLOR: 'white', SCREEN_FLASH_WARMUP_MS: 0 },
    '@/lib/videoLimits': { checkPickedVideo: () => 'ok', FREE_VIDEO_SECONDS: 30, PLUS_VIDEO_SECONDS: 60, maxVideoSeconds: () => 30, TOO_BIG_VIDEO: 'Too big' },
    './HomeTabBar': { TAB_BAR_HEIGHT: 60 },
    './ModeDial': { ModeDial: host('ModeDial'), GroupGuessCaption: host('GroupGuessCaption') },
  });
  return { screen, asked, pushed };
}

async function renderCamera(setup, props) {
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(setup.screen.exports.CameraPage, { active: true, ...props })); });
  return tree;
}

const LIVE = { kind: 'live', endsAt: new Date(Date.now() + 60_000), now: Date.now() };
const has = (tree, name) => tree.root.findAllByType(name).length > 0;

test('during the drop\'s 2 minutes the camera is in drop mode at once, while "have you posted?" is still being asked', async () => {
  const setup = loadCamera({ done: null, status: LIVE });
  const tree = await renderCamera(setup, {});
  try {
    assert.ok(has(tree, 'DropTimer'), 'the drop countdown shows straight away');
  } finally { await unmount(tree); }
});

test('once we know you posted today\'s drop, the camera is a normal camera again', async () => {
  const setup = loadCamera({ done: true, status: LIVE });
  const tree = await renderCamera(setup, {});
  try {
    assert.equal(has(tree, 'DropTimer'), false);
  } finally { await unmount(tree); }
});

test('a late drop still needs a sure "not posted" before the "you\'re late" button shows', async () => {
  const late = { kind: 'late', at: new Date(Date.now() - 3_600_000), now: Date.now() };
  for (const [done, shown] of [[null, false], [false, true], [true, false]]) {
    const setup = loadCamera({ done, status: late });
    const tree = await renderCamera(setup, {});
    try {
      assert.equal(has(tree, 'DropPill'), shown, `done=${done}`);
    } finally { await unmount(tree); }
  }
});

test('the drop camera (from the drop notification) asks its small question as soon as it opens, to warm up the connection', async () => {
  const setup = loadCamera({ done: null, status: LIVE });
  const tree = await renderCamera(setup, { drop: true });
  try {
    assert.ok(setup.asked.includes(true), 'asked while the drop camera is open');
    assert.ok(has(tree, 'DropTimer'));
  } finally { await unmount(tree); }
});

// SPEED-3: Send to… closes at once now, so you can be back on the camera while your drop is still on its way. The
// server only knows about your drop once it's saved, so the camera stayed in drop mode, and the next photo (meant
// for a friend) went to Send to… as a second drop – on a weak signal it could even be saved before the real one.
test('while your drop is still on its way, the camera is a normal camera: the next photo is not a second drop', async () => {
  const shutterFor = (tree) => tree.root.find((node) => node.type === 'Bouncy' && typeof node.props.accessibilityLabel === 'string' && /^Take/.test(node.props.accessibilityLabel));
  const late = { kind: 'late', at: new Date(Date.now() - 3_600_000), now: Date.now() };
  for (const [sending, dropMode] of [[null, true], ['job-drop', false]]) {
    const setup = loadCamera({ done: false, status: LIVE, sending });
    const tree = await renderCamera(setup, {});
    try {
      assert.equal(has(tree, 'DropTimer'), dropMode, `sending=${sending}`);
      const shutter = shutterFor(tree);
      assert.equal(shutter.props.accessibilityLabel, dropMode ? 'Take your Peekaboo drop photo' : 'Take photo, or hold to record a video');
      await act(async () => { await shutter.props.onPress(); });
      assert.equal(setup.pushed.length, 1);
      assert.equal(setup.pushed[0].params.drop, dropMode ? '1' : undefined, `sending=${sending}`);
    } finally { await unmount(tree); }
    // A late drop: no "post today's drop" button while it's on its way either.
    const lateSetup = loadCamera({ done: false, status: late, sending });
    const lateTree = await renderCamera(lateSetup, {});
    try {
      assert.equal(has(lateTree, 'DropPill'), dropMode, `late, sending=${sending}`);
    } finally { await unmount(lateTree); }
  }
});

// 26 Nov (owner's screenshot, 2:32 AM): "Open camera" on a friend's locked drop opened the drop camera after
// midnight. Yesterday's drop is over by then and today's hasn't gone off, so the server refused the post ("Your drop
// didn't post: Today's Peekaboo drop hasn't happened yet"). Now the drop camera opened before today's drop shows
// the "hasn't happened yet" timer, and the photo is a normal one (not sent as a drop).
test('the drop camera opened before today\'s drop has gone off takes a normal photo, not a drop', async () => {
  const shutterFor = (tree) => tree.root.find((node) => node.type === 'Bouncy' && typeof node.props.accessibilityLabel === 'string' && /^Take/.test(node.props.accessibilityLabel));
  const waiting = { kind: 'waiting', at: new Date(Date.now() + 3_600_000), now: Date.now() };
  for (const [status, dropParam] of [[waiting, undefined], [LIVE, '1']]) {
    const setup = loadCamera({ done: false, status });
    const tree = await renderCamera(setup, { drop: true });
    try {
      assert.ok(has(tree, 'DropTimer'), 'the timer still says where the drop is at');
      await act(async () => { await shutterFor(tree).props.onPress(); });
      assert.equal(setup.pushed.length, 1);
      assert.equal(setup.pushed[0].params.drop, dropParam, `status=${status.kind}`);
    } finally { await unmount(tree); }
  }
});
