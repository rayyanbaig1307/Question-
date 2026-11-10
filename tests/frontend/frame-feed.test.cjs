const test = require('node:test');
const assert = require('node:assert/strict');
const { React, renderer, act, loadScreen, loadPure, host, unmount } = require('./harness.cjs');

// The 4 stretchy face filters (🫥 🗿 😃 👾) on the new download: the camera's own pictures come from
// src/components/lens/warp/FrameFeed.tsx, which src/components/lens/SoftGlowCamera.tsx shows only while one of them
// is on. Checked here:
// - a camera error while they are on switches them off at once, but the phone only remembers that when it came
//   just after their pictures were switched on (a "strike", lib/frameAccess.ts); any later camera error (a zoom
//   the camera can't do, the phone's media system restarting) only counts until the app is closed;
// - flipping the camera throws the old FrameFeed away (with the pictures it kept) and starts a new one for the
//   other camera, and every picture says itself whether it is drawn mirrored, so a picture from before the flip is
//   never drawn the wrong way round.

// A stand-in for lib/frameAccess.ts on the new download that notes how each switch-off was asked for.
function framesStandIn() {
  let broken = false;
  const listeners = new Set();
  const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
  const marks = [];
  return {
    marks,
    module: {
      FRAME_ACCESS_AVAILABLE: true, FRAME_SETUP_MS: 4000, FRAME_PATH: 'share', FRAME_DELAY: 1, STALE_MS: 300,
      framesBroken: () => broken,
      subscribeFramesBroken: subscribe,
      markFramesBroken(why, how = 'remember') {
        marks.push({ why: why instanceof Error ? why.message : String(why), how });
        if (broken) return;
        broken = true;
        listeners.forEach((listener) => listener());
      },
      useWarpLooksOn() { return !React.useSyncExternalStore(subscribe, () => broken, () => broken); },
    },
  };
}

function loadSoftGlow() {
  const frames = framesStandIn();
  // Every FrameFeed shown: which camera it was for, and whether it is still there.
  const feeds = [];
  function FrameFeed({ onOutput, facing }) {
    // One record per FrameFeed made (not per drawing), with every camera it was ever told about.
    const ref = React.useRef(null);
    if (!ref.current) {
      ref.current = { facing, facings: [], mounted: false, output: { name: `frames-${facing}-${feeds.length + 1}` } };
      feeds.push(ref.current);
    }
    const feed = ref.current;
    if (!feed.facings.includes(facing)) feed.facings.push(facing);
    React.useEffect(() => {
      feed.mounted = true;
      onOutput(feed.output);
      return () => { feed.mounted = false; onOutput(null); };
    }, [feed, onOutput]);
    return null;
  }
  const screen = loadScreen('src/components/lens/SoftGlowCamera.tsx', {
    'expo-image-manipulator': { FlipType: {}, ImageManipulator: {}, SaveFormat: {} },
    'react-native-reanimated': { useSharedValue: (initial) => React.useRef({ value: initial, get() { return this.value; }, set(v) { this.value = v; } }).current },
    'react-native-vision-camera': { Camera: host('Camera'), usePhotoOutput: () => React.useRef({ name: 'photo' }).current },
    '@/lib/faceMesh': { toScreenPoints: () => [], useFaceMeshOutput: () => null },
    '@/lib/frameAccess': frames.module,
    './bakeLook': { bakeLook: async () => 'file:///baked.jpg' },
    './faceTrack': { newTrackMemory: () => ({}), trackFaces: () => [] },
    './LensOverlay': { LensOverlay: host('LensOverlay') },
    './lensPaint': { MAX_LENS_FACES: 2 },
    './warp/FrameFeed': { FrameFeed },
  });
  // The camera's clock (Date.now inside SoftGlowCamera).
  const clock = { now: 1_000_000 };
  screen.getBinding('Date').now = () => clock.now;
  return { SoftGlowCamera: screen.exports.SoftGlowCamera, frames, feeds, clock };
}

