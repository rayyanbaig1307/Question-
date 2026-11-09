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

// Every face filter, in the order it sits on the row (the new ones follow the owner's concept sheet).
const FILTERS = ['glow', 'golden', 'peekabooEyes', 'brainBuffering', 'crybaby', 'auraOverload', 'heartEyes'];
const FILTER_LABELS = ['Soft Glow mode', 'Golden Hour mode', 'Peekaboo Eyes mode', 'Brain Buffering mode', 'Crybaby mode', 'Aura Overload mode', 'Heart Eyes mode'];

test('Dare and Guess Who are the first bubbles, and the Peekaboo+ filters are last', () => {
  const { CAMERA_MODES } = loadDial(true);
  assert.deepEqual(plain(CAMERA_MODES.map((m) => m.key)), ['dare', 'guess', 'googly', ...FILTERS]);
  // Every face filter is Peekaboo+, and nothing before them is.
  assert.deepEqual(plain(CAMERA_MODES.filter((m) => m.plus).map((m) => m.key)), FILTERS);
});

test('without the face filters on this download, the row is Dare, Guess Who, Googly', () => {
  const { CAMERA_MODES } = loadDial(false);
  assert.deepEqual(plain(CAMERA_MODES.map((m) => m.key)), ['dare', 'guess', 'googly']);
});

test('the chat camera still shows only the lenses, googly first', () => {
  const { CAMERA_MODES, LENS_MODES } = loadDial(true);
  assert.deepEqual(plain(CAMERA_MODES.filter((m) => LENS_MODES.includes(m.key)).map((m) => m.key)), ['googly', ...FILTERS]);
});

// ---------------------------------------------------------------------------
// 🕵️ The group chat camera: the lenses plus a Guess Who bubble (the photo goes to the group with no name on it).
// ---------------------------------------------------------------------------
const { renderer, act, unmount, textOf } = require('./harness.cjs');

async function renderDial(props, extra = {}) {
  const screen = loadScreen('src/components/home/ModeDial.tsx', {
    ...extra,
    'expo-linear-gradient': { LinearGradient: host('LinearGradient') },
    '@/components/Bouncy': { Bouncy: host('Bouncy') },
    '@/lib/drop': { formatClock: () => '', lateLabel: () => '' },
    '@/lib/faceLens': { FACE_LENS_AVAILABLE: true },
    '@/lib/faceMesh': { FACE_MESH_AVAILABLE: true },
    'react-native-reanimated': { __esModule: true, default: { View: host('AnimatedView') }, useSharedValue: (initial) => React.useRef({ value: initial, get() { return this.value; }, set(value) { this.value = value; } }).current, useAnimatedStyle: (callback) => callback(), withRepeat: (value) => value, withSequence: (...values) => values[0], withTiming: (value) => value },
  });
  const changes = [];
  let tree;
  await act(async () => {
    tree = renderer.create(React.createElement(screen.exports.ModeDial, { onChange: (mode) => { changes.push(mode); }, ...props }));
  });
  const bubbles = () => tree.root.findAllByType('Pressable').map((node) => node.props.accessibilityLabel);
  const bubble = (label) => tree.root.findAllByType('Pressable').find((node) => node.props.accessibilityLabel === label);
  // Which mode a bubble is for (worked out from its VoiceOver label).
  const keyOf = (node) => node.props.accessibilityLabel === 'Plain camera'
    ? 'photo'
    : screen.exports.CAMERA_MODES.find((item) => node.props.accessibilityLabel.startsWith(`${item.label} mode`)).key;
  return { screen, tree, changes, bubbles, bubble, keyOf };
}

