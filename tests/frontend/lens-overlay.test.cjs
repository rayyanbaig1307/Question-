const test = require('node:test');
const assert = require('node:assert/strict');
const { React, renderer, act, loadScreen, host, unmount } = require('./harness.cjs');

// The live face filter drawn over the camera (src/components/lens/LensOverlay.tsx). If one filter's drawing
// ever fails on the phone, only THAT filter pauses for a moment (instead of the whole app closing) – and switching
// to another filter must still draw it: the overlay stays the same when you switch filters, so one broken filter
// used to blank every other filter too.
// Also (12 Nov, the owner's screenshots): the camera picture under a stretchy filter fills the whole view, sized
// from SoftGlowCamera's onLayout (`viewSize`), never the Canvas's own size (it included the pager's 0.92 shrink);
// each finished drawing is let go of two drawings later, and the last two when the overlay closes (the garbage
// collector was too slow: the camera ran out of pictures and the picture froze and snapped back); and the very
// first drawing (on the JS thread) never uses the camera picture.

// `paint(canvas, look, faces, width, height, time, fill, src)` (optional) runs inside the pretend paintLook, like
// the real stretchy filters' drawing (it may put things on src.trash, or fail).
// `samePicture`: every drawing gives back the very same picture object. `worklet`: the drawing runs on the drawing
// thread (globalThis._WORKLET true, as on the phone after the first drawing) – false: the JS thread's first one.
function loadOverlay({ effects = { balloon: {} }, paint, samePicture = false, worklet = true } = {}) {
  const painted = [];
  const backdrops = [];
  // Every Skia paint the overlay makes, and the order things were let go of (dispose).
  const paints = [];
  const disposed = [];
  // Every finished drawing (picture), and which were let go of.
  const pictures = [];
  // Where each camera picture was placed: the arguments placeShot got.
  const placed = [];
  const clock = { value: 2500 };
  let made = 0;
  const screen = loadScreen('src/components/lens/LensOverlay.tsx', {
    '@shopify/react-native-skia': {
      Canvas: host('Canvas'),
      Picture: host('Picture'),
      // Draws straight away on a pretend canvas (which notes the camera picture drawn under a stretchy filter).
      createPicture: (draw) => {
        draw({ drawRect: (rect, paint) => backdrops.push({ rect, shader: paint.shader }) });
        if (samePicture && pictures.length > 0) return pictures[0];
        const picture = { name: `picture${pictures.length + 1}`, disposed: false, frees: 0, dispose() { this.disposed = true; this.frees += 1; } };
        pictures.push(picture);
        return picture;
      },
      useClock: () => clock,
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
    // Every render stands for one drawing-thread frame: the drawing is made again, and the reactions see it.
    'react-native-reanimated': {
      useSharedValue: (initial) => React.useRef({ value: initial, get() { return this.value; }, set(v) { this.value = v; } }).current,
      useDerivedValue: (updater) => { const ref = React.useRef({ value: null }); ref.current.value = updater(); return ref.current; },
      useAnimatedReaction: (prepare, react) => { const last = React.useRef(null); const value = prepare(); react(value, last.current); last.current = value; },
    },
    'react-native-worklets': { scheduleOnUI: (work) => work() },
    './lensPaint': {
      // Crybaby's drawing "breaks"; every other filter draws fine.
      paintLook: (canvas, look, faces, width, height, time, fill, src) => {
        painted.push({ look, time, width, height, fill, src });
        if (look === 'crybaby') throw new Error('broken drawing');
        if (paint) paint(canvas, look, faces, width, height, time, fill, src);
      },
    },
    './warp/frameMatrix': {
      placeShot: (frame, vw, vh, axes, placement) => {
        placed.push({ axes, placement });
        return { m: ['placed', frame.w, frame.h, frame.turn, frame.mirror, vw, vh], how: 0, turn: frame.turn, mirror: frame.mirror };
      },
      toMatrix9: (m) => [...m, 'm9'],
    },
    // The stretchy filters' GPU programs: made once, only when one of them is used.
    './warp/warpEffects': { warpEffects: () => { made++; return effects; } },
  });
  // On the phone this is true on the drawing thread (react-native-worklets sets it there).
  if (worklet) screen.getBinding('globalThis')._WORKLET = true;
  return { LensOverlay: screen.exports.LensOverlay, painted, backdrops, paints, disposed, pictures, placed, clock, made: () => made };
}

// The camera view's size from SoftGlowCamera's onLayout (0 × 0 until it is laid out).
const newViewSize = () => ({ value: { width: 0, height: 0 }, get() { return this.value; } });

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
  return { shot: { value: { image, w: 1920, h: 1440, turn: 270, mirror, label: 90, front: mirror }, get() { return this.value; } }, shaders };
}