async function renderSoftGlow(SoftGlowCamera, props) {
  let tree;
  const element = (more) => React.createElement(SoftGlowCamera, { ref: React.createRef(), active: true, facing: 'front', flash: 'off', ...props, ...more });
  await act(async () => { tree = renderer.create(element()); });
  return { tree, update: (more) => act(async () => { tree.update(element(more)); }) };
}

const camera = (tree) => tree.root.findByType('Camera');
// (Copied into a plain array: the screen's own arrays come from its separate sandbox.)
const outputNames = (tree) => Array.from(camera(tree).props.outputs, (output) => output.name);

test('a camera error long after the stretchy pictures switched on: off until the app closes, nothing remembered', async () => {
  const { SoftGlowCamera, frames, feeds, clock } = loadSoftGlow();
  const originalWarn = console.warn;
  console.warn = () => {};
  const { tree } = await renderSoftGlow(SoftGlowCamera, { look: 'bigMouth' });
  try {
    assert.deepEqual(outputNames(tree), ['photo', 'frames-front-1']);
    clock.now += 60_000;
    await act(async () => { camera(tree).props.onError(new Error('zoom out of range')); });
    assert.deepEqual(frames.marks, [{ why: 'zoom out of range', how: 'thisRun' }]);
    // Switched off at once: the camera is back to how every other download has it.
    assert.equal(feeds[0].mounted, false);
    assert.deepEqual(outputNames(tree), ['photo']);
  } finally {
    console.warn = originalWarn;
    await unmount(tree);
  }
});

test('a camera error just after the stretchy pictures switched on is a strike (it looks like they broke the camera)', async () => {
  const { SoftGlowCamera, frames, clock } = loadSoftGlow();
  const originalWarn = console.warn;
  console.warn = () => {};
  const { tree } = await renderSoftGlow(SoftGlowCamera, { look: 'gigachin' });
  try {
    clock.now += 1_500;
    await act(async () => { camera(tree).props.onError(new Error('could not add the output')); });
    assert.deepEqual(frames.marks, [{ why: 'could not add the output', how: 'strike' }]);
  } finally {
    console.warn = originalWarn;
    await unmount(tree);
  }
});

test('a camera error with any other filter on never touches the stretchy filters', async () => {
  const { SoftGlowCamera, frames, feeds } = loadSoftGlow();
  const originalWarn = console.warn;
  console.warn = () => {};
  const { tree } = await renderSoftGlow(SoftGlowCamera, { look: 'heartEyes' });
  try {
    assert.equal(feeds.length, 0, 'no camera pictures for the other filters');
    assert.deepEqual(outputNames(tree), ['photo']);
    await act(async () => { camera(tree).props.onError(new Error('media services were reset')); });
    assert.deepEqual(frames.marks, []);
  } finally {
    console.warn = originalWarn;
    await unmount(tree);
  }
});

test('flipping the camera starts a new FrameFeed for the other camera, and only its pictures reach the camera', async () => {
  const { SoftGlowCamera, feeds, clock } = loadSoftGlow();
  const { tree, update } = await renderSoftGlow(SoftGlowCamera, { look: 'pixelPanic', facing: 'front' });
  try {
    assert.deepEqual(feeds.map((f) => [f.facing, f.mounted]), [['front', true]]);
    clock.now += 30_000;
    await update({ facing: 'back' });
    // The selfie camera's FrameFeed (and every picture it kept) is gone; a new one is there for the back camera.
    assert.deepEqual(feeds.map((f) => [f.facing, f.mounted]), [['front', false], ['back', true]]);
    // A FrameFeed is only ever for one camera (so the mirror it puts on its pictures is always right).
    assert.deepEqual(feeds.map((f) => f.facings), [['front'], ['back']]);
    assert.equal(camera(tree).props.device, 'back');
    assert.deepEqual(outputNames(tree), ['photo', 'frames-back-2']);
    // The overlay is not told which camera it is: each picture says itself whether it is mirrored.
    assert.equal(tree.root.findByType('LensOverlay').props.facing, undefined);
  } finally {
    await unmount(tree);
  }
});

// ---------------------------------------------------------------------------
// FrameFeed itself, with a pretend camera thread and drawing thread.
// ---------------------------------------------------------------------------