test('the group chat dial has a Guess Who bubble before the lenses; other chat dials do not', async () => {
  const group = await renderDial({ mode: 'photo', lensesOnly: true, withGuess: true });
  try {
    assert.deepEqual(group.bubbles(), ['Plain camera', 'Guess Who mode', 'Googly mode', ...FILTER_LABELS]);
    await act(() => group.bubble('Guess Who mode').props.onPress());
    assert.deepEqual(group.changes, ['guess']);
  } finally { await unmount(group.tree); }
  const chat = await renderDial({ mode: 'photo', lensesOnly: true });
  try {
    assert.deepEqual(chat.bubbles(), ['Plain camera', 'Googly mode', ...FILTER_LABELS]);
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

// ---------------------------------------------------------------------------
// ⭐ Peekaboo+ filters without Plus: a small star on their bubbles, and the row glides back when one is refused
// (it used to stay parked on the Plus bubble while the camera stayed plain).
// ---------------------------------------------------------------------------

// A ScrollView stand-in that remembers where the row was asked to glide to.
function scrollingRow() {
  const scrolls = [];
  const ScrollView = React.forwardRef(function ScrollView(props, ref) {
    React.useImperativeHandle(ref, () => ({ scrollTo: (to) => scrolls.push(to) }));
    return React.createElement('ScrollView', props, props.children);
  });
  const reactNative = { ...loadScreen('src/components/home/ModeDial.tsx', {
    'expo-linear-gradient': { LinearGradient: host('LinearGradient') },
    '@/components/Bouncy': { Bouncy: host('Bouncy') },
    '@/lib/drop': { formatClock: () => '', lateLabel: () => '' },
    '@/lib/faceLens': { FACE_LENS_AVAILABLE: true },
    '@/lib/faceMesh': { FACE_MESH_AVAILABLE: true },
    'react-native-reanimated': { __esModule: true, default: { View: host('AnimatedView') }, useSharedValue: (initial) => React.useRef({ value: initial, get() { return this.value; }, set(value) { this.value = value; } }).current, useAnimatedStyle: (callback) => callback(), withRepeat: (value) => value, withSequence: (...values) => values[0], withTiming: (value) => value },
  }).modules['react-native'], ScrollView };
  return { scrolls, overrides: { 'react-native': reactNative } };
}

// Stops the row on a spot, the way a swipe does (76 points per spot).
async function settleOn(dial, mode) {
  const slots = dial.tree.root.findAllByType('Pressable').map(dial.keyOf);
  const at = slots.indexOf(mode);
  assert.ok(at > 0, `${mode} is on the row`);
  await act(() => dial.tree.root.findByType('ScrollView').props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: at * 76, y: 0 } } }));
}

test('a refused swipe onto a Plus filter glides the row back; an allowed one does not', async () => {
  const row = scrollingRow();
  const refused = await renderDial({ mode: 'photo', onChange: (mode) => { refused.changes.push(mode); return false; } }, row.overrides);
  try {
    row.scrolls.length = 0;
    await settleOn(refused, 'heartEyes');
    assert.deepEqual(refused.changes, ['heartEyes']);
    assert.deepEqual(plain(row.scrolls), [{ x: 0, animated: true }], 'back to the plain camera spot');
    // A refused tap glides back too.
    row.scrolls.length = 0;
    await act(() => refused.bubble('Crybaby mode').props.onPress());
    assert.deepEqual(refused.changes, ['heartEyes', 'crybaby']);
    assert.deepEqual(plain(row.scrolls), [{ x: 0, animated: true }]);
  } finally { await unmount(refused.tree); }

  const row2 = scrollingRow();
  const allowed = await renderDial({ mode: 'photo', onChange: (mode) => { allowed.changes.push(mode); return true; } }, row2.overrides);
  try {
    row2.scrolls.length = 0;
    await settleOn(allowed, 'heartEyes');
    assert.deepEqual(allowed.changes, ['heartEyes']);
    assert.deepEqual(plain(row2.scrolls), [], 'no extra glide (the camera moves the row when the mode really changes)');
  } finally { await unmount(allowed.tree); }
});

test('without Plus, only the Plus filters get the ⭐ and say "needs Peekaboo+"; with Plus (or still checking) nothing does', async () => {
  const locked = await renderDial({ mode: 'photo', locked: true });
  try {
    const badged = locked.tree.root.findAllByType('Pressable').filter((node) => node.findAll((child) => child.props.testID === 'plus-badge' && typeof child.type === 'string').length > 0);
    assert.deepEqual(badged.map(locked.keyOf), FILTERS);
    assert.deepEqual(locked.bubbles(), ['Plain camera', 'Dare mode', 'Guess Who mode', 'Googly mode', ...FILTER_LABELS.map((label) => `${label}, needs Peekaboo+`)]);
    for (const node of badged) assert.ok(node.findAllByType('Text').some((child) => child.props.children === '⭐'));
  } finally { await unmount(locked.tree); }
  const open = await renderDial({ mode: 'photo' });
  try {
    assert.equal(open.tree.root.findAll((child) => child.props.testID === 'plus-badge').length, 0);
    assert.deepEqual(open.bubbles(), ['Plain camera', 'Dare mode', 'Guess Who mode', 'Googly mode', ...FILTER_LABELS]);
  } finally { await unmount(open.tree); }
});

test('every face filter has a VoiceOver hint (there are no words on the camera)', async () => {
  const dial = await renderDial({ mode: 'photo' });
  try {
    for (const key of FILTERS) {
      const node = dial.tree.root.findAllByType('Pressable').find((child) => dial.keyOf(child) === key);
      assert.equal(typeof node.props.accessibilityHint, 'string', key);
      assert.ok(node.props.accessibilityHint.length > 0, key);
    }
  } finally { await unmount(dial.tree); }
});

test('no caption on the camera for any face filter', async () => {
  const dial = await renderDial({ mode: 'photo' });
  try {
    for (const mode of FILTERS) {
      let tree;
      await act(async () => { tree = renderer.create(React.createElement(dial.screen.exports.ModeCaption, { mode, drop: { kind: 'waiting' } })); });
      try { assert.equal(tree.toJSON(), null, mode); } finally { await unmount(tree); }
    }
  } finally { await unmount(dial.tree); }
});
