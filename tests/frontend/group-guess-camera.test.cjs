const test = require('node:test');
const assert = require('node:assert/strict');
const { React, renderer, loadScreen, act, unmount, host } = require('./harness.cjs');

// 🕵️ The group chat camera (src/components/home/CameraPage.tsx with sendToGroup): its dial has a Guess Who bubble
// when the chat says Guess Who can work there (groupGuessOk: at least 3 people, and a server that has it).
// In that mode the shutter only takes photos and the editor is told it's a group Guess Who (groupGuess=1) – never
// the friends' Guess Who (guess=1). A group dare proof camera has no Guess Who.
const plain = value => JSON.parse(JSON.stringify(value));

function loadCamera() {
  const calls = { pushed: [], pickers: [], shots: 0 };
  const noop = () => {};
  class CameraView extends React.Component {
    async takePictureAsync() { calls.shots++; return { uri: 'file:///qa-shot.jpg' }; }
    render() { return React.createElement('CameraView', this.props); }
  }
  const shared = initial => React.useRef({ value: initial, get() { return this.value; }, set(value) { this.value = value; } }).current;
  const screen = loadScreen('src/components/home/CameraPage.tsx', {
    'expo-camera': { CameraView, useCameraPermissions: () => [{ granted: true }, noop], useMicrophonePermissions: () => [{ granted: true }, noop] },
    'expo-image-picker': { launchImageLibraryAsync: async options => { calls.pickers.push(options); return { canceled: true, assets: [] }; } },
    'expo-router': { router: { push: to => calls.pushed.push(to), back: noop } },
    'react-native-reanimated': {
      __esModule: true, default: { View: host('AnimatedView') },
      cancelAnimation: noop, Easing: { linear: 'linear' }, useAnimatedStyle: callback => callback(), useSharedValue: shared,
      withSequence: (...values) => values[0], withTiming: value => value,
    },
    'react-native-gesture-handler': { GestureDetector: host('GestureDetector'), usePinchGesture: () => ({}), useSimultaneousGestures: () => ({}), useTapGesture: () => ({}) },
    'react-native-worklets': { scheduleOnRN: noop },
    '@/components/Bouncy': { Bouncy: host('Bouncy') },
    '@/components/DareBanner': { DareBanner: host('DareBanner'), DarePill: host('DarePill') },
    '@/components/DropPill': { DropPill: host('DropPill'), DropTimer: host('DropTimer') },
    '@/components/IconButton': { IconButton: host('IconButton') },
    '@/components/SafeEdge': { SafeEdge: host('SafeEdge') },
    '@/lib/dares': { todayDareDay: () => '2026-11-04', useDareDone: () => null },
    '@/lib/drop': { useDropDone: () => null, useDropStatus: () => ({ kind: 'waiting' }) },
    '@/lib/faceLens': { FACE_LENS_AVAILABLE: false },
    '@/lib/faceMesh': { FACE_MESH_AVAILABLE: false },
    '@/lib/friends': { useIncomingRequestCount: () => 0 },
    '@/lib/screenFlash': { brightenScreen: async () => async () => {}, SCREEN_FLASH_COLOR: 'white', SCREEN_FLASH_WARMUP_MS: 0 },
    '@/lib/videoLimits': { checkPickedVideo: () => 'ok', FREE_VIDEO_SECONDS: 30, PLUS_VIDEO_SECONDS: 60, maxVideoSeconds: () => 30, TOO_BIG_VIDEO: 'Too big' },
    './HomeTabBar': { TAB_BAR_HEIGHT: 60 },
    './ModeDial': { ModeDial: host('ModeDial'), GroupGuessCaption: host('GroupGuessCaption') },
  });
  return { CameraPage: screen.exports.CameraPage, calls };
}

async function renderCamera(props) {
  const { CameraPage, calls } = loadCamera();
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(CameraPage, { active: true, ...props })); });
  const shutter = () => tree.root.findByType('Bouncy');
  const dial = () => tree.root.findByType('ModeDial');
  return { tree, calls, shutter, dial };
}

test('in a group chat camera, Guess Who mode opens the editor as a group Guess Who (never the friends one)', async () => {
  const { tree, calls, shutter, dial } = await renderCamera({ sendToGroup: 'squad', groupGuessOk: true });
  try {
    assert.equal(dial().props.lensesOnly, true);
    assert.equal(dial().props.withGuess, true);
    assert.equal(tree.root.findAllByType('GroupGuessCaption').length, 0);
    await act(() => dial().props.onChange('guess'));
    assert.equal(tree.root.findAllByType('GroupGuessCaption').length, 1);
    assert.equal(shutter().props.accessibilityLabel, 'Take your Guess Who photo');
    await act(() => shutter().props.onPress());
    assert.equal(calls.shots, 1);
    const [opened] = plain(calls.pushed);
    assert.equal(opened.pathname, '/editor');
    assert.deepEqual(opened.params, { uri: 'file:///qa-shot.jpg', fit: 'cover', group: 'squad', groupGuess: '1' });
  } finally { await unmount(tree); }
});

