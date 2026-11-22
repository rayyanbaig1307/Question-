const test = require('node:test');
const assert = require('node:assert/strict');
const { React, loadScreen, host } = require('./harness.cjs');

// (The file runs in its own sandbox, so compare plain copies of its arrays.)
const plain = (value) => JSON.parse(JSON.stringify(value));

// The round mode bubbles above the shutter. The owner (6 Nov): Dare and Guess Who must come first, before the
// Peekaboo+ filters – stopping on a Plus filter without Plus opens the Peekaboo+ screen, which kept popping up
// on the way to Dare and Guess Who.
// `frames`: a stand-in for lib/frameAccess.ts (the harness default is an older download without the camera's own
// pixels, so the 4 stretchy filters are not there).
function loadDial(faceMesh, frames) {
  return loadScreen('src/components/home/ModeDial.tsx', {
    ...(frames ? { '@/lib/frameAccess': frames } : {}),
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

// Every face filter on an older download (no stretchy ones), in the order it sits on the row (the new ones follow
// the owner's concept sheet).
const FILTERS = ['glow', 'golden', 'peekabooEyes', 'brainBuffering', 'crybaby', 'auraOverload', 'heartEyes'];
const FILTER_LABELS = ['Soft Glow mode', 'Golden Hour mode', 'Peekaboo Eyes mode', 'Brain Buffering mode', 'Crybaby mode', 'Aura Overload mode', 'Heart Eyes mode'];
// Soft Glow and Golden Hour are free for everyone (owner, 9 Nov); the new ones are Peekaboo+.
const FREE_FILTERS = ['glow', 'golden'];
const PLUS_FILTERS = FILTERS.filter((key) => !FREE_FILTERS.includes(key));

test('Dare and Guess Who are the first bubbles, and the Peekaboo+ filters are last', () => {
  const { CAMERA_MODES } = loadDial(true);
  assert.deepEqual(plain(CAMERA_MODES.map((m) => m.key)), ['dare', 'guess', 'googly', ...FILTERS]);
  // The new face filters are Peekaboo+ and sit at the end; Soft Glow and Golden Hour are free.
  assert.deepEqual(plain(CAMERA_MODES.filter((m) => m.plus).map((m) => m.key)), PLUS_FILTERS);
  assert.deepEqual(plain(CAMERA_MODES.slice(-PLUS_FILTERS.length).map((m) => m.key)), PLUS_FILTERS);
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
    assert.deepEqual(badged.map(locked.keyOf), PLUS_FILTERS);
    assert.deepEqual(locked.bubbles(), ['Plain camera', 'Dare mode', 'Guess Who mode', 'Googly mode', ...FILTER_LABELS.map((label, i) => (PLUS_FILTERS.includes(FILTERS[i]) ? `${label}, needs Peekaboo+` : label))]);
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

// ---------------------------------------------------------------------------
// 🫥 🗿 😃 👾 The 4 stretchy filters (Tiny Face, Gigachin, Big Mouth, Pixel Panic) change the camera picture itself,
// so they need the camera's own pixels (lib/frameAccess.ts). Only the new download has them: everywhere else (App
// Store build 10, TestFlight 7–9, old APKs, Expo Go) the row must stay exactly as it is above.
// ---------------------------------------------------------------------------
const { frameAccessMock } = require('./harness.cjs');

// The whole row on the new download: the plain camera spot, then 14 bubbles (15 spots).
const ALL_FILTERS = ['glow', 'golden', 'peekabooEyes', 'tinyFace', 'gigachin', 'brainBuffering', 'crybaby', 'bigMouth', 'auraOverload', 'heartEyes', 'pixelPanic'];
const ALL_LABELS = ['Soft Glow mode', 'Golden Hour mode', 'Peekaboo Eyes mode', 'Tiny Face mode', 'Gigachin mode', 'Brain Buffering mode', 'Crybaby mode', 'Big Mouth mode', 'Aura Overload mode', 'Heart Eyes mode', 'Pixel Panic mode'];
const STRETCHY = ['tinyFace', 'gigachin', 'bigMouth', 'pixelPanic'];
const ALL_PLUS = ALL_FILTERS.filter((key) => !FREE_FILTERS.includes(key));

test('the new download: the 4 stretchy filters sit between the others, and the row has 15 spots', async () => {
  const { CAMERA_MODES, LENS_MODES } = loadDial(true, frameAccessMock(true));
  assert.deepEqual(plain(CAMERA_MODES.map((m) => m.key)), ['dare', 'guess', 'googly', ...ALL_FILTERS]);
  assert.deepEqual(plain(LENS_MODES), ['googly', ...ALL_FILTERS]);
  // All 4 are Peekaboo+; Soft Glow and Golden Hour stay free.
  assert.deepEqual(plain(CAMERA_MODES.filter((m) => m.plus).map((m) => m.key)), ALL_PLUS);
  for (const key of STRETCHY) assert.equal(CAMERA_MODES.find((m) => m.key === key).plus, true, key);

  const dial = await renderDial({ mode: 'photo' }, { '@/lib/frameAccess': frameAccessMock(true) });
  try {
    assert.deepEqual(dial.bubbles(), ['Plain camera', 'Dare mode', 'Guess Who mode', 'Googly mode', ...ALL_LABELS]);
    assert.equal(dial.bubbles().length, 15);
  } finally { await unmount(dial.tree); }
});

test('without face tracking there are no filter bubbles at all, even on a download with the camera pixels', () => {
  const { CAMERA_MODES } = loadDial(false, frameAccessMock(true));
  assert.deepEqual(plain(CAMERA_MODES.map((m) => m.key)), ['dare', 'guess', 'googly']);
});

test('the stretchy filters broke on this phone before: their bubbles are not there', async () => {
  const frames = frameAccessMock(true, { broken: true });
  const { CAMERA_MODES, LENS_MODES } = loadDial(true, frames);
  assert.deepEqual(plain(CAMERA_MODES.map((m) => m.key)), ['dare', 'guess', 'googly', ...FILTERS]);
  assert.deepEqual(plain(LENS_MODES), ['googly', ...FILTERS]);
  const dial = await renderDial({ mode: 'photo' }, { '@/lib/frameAccess': frameAccessMock(true, { broken: true }) });
  try {
    assert.deepEqual(dial.bubbles(), ['Plain camera', 'Dare mode', 'Guess Who mode', 'Googly mode', ...FILTER_LABELS]);
  } finally { await unmount(dial.tree); }
});

test('the stretchy filters break while the row is on screen: their 4 bubbles go away at once', async () => {
  const frames = frameAccessMock(true);
  const dial = await renderDial({ mode: 'photo' }, { '@/lib/frameAccess': frames });
  try {
    assert.equal(dial.bubbles().length, 15);
    await act(() => frames.markFramesBroken(new Error('no camera pictures')));
    assert.deepEqual(dial.bubbles(), ['Plain camera', 'Dare mode', 'Guess Who mode', 'Googly mode', ...FILTER_LABELS]);
  } finally { await unmount(dial.tree); }
  // The chat camera's row too.
  const chatFrames = frameAccessMock(true);
  const chat = await renderDial({ mode: 'photo', lensesOnly: true }, { '@/lib/frameAccess': chatFrames });
  try {
    assert.deepEqual(chat.bubbles(), ['Plain camera', 'Googly mode', ...ALL_LABELS]);
    await act(() => chatFrames.markFramesBroken());
    assert.deepEqual(chat.bubbles(), ['Plain camera', 'Googly mode', ...FILTER_LABELS]);
  } finally { await unmount(chat.tree); }
});

test('the new download: chat cameras get the stretchy filters too (the group one with its Guess Who bubble)', async () => {
  const chat = await renderDial({ mode: 'photo', lensesOnly: true }, { '@/lib/frameAccess': frameAccessMock(true) });
  try {
    assert.deepEqual(chat.bubbles(), ['Plain camera', 'Googly mode', ...ALL_LABELS]);
    await act(() => chat.bubble('Big Mouth mode').props.onPress());
    assert.deepEqual(chat.changes, ['bigMouth']);
  } finally { await unmount(chat.tree); }
  const group = await renderDial({ mode: 'photo', lensesOnly: true, withGuess: true }, { '@/lib/frameAccess': frameAccessMock(true) });
  try {
    assert.deepEqual(group.bubbles(), ['Plain camera', 'Guess Who mode', 'Googly mode', ...ALL_LABELS]);
  } finally { await unmount(group.tree); }
});

test('the new download without Plus: all 4 stretchy filters get the ⭐ like the other Plus filters', async () => {
  const locked = await renderDial({ mode: 'photo', locked: true }, { '@/lib/frameAccess': frameAccessMock(true) });
  try {
    const badged = locked.tree.root.findAllByType('Pressable').filter((node) => node.findAll((child) => child.props.testID === 'plus-badge' && typeof child.type === 'string').length > 0);
    assert.deepEqual(badged.map(locked.keyOf), ALL_PLUS);
    for (const label of ['Tiny Face', 'Gigachin', 'Big Mouth', 'Pixel Panic']) {
      assert.ok(locked.bubble(`${label} mode, needs Peekaboo+`), label);
    }
  } finally { await unmount(locked.tree); }
});

test('the stretchy filters have VoiceOver hints and no caption on the camera', async () => {
  const dial = await renderDial({ mode: 'photo' }, { '@/lib/frameAccess': frameAccessMock(true) });
  try {
    for (const key of STRETCHY) {
      const node = dial.tree.root.findAllByType('Pressable').find((child) => dial.keyOf(child) === key);
      assert.ok(node, key);
      assert.equal(typeof node.props.accessibilityHint, 'string', key);
      assert.ok(node.props.accessibilityHint.length > 0, key);
      let tree;
      await act(async () => { tree = renderer.create(React.createElement(dial.screen.exports.ModeCaption, { mode: key, drop: { kind: 'waiting' } })); });
      try { assert.equal(tree.toJSON(), null, key); } finally { await unmount(tree); }
    }
  } finally { await unmount(dial.tree); }
});

// ---------------------------------------------------------------------------
// 🌆 Main Character Mode on the home camera's row. It only shows where lib/mainCharacter/config.ts says this phone
// can use it: an iPhone download with face tracking, and for now only on the `testing` update channel. It sits
// right after 🤪 Googly. The row PARKS on it (the owner's rule: settling never opens a page); only a tap on the
// bubble (or its card, or the shutter – camera-main-character.test.cjs) opens the Main Character screen.
// The harness says Android and no channel, so every row above stays exactly as it was.
// ---------------------------------------------------------------------------
const { loadPure } = require('./harness.cjs');

// The real switches, or the same with some of them changed.
const mainCharacterConfig = (changes = {}) => ({ ...loadPure('src/lib/mainCharacter/config.ts'), ...changes });

// Where the dial thinks it is: `os` (Platform.OS), `channel` (the update channel), `faceMesh`, and `config`.
function placeOverrides({ os = 'ios', channel = 'testing', faceMesh = true, config, frames, reactNative = {} } = {}) {
  const base = loadScreen('src/components/home/ModeDial.tsx', {
    'expo-linear-gradient': { LinearGradient: host('LinearGradient') },
    '@/components/Bouncy': { Bouncy: host('Bouncy') },
    '@/lib/drop': { formatClock: () => '', lateLabel: () => '' },
    '@/lib/faceLens': { FACE_LENS_AVAILABLE: true },
    '@/lib/faceMesh': { FACE_MESH_AVAILABLE: true },
    'react-native-reanimated': { __esModule: true, default: { View: host('AnimatedView') }, useSharedValue: (initial) => React.useRef({ value: initial }).current, useAnimatedStyle: (callback) => callback(), withRepeat: (value) => value, withSequence: (...values) => values[0], withTiming: (value) => value },
  }).modules['react-native'];
  return {
    'react-native': { ...base, Platform: { OS: os }, ...reactNative },
    '@/lib/lensDiagnostics': { updateChannel: () => channel },
    '@/lib/faceMesh': { FACE_MESH_AVAILABLE: faceMesh },
    ...(config ? { '@/lib/mainCharacter/config': config } : {}),
    ...(frames ? { '@/lib/frameAccess': frames } : {}),
  };
}

// The ModeDial file on that phone.
function loadPlacedDial(place) {
  return loadScreen('src/components/home/ModeDial.tsx', {
    'expo-linear-gradient': { LinearGradient: host('LinearGradient') },
    '@/components/Bouncy': { Bouncy: host('Bouncy') },
    '@/lib/drop': { formatClock: () => '', lateLabel: () => '' },
    '@/lib/faceLens': { FACE_LENS_AVAILABLE: true },
    'react-native-reanimated': { __esModule: true, default: { View: host('AnimatedView') }, useSharedValue: (initial) => React.useRef({ value: initial, get() { return this.value; }, set(value) { this.value = value; } }).current, useAnimatedStyle: (callback) => callback(), withRepeat: (value) => value, withSequence: (...values) => values[0], withTiming: (value) => value },
    ...placeOverrides(place),
  });
}

// A rendered dial on that phone (like renderDial above). `keyOf` also knows the 🌆 bubble (it isn't in CAMERA_MODES).
async function renderPlacedDial(props, place = {}) {
  const screen = loadPlacedDial(place);
  const changes = [];
  let tree;
  await act(async () => {
    tree = renderer.create(React.createElement(screen.exports.ModeDial, { onChange: (mode) => { changes.push(mode); }, ...props }));
  });
  const bubbles = () => tree.root.findAllByType('Pressable').map((node) => node.props.accessibilityLabel);
  const bubble = (label) => tree.root.findAllByType('Pressable').find((node) => node.props.accessibilityLabel === label);
  const keyOf = (node) => {
    const label = node.props.accessibilityLabel;
    if (label === 'Plain camera') return 'photo';
    if (label.startsWith('Main Character mode')) return 'mainCharacter';
    if (label.startsWith('Go live mode')) return 'live';
    return screen.exports.CAMERA_MODES.find((item) => label.startsWith(`${item.label} mode`)).key;
  };
  return { screen, tree, changes, bubbles, bubble, keyOf };
}

async function settleOnKey(dial, key) {
  const slots = dial.tree.root.findAllByType('Pressable').map(dial.keyOf);
  const at = slots.indexOf(key);
  assert.ok(at > 0, `${key} is on the row`);
  await act(() => dial.tree.root.findByType('ScrollView').props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: at * 76, y: 0 } } }));
}

test('🌆 on an iPhone with face tracking on the testing channel: right after Googly, also with 🔴 on the row', async () => {
  const { exports } = loadPlacedDial();
  assert.deepEqual(plain(exports.homeModes(false).map((m) => m.key)), ['dare', 'guess', 'googly', 'mainCharacter', ...FILTERS]);
  assert.deepEqual(plain(exports.homeModes(true).map((m) => m.key)), ['dare', 'guess', 'live', 'googly', 'mainCharacter', ...FILTERS]);
  // The bubble itself: the emoji, the words VoiceOver reads, free (no ⭐ flag) while MAIN_CHARACTER_PLUS is false.
  const bubble = exports.homeModes(false).find((m) => m.key === 'mainCharacter');
  assert.deepEqual(plain(bubble), { key: 'mainCharacter', emoji: '🌆', label: 'Main Character', hint: 'Put your face in a comic poster', plus: false });
  // Never in the list made when the app starts, and never in a chat camera's lenses.
  assert.equal(exports.CAMERA_MODES.some((m) => m.key === 'mainCharacter'), false);
  assert.equal(exports.LENS_MODES.includes('mainCharacter'), false);

  const dial = await renderPlacedDial({ mode: 'photo' });
  try {
    assert.deepEqual(dial.bubbles(), ['Plain camera', 'Dare mode', 'Guess Who mode', 'Googly mode', 'Main Character mode', ...FILTER_LABELS]);
    const node = dial.bubble('Main Character mode');
    assert.equal(node.props.accessibilityHint, 'Put your face in a comic poster');
    assert.ok(node.findAllByType('Text').some((child) => child.props.children === '🌆'));
  } finally { await unmount(dial.tree); }
  const withLive = await renderPlacedDial({ mode: 'photo', live: true });
  try {
    assert.deepEqual(withLive.bubbles().slice(0, 6), ['Plain camera', 'Dare mode', 'Guess Who mode', 'Go live mode', 'Googly mode', 'Main Character mode']);
  } finally { await unmount(withLive.tree); }
  // On the newest download (the 4 stretchy filters too) it is still right after Googly.
  const newest = await renderPlacedDial({ mode: 'photo' }, { frames: frameAccessMock(true) });
  try {
    assert.deepEqual(newest.bubbles(), ['Plain camera', 'Dare mode', 'Guess Who mode', 'Googly mode', 'Main Character mode', ...ALL_LABELS]);
  } finally { await unmount(newest.tree); }
});

// The real switch as it was before 22 Nov (testing channel only), to check the dial still follows it.
const TESTING_ONLY = mainCharacterConfig({ mainCharacterHere: (os, faceMesh, channel) => faceMesh === true && os === 'ios' && channel === 'testing' });

test('🌆 is on for everyone now: an iPhone with face tracking on the App Store channel (and any channel) has it', async () => {
  for (const channel of ['production', 'testing', 'preview', null]) {
    const { exports } = loadPlacedDial({ channel });
    assert.equal(exports.homeModes(true).some((m) => m.key === 'mainCharacter'), true, `channel ${channel}`);
  }
});

test('no 🌆 on Android, without face tracking, or when switched off (or back to testing only, off the testing channel)', async () => {
  const places = [
    { os: 'android' },
    { os: 'web' },
    { faceMesh: false },
    { channel: 'production', config: TESTING_ONLY },
    { channel: 'preview', config: TESTING_ONLY },
    { channel: null, config: TESTING_ONLY },
    { config: mainCharacterConfig({ mainCharacterHere: () => false }) },
  ];
  for (const place of places) {
    const { exports } = loadPlacedDial(place);
    assert.equal(exports.homeModes(true).some((m) => m.key === 'mainCharacter'), false, JSON.stringify(place));
    const dial = await renderPlacedDial({ mode: 'photo' }, place);
    try {
      assert.equal(dial.bubbles().includes('Main Character mode'), false, JSON.stringify(place));
    } finally { await unmount(dial.tree); }
  }
  // The harness itself (Android, no channel): the row is exactly as before.
  const { CAMERA_MODES, homeModes } = loadDial(true);
  assert.equal(homeModes(false), CAMERA_MODES);
  assert.deepEqual(plain(homeModes(true).map((m) => m.key)), ['dare', 'guess', 'live', 'googly', ...FILTERS]);
});

test('the chat cameras never show 🌆, even on an iPhone on the testing channel', async () => {
  const chat = await renderPlacedDial({ mode: 'photo', lensesOnly: true });
  try {
    assert.deepEqual(chat.bubbles(), ['Plain camera', 'Googly mode', ...FILTER_LABELS]);
  } finally { await unmount(chat.tree); }
  const group = await renderPlacedDial({ mode: 'photo', lensesOnly: true, withGuess: true, live: true });
  try {
    assert.deepEqual(group.bubbles(), ['Plain camera', 'Guess Who mode', 'Googly mode', ...FILTER_LABELS]);
  } finally { await unmount(group.tree); }
});

test('settling the row on 🌆 only parks it there: onChange, never a page – also when it settles again after a page swipe', async () => {
  const dial = await renderPlacedDial({ mode: 'photo' });
  try {
    await settleOnKey(dial, 'mainCharacter');
    assert.deepEqual(dial.changes, ['mainCharacter']);
    assert.deepEqual(dial.screen.calls.routes, []);
  } finally { await unmount(dial.tree); }
  // Already parked on 🌆 (the camera passes the mode back in): swiping between the Chat / Camera / Home pages makes
  // the row settle again on the same spot. That is not a tap: nothing opens, nothing changes.
  const parked = await renderPlacedDial({ mode: 'mainCharacter' });
  try {
    await settleOnKey(parked, 'mainCharacter');
    await settleOnKey(parked, 'mainCharacter');
    assert.deepEqual(parked.changes, []);
    assert.deepEqual(parked.screen.calls.routes, []);
    // Settling on another bubble from there opens nothing either.
    await settleOnKey(parked, 'dare');
    assert.deepEqual(parked.changes, ['dare']);
    assert.deepEqual(parked.screen.calls.routes, []);
  } finally { await unmount(parked.tree); }
});

test('a tap on 🌆 picks it and opens the Main Character screen; a tap again opens it again', async () => {
  const dial = await renderPlacedDial({ mode: 'photo', onChange: (mode) => { dial.changes.push(mode); return true; } });
  try {
    await act(() => dial.bubble('Main Character mode').props.onPress());
    assert.deepEqual(dial.changes, ['mainCharacter']);
    assert.deepEqual(plain(dial.screen.calls.routes), [['push', '/main-character']]);
  } finally { await unmount(dial.tree); }
  // Tapped while already on it (like Dare and Guess Who): opens it again, no mode change.
  const parked = await renderPlacedDial({ mode: 'mainCharacter' });
  try {
    await act(() => parked.bubble('Main Character mode').props.onPress());
    await act(() => parked.bubble('Main Character mode').props.onPress());
    assert.deepEqual(parked.changes, []);
    assert.deepEqual(plain(parked.screen.calls.routes), [['push', '/main-character'], ['push', '/main-character']]);
  } finally { await unmount(parked.tree); }
});

test('a refused tap on 🌆 (the camera said no) opens nothing and glides the row back', async () => {
  const row = scrollingRow();
  const reactNative = { ScrollView: row.overrides['react-native'].ScrollView };
  const dial = await renderPlacedDial({ mode: 'photo', onChange: (mode) => { dial.changes.push(mode); return false; } }, { reactNative });
  try {
    row.scrolls.length = 0;
    await act(() => dial.bubble('Main Character mode').props.onPress());
    assert.deepEqual(dial.changes, ['mainCharacter']);
    assert.deepEqual(dial.screen.calls.routes, []);
    assert.deepEqual(plain(row.scrolls), [{ x: 0, animated: true }]);
  } finally { await unmount(dial.tree); }
});

test('⭐ on 🌆 only when MAIN_CHARACTER_PLUS is on and you surely don\'t have Plus', async () => {
  const free = await renderPlacedDial({ mode: 'photo', locked: true });
  try {
    const node = free.bubble('Main Character mode');
    assert.ok(node, 'free: no "needs Peekaboo+" in its name');
    assert.equal(node.findAll((child) => child.props.testID === 'plus-badge' && typeof child.type === 'string').length, 0);
  } finally { await unmount(free.tree); }
  const plusConfig = mainCharacterConfig({ MAIN_CHARACTER_PLUS: true });
  const locked = await renderPlacedDial({ mode: 'photo', locked: true }, { config: plusConfig });
  try {
    const node = locked.bubble('Main Character mode, needs Peekaboo+');
    assert.ok(node);
    assert.equal(node.findAll((child) => child.props.testID === 'plus-badge' && typeof child.type === 'string').length, 1);
  } finally { await unmount(locked.tree); }
  const plus = await renderPlacedDial({ mode: 'photo', locked: false }, { config: plusConfig });
  try {
    assert.ok(plus.bubble('Main Character mode'));
    assert.equal(plus.tree.root.findAll((child) => child.props.testID === 'plus-badge').length, 0);
  } finally { await unmount(plus.tree); }
});

test('the 🌆 card says what it is, and a tap on it opens the Main Character screen', async () => {
  const dial = await renderPlacedDial({ mode: 'mainCharacter' });
  try {
    for (const element of [
      React.createElement(dial.screen.exports.ModeCaption, { mode: 'mainCharacter', drop: { kind: 'waiting' } }),
      React.createElement(dial.screen.exports.MainCharacterCaption),
    ]) {
      dial.screen.calls.routes.length = 0;
      let tree;
      await act(async () => { tree = renderer.create(element); });
      try {
        const card = tree.root.findByType('Bouncy');
        assert.equal(textOf(card), '🌆 Main Character · your face in a comic poster' + 'Tap to start');
        assert.equal(card.props.accessibilityRole, 'button');
        assert.match(card.props.accessibilityLabel, /Main Character/);
        assert.deepEqual(dial.screen.calls.routes, []);
        await act(() => card.props.onPress());
        assert.deepEqual(plain(dial.screen.calls.routes), [['push', '/main-character']]);
      } finally { await unmount(tree); }
    }
  } finally { await unmount(dial.tree); }
});