// Lays the camera view out (390 × 844, SoftGlowCamera's onLayout), as the phone does after the first frame.
async function layOut(tree, props) {
  await act(async () => {
    props.props.viewSize.value = { width: 390, height: 844 };
    tree.update(React.createElement(props.LensOverlay, props.props));
  });
}

test('a filter whose drawing breaks stops on its own, and the other filters keep drawing', async () => {
  const { LensOverlay, painted } = loadOverlay();
  const faces = { value: [] };
  const viewSize = newViewSize();
  const originalWarn = console.warn;
  const warned = [];
  console.warn = (...args) => warned.push(args.map(String).join(' '));
  let tree;
  try {
    await act(async () => { tree = renderer.create(React.createElement(LensOverlay, { faces, look: 'crybaby', viewSize })); });
    assert.deepEqual(painted.map((p) => p.look), ['crybaby']);
    assert.equal(painted[0].time, 2.5);
    // It said which filter stopped, once.
    assert.equal(warned.length, 1);
    assert.match(warned[0], /crybaby/);

    // Switching to another filter (same overlay, not made again) still draws it.
    await act(async () => { tree.update(React.createElement(LensOverlay, { faces, look: 'heartEyes', viewSize })); });
    assert.deepEqual(painted.map((p) => p.look), ['crybaby', 'heartEyes']);

    // Back to the broken one: it pauses for a moment (no drawing, no new warning)…
    await act(async () => { tree.update(React.createElement(LensOverlay, { faces, look: 'crybaby', viewSize })); });
    assert.deepEqual(painted.map((p) => p.look), ['crybaby', 'heartEyes']);
    assert.equal(warned.length, 1);

    // …and the good ones still draw.
    await act(async () => { tree.update(React.createElement(LensOverlay, { faces, look: 'glow', viewSize })); });
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
  await act(async () => { tree = renderer.create(React.createElement(LensOverlay, { faces: { value: [] }, look: 'auraOverload', shownTime: shown, viewSize: newViewSize() })); });
  assert.equal(shown.value, 2.5);
  await unmount(tree);
});

test('the other filters draw exactly as before: no camera picture, no GPU programs', async () => {
  const { LensOverlay, painted, backdrops, made } = loadOverlay();
  const { shot } = cameraShot();
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(LensOverlay, { faces: { value: [] }, look: 'heartEyes', shot, viewSize: newViewSize() })); });
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
  const viewSize = newViewSize();
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(LensOverlay, { faces: { value: [] }, look: 'bigMouth', shot, viewSize })); });
  // The view has no size until it is laid out: nothing is drawn under the filter yet.
  assert.equal(painted.at(-1).src, null);
  // Laid out (390 × 844): the picture is placed like the camera view and drawn over all of it.
  await layOut(tree, { LensOverlay, props: { faces: { value: [] }, look: 'bigMouth', shot, viewSize } });
  const last = painted.at(-1);
  assert.equal(last.look, 'bigMouth');
  assert.ok(last.src, 'the filter gets the camera picture');
  assert.equal(last.src.image, shaders.at(-1));
  assert.deepEqual(shaders.at(-1).args.slice(0, 4), [0, 0, 1, 0]);
  assert.deepEqual(shaders.at(-1).args[4].matrix, ['placed', 1920, 1440, 270, true, 390, 844, 'm9']);
  assert.deepEqual(backdrops.at(-1).rect, { x: 0, y: 0, width: 390, height: 844 });
  assert.equal(backdrops.at(-1).shader, shaders.at(-1));
  assert.equal(made(), 1);

  // A picture from the back camera is not mirrored (each picture says so itself, so a picture from before you
  // flipped the camera is still drawn the right way round).
  shot.value = { ...shot.value, mirror: false };
  await act(async () => { tree.update(React.createElement(LensOverlay, { faces: { value: [] }, look: 'bigMouth', shot, viewSize })); });
  assert.equal(shaders.at(-1).args[4].matrix[4], false);

  // No fresh camera picture: no picture under it, and the filter is told so (it then draws nothing).
  shot.value = null;
  const before = backdrops.length;
  await act(async () => { tree.update(React.createElement(LensOverlay, { faces: { value: [] }, look: 'gigachin', shot, viewSize })); });
  assert.equal(painted.at(-1).src, null);
  assert.equal(backdrops.length, before);
  await unmount(tree);
});

