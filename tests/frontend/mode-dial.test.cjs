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
