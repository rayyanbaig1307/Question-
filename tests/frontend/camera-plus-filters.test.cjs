const test = require('node:test');
const assert = require('node:assert/strict');
const { React, renderer, loadScreen, act, unmount, host } = require('./harness.cjs');

// 🎭 The Peekaboo+ face filters on the camera (src/components/home/CameraPage.tsx): Soft Glow, Golden Hour, and the
// five new ones (Peekaboo Eyes, Brain Buffering, Crybaby, Aura Overload, Heart Eyes).
// - Sure you don't have Plus: picking one is refused (the mode row glides back) and the Peekaboo+ screen opens.
// - Plus: the face-tracking camera shows the filter, on the selfie camera, and switching filters keeps the same
//   camera (no restart).
// - Plus runs out while a filter is on: back to the plain camera.
// - Not sure yet (just after the app starts, or no internet): the filter goes on, and switches off after a few
//   seconds if Plus still isn't confirmed.
const plain = value => JSON.parse(JSON.stringify(value));

// The theme's real camera colours (the harness default has none).
const COLORS = {
  white: '#FFFFFF', black: '#000000', red: '#FF4D4D', blue: '#38B6FF', yellow: '#FFE14D', orange: '#FF8A3D',
  pink: '#FF4F9A', purple: '#9B5CFF', green: '#3DDC97', accent: '#FF4F9A', surface: '#111111', textMuted: '#999999',
};

function loadCamera(firstAnswer) {
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
    'react-native-gesture-handler': { GestureDetector: host('GestureDetector'), usePinchGesture: () => ({}), useSimultaneousGestures: () => ({}), useTapGesture: () => ({}) },
    'react-native-worklets': { scheduleOnRN: noop },
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
  });
  return { screen, calls, setAnswer };
}

async function renderCamera(answer, props = {}) {
  const { screen, calls, setAnswer } = loadCamera(answer);
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(screen.exports.CameraPage, { active: true, ...props })); });
  const dial = () => tree.root.findByType('ModeDial');
  const shutter = () => tree.root.findByType('Bouncy');
  const softGlow = () => tree.root.findAllByType('SoftGlow');
  // Picks a mode on the row, and gives back what the camera answered (false = refused).
  const pick = async mode => { let answered; await act(() => { answered = dial().props.onChange(mode); }); return answered; };
  // Runs every timer the camera started and didn't stop again (each one only once).
  const ran = new Set();
  const runTimers = async () => {
    for (let i = 0; i < screen.calls.timers.length; i++) {
      if (ran.has(i) || screen.calls.clearedTimers.has(i + 1)) continue;
      ran.add(i);
      await act(() => screen.calls.timers[i]());
    }
  };
  const answer2 = async next => act(() => setAnswer(next));
  return { tree, calls, screen, dial, shutter, softGlow, pick, runTimers, setAnswer: answer2 };
}

const NEW_FILTERS = ['peekabooEyes', 'brainBuffering', 'crybaby', 'auraOverload', 'heartEyes'];

test('sure you have no Plus: a face filter is refused, the Peekaboo+ screen opens and the camera stays plain', async () => {
  const camera = await renderCamera('no');
  try {
    assert.equal(camera.dial().props.locked, true, 'the Plus bubbles show their ⭐');
    for (const mode of [...NEW_FILTERS, 'glow', 'golden']) {
      assert.equal(await camera.pick(mode), false, `${mode} is refused`);
      assert.equal(camera.dial().props.mode, 'photo');
      assert.equal(camera.softGlow().length, 0);
    }
    assert.equal(camera.calls.pushed.length, 7);
    assert.ok(camera.calls.pushed.every(to => to === '/plus'));
    // The free modes still work.
    assert.notEqual(await camera.pick('dare'), false);
    assert.equal(camera.dial().props.mode, 'dare');
  } finally { await unmount(camera.tree); }
});

test('with Plus: the filter shows on the selfie camera with its own ring colour, and switching filters keeps the same camera', async () => {
  const camera = await renderCamera('yes');
  try {
    assert.equal(camera.dial().props.locked, false, 'no ⭐ for Plus members');
    assert.equal(await camera.pick('crybaby'), true);
    assert.equal(camera.dial().props.mode, 'crybaby');
    const [glow] = camera.softGlow();
    assert.equal(glow.props.look, 'crybaby');
    assert.equal(glow.props.facing, 'front', 'filters are for faces: the selfie camera');
    const ring = camera.screen.getBinding('MODE_RING');
    assert.equal(camera.shutter().props.style[1].borderColor, ring.crybaby);
    assert.equal(ring.crybaby, COLORS.blue);
    // Every filter has its own ring colour entry.
    for (const mode of NEW_FILTERS) assert.equal(typeof ring[mode], 'string', mode);
    assert.equal(camera.calls.glowMounts, 1);
    for (const mode of ['auraOverload', 'heartEyes', 'peekabooEyes', 'brainBuffering', 'glow', 'golden']) {
      assert.equal(await camera.pick(mode), true);
      assert.equal(camera.softGlow()[0].props.look, mode);
      assert.equal(camera.shutter().props.style[1].borderColor, ring[mode]);
    }
    assert.equal(camera.calls.glowMounts, 1, 'the face camera never restarted');
    assert.deepEqual(camera.calls.pushed, []);
    // Back to the plain camera: the normal camera again.
    await camera.pick('photo');
    assert.equal(camera.softGlow().length, 0);
    assert.equal(camera.tree.root.findAllByType('CameraView').length, 1);
  } finally { await unmount(camera.tree); }
});

