const test = require('node:test');
const assert = require('node:assert/strict');
const { React, renderer, loadScreen, loadPure, act, unmount, host, textOf } = require('./harness.cjs');

// 🌆 Main Character Mode on the home camera (src/components/home/CameraPage.tsx with the real ModeDial):
// - the row parks on 🌆 (sunset orange shutter ring, a card above the row). The camera stays plain;
// - the shutter (tap AND hold) opens the Main Character screen, and never takes a photo or starts a video;
// - the card opens it too;
// - if it is ever made Peekaboo+ only (MAIN_CHARACTER_PLUS), picking it without Plus opens Peekaboo+ instead;
// - the chat cameras never have it.
// The phone here is an iPhone with face tracking on the `testing` update channel (where 🌆 shows for now).

const plain = (value) => JSON.parse(JSON.stringify(value));
const SUNSET = '#FF6B3D';
const COLORS = {
  white: '#FFFFFF', black: '#000000', red: '#FF4D4D', blue: '#38B6FF', yellow: '#FFE14D', orange: '#FF8A3D',
  pink: '#FF4F9A', purple: '#9B5CFF', green: '#3DDC97', accent: '#FF4F9A', live: '#FF3D7F',
};
const useShared = (initial) => React.useRef({ value: initial, get() { return this.value; }, set(value) { this.value = value; } }).current;
const reanimated = {
  __esModule: true, default: { View: host('AnimatedView') },
  cancelAnimation() {}, Easing: { linear: 'linear' }, useAnimatedStyle: (callback) => callback(), useSharedValue: useShared,
  withRepeat: (value) => value, withSequence: (...values) => values[0], withTiming: (value) => value,
};
const config = (changes = {}) => ({ ...loadPure('src/lib/mainCharacter/config.ts'), ...changes });

// `answer`: Peekaboo+ ('yes', 'no', 'checking'). `mainCharacter`: the switches (lib/mainCharacter/config.ts).
function loadCamera({ answer = 'no', mainCharacter = config() } = {}) {
  const calls = { routes: [], shots: 0, recordings: 0, picks: 0, haptics: [] };
  const noop = () => {};
  const router = { push: (to) => calls.routes.push(['push', to]), back: () => calls.routes.push(['back']) };
  class CameraView extends React.Component {
    async takePictureAsync() { calls.shots++; return { uri: 'file:///qa-shot.jpg' }; }
    async recordAsync() { calls.recordings++; return { uri: 'file:///qa-video.mov' }; }
    stopRecording() {}
    render() { return React.createElement('CameraView', this.props); }
  }
  const shared = {
    'expo-router': { router },
    'expo-haptics': {
      selectionAsync: async () => { calls.haptics.push('selection'); },
      impactAsync: async (style) => { calls.haptics.push(`impact:${style}`); },
      notificationAsync: async () => {},
      ImpactFeedbackStyle: { Heavy: 'heavy', Medium: 'medium', Light: 'light' },
      NotificationFeedbackType: { Success: 'success' },
    },
    'react-native-reanimated': reanimated,
    '@/components/Bouncy': { Bouncy: host('Bouncy') },
    '@/lib/faceLens': { FACE_LENS_AVAILABLE: false },
    '@/lib/mainCharacter/config': mainCharacter,
  };
  // The real mode row, on an iPhone with face tracking on the testing channel.
  const dial = loadScreen('src/components/home/ModeDial.tsx', {
    ...shared,
    'expo-linear-gradient': { LinearGradient: host('LinearGradient') },
    '@/lib/drop': { formatClock: () => '', lateLabel: () => '' },
    '@/lib/faceMesh': { FACE_MESH_AVAILABLE: true },
    '@/lib/lensDiagnostics': { updateChannel: () => 'testing' },
  });
  // An iPhone (the harness says Android). Read when the row is worked out, so changing it here is enough.
  dial.modules['react-native'].Platform = { OS: 'ios' };
  const screen = loadScreen('src/components/home/CameraPage.tsx', {
    ...shared,
    'expo-camera': { CameraView, useCameraPermissions: () => [{ granted: true }, noop], useMicrophonePermissions: () => [{ granted: true }, noop] },
    'expo-image-picker': { launchImageLibraryAsync: async () => { calls.picks++; return { canceled: true, assets: [] }; } },
    'react-native-gesture-handler': { GestureDetector: host('GestureDetector'), usePinchGesture: () => ({}), useSimultaneousGestures: () => ({}), useTapGesture: () => ({}) },
    'react-native-worklets': { scheduleOnRN: noop },
    '@/theme': { colors: COLORS, font: {}, radius: {}, space: {} },
    '@/components/DareBanner': { DareBanner: host('DareBanner'), DarePill: host('DarePill') },
    '@/components/DropPill': { DropPill: host('DropPill'), DropTimer: host('DropTimer') },
    '@/components/IconButton': { IconButton: host('IconButton') },
    '@/components/SafeEdge': { SafeEdge: host('SafeEdge') },
    '@/lib/dares': { todayDareDay: () => '2026-11-22', useDareDone: () => null },
    '@/lib/drop': { useDropDone: () => null, useDropStatus: () => ({ kind: 'waiting' }) },
    // The camera page itself doesn't need the face-filter camera for 🌆 (the Main Character screen has its own).
    '@/lib/faceMesh': { FACE_MESH_AVAILABLE: false },
    '@/lib/friends': { useIncomingRequestCount: () => 0 },
    '@/lib/plus': { usePlus: () => answer === 'yes', usePlusAnswer: () => answer },
    '@/lib/screenFlash': { brightenScreen: async () => async () => {}, SCREEN_FLASH_COLOR: 'white', SCREEN_FLASH_WARMUP_MS: 0 },
    '@/lib/videoLimits': { checkPickedVideo: () => 'ok', FREE_VIDEO_SECONDS: 30, PLUS_VIDEO_SECONDS: 60, maxVideoSeconds: () => 30, TOO_BIG_VIDEO: 'Too big' },
    './HomeTabBar': { TAB_BAR_HEIGHT: 60 },
    './ModeDial': dial.exports,
  });
  return { screen, calls, dialExports: dial.exports };
}

