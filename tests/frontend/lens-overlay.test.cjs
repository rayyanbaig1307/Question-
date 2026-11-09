const test = require('node:test');
const assert = require('node:assert/strict');
const { React, renderer, act, loadScreen, host, unmount } = require('./harness.cjs');

// The live face filter drawn over the camera (src/components/lens/LensOverlay.tsx). If one filter's drawing
// ever fails on the phone, only THAT filter stops (instead of the whole app closing) – and switching to another
// filter must still draw it: the overlay stays the same when you switch filters, so one broken filter used to
// blank every other filter too.

function loadOverlay() {
  const painted = [];
  const screen = loadScreen('src/components/lens/LensOverlay.tsx', {
    '@shopify/react-native-skia': {
      Canvas: host('Canvas'),
      Picture: host('Picture'),
      // Draws straight away on a pretend canvas.
      createPicture: (draw) => { draw({}); return {}; },
      useClock: () => ({ value: 2500 }),
    },
    'react-native-reanimated': {
      useSharedValue: (initial) => React.useRef({ value: initial, get() { return this.value; }, set(v) { this.value = v; } }).current,
      useDerivedValue: (updater) => ({ value: updater() }),
      useAnimatedReaction: (prepare, react) => react(prepare()),
    },
    './lensPaint': {
      // Crybaby's drawing "breaks"; every other filter draws fine.
      paintLook: (canvas, look, faces, width, height, time) => {
        painted.push({ look, time });
        if (look === 'crybaby') throw new Error('broken drawing');
      },
    },
  });
  return { LensOverlay: screen.exports.LensOverlay, painted };
}

test('a filter whose drawing breaks stops on its own, and the other filters keep drawing', async () => {
  const { LensOverlay, painted } = loadOverlay();
  const faces = { value: [] };
  const originalWarn = console.warn;
  const warned = [];
  console.warn = (...args) => warned.push(args.map(String).join(' '));
  let tree;
  try {
    await act(async () => { tree = renderer.create(React.createElement(LensOverlay, { faces, look: 'crybaby' })); });
    assert.deepEqual(painted.map((p) => p.look), ['crybaby']);
    assert.equal(painted[0].time, 2.5);
    // It said which filter stopped, once.
    assert.equal(warned.length, 1);
    assert.match(warned[0], /crybaby/);

    // Switching to another filter (same overlay, not made again) still draws it.
    await act(async () => { tree.update(React.createElement(LensOverlay, { faces, look: 'heartEyes' })); });
    assert.deepEqual(painted.map((p) => p.look), ['crybaby', 'heartEyes']);

    // Back to the broken one: it stays off (no drawing, no new warning)…
    await act(async () => { tree.update(React.createElement(LensOverlay, { faces, look: 'crybaby' })); });
    assert.deepEqual(painted.map((p) => p.look), ['crybaby', 'heartEyes']);
    assert.equal(warned.length, 1);

    // …and the good ones still draw.
    await act(async () => { tree.update(React.createElement(LensOverlay, { faces, look: 'glow' })); });
    assert.deepEqual(painted.map((p) => p.look), ['crybaby', 'heartEyes', 'glow']);
  } finally {
    console.warn = originalWarn;
    if (tree) await unmount(tree);
  }
});

test('the moment on screen is passed on, so a photo taken now gets the same moment', async () => {
  const { LensOverlay } = loadOverlay();
  const shown = { value: 0, set(v) { this.value = v; } };
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(LensOverlay, { faces: { value: [] }, look: 'auraOverload', shownTime: shown })); });
  assert.equal(shown.value, 2.5);
  await unmount(tree);
});