test('if the GPU programs could not be made, a stretchy filter draws nothing over the camera', async () => {
  const { LensOverlay, painted, backdrops } = loadOverlay({ effects: null });
  const { shot } = cameraShot();
  const viewSize = newViewSize();
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(LensOverlay, { faces: { value: [] }, look: 'pixelPanic', shot, viewSize })); });
  await layOut(tree, { LensOverlay, props: { faces: { value: [] }, look: 'pixelPanic', shot, viewSize } });
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
  const viewSize = newViewSize();
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(LensOverlay, { faces: { value: [] }, look: 'bigMouth', shot, viewSize })); });
  assert.deepEqual(disposed, [], 'nothing made before the view has a size');
  await layOut(tree, { LensOverlay, props: { faces: { value: [] }, look: 'bigMouth', shot, viewSize } });
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
    const viewSize = newViewSize();
    let tree;
    await act(async () => { tree = renderer.create(React.createElement(LensOverlay, { faces: { value: [] }, look: 'gigachin', shot, viewSize })); });
    await layOut(tree, { LensOverlay, props: { faces: { value: [] }, look: 'gigachin', shot, viewSize } });
    assert.equal(painted.at(-1).look, 'gigachin');
    assert.deepEqual(disposed, ['warpPaint', 'warpShader', paints.at(-1).name, 'camera1']);
    await unmount(tree);
  } finally {
    console.warn = originalWarn;
  }
});

test('the camera picture fills the whole camera view, sized from onLayout; the Canvas has no size of its own', async () => {
  const { LensOverlay, backdrops, placed } = loadOverlay();
  const { shot } = cameraShot();
  const viewSize = newViewSize();
  const axes = { value: { ox: -121.5, oy: 0, ax: 0, ay: 844, bx: 633, by: 0, front: true } };
  const props = { faces: { value: [] }, look: 'pixelPanic', shot, viewSize, axes };
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(LensOverlay, props)); });
  assert.equal(tree.root.findByType('Canvas').props.onSize, undefined);
  assert.deepEqual(backdrops, [], 'nothing before the view has a size');
  await layOut(tree, { LensOverlay, props });
  assert.deepEqual(backdrops.at(-1).rect, { x: 0, y: 0, width: 390, height: 844 });
  // Placed by the rule (lib/frameAccess.ts FRAME_PLACEMENT), with the converter as a second opinion.
  assert.equal(placed.at(-1).placement, 'rule');
  assert.equal(placed.at(-1).axes, axes.value);
  await unmount(tree);
});

test('each finished drawing is let go of two drawings later, never the newest or the one before', async () => {
  const { LensOverlay, pictures } = loadOverlay();
  const { shot } = cameraShot();
  const viewSize = newViewSize();
  viewSize.value = { width: 390, height: 844 };
  const props = { faces: { value: [] }, look: 'gigachin', shot, viewSize };
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(LensOverlay, props)); });
  const draw = () => act(async () => { tree.update(React.createElement(LensOverlay, { ...props })); });
  await draw();
  assert.deepEqual(pictures.map((p) => p.disposed), [false, false]);
  await draw();
  // Drawings N, N+1, N+2: N is let go of; N+1 and N+2 are kept.
  assert.deepEqual(pictures.map((p) => p.disposed), [true, false, false]);
  await draw();
  await draw();
  assert.deepEqual(pictures.map((p) => p.disposed), [true, true, true, false, false]);
  await unmount(tree);
  // Closing (e.g. swiping to Chat) lets go of the last two as well – the newest too, so its camera picture goes back
  // to the camera now, not whenever the garbage collector gets to it (the screen keeps its own copy until it is
  // torn down). Each one exactly once.
  assert.deepEqual(pictures.map((p) => p.frees), [1, 1, 1, 1, 1]);
});