async function renderCamera(options, props = {}) {
  const { screen, calls, dialExports } = loadCamera(options);
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(screen.exports.CameraPage, { active: true, ...props })); });
  // The mode row's scrolling part, and the ModeDial itself (what the camera page passes it).
  const dial = () => tree.root.findAll((node) => node.type === 'ScrollView')[0];
  const modeDial = () => tree.root.findAll((node) => node.type === dialExports.ModeDial)[0];
  const bubble = (label) => tree.root.findAll((node) => node.type === 'Pressable' && node.props.accessibilityLabel === label)[0] ?? null;
  const bubbles = () => tree.root.findAll((node) => node.type === 'Pressable' && node.props.accessibilityRole === 'tab').map((node) => node.props.accessibilityLabel);
  // The shutter is the Bouncy that takes the photo (the 🌆 card is a Bouncy too).
  const shutter = () => tree.root.findAll((node) => node.type === 'Bouncy' && node.props.onLongPress)[0];
  const card = () => tree.root.findAll((node) => node.type === 'Bouncy' && !node.props.onLongPress)[0] ?? null;
  const icons = () => tree.root.findAllByType('IconButton').map((node) => node.props.label);
  const camera = () => tree.root.findAllByType('CameraView')[0] ?? null;
  // Stops the mode row on a spot, the way a swipe does (76 points per spot).
  const settleOn = async (label) => {
    const at = bubbles().indexOf(label);
    assert.ok(at > 0, `${label} is on the row`);
    await act(() => dial().props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: at * 76, y: 0 } } }));
  };
  return { tree, calls, dial, modeDial, bubble, bubbles, shutter, card, icons, camera, settleOn };
}

test('🌆 sits after Googly on the home camera; parking on it changes the ring and shows the card, and opens nothing', async () => {
  const camera = await renderCamera();
  try {
    // (The face filters follow it; this camera page itself is told there is no face tracking.)
    assert.deepEqual(camera.bubbles().slice(0, 6), ['Plain camera', 'Dare mode', 'Guess Who mode', 'Googly mode', 'Main Character mode', 'Soft Glow mode']);
    assert.equal(camera.card(), null, 'no card on the plain camera');
    await camera.settleOn('Main Character mode');
    assert.deepEqual(camera.calls.routes, [], 'settling never opens a page');
    assert.equal(camera.shutter().props.style[1].borderColor, SUNSET);
    assert.equal(camera.shutter().props.accessibilityLabel, 'Open Main Character Mode');
    assert.equal(textOf(camera.card()), '🌆 Main Character · your face in a comic poster' + 'Tap to start');
    // The camera stays the plain one, and stays on the side it was (back).
    assert.ok(camera.camera());
    assert.equal(camera.camera().props.facing, 'back');
    // No gallery here (the shutter doesn't take a photo in this mode).
    assert.equal(camera.icons().includes('Pick from gallery'), false);
    // Settling again on the same spot (a swipe between the Chat / Camera / Home pages) still opens nothing.
    await camera.settleOn('Main Character mode');
    assert.deepEqual(camera.calls.routes, []);
  } finally { await unmount(camera.tree); }
});

test('in 🌆 mode the shutter (tap and hold) opens the Main Character screen: no photo, no video', async () => {
  const camera = await renderCamera();
  try {
    await camera.settleOn('Main Character mode');
    await act(() => camera.shutter().props.onPress());
    assert.deepEqual(plain(camera.calls.routes), [['push', '/main-character']]);
    assert.equal(camera.calls.shots, 0);
    // Holding the shutter does the same: no video starts.
    await act(() => camera.shutter().props.onLongPress());
    await act(() => camera.shutter().props.onPressOut());
    assert.deepEqual(plain(camera.calls.routes), [['push', '/main-character'], ['push', '/main-character']]);
    assert.equal(camera.calls.recordings, 0);
    assert.equal(camera.calls.shots, 0);
    assert.equal(camera.camera().props.mode, 'picture');
    assert.equal(camera.shutter().props.disabled, false, 'never left busy');
    assert.ok(camera.calls.haptics.includes('selection'));
    assert.equal(camera.calls.haptics.includes('impact:heavy'), false, 'no photo-taking buzz');
  } finally { await unmount(camera.tree); }
});

