const test = require('node:test');
const assert = require('node:assert/strict');
const { React, renderer, loadScreen, act, unmount, host } = require('./harness.cjs');

// Pinch to zoom must never flip the camera (the owner zoomed the back camera and it jumped to the selfie camera).
// A double tap still flips it, but not during a pinch or just after one.
const plain = value => JSON.parse(JSON.stringify(value));

// The theme's real camera colours (the harness default has none).
const COLORS = {
  white: '#FFFFFF', black: '#000000', red: '#FF4D4D', blue: '#38B6FF', yellow: '#FFE14D', orange: '#FF8A3D',
  pink: '#FF4F9A', purple: '#9B5CFF', green: '#3DDC97', accent: '#FF4F9A', surface: '#111111', textMuted: '#999999',
};

// `frames`: a stand-in for lib/frameAccess.ts (left out: an older download without the 4 stretchy filters).
function loadCamera(firstAnswer, frames, gestures) {
  const calls = { pushed: [], shots: 0, captures: 0, glowMounts: 0, recordings: 0 };
  const noop = () => {};
  // Peekaboo+: 'yes', 'no' or 'checking', changed by the test with setAnswer().
  let answer = firstAnswer;
  const listeners = new Set();
  const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  const usePlusAnswer = () => React.useSyncExternalStore(subscribe, () => answer);
  const setAnswer = next => { answer = next; listeners.forEach(listener => listener()); };

  class CameraView extends React.Component {
    async takePictureAsync() { calls.shots++; return { uri: 'file:///qa-shot.jpg' }; }
    async recordAsync() { calls.recordings++; return { uri: 'file:///qa-video.mov' }; }
    stopRecording() {}
    render() { return React.createElement('CameraView', this.props); }
  }
  // The face-tracking camera: counts how often it starts, and hands back a photo with the filter on it.
  const SoftGlowCamera = React.forwardRef(function SoftGlowCamera(props, ref) {
    React.useImperativeHandle(ref, () => ({ capture: async () => { calls.captures++; return { uri: 'file:///qa-filter.jpg' }; } }));
    React.useEffect(() => { calls.glowMounts++; }, []);
    return React.createElement('SoftGlow', props);
  });
  const useShared = initial => React.useRef({ value: initial, get() { return this.value; }, set(value) { this.value = value; } }).current;
  const screen = loadScreen('src/components/home/CameraPage.tsx', {
    'expo-camera': { CameraView, useCameraPermissions: () => [{ granted: true }, noop], useMicrophonePermissions: () => [{ granted: true }, noop] },
    'expo-image-picker': { launchImageLibraryAsync: async () => ({ canceled: true, assets: [] }) },
    'expo-router': { router: { push: to => calls.pushed.push(to), back: noop } },
    'react-native-reanimated': {
      __esModule: true, default: { View: host('AnimatedView') },
      cancelAnimation: noop, Easing: { linear: 'linear' }, useAnimatedStyle: callback => callback(), useSharedValue: useShared,
      withSequence: (...values) => values[0], withTiming: value => value,
    },
    // Keep the gesture settings, so the test can play a pinch and a double tap.
    'react-native-gesture-handler': {
      GestureDetector: host('GestureDetector'),
      usePinchGesture: config => { gestures.pinch = config; return {}; },
      useTapGesture: config => { gestures.tap = config; return {}; },
      useSimultaneousGestures: () => ({}),
    },
    'react-native-worklets': { scheduleOnRN: (fn, ...args) => fn(...args) },
    '@/theme': { colors: COLORS, font: {}, radius: {}, space: {} },
    '@/components/Bouncy': { Bouncy: host('Bouncy') },
    '@/components/DareBanner': { DareBanner: host('DareBanner'), DarePill: host('DarePill') },
    '@/components/DropPill': { DropPill: host('DropPill'), DropTimer: host('DropTimer') },
    '@/components/IconButton': { IconButton: host('IconButton') },
    '@/components/SafeEdge': { SafeEdge: host('SafeEdge') },
    '@/components/lens/SoftGlowCamera': { SoftGlowCamera },
    '@/lib/dares': { todayDareDay: () => '2026-11-09', useDareDone: () => null },
    '@/lib/drop': { useDropDone: () => null, useDropStatus: () => ({ kind: 'waiting' }) },
    '@/lib/faceLens': { FACE_LENS_AVAILABLE: false },
    '@/lib/faceMesh': { FACE_MESH_AVAILABLE: true },
    '@/lib/friends': { useIncomingRequestCount: () => 0 },
    '@/lib/plus': { usePlus: () => answer === 'yes', usePlusAnswer },
    '@/lib/screenFlash': { brightenScreen: async () => async () => {}, SCREEN_FLASH_COLOR: 'white', SCREEN_FLASH_WARMUP_MS: 0 },
    '@/lib/videoLimits': { checkPickedVideo: () => 'ok', FREE_VIDEO_SECONDS: 30, PLUS_VIDEO_SECONDS: 60, maxVideoSeconds: () => 30, TOO_BIG_VIDEO: 'Too big' },
    './HomeTabBar': { TAB_BAR_HEIGHT: 60 },
    './ModeDial': { ModeDial: host('ModeDial'), GroupGuessCaption: host('GroupGuessCaption') },
    ...(frames ? { '@/lib/frameAccess': frames } : {}),
  });
  return { screen, calls, setAnswer };
}


async function renderCamera() {
  const gestures = {};
  const { screen } = loadCamera('no', undefined, gestures);
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(screen.exports.CameraPage, { active: true })); });
  const facing = () => tree.root.findByType('CameraView').props.facing;
  return { tree, gestures, facing };
}

// The camera code reads the real clock, so the test waits for real.
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (fn) => act(async () => fn());

test('a double tap on its own flips the camera', async () => {
  const c = await renderCamera();
  assert.equal(c.facing(), 'back');
  await run(() => c.gestures.tap.onActivate());
  assert.equal(c.facing(), 'front');
  assert.equal(c.gestures.tap.maxDistance, 24);
  await unmount(c.tree);
});

test('zooming with two fingers never flips the camera, even when lifting the fingers looks like a double tap', async () => {
  const c = await renderCamera();
  await run(() => { c.gestures.pinch.onBegin(); c.gestures.pinch.onActivate(); });
  await run(() => c.gestures.pinch.onUpdate({ scale: 1.6 }));
  // During the pinch.
  await run(() => c.gestures.tap.onActivate());
  assert.equal(c.facing(), 'back');
  await run(() => c.gestures.pinch.onFinalize());
  // Fingers lifting right after the pinch.
  await wait(300);
  await run(() => c.gestures.tap.onActivate());
  assert.equal(c.facing(), 'back');
  // A real double tap a moment later still works.
  await wait(800);
  await run(() => c.gestures.tap.onActivate());
  assert.equal(c.facing(), 'front');
  await unmount(c.tree);
});