function loadFrameFeed() {
  const state = { released: [], images: [], frameCallback: null, options: null };
  const screen = loadScreen('src/components/lens/warp/FrameFeed.tsx', {
    '@shopify/react-native-skia': {
      Skia: {
        Image: { MakeImageFromNativeBuffer: (ptr) => { const image = { ptr, disposed: false, dispose() { this.disposed = true; } }; state.images.push(image); return image; } },
        NativeBuffer: { Release: (ptr) => state.released.push(ptr) },
      },
    },
    'react-native': { Platform: { OS: 'ios' } },
    'react-native-reanimated': {
      useFrameCallback: (callback) => { state.frameCallback = callback; },
      useSharedValue: (initial) => React.useRef({ value: initial, get() { return this.value; }, set(v) { this.value = v; } }).current,
    },
    'react-native-vision-camera': {
      CommonResolutions: { HD_4_3: 'hd' },
      useFrameOutput: (options) => { state.options = options; return React.useRef({ name: 'frames', outputOrientation: 'up' }).current; },
    },
    'react-native-worklets': {
      createSynchronizable: (value) => ({ value, getDirty() { return this.value; }, setDirty(v) { this.value = v; }, getBlocking() { return this.value; }, setBlocking(v) { this.value = v; }, lock() {}, unlock() {} }),
      scheduleOnUI: (work) => work(),
    },
    '@/lib/frameAccess': framesStandIn().module,
    './frameMatrix': loadPure('src/components/lens/warp/frameMatrix.ts'),
    './warpEffects': { warpEffects: () => ({}) },
  });
  return { FrameFeed: screen.exports.FrameFeed, state };
}

// One camera picture, as the camera thread gets it.
function cameraFrame(pointer) {
  return { width: 1920, height: 1440, orientation: 'right', taken: false, disposed: false, getNativeBuffer() { this.taken = true; return { pointer, release() {} }; }, dispose() { this.disposed = true; } };
}

for (const [facing, mirrored] of [['front', true], ['back', false]]) {
  test(`every picture from the ${facing} camera says it is ${mirrored ? '' : 'not '}drawn mirrored`, async () => {
    const { FrameFeed, state } = loadFrameFeed();
    const shot = { value: null, get() { return this.value; }, set(v) { this.value = v; } };
    const outputs = [];
    let tree;
    await act(async () => { tree = renderer.create(React.createElement(FrameFeed, { shot, facing, onOutput: (output) => outputs.push(output) })); });
    try {
      // Two pictures come in (one is held back, so the picture matches the face points).
      state.options.onFrame(cameraFrame(11n));
      state.frameCallback({ timestamp: 1000 });
      state.options.onFrame(cameraFrame(12n));
      state.frameCallback({ timestamp: 1033 });
      assert.equal(shot.value.image.ptr, 11n);
      assert.equal(shot.value.mirror, mirrored);
      assert.equal(shot.value.turn, 90);
      // The camera's buffers went straight back (the Skia images keep what they need).
      assert.deepEqual(state.released, [11n, 12n]);
    } finally {
      await unmount(tree);
    }
    // Gone: the pictures it kept are let go of, nothing is shown, and the camera output is handed back.
    assert.equal(shot.value, null);
    assert.ok(state.images.every((image) => image.disposed));
    assert.equal(outputs.at(-1), null);
  });
}

test('a picture still waiting when FrameFeed goes away (the camera was flipped) is let go of, never shown', async () => {
  const { FrameFeed, state } = loadFrameFeed();
  const shot = { value: null, get() { return this.value; }, set(v) { this.value = v; } };
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(FrameFeed, { shot, facing: 'front', onOutput: () => {} })); });
  state.options.onFrame(cameraFrame(21n));
  const onFrame = state.options.onFrame;
  await unmount(tree);
  assert.deepEqual(state.released, [21n]);
  assert.equal(shot.value, null);
  // A picture the old camera still sends afterwards goes straight back to the camera (its buffer is never taken).
  const late = cameraFrame(22n);
  onFrame(late);
  assert.equal(late.taken, false);
  assert.equal(late.disposed, true);
  assert.equal(shot.value, null);
});
