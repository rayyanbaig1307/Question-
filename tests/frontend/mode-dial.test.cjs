const test = require('node:test');
const assert = require('node:assert/strict');
const { React, loadScreen, host } = require('./harness.cjs');

// (The file runs in its own sandbox, so compare plain copies of its arrays.)
const plain = (value) => JSON.parse(JSON.stringify(value));

// The round mode bubbles above the shutter. The owner (6 Nov): Dare and Guess Who must come first, before the
// Peekaboo+ filters – stopping on a Plus filter without Plus opens the Peekaboo+ screen, which kept popping up
// on the way to Dare and Guess Who.
function loadDial(faceMesh) {
  return loadScreen('src/components/home/ModeDial.tsx', {
    'expo-linear-gradient': { LinearGradient: host('LinearGradient') },
    '@/components/Bouncy': { Bouncy: host('Bouncy') },
    '@/lib/drop': { formatClock: () => '', lateLabel: () => '' },
    '@/lib/faceLens': { FACE_LENS_AVAILABLE: true },
    '@/lib/faceMesh': { FACE_MESH_AVAILABLE: faceMesh },
    'react-native-reanimated': {
      __esModule: true,
      default: { View: host('AnimatedView') },
      useSharedValue: (initial) => React.useRef({ value: initial }).current,
      useAnimatedStyle: (callback) => callback(),
      withRepeat: (value) => value,
      withSequence: (...values) => values[0],
      withTiming: (value) => value,
    },
  }).exports;
}

test('Dare and Guess Who are the first bubbles, and the Peekaboo+ filters are last', () => {
  const { CAMERA_MODES } = loadDial(true);
  assert.deepEqual(plain(CAMERA_MODES.map((m) => m.key)), ['dare', 'guess', 'googly', 'glow', 'golden']);
});

test('without the face filters on this download, the row is Dare, Guess Who, Googly', () => {
  const { CAMERA_MODES } = loadDial(false);
  assert.deepEqual(plain(CAMERA_MODES.map((m) => m.key)), ['dare', 'guess', 'googly']);
});

test('the chat camera still shows only the lenses, googly first', () => {
  const { CAMERA_MODES, LENS_MODES } = loadDial(true);
  assert.deepEqual(plain(CAMERA_MODES.filter((m) => LENS_MODES.includes(m.key)).map((m) => m.key)), ['googly', 'glow', 'golden']);
});

// ---------------------------------------------------------------------------
// 🕵️ The group chat camera: the lenses plus a Guess Who bubble (the photo goes to the group with no name on it).
// ---------------------------------------------------------------------------
const { renderer, act, unmount, textOf } = require('./harness.cjs');

async function renderDial(props) {
  const screen = loadScreen('src/components/home/ModeDial.tsx', {
    'expo-linear-gradient': { LinearGradient: host('LinearGradient') },
    '@/components/Bouncy': { Bouncy: host('Bouncy') },
    '@/lib/drop': { formatClock: () => '', lateLabel: () => '' },
    '@/lib/faceLens': { FACE_LENS_AVAILABLE: true },
    '@/lib/faceMesh': { FACE_MESH_AVAILABLE: true },
    'react-native-reanimated': { __esModule: true, default: { View: host('AnimatedView') }, useSharedValue: (initial) => React.useRef({ value: initial }).current, useAnimatedStyle: (callback) => callback(), withRepeat: (value) => value, withSequence: (...values) => values[0], withTiming: (value) => value },
  });
  const changes = [];
  let tree;
  await act(async () => {
    tree = renderer.create(React.createElement(screen.exports.ModeDial, { onChange: (mode) => changes.push(mode), ...props }));
  });
  const bubbles = () => tree.root.findAllByType('Pressable').map((node) => node.props.accessibilityLabel);
  const bubble = (label) => tree.root.findAllByType('Pressable').find((node) => node.props.accessibilityLabel === label);
  return { screen, tree, changes, bubbles, bubble };
}

test('the group chat dial has a Guess Who bubble before the lenses; other chat dials do not', async () => {
  const group = await renderDial({ mode: 'photo', lensesOnly: true, withGuess: true });
  try {
    assert.deepEqual(group.bubbles(), ['Plain camera', 'Guess Who mode', 'Googly mode', 'Soft Glow mode', 'Golden Hour mode']);
    await act(() => group.bubble('Guess Who mode').props.onPress());
    assert.deepEqual(group.changes, ['guess']);
  } finally { await unmount(group.tree); }
  const chat = await renderDial({ mode: 'photo', lensesOnly: true });
  try {
    assert.deepEqual(chat.bubbles(), ['Plain camera', 'Googly mode', 'Soft Glow mode', 'Golden Hour mode']);
  } finally { await unmount(chat.tree); }
});

test('tapping the chosen Guess Who bubble again in a group chat stays on the camera (the Guess Who page is for friends)', async () => {
  const group = await renderDial({ mode: 'guess', lensesOnly: true, withGuess: true });
  try {
    await act(() => group.bubble('Guess Who mode').props.onPress());
    assert.deepEqual(group.screen.calls.routes, []);
    assert.deepEqual(group.changes, []);
  } finally { await unmount(group.tree); }
  // The home camera still opens the Guess Who page that way.
  const home = await renderDial({ mode: 'guess' });
  try {
    await act(() => home.bubble('Guess Who mode').props.onPress());
    assert.deepEqual(plain(home.screen.calls.routes), [['push', '/guess']]);
  } finally { await unmount(home.tree); }
});

test('the group Guess Who caption says there is no name on it', async () => {
  const dial = await renderDial({ mode: 'photo' });
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(dial.screen.exports.GroupGuessCaption)); });
  try {
    assert.equal(textOf(tree.root.findByType('Text')), '🕵️ No name on it · the group guesses who sent it');
  } finally { await unmount(tree); await unmount(dial.tree); }
});