test('the same drawing seen twice is never let go of while it is shown, and only once when closing', async () => {
  const { LensOverlay, pictures } = loadOverlay({ samePicture: true });
  const props = { faces: { value: [] }, look: 'glow', viewSize: newViewSize() };
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(LensOverlay, props)); });
  for (let i = 0; i < 4; i++) await act(async () => { tree.update(React.createElement(LensOverlay, { ...props })); });
  assert.equal(pictures.length, 1);
  assert.equal(pictures[0].disposed, false);
  await unmount(tree);
  assert.equal(pictures[0].frees, 1);
});

test('closing right after the first drawing lets go of it (nothing is left for the garbage collector)', async () => {
  const { LensOverlay, pictures } = loadOverlay();
  const { shot } = cameraShot();
  const viewSize = newViewSize();
  viewSize.value = { width: 390, height: 844 };
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(LensOverlay, { faces: { value: [] }, look: 'bigMouth', shot, viewSize })); });
  assert.deepEqual(pictures.map((p) => p.frees), [0]);
  await unmount(tree);
  assert.deepEqual(pictures.map((p) => p.frees), [1]);
});

test('the very first drawing (on the JS thread) never uses the camera picture', async () => {
  const { LensOverlay, backdrops, painted } = loadOverlay({ worklet: false });
  const { shot, shaders } = cameraShot();
  const viewSize = newViewSize();
  viewSize.value = { width: 390, height: 844 };
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(LensOverlay, { faces: { value: [] }, look: 'bigMouth', shot, viewSize })); });
  assert.deepEqual(backdrops, []);
  assert.equal(shaders.length, 0, 'no shader made from the camera picture');
  assert.equal(painted.at(-1).src, null);
  await unmount(tree);
});

test('switching looks never re-builds the canvas (no re-drawing on the JS thread)', async () => {
  const { LensOverlay } = loadOverlay();
  const viewSize = newViewSize();
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(LensOverlay, { faces: { value: [] }, look: 'bigMouth', viewSize })); });
  const before = tree.root.findByType('Canvas').props.children;
  await act(async () => { tree.update(React.createElement(LensOverlay, { faces: { value: [] }, look: 'heartEyes', viewSize })); });
  assert.equal(tree.root.findByType('Canvas').props.children, before);
  await unmount(tree);
});

test('a stretchy filter that fails pauses for 1.5 s with the camera picture still shown, then tries again; after 5 failures it stays off', async () => {
  const originalWarn = console.warn;
  const warned = [];
  console.warn = (...args) => warned.push(args.map(String).join(' '));
  try {
    const { LensOverlay, painted, backdrops, clock } = loadOverlay({
      paint: (canvas, look) => { if (look === 'bigMouth') throw new Error('broken frame'); },
    });
    const { shot } = cameraShot();
    const viewSize = newViewSize();
    viewSize.value = { width: 390, height: 844 };
    const props = { faces: { value: [] }, look: 'bigMouth', shot, viewSize };
    let tree;
    await act(async () => { tree = renderer.create(React.createElement(LensOverlay, props)); });
    const frameAt = (ms) => { clock.value = ms; return act(async () => { tree.update(React.createElement(LensOverlay, { ...props })); }); };
    assert.equal(painted.length, 1);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /bigMouth/);
    // Pausing: the filter isn't drawn, but the camera picture under it still is (no jump to the plain camera).
    const shownBefore = backdrops.length;
    await frameAt(2500 + 1000);
    assert.equal(painted.length, 1);
    assert.equal(backdrops.length, shownBefore + 1);
    // After the pause it tries again.
    await frameAt(2500 + 1501);
    assert.equal(painted.length, 2);
    // Failures 3, 4 and 5 (each after a pause): then it stays off, even after the pause.
    let t = 2500 + 1501;
    for (let i = 0; i < 3; i++) await frameAt((t += 1501));
    assert.equal(painted.length, 5);
    await frameAt((t += 5000));
    await frameAt((t += 5000));
    assert.equal(painted.length, 5);
    // Said twice: when it first paused and when it gave up.
    assert.equal(warned.length, 2);
    assert.match(warned[1], /stopped drawing/);
    // Other filters still draw.
    await act(async () => { tree.update(React.createElement(LensOverlay, { ...props, look: 'heartEyes' })); });
    assert.equal(painted.at(-1).look, 'heartEyes');
    await unmount(tree);
  } finally {
    console.warn = originalWarn;
  }
});