test('Guess Who in a group is photos only: holding the shutter takes a photo, and the gallery offers only photos', async () => {
  const { tree, calls, shutter, dial } = await renderCamera({ sendToGroup: 'squad', groupGuess: true, groupGuessOk: true });
  try {
    assert.equal(dial().props.mode, 'guess', 'opened straight in Guess Who mode');
    assert.equal(shutter().props.onLongPress, shutter().props.onPress, 'no video recording in this mode');
    await act(() => tree.root.findAllByType('IconButton').find(node => node.props.label === 'Pick from gallery').props.onPress());
    assert.deepEqual(plain(calls.pickers[0].mediaTypes), ['images']);
  } finally { await unmount(tree); }
});

test('the normal group camera still sends a normal group photo, and can record videos', async () => {
  const { tree, calls, shutter } = await renderCamera({ sendToGroup: 'squad' });
  try {
    assert.notEqual(shutter().props.onLongPress, shutter().props.onPress);
    await act(() => tree.root.findAllByType('IconButton').find(node => node.props.label === 'Pick from gallery').props.onPress());
    assert.deepEqual(plain(calls.pickers[0].mediaTypes), ['images', 'videos']);
    await act(() => shutter().props.onPress());
    assert.deepEqual(plain(calls.pushed[0].params), { uri: 'file:///qa-shot.jpg', fit: 'cover', group: 'squad' });
  } finally { await unmount(tree); }
});

test('a group dare proof camera has no Guess Who bubble, even if asked to start in Guess Who mode', async () => {
  const { tree, calls, shutter, dial } = await renderCamera({ sendToGroup: 'squad', groupDare: 'dare1', groupGuess: true, groupGuessOk: true });
  try {
    assert.equal(dial().props.withGuess, false);
    assert.equal(dial().props.mode, 'photo');
    await act(() => shutter().props.onPress());
    assert.deepEqual(plain(calls.pushed[0].params), { uri: 'file:///qa-shot.jpg', fit: 'cover', group: 'squad', groupDare: 'dare1' });
  } finally { await unmount(tree); }
});

test('a one-to-one chat camera has no Guess Who bubble', async () => {
  const { tree, dial } = await renderCamera({ sendTo: 'bob' });
  try {
    assert.equal(dial().props.withGuess, false);
  } finally { await unmount(tree); }
});

test('without the chat saying Guess Who can work (fewer than 3 people, or a server without it): no bubble, never a Guess Who', async () => {
  // Even when asked to start in Guess Who mode.
  const { tree, calls, shutter, dial } = await renderCamera({ sendToGroup: 'squad', groupGuess: true });
  try {
    assert.equal(dial().props.withGuess, false, 'no Guess Who bubble');
    assert.equal(dial().props.mode, 'photo');
    assert.equal(tree.root.findAllByType('GroupGuessCaption').length, 0);
    // Even if the dial somehow lands on Guess Who, the photo is a normal group photo.
    await act(() => dial().props.onChange('guess'));
    assert.equal(tree.root.findAllByType('GroupGuessCaption').length, 0);
    assert.notEqual(shutter().props.accessibilityLabel, 'Take your Guess Who photo');
    await act(() => shutter().props.onPress());
    const [opened] = plain(calls.pushed);
    assert.equal(opened.params.groupGuess, undefined, 'never sent as a group Guess Who');
    assert.deepEqual(opened.params, { uri: 'file:///qa-shot.jpg', fit: 'cover', group: 'squad' });
  } finally { await unmount(tree); }
});

test('the camera screen passes on what the group chat said (groupGuessOk=1 only)', async () => {
  const seen = [];
  for (const params of [{ group: 'squad', groupGuessOk: '1' }, { group: 'squad' }, { group: 'squad', groupGuessOk: '0' }]) {
    const screen = loadScreen('src/app/(app)/camera.tsx', {
      'expo-router': { useIsFocused: () => true, useLocalSearchParams: () => params },
      'expo-status-bar': { StatusBar: host('StatusBar') },
      '@/components/home/CameraPage': { CameraPage: host('CameraPage') },
    });
    let tree;
    await act(async () => { tree = renderer.create(React.createElement(screen.Component)); });
    try {
      const page = tree.root.findByType('CameraPage');
      seen.push([page.props.sendToGroup, page.props.groupGuessOk]);
    } finally { await unmount(tree); }
  }
  assert.deepEqual(seen, [['squad', true], ['squad', false], ['squad', false]]);
});