test('Plus runs out while a filter is on: back to the plain camera and the Peekaboo+ screen', async () => {
  const camera = await renderCamera('yes');
  try {
    await camera.pick('heartEyes');
    await camera.runTimers();
    assert.equal(camera.dial().props.mode, 'heartEyes', 'nothing switches it off while you have Plus');
    await camera.setAnswer('no');
    await camera.runTimers();
    assert.equal(camera.dial().props.mode, 'photo');
    assert.equal(camera.softGlow().length, 0);
    assert.deepEqual(camera.calls.pushed, ['/plus']);
  } finally { await unmount(camera.tree); }
});

test('Plus runs out while the camera is off screen: the filter switches off without opening the Peekaboo+ screen', async () => {
  const camera = await renderCamera('yes');
  try {
    await camera.pick('auraOverload');
    await act(() => camera.tree.update(React.createElement(camera.screen.exports.CameraPage, { active: false })));
    await camera.setAnswer('no');
    await camera.runTimers();
    assert.equal(camera.dial().props.mode, 'photo');
    assert.deepEqual(camera.calls.pushed, []);
  } finally { await unmount(camera.tree); }
});

test('not sure yet: the filter goes on, then switches off after a while if Plus is never confirmed', async () => {
  const camera = await renderCamera('checking');
  try {
    assert.equal(camera.dial().props.locked, false, 'no ⭐ while still checking');
    assert.equal(await camera.pick('brainBuffering'), true, 'a Plus member whose Plus is still loading is never sent away');
    assert.equal(camera.softGlow()[0].props.look, 'brainBuffering');
    assert.deepEqual(camera.calls.pushed, []);
    await camera.runTimers();
    assert.equal(camera.dial().props.mode, 'photo');
    assert.deepEqual(camera.calls.pushed, ['/plus']);
  } finally { await unmount(camera.tree); }
});

test('not sure yet, then Plus is confirmed: the filter stays on', async () => {
  const camera = await renderCamera('checking');
  try {
    await camera.pick('peekabooEyes');
    await camera.setAnswer('yes');
    await camera.runTimers();
    assert.equal(camera.dial().props.mode, 'peekabooEyes');
    assert.equal(camera.softGlow()[0].props.look, 'peekabooEyes');
    assert.deepEqual(camera.calls.pushed, []);
  } finally { await unmount(camera.tree); }
});

test('the camera inside a chat has the filters too, with the same Plus check', async () => {
  const camera = await renderCamera('yes', { sendTo: 'bob' });
  try {
    assert.equal(camera.dial().props.lensesOnly, true);
    assert.equal(camera.dial().props.locked, false);
    assert.equal(await camera.pick('heartEyes'), true);
    assert.equal(camera.softGlow()[0].props.look, 'heartEyes');
    await act(() => camera.shutter().props.onPress());
    assert.equal(camera.calls.captures, 1);
    assert.deepEqual(plain(camera.calls.pushed), [{ pathname: '/editor', params: { uri: 'file:///qa-filter.jpg', fit: 'cover', to: 'bob' } }]);
  } finally { await unmount(camera.tree); }
  const refused = await renderCamera('no', { sendTo: 'bob' });
  try {
    assert.equal(refused.dial().props.locked, true);
    assert.equal(await refused.pick('crybaby'), false);
    assert.deepEqual(refused.calls.pushed, ['/plus']);
  } finally { await unmount(refused.tree); }
});

test('a shutter tap with a filter on takes the photo from the face camera and opens the editor', async () => {
  const camera = await renderCamera('yes');
  try {
    await camera.pick('auraOverload');
    await act(() => camera.shutter().props.onPress());
    assert.equal(camera.calls.captures, 1);
    assert.equal(camera.calls.shots, 0, 'not the normal camera');
    assert.deepEqual(plain(camera.calls.pushed), [{ pathname: '/editor', params: { uri: 'file:///qa-filter.jpg', fit: 'cover' } }]);
  } finally { await unmount(camera.tree); }
});

test('holding the shutter with a filter on records a plain video with the normal camera (like Soft Glow)', async () => {
  const camera = await renderCamera('yes');
  try {
    await camera.pick('crybaby');
    let recording;
    await act(() => { recording = camera.shutter().props.onLongPress(); });
    // The normal camera takes over while you record.
    assert.equal(camera.softGlow().length, 0);
    assert.equal(camera.tree.root.findAllByType('CameraView').length, 1);
    // Let the camera "start up" (the recorded waits), then the video is recorded.
    for (let round = 0; round < 3; round++) await camera.runTimers();
    await act(() => recording);
    assert.equal(camera.calls.recordings, 1);
    assert.deepEqual(plain(camera.calls.pushed), [{ pathname: '/editor', params: { uri: 'file:///qa-video.mov', fit: 'cover', video: '1' } }]);
    // Afterwards the filter is back.
    assert.equal(camera.softGlow()[0].props.look, 'crybaby');
  } finally { await unmount(camera.tree); }
});