test('the 🌆 card opens the Main Character screen; so does a tap on the bubble', async () => {
  const camera = await renderCamera();
  try {
    await camera.settleOn('Main Character mode');
    await act(() => camera.card().props.onPress());
    assert.deepEqual(plain(camera.calls.routes), [['push', '/main-character']]);
    // A tap on the bubble it is already on: opens it again.
    await act(() => camera.bubble('Main Character mode').props.onPress());
    assert.deepEqual(plain(camera.calls.routes), [['push', '/main-character'], ['push', '/main-character']]);
  } finally { await unmount(camera.tree); }
  // From another mode, one tap on the bubble picks it AND opens the screen.
  const other = await renderCamera();
  try {
    await act(() => other.bubble('Main Character mode').props.onPress());
    assert.deepEqual(plain(other.calls.routes), [['push', '/main-character']]);
    assert.equal(other.shutter().props.style[1].borderColor, SUNSET);
  } finally { await unmount(other.tree); }
});

test('leaving 🌆 for the plain camera: the shutter takes photos again and the gallery is back', async () => {
  const camera = await renderCamera();
  try {
    await camera.settleOn('Main Character mode');
    await act(() => camera.dial().props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: 0, y: 0 } } }));
    assert.equal(camera.card(), null);
    assert.ok(camera.icons().includes('Pick from gallery'));
    assert.equal(camera.shutter().props.accessibilityLabel, 'Take photo, or hold to record a video');
    await act(() => camera.shutter().props.onPress());
    assert.equal(camera.calls.shots, 1);
    assert.deepEqual(plain(camera.calls.routes.map(([, to]) => (typeof to === 'string' ? to : to.pathname))), ['/editor']);
  } finally { await unmount(camera.tree); }
});

test('Plus variant: with MAIN_CHARACTER_PLUS on and surely no Plus, 🌆 has the ⭐ and picking it opens Peekaboo+ instead', async () => {
  const mainCharacter = config({ MAIN_CHARACTER_PLUS: true });
  const locked = await renderCamera({ answer: 'no', mainCharacter });
  try {
    assert.ok(locked.bubble('Main Character mode, needs Peekaboo+'));
    // A tap: Peekaboo+ opens, the Main Character screen doesn't, and the row stays where it was.
    await act(() => locked.bubble('Main Character mode, needs Peekaboo+').props.onPress());
    assert.deepEqual(plain(locked.calls.routes), [['push', '/plus']]);
    assert.equal(locked.card(), null);
    assert.equal(locked.shutter().props.accessibilityLabel, 'Take photo, or hold to record a video');
    // The same when the row settles on it (as with the Plus face filters).
    await locked.settleOn('Main Character mode, needs Peekaboo+');
    assert.deepEqual(plain(locked.calls.routes), [['push', '/plus'], ['push', '/plus']]);
    assert.equal(locked.card(), null);
  } finally { await unmount(locked.tree); }

  // With Plus, or while still checking (the Main Character screen asks again itself): it works as usual.
  for (const answer of ['yes', 'checking']) {
    const camera = await renderCamera({ answer, mainCharacter });
    try {
      assert.ok(camera.bubble('Main Character mode'), answer);
      await act(() => camera.bubble('Main Character mode').props.onPress());
      assert.deepEqual(plain(camera.calls.routes), [['push', '/main-character']], answer);
      await act(() => camera.shutter().props.onPress());
      assert.deepEqual(plain(camera.calls.routes), [['push', '/main-character'], ['push', '/main-character']], answer);
    } finally { await unmount(camera.tree); }
  }

  // Free (the plan): no ⭐ and no Peekaboo+ screen, even without Plus.
  const free = await renderCamera({ answer: 'no' });
  try {
    await act(() => free.bubble('Main Character mode').props.onPress());
    assert.deepEqual(plain(free.calls.routes), [['push', '/main-character']]);
  } finally { await unmount(free.tree); }
});

test('the chat cameras never have 🌆, and their shutter always takes the photo', async () => {
  for (const props of [{ sendTo: 'friend-1' }, { sendToGroup: 'group-1', groupGuessOk: true }]) {
    const camera = await renderCamera({}, props);
    try {
      assert.equal(camera.bubbles().some((label) => label.startsWith('Main Character')), false, JSON.stringify(props));
      // Even if its row were somehow asked for it, a chat camera is never in Main Character mode.
      await act(() => camera.modeDial().props.onChange('mainCharacter'));
      assert.equal(camera.card(), null);
      await act(() => camera.shutter().props.onPress());
      assert.equal(camera.calls.shots, 1, JSON.stringify(props));
      assert.equal(camera.calls.routes.some(([, to]) => to === '/main-character'), false, JSON.stringify(props));
    } finally { await unmount(camera.tree); }
  }
});
