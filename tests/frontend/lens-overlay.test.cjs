const test = require('node:test');
const assert = require('node:assert/strict');
const { React, renderer, act, loadScreen, host, unmount } = require('./harness.cjs');

// The live face filter drawn over the camera (src/components/lens/LensOverlay.tsx). If one filter's drawing
// ever fails on the phone, only THAT filter stops (instead of the whole app closing) – and switching to another
// filter must still draw it: the overlay stays the same when you switch filters, so one broken filter used to
// blank every other filter too.

// `paint(canvas, look, faces, width, height, time, fill, src)` (optional) runs inside the pretend paintLook, like
// the real stretchy filters' drawing (it may put things on src.trash, or fail).
function loadOverlay({ effects = { balloon: {} }, paint } = {}) {
  const painted = [];
  const backdrops = [];
  // Every Skia paint the overlay makes, and the order things were let go of (dispose).
  const paints = [];
  const disposed = [];
  let made = 0;
  const screen = loadScreen('src/components/lens/LensOverlay.tsx', {
    '@shopify/react-native-skia': {
      Canvas: host('Canvas'),
      Picture: host('Picture'),
      // Draws straight away on a pretend canvas (which notes the camera picture drawn under a stretchy filter).
      createPicture: (draw) => { draw({ drawRect: (rect, paint) => backdrops.push({ rect, shader: paint.shader }) }); return {}; },
      useClock: () => ({ value: 2500 }),
      FilterMode: { Linear: 1 }, MipmapMode: { None: 0 }, TileMode: { Clamp: 0 },
      Skia: {
        Matrix: (m) => ({ matrix: m }),
        Paint: () => {
          const p = { name: `paint${paints.length + 1}`, shader: null };
          p.setShader = (s) => { p.shader = s; };
          p.dispose = () => disposed.push(p.name);
          paints.push(p);
          return p;
        },
        XYWHRect: (x, y, width, height) => ({ x, y, width, height }),
      },
    },
    'react-native-reanimated': {
      useSharedValue: (initial) => React.useRef({ value: initial, get() { return this.value; }, set(v) { this.value = v; } }).current,
      useDerivedValue: (updater) => ({ value: updater() }),
      useAnimatedReaction: (prepare, react) => react(prepare()),
    },
    './lensPaint': {
      // Crybaby's drawing "breaks"; every other filter draws fine.
      paintLook: (canvas, look, faces, width, height, time, fill, src) => {
        painted.push({ look, time, width, height, fill, src });
        if (look === 'crybaby') throw new Error('broken drawing');
        if (paint) paint(canvas, look, faces, width, height, time, fill, src);
      },
    },
    './warp/frameMatrix': {
      frameToView: (w, h, turn, mirror, vw, vh) => ['placed', w, h, turn, mirror, vw, vh],
      toMatrix9: (m) => [...m, 'm9'],
    },
    // The stretchy filters' GPU programs: made once, only when one of them is used.
    './warp/warpEffects': { warpEffects: () => { made++; return effects; } },
  });
  return { LensOverlay: screen.exports.LensOverlay, painted, backdrops, paints, disposed, made: () => made };
}

// A camera picture from FrameFeed (the stretchy filters). `mirror`: FrameFeed says the picture is drawn mirrored
// (the selfie camera's). `disposed` (optional) notes when the picture's shader is let go of.
function cameraShot({ mirror = true, disposed = [] } = {}) {
  const shaders = [];
  const image = {
    makeShaderOptions: (...args) => {
      const shader = { from: 'camera', args, name: `camera${shaders.length + 1}`, dispose: () => disposed.push(shader.name) };
      shaders.push(shader);
      return shader;
    },
  };
  return { shot: { value: { image, w: 1920, h: 1440, turn: 90, mirror }, get() { return this.value; } }, shaders };
}

// Lays the overlay out (390 × 844), as the phone does after the first frame.
async function layOut(tree, props) {
  const overlay = tree.root.findByType('Canvas');
  await act(async () => {
    overlay.props.onSize.value = { width: 390, height: 844 };
    tree.update(React.createElement(props.LensOverlay, props.props));
  });
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

test('the other filters draw exactly as before: no camera picture, no GPU programs', async () => {
  const { LensOverlay, painted, backdrops, made } = loadOverlay();
  const { shot } = cameraShot();
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(LensOverlay, { faces: { value: [] }, look: 'heartEyes', shot })); });
  assert.equal(painted.length, 1);
  assert.equal(painted[0].src, null);
  assert.equal(painted[0].fill, undefined);
  assert.deepEqual(backdrops, []);
  assert.equal(made(), 0, 'the GPU programs are only made for a stretchy filter');
  await unmount(tree);
});

test('a stretchy filter draws the camera picture over the camera view, mirrored when the picture says so, and stretches that', async () => {
  const { LensOverlay, painted, backdrops, made } = loadOverlay();
  const { shot, shaders } = cameraShot({ mirror: true });
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(LensOverlay, { faces: { value: [] }, look: 'bigMouth', shot })); });
  // The view has no size until it is laid out: nothing is drawn under the filter yet.
  assert.equal(painted.at(-1).src, null);
  // Laid out (390 × 844): the picture is placed like the camera view and drawn over all of it.
  await layOut(tree, { LensOverlay, props: { faces: { value: [] }, look: 'bigMouth', shot } });
  const last = painted.at(-1);
  assert.equal(last.look, 'bigMouth');
  assert.ok(last.src, 'the filter gets the camera picture');
  assert.equal(last.src.image, shaders.at(-1));
  assert.deepEqual(shaders.at(-1).args.slice(0, 4), [0, 0, 1, 0]);
  assert.deepEqual(shaders.at(-1).args[4].matrix, ['placed', 1920, 1440, 90, true, 390, 844, 'm9']);
  assert.deepEqual(backdrops.at(-1).rect, { x: 0, y: 0, width: 390, height: 844 });
  assert.equal(backdrops.at(-1).shader, shaders.at(-1));
  assert.equal(made(), 1);

  // A picture from the back camera is not mirrored (each picture says so itself, so a picture from before you
  // flipped the camera is still drawn the right way round).
  shot.value = { ...shot.value, mirror: false };
  await act(async () => { tree.update(React.createElement(LensOverlay, { faces: { value: [] }, look: 'bigMouth', shot })); });
  assert.equal(shaders.at(-1).args[4].matrix[4], false);

  // No fresh camera picture: no picture under it, and the filter is told so (it then draws nothing).
  shot.value = null;
  const before = backdrops.length;
  await act(async () => { tree.update(React.createElement(LensOverlay, { faces: { value: [] }, look: 'gigachin', shot })); });
  assert.equal(painted.at(-1).src, null);
  assert.equal(backdrops.length, before);
  await unmount(tree);
});

test('if the GPU programs could not be made, a stretchy filter draws nothing over the camera', async () => {
  const { LensOverlay, painted, backdrops } = loadOverlay({ effects: null });
  const { shot } = cameraShot();
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(LensOverlay, { faces: { value: [] }, look: 'pixelPanic', shot })); });
  await layOut(tree, { LensOverlay, props: { faces: { value: [] }, look: 'pixelPanic', shot } });
  assert.equal(painted.at(-1).src, null);
  assert.deepEqual(backdrops, []);
  await unmount(tree);
});

// The camera picture lives on the graphics chip and belongs to the drawing thread. Everything made from it for one
// frame (the picture's shader, the paint under the filter, and whatever the filter put on src.trash) must be let go
// of right after that frame, there – newest first, the picture's shader last – and not left for the garbage
// collector (too late for the camera, and maybe on another thread, which can crash the app).
test('a stretchy filter lets go of everything it made from the camera picture right after each frame', async () => {
  const fromFilter = [];
  const { LensOverlay, paints, disposed } = loadOverlay({
    paint: (canvas, look, faces, width, height, time, fill, src) => {
      if (!src) return;
      for (const name of ['warpShader', 'warpPaint']) {
        const thing = { name, dispose: () => disposed.push(name) };
        fromFilter.push(thing);
        src.trash.push(thing);
      }
    },
  });
  const { shot } = cameraShot({ disposed });
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(LensOverlay, { faces: { value: [] }, look: 'bigMouth', shot })); });
  assert.deepEqual(disposed, [], 'nothing made before the view has a size');
  await layOut(tree, { LensOverlay, props: { faces: { value: [] }, look: 'bigMouth', shot } });
  const backdrop = paints.at(-1).name;
  assert.deepEqual(disposed, ['warpPaint', 'warpShader', backdrop, 'camera1']);
  await unmount(tree);
});

test('…also when the filter fails halfway, and one thing that can\'t be let go of doesn\'t stop the rest', async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const { LensOverlay, paints, disposed, painted } = loadOverlay({
      paint: (canvas, look, faces, width, height, time, fill, src) => {
        if (!src) return;
        src.trash.push({ name: 'warpShader', dispose: () => disposed.push('warpShader') });
        src.trash.push({ name: 'stubborn', dispose: () => { throw new Error('already gone'); } });
        src.trash.push({ name: 'warpPaint', dispose: () => disposed.push('warpPaint') });
        throw new Error('broken frame');
      },
    });
    const { shot } = cameraShot({ disposed });
    let tree;
    await act(async () => { tree = renderer.create(React.createElement(LensOverlay, { faces: { value: [] }, look: 'gigachin', shot })); });
    await layOut(tree, { LensOverlay, props: { faces: { value: [] }, look: 'gigachin', shot } });
    assert.equal(painted.at(-1).look, 'gigachin');
    assert.deepEqual(disposed, ['warpPaint', 'warpShader', paints.at(-1).name, 'camera1']);
    await unmount(tree);
  } finally {
    console.warn = originalWarn;
  }
});
