const test = require('node:test');
const assert = require('node:assert/strict');
const { React, renderer, act, loadScreen, loadPure, host, unmount } = require('./harness.cjs');

// The 4 stretchy face filters (🫥 🗿 😃 👾) on the new download: the camera's own pictures come from
// src/components/lens/warp/FrameFeed.tsx, which src/components/lens/SoftGlowCamera.tsx shows only while one of them
// is on. Checked here:
// - a camera error while they are on switches them off at once, but the phone only remembers that when it came
//   just after their pictures were switched on (a "strike", lib/frameAccess.ts); any later camera error (a zoom
//   the camera can't do, the phone's media system restarting) only counts until the app is closed;
// - flipping the camera with a stretchy filter on throws the old FrameFeed away (with the pictures it kept) and
//   starts a new one for the other camera, and every picture says itself whether it is drawn mirrored, so a picture
//   from before the flip is never drawn the wrong way round; flipping with another filter on keeps the same
//   FrameFeed and camera output (one camera set-up), and it changes camera only when a stretchy filter is picked;
// - once a stretchy filter was picked, FrameFeed stays until the camera closes (switching to another filter must
//   not change the camera's outputs: that restarts the camera's set-up, a black flash) and is only told whether its
//   pictures are wanted (`inUse`);
// - the live overlay and the photo get the same view size, from onLayout (12 Nov: the overlay's own Canvas size
//   included the pager's shrink animation, so the picture covered only 92 % of the screen);
// - FrameFeed stands the picture up with the iPhone rule (the selfie picture was upside down), keeps the last good
//   picture for up to 1 s, skips failed pictures, counts what went wrong, and only switches the filters off when
//   most pictures fail for a while;
// - while its pictures aren't wanted, FrameFeed's every-screen-frame check is paused and everything is let go of at
//   once; the testing readout's black-picture check runs only now and then, never in a frame that makes a picture.

// A stand-in for lib/frameAccess.ts on the new download that notes how each switch-off was asked for.
function framesStandIn() {
  let broken = false;
  const listeners = new Set();
  const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
  const marks = [];
  return {
    marks,
    module: {
      FRAME_ACCESS_AVAILABLE: true, FRAME_SETUP_MS: 4000, FRAME_PATH: 'share', FRAME_DELAY: 1, STALE_MS: 1000,
      FRAME_PIXEL_FORMAT: 'yuv', FRAME_PLACEMENT: 'rule', FRAME_ERROR_WINDOW_MS: 2000, FRAME_ERROR_MIN: 10, FRAME_ERROR_RATE: 0.5,
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

// `channel`: the update channel the download listens on (the readout is only on 'testing').
function loadSoftGlow({ channel = null } = {}) {
  const frames = framesStandIn();
  // Every FrameFeed shown: which camera it was for, whether it is still there, and its newest props.
  const feeds = [];
  // What the photo was made with (the stand-in for bakeLook).
  const baked = [];
  function FrameFeed(props) {
    const { onOutput, facing } = props;
    // One record per FrameFeed made (not per drawing), with every camera it was ever told about.
    const ref = React.useRef(null);
    if (!ref.current) {
      ref.current = { facing, facings: [], mounted: false, output: { name: `frames-${facing}-${feeds.length + 1}` } };
      feeds.push(ref.current);
    }
    const feed = ref.current;
    feed.props = props;
    if (!feed.facings.includes(facing)) feed.facings.push(facing);
    React.useEffect(() => {
      feed.mounted = true;
      onOutput(feed.output);
      return () => { feed.mounted = false; onOutput(null); };
    }, [feed, onOutput]);
    return null;
  }
  const photo = { flip() { return photo; }, renderAsync: async () => ({ saveAsync: async () => ({ uri: 'file:///saved.jpg' }) }) };
  const screen = loadScreen('src/components/lens/SoftGlowCamera.tsx', {
    'expo-image-manipulator': { FlipType: { Horizontal: 'h' }, ImageManipulator: { manipulate: () => photo }, SaveFormat: { JPEG: 'jpeg' } },
    'react-native-reanimated': { useSharedValue: (initial) => React.useRef({ value: initial, get() { return this.value; }, set(v) { this.value = v; } }).current },
    'react-native-vision-camera': {
      Camera: host('Camera'),
      usePhotoOutput: () => React.useRef({ name: 'photo', capturePhotoToFile: async () => ({ filePath: '/tmp/photo.jpg', isMirrored: true }) }).current,
    },
    '@/lib/faceMesh': { cameraAxes: () => null, toScreenPointsFrom: () => [], useFaceMeshOutput: () => null },
    '@/lib/frameAccess': frames.module,
    '@/lib/lensDiagnostics': { lensDiagnosticsOn: () => channel === 'testing' },
    './bakeLook': { bakeLook: async (uri, look, faces, view) => { baked.push({ uri, look, view }); return 'file:///baked.jpg'; } },
    './faceTrack': { newTrackMemory: () => ({}), trackFaces: () => [] },
    './LensOverlay': { LensOverlay: host('LensOverlay') },
    './lensPaint': { MAX_LENS_FACES: 2 },
    './warp/FrameFeed': { FrameFeed },
    './warp/WarpDiagnostics': { WarpDiagnostics: host('WarpDiagnostics') },
  });
  // The camera's clock (Date.now inside SoftGlowCamera).
  const clock = { now: 1_000_000 };
  screen.getBinding('Date').now = () => clock.now;
  return { SoftGlowCamera: screen.exports.SoftGlowCamera, frames, feeds, clock, baked };
}

async function renderSoftGlow(SoftGlowCamera, props) {
  let tree;
  const ref = React.createRef();
  let current = { ref, active: true, facing: 'front', flash: 'off', ...props };
  await act(async () => { tree = renderer.create(React.createElement(SoftGlowCamera, current)); });
  return {
    tree,
    ref,
    update: (more) => act(async () => { current = { ...current, ...more }; tree.update(React.createElement(SoftGlowCamera, current)); }),
  };
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

test('flipping the camera with another filter on keeps the same FrameFeed and output (one set-up); it changes camera only when a stretchy filter is picked', async () => {
  const { SoftGlowCamera, feeds } = loadSoftGlow();
  const { tree, update } = await renderSoftGlow(SoftGlowCamera, { look: 'pixelPanic', facing: 'front' });
  try {
    const output = camera(tree).props.outputs[1];
    await update({ look: 'heartEyes' });
    // Flipped with 😘 Heart Eyes on: only the camera changes, not its outputs (the camera is set up once).
    await update({ facing: 'back' });
    assert.equal(camera(tree).props.device, 'back');
    assert.equal(camera(tree).props.outputs[1], output, 'the very same output');
    assert.deepEqual(feeds.map((f) => [f.facing, f.mounted]), [['front', true]]);
    // Still the selfie camera's FrameFeed (it never changes camera), and its pictures aren't wanted.
    assert.deepEqual(feeds[0].facings, ['front']);
    assert.equal(feeds[0].props.inUse, false);
    // Flipped back and forth again: still nothing new.
    await update({ facing: 'front' });
    await update({ facing: 'back' });
    assert.equal(feeds.length, 1);
    assert.equal(camera(tree).props.outputs[1], output);
    // A stretchy filter on the back camera: now a new FrameFeed for the back camera takes over.
    await update({ look: 'bigMouth' });
    assert.deepEqual(feeds.map((f) => [f.facing, f.mounted]), [['front', false], ['back', true]]);
    assert.deepEqual(feeds.map((f) => f.facings), [['front'], ['back']]);
    assert.equal(feeds[1].props.inUse, true);
    assert.deepEqual(outputNames(tree), ['photo', 'frames-back-2']);
    // The selfie camera's FrameFeed was never told its pictures were wanted while the back camera was on.
    assert.equal(feeds[0].props.inUse, false);
    // Flipped back to the selfie camera with another filter, and a stretchy one picked there again.
    await update({ look: 'heartEyes' });
    await update({ facing: 'front' });
    assert.equal(feeds.length, 2);
    await update({ look: 'tinyFace' });
    assert.deepEqual(feeds.map((f) => [f.facing, f.mounted]), [['front', false], ['back', false], ['front', true]]);
    assert.deepEqual(outputNames(tree), ['photo', 'frames-front-3']);
  } finally {
    await unmount(tree);
  }
});

test('flipping away and back with another filter on, then picking a stretchy one: the same FrameFeed, nothing set up again', async () => {
  const { SoftGlowCamera, feeds } = loadSoftGlow();
  const { tree, update } = await renderSoftGlow(SoftGlowCamera, { look: 'gigachin', facing: 'front' });
  try {
    const output = camera(tree).props.outputs[1];
    await update({ look: 'glow' });
    await update({ facing: 'back' });
    await update({ facing: 'front' });
    await update({ look: 'gigachin' });
    assert.equal(feeds.length, 1);
    assert.equal(feeds[0].mounted, true);
    assert.equal(feeds[0].props.inUse, true);
    assert.equal(camera(tree).props.outputs[1], output);
  } finally {
    await unmount(tree);
  }
});

test('once a stretchy filter was picked, switching to another filter keeps the camera\'s outputs (no restart, no flash)', async () => {
  const { SoftGlowCamera, feeds } = loadSoftGlow();
  const { tree, update } = await renderSoftGlow(SoftGlowCamera, { look: 'pixelPanic' });
  try {
    assert.deepEqual(outputNames(tree), ['photo', 'frames-front-1']);
    const output = camera(tree).props.outputs[1];
    assert.equal(feeds[0].props.inUse, true);
    // 😘 Heart Eyes sits between the stretchy ones on the bubble row.
    await update({ look: 'heartEyes' });
    assert.deepEqual(outputNames(tree), ['photo', 'frames-front-1']);
    assert.equal(camera(tree).props.outputs[1], output, 'the very same output: the camera is not set up again');
    assert.equal(feeds.length, 1);
    assert.equal(feeds[0].mounted, true);
    assert.equal(feeds[0].props.inUse, false, 'its pictures are not wanted now');
    // Back to a stretchy one: the same FrameFeed and output, wanted again.
    await update({ look: 'bigMouth' });
    assert.equal(camera(tree).props.outputs[1], output);
    assert.equal(feeds.length, 1);
    assert.equal(feeds[0].props.inUse, true);
    // The camera page swiped away: still there, not wanted.
    await update({ active: false });
    assert.equal(feeds[0].mounted, true);
    assert.equal(feeds[0].props.inUse, false);
  } finally {
    await unmount(tree);
  }
  // The camera closed: gone, and the output handed back.
  assert.equal(feeds[0].mounted, false);
});

test('a camera error long after the stretchy pictures were added, while another filter is on: off until the app closes', async () => {
  const { SoftGlowCamera, frames, feeds, clock } = loadSoftGlow();
  const originalWarn = console.warn;
  console.warn = () => {};
  const { tree, update } = await renderSoftGlow(SoftGlowCamera, { look: 'tinyFace' });
  try {
    clock.now += 60_000;
    await update({ look: 'heartEyes' });
    await act(async () => { camera(tree).props.onError(new Error('media services were reset')); });
    assert.deepEqual(frames.marks, [{ why: 'media services were reset', how: 'thisRun' }]);
    assert.equal(feeds[0].mounted, false);
    assert.deepEqual(outputNames(tree), ['photo']);
  } finally {
    console.warn = originalWarn;
    await unmount(tree);
  }
});

test('the live overlay and the photo get the very same view size, from onLayout (not the Canvas\'s own size)', async () => {
  const { SoftGlowCamera, baked } = loadSoftGlow();
  const { tree, ref } = await renderSoftGlow(SoftGlowCamera, { look: 'gigachin' });
  try {
    const overlay = () => tree.root.findByType('LensOverlay');
    const viewSize = overlay().props.viewSize;
    assert.ok(viewSize, 'the overlay is given the view size');
    assert.deepEqual({ ...viewSize.value }, { width: 0, height: 0 });
    // The camera page is laid out at full size (its shrink animation is not part of the layout).
    const root = tree.root.findAll((node) => typeof node.props.onLayout === 'function' && node.type === 'View')[0];
    await act(async () => { root.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 844 } } }); });
    assert.deepEqual({ ...overlay().props.viewSize.value }, { width: 390, height: 844 });
    // A photo now: bakeLook gets the same size.
    await act(async () => { await ref.current.capture(); });
    assert.equal(baked.length, 1);
    assert.equal(baked[0].look, 'gigachin');
    assert.deepEqual({ ...baked[0].view }, { width: 390, height: 844 });
    assert.equal(overlay().props.onSize, undefined);
  } finally {
    await unmount(tree);
  }
});

test('the readout line shows only on the testing channel, with a stretchy filter on', async () => {
  const readouts = (tree) => tree.root.findAllByType('WarpDiagnostics');
  {
    const { SoftGlowCamera, feeds } = loadSoftGlow({ channel: 'testing' });
    const { tree, update } = await renderSoftGlow(SoftGlowCamera, { look: 'bigMouth' });
    try {
      assert.equal(readouts(tree).length, 1);
      assert.equal(readouts(tree)[0].props.facing, 'front');
      assert.equal(feeds[0].props.probeDark, true, 'the black-picture check is on with the readout');
      // FrameFeed hands its counts up; the readout reads them.
      const counts = { w: { getDirty: () => 1920 } };
      await act(async () => { feeds[0].props.onStats(counts); });
      assert.equal(readouts(tree)[0].props.stats.current, counts);
      await update({ look: 'heartEyes' });
      assert.equal(readouts(tree).length, 0, 'not with another filter');
      await update({ look: 'pixelPanic', active: false });
      assert.equal(readouts(tree).length, 0, 'not while the camera is away');
    } finally {
      await unmount(tree);
    }
  }
  for (const channel of ['production', 'preview', null]) {
    const { SoftGlowCamera, feeds } = loadSoftGlow({ channel });
    const { tree } = await renderSoftGlow(SoftGlowCamera, { look: 'bigMouth' });
    try {
      assert.equal(readouts(tree).length, 0, String(channel));
      assert.equal(feeds[0].props.probeDark, false);
    } finally {
      await unmount(tree);
    }
  }
});

// ---------------------------------------------------------------------------
// FrameFeed itself, with a pretend camera thread and drawing thread.
// ---------------------------------------------------------------------------

// `badSize`: pointers whose Skia image comes out the wrong size. `throwsFor`: pointers whose import throws.
// `dark`: pointers whose picture is black in the middle (for the readout's black-picture check).
// `state.frames` is the every-screen-frame check: `autostart` (whether it ran from the start) and `active`.
// `state.reads` lists the pictures the black-picture check read (their pointers).
function loadFrameFeed({ badSize = [], throwsFor = [], dark = [] } = {}) {
  const state = { released: [], images: [], frameCallback: null, frames: null, reads: [], options: null, output: null };
  const frames = framesStandIn();
  const screen = loadScreen('src/components/lens/warp/FrameFeed.tsx', {
    '@shopify/react-native-skia': {
      AlphaType: { Premul: 2 }, ColorType: { RGBA_8888: 4 },
      Skia: {
        Image: {
          MakeImageFromNativeBuffer: (ptr) => {
            if (throwsFor.includes(ptr)) throw new Error('could not read the picture');
            const size = badSize.includes(ptr) ? [640, 480] : [1920, 1440];
            const image = {
              ptr, disposed: false, dispose() { this.disposed = true; }, width: () => size[0], height: () => size[1],
              // 4 × 4 pixels (RGBA) from the middle: black or mid-grey.
              readPixels: () => { state.reads.push(ptr); return new Uint8Array(64).fill(dark.includes(ptr) ? 0 : 128); },
            };
            state.images.push(image);
            return image;
          },
        },
        NativeBuffer: { Release: (ptr) => state.released.push(ptr) },
      },
    },
    'react-native': { Platform: { OS: 'ios' } },
    'react-native-reanimated': {
      // Like Reanimated's: the same handle for every drawing, which remembers whether it runs.
      useFrameCallback: (callback, autostart = true) => {
        state.frameCallback = callback;
        const handle = React.useRef(null);
        if (!handle.current) handle.current = { autostart, active: autostart, setActive(on) { this.active = on; } };
        state.frames = handle.current;
        return handle.current;
      },
      useSharedValue: (initial) => React.useRef({ value: initial, get() { return this.value; }, set(v) { this.value = v; } }).current,
    },
    'react-native-vision-camera': {
      CommonResolutions: { HD_4_3: 'hd' },
      useFrameOutput: (options) => {
        state.options = options;
        const output = React.useRef({ name: 'frames', outputOrientation: 'up' }).current;
        state.output = output;
        return output;
      },
    },
    'react-native-worklets': {
      createSynchronizable: (value) => ({ value, getDirty() { return this.value; }, setDirty(v) { this.value = v; }, getBlocking() { return this.value; }, setBlocking(v) { this.value = v; }, lock() {}, unlock() {} }),
      scheduleOnUI: (work) => work(),
    },
    '@/lib/frameAccess': frames.module,
    '@/lib/lensDiagnostics': loadPure('src/lib/lensDiagnostics.ts'),
    './feedLogic': loadPure('src/components/lens/warp/feedLogic.ts'),
    './frameMatrix': loadPure('src/components/lens/warp/frameMatrix.ts'),
    './warpEffects': { warpEffects: () => ({}) },
  });
  return { FrameFeed: screen.exports.FrameFeed, state, frames, calls: screen.calls };
}

// One camera picture, as the camera thread gets it. `orientation`: VisionCamera's label (iPhone: 'right' for the
// selfie camera, 'left' for the back camera). `at`: when the camera took it, in seconds.
let clockSeconds = 100;
function cameraFrame(pointer, { orientation = 'right', at, fails = false } = {}) {
  clockSeconds += 1 / 30;
  return {
    width: 1920, height: 1440, orientation, timestamp: at ?? clockSeconds, taken: false, disposed: false,
    getNativeBuffer() {
      if (fails) throw new Error('no buffer');
      this.taken = true;
      return { pointer, release() {} };
    },
    dispose() { this.disposed = true; },
  };
}

const newShot = () => ({ value: null, get() { return this.value; }, set(v) { this.value = v; } });

async function renderFeed(FrameFeed, props) {
  let tree;
  let stats = null;
  const shot = newShot();
  const outputs = [];
  let current = { shot, facing: 'front', inUse: true, onOutput: (output) => outputs.push(output), onStats: (s) => { stats = s; }, ...props };
  await act(async () => { tree = renderer.create(React.createElement(FrameFeed, current)); });
  return {
    tree, shot, outputs,
    stats: () => stats,
    count: (name) => stats[name].getDirty(),
    update: (more) => act(async () => { current = { ...current, ...more }; tree.update(React.createElement(FrameFeed, current)); }),
    // The same, finished before it returns (to change a prop in the middle of the camera thread's work).
    updateNow: (more) => renderer.act(() => { current = { ...current, ...more }; tree.update(React.createElement(FrameFeed, current)); }),
  };
}

for (const [facing, orientation, mirrored] of [['front', 'right', true], ['back', 'left', false]]) {
  test(`every picture from the ${facing} camera stands upright (turn 270 on iPhone) and is ${mirrored ? '' : 'not '}mirrored`, async () => {
    const { FrameFeed, state } = loadFrameFeed();
    const feed = await renderFeed(FrameFeed, { facing });
    try {
      // Two pictures come in (one is held back, so the picture matches the face points).
      state.options.onFrame(cameraFrame(11n, { orientation }));
      state.frameCallback({ timestamp: 1000 });
      state.options.onFrame(cameraFrame(12n, { orientation }));
      state.frameCallback({ timestamp: 1033 });
      const shown = feed.shot.value;
      assert.equal(shown.image.ptr, 11n);
      assert.equal(shown.mirror, mirrored);
      // VisionCamera says 90 for the selfie camera and 270 for the back one; both need 270 (the selfie label counts
      // the other way round: following it drew the selfie picture upside down).
      assert.equal(shown.turn, 270);
      assert.equal(shown.label, orientation === 'right' ? 90 : 270);
      assert.equal(shown.front, facing === 'front');
      // The camera's buffers went straight back (the Skia images keep what they need).
      assert.deepEqual(state.released, [11n, 12n]);
      // The counts for the readout.
      assert.equal(feed.count('w'), 1920);
      assert.equal(feed.count('h'), 1440);
      assert.equal(feed.count('turn'), 270);
      assert.equal(feed.count('mirror'), mirrored ? 1 : 0);
      assert.equal(feed.count('attempts'), 2);
    } finally {
      await unmount(feed.tree);
    }
    // Gone: the pictures it kept are let go of, nothing is shown, and the camera output and counts are handed back.
    assert.equal(feed.shot.value, null);
    assert.ok(state.images.every((image) => image.disposed));
    assert.equal(feed.outputs.at(-1), null);
    assert.equal(feed.stats(), null);
  });
}

test('the iPhone rule follows the back camera\'s own label (a back camera that says 90 is turned 90)', async () => {
  const { FrameFeed, state } = loadFrameFeed();
  const feed = await renderFeed(FrameFeed, { facing: 'back' });
  try {
    state.options.onFrame(cameraFrame(1n, { orientation: 'right' }));
    state.frameCallback({ timestamp: 1000 });
    assert.equal(feed.shot.value.turn, 90);
    assert.equal(feed.shot.value.mirror, false);
  } finally {
    await unmount(feed.tree);
  }
});

test('the camera\'s label is held: one odd picture (the phone\'s turn sensor flipping) never turns the picture', async () => {
  const { FrameFeed, state } = loadFrameFeed();
  const feed = await renderFeed(FrameFeed, { facing: 'front' });
  try {
    let t = 1000;
    const step = (ptr) => { state.options.onFrame(cameraFrame(ptr)); state.frameCallback({ timestamp: (t += 33) }); };
    for (const ptr of [1n, 2n, 3n]) step(ptr);
    // One picture while the output says the phone is held sideways ('right' + 'right' = 180).
    state.output.outputOrientation = 'right';
    step(4n);
    state.output.outputOrientation = 'up';
    step(5n);
    step(6n);
    assert.ok(state.images.length === 6);
    assert.equal(feed.shot.value.turn, 270);
    assert.equal(feed.shot.value.label, 90);
    assert.equal(feed.count('turn'), 270);
  } finally {
    await unmount(feed.tree);
  }
});

test('a picture that fails or has the wrong size is skipped: the last good one stays, and it is counted', async () => {
  const { FrameFeed, state } = loadFrameFeed({ badSize: [3n], throwsFor: [4n] });
  const feed = await renderFeed(FrameFeed, { facing: 'front' });
  try {
    state.options.onFrame(cameraFrame(1n));
    state.frameCallback({ timestamp: 1000 });
    state.options.onFrame(cameraFrame(2n));
    state.frameCallback({ timestamp: 1033 });
    const good = feed.shot.value;
    assert.equal(good.image.ptr, 1n);
    state.options.onFrame(cameraFrame(3n));
    state.frameCallback({ timestamp: 1066 });
    state.options.onFrame(cameraFrame(4n));
    state.frameCallback({ timestamp: 1100 });
    assert.equal(feed.shot.value, good, 'the last good picture is still shown');
    assert.equal(good.image.disposed, false);
    assert.equal(feed.count('uiErr'), 2);
    // The wrong-size picture was let go of at once, and both camera buffers went back.
    assert.equal(state.images.find((image) => image.ptr === 3n).disposed, true);
    assert.ok(state.released.includes(3n) && state.released.includes(4n));
    // A picture that fails on the camera thread is counted there.
    state.options.onFrame(cameraFrame(5n, { fails: true }));
    assert.equal(feed.count('camErr'), 1);
  } finally {
    await unmount(feed.tree);
  }
});

test('with no new picture the last one stays for up to 1 s; after that nothing is shown and a gap is counted', async () => {
  const { FrameFeed, state } = loadFrameFeed();
  const feed = await renderFeed(FrameFeed, { facing: 'front' });
  try {
    state.options.onFrame(cameraFrame(1n));
    state.frameCallback({ timestamp: 1000 });
    assert.ok(feed.shot.value);
    state.frameCallback({ timestamp: 1999 });
    assert.ok(feed.shot.value, 'still there after 999 ms');
    assert.equal(feed.count('gap'), 0);
    state.frameCallback({ timestamp: 2001 });
    assert.equal(feed.shot.value, null);
    assert.equal(feed.count('gap'), 1);
    assert.ok(state.images.every((image) => image.disposed));
    // The next picture shows at once.
    state.options.onFrame(cameraFrame(2n));
    state.frameCallback({ timestamp: 2034 });
    assert.equal(feed.shot.value.image.ptr, 2n);
  } finally {
    await unmount(feed.tree);
  }
});

test('while its pictures aren\'t wanted (another filter is on) the camera\'s pictures go straight back and nothing is kept', async () => {
  const { FrameFeed, state } = loadFrameFeed();
  const feed = await renderFeed(FrameFeed, { facing: 'front' });
  try {
    // The every-screen-frame check doesn't start by itself: it runs because the pictures are wanted.
    assert.equal(state.frames.autostart, false);
    assert.equal(state.frames.active, true);
    state.options.onFrame(cameraFrame(1n));
    state.frameCallback({ timestamp: 1000 });
    state.options.onFrame(cameraFrame(2n));
    assert.ok(feed.shot.value);
    await feed.update({ inUse: false });
    // Paused (it would otherwise wake the phone every screen frame for as long as the camera is open)…
    assert.equal(state.frames.active, false);
    // …and everything let go of at once, without waiting for a screen frame: nothing shown, the kept picture
    // gone, and the one that was still waiting back with the camera. Nothing counts as a gap.
    assert.equal(feed.shot.value, null);
    assert.ok(state.images.every((image) => image.disposed));
    assert.deepEqual(state.released, [1n, 2n]);
    const late = cameraFrame(3n);
    state.options.onFrame(late);
    assert.equal(late.taken, false);
    assert.equal(late.disposed, true);
    // A screen frame that was already on its way when it paused changes nothing.
    state.frameCallback({ timestamp: 1033 });
    assert.equal(feed.shot.value, null);
    assert.deepEqual(state.released, [1n, 2n]);
    assert.equal(feed.count('gap'), 0);
    assert.equal(feed.count('attempts'), 2);
    // Wanted again: running again, and the next picture shows straight away.
    await feed.update({ inUse: true });
    assert.equal(state.frames.active, true);
    state.options.onFrame(cameraFrame(4n));
    state.frameCallback({ timestamp: 5000 });
    assert.equal(feed.shot.value.image.ptr, 4n);
  } finally {
    await unmount(feed.tree);
  }
});

test('a picture the camera thread was still handing over when the pictures stopped being wanted never stays in the mailbox', async () => {
  const { FrameFeed, state } = loadFrameFeed();
  const feed = await renderFeed(FrameFeed, { facing: 'front' });
  try {
    // The camera thread checked "wanted" just before the switch, and puts its picture in the mailbox just after
    // the drawing thread emptied it for the last time: it must go straight back instead (asked again inside).
    const frame = cameraFrame(7n);
    const realBuffer = frame.getNativeBuffer;
    frame.getNativeBuffer = function () {
      const buffer = realBuffer.call(this);
      // The switch happens right here, between the first check and the mailbox.
      feed.updateNow({ inUse: false });
      return buffer;
    };
    state.options.onFrame(frame);
    assert.equal(state.frames.active, false);
    assert.deepEqual(state.released, [7n], 'its buffer went back');
    // When the pictures are wanted again, that old picture is not shown.
    await feed.update({ inUse: true });
    state.frameCallback({ timestamp: 9000 });
    assert.equal(feed.shot.value, null);
    assert.deepEqual(state.released, [7n]);
  } finally {
    await unmount(feed.tree);
  }
});

test('the black-picture check (testing readout) runs only in a screen frame with no new picture, and only now and then', async () => {
  const { FrameFeed, state } = loadFrameFeed({ dark: [1n, 2n] });
  const feed = await renderFeed(FrameFeed, { facing: 'front', probeDark: true });
  try {
    let ptr = 0n;
    const picture = (at) => { state.options.onFrame(cameraFrame((ptr += 1n))); state.frameCallback({ timestamp: at }); };
    const quiet = (at) => state.frameCallback({ timestamp: at });
    // A screen frame that makes a picture never checks (the check makes the drawing thread wait).
    picture(1000);
    picture(1033);
    assert.deepEqual(state.reads, []);
    // The first quiet screen frame after the pictures started checks the picture on screen (here a black one).
    quiet(1050);
    assert.deepEqual(state.reads, [1n]);
    assert.equal(feed.count('dark'), 1);
    // Then not again for a while, however many pictures and quiet frames come.
    for (let t = 1100; t < 11_000; t += 100) { picture(t); quiet(t + 16); }
    assert.deepEqual(state.reads, [1n]);
    // About every 10 s.
    picture(11_000);
    quiet(11_066);
    assert.equal(state.reads.length, 2);
    assert.equal(feed.count('dark'), 1, 'that one was not black');
    // After a gap (no picture for 1 s) the first picture is checked soon again – but never within 2 s of the last.
    quiet(12_100);
    assert.equal(feed.shot.value, null);
    assert.equal(feed.count('gap'), 1);
    picture(12_200);
    quiet(12_216);
    assert.equal(state.reads.length, 2, 'not within 2 s of the last check');
    quiet(13_100);
    assert.equal(state.reads.length, 3);
    assert.equal(state.reads[2], feed.shot.value.image.ptr, 'the picture on screen');
  } finally {
    await unmount(feed.tree);
  }
});

test('without the testing readout the black-picture check never runs', async () => {
  const { FrameFeed, state } = loadFrameFeed({ dark: [1n] });
  const feed = await renderFeed(FrameFeed, { facing: 'front' });
  try {
    state.options.onFrame(cameraFrame(1n));
    state.frameCallback({ timestamp: 1000 });
    for (let t = 1016; t < 30_000; t += 500) state.frameCallback({ timestamp: t });
    assert.deepEqual(state.reads, []);
    assert.equal(feed.count('dark'), 0);
  } finally {
    await unmount(feed.tree);
  }
});

test('pictures the camera drops are counted by reason (out-of-buffers separately)', async () => {
  const { FrameFeed, state } = loadFrameFeed();
  const feed = await renderFeed(FrameFeed, { facing: 'front' });
  try {
    state.options.onFrameDropped('frame-was-late');
    state.options.onFrameDropped('out-of-buffers');
    state.options.onFrameDropped('out-of-buffers');
    assert.equal(feed.count('drop'), 3);
    assert.equal(feed.count('oob'), 2);
  } finally {
    await unmount(feed.tree);
  }
});

test('a few failed pictures never switch the filters off; most pictures failing for a while does, until the app closes', async () => {
  const { FrameFeed, state, frames, calls } = loadFrameFeed({ throwsFor: [91n, 92n, 93n] });
  const feed = await renderFeed(FrameFeed, { facing: 'front' });
  const check = () => { for (const tick of calls.intervals.values()) tick(); };
  try {
    // Only the shaders check ran at the start (they were made fine).
    assert.deepEqual(frames.marks, []);
    let t = 1000;
    // 3 failed pictures among good ones (this switched them off for good on build 11).
    for (const ptr of [1n, 91n, 2n, 92n, 3n, 93n, 4n, 5n]) { state.options.onFrame(cameraFrame(ptr)); state.frameCallback({ timestamp: (t += 33) }); }
    assert.equal(feed.count('uiErr'), 3);
    check();
    assert.deepEqual(frames.marks, []);
    // 10 of the next 12 fail on the camera thread: off, but only until the app closes.
    for (let i = 0; i < 12; i++) state.options.onFrame(cameraFrame(BigInt(200 + i), { fails: i < 10 }));
    check();
    assert.deepEqual(frames.marks, [{ why: 'Camera pictures keep failing', how: 'thisRun' }]);
  } finally {
    await unmount(feed.tree);
  }
});

test('the camera output asks for YUV pictures on iPhone, never turned by the camera, and counts dropped pictures', async () => {
  const { FrameFeed, state } = loadFrameFeed();
  const feed = await renderFeed(FrameFeed, { facing: 'back' });
  try {
    assert.equal(state.options.pixelFormat, 'yuv');
    assert.equal(state.options.enablePhysicalBufferRotation, false);
    assert.equal(state.options.enablePreviewSizedOutputBuffers, true);
    assert.equal(typeof state.options.onFrameDropped, 'function');
    state.options.onFrameDropped('unknown');
    assert.equal(feed.count('drop'), 1, 'not a do-nothing: drops are counted');
  } finally {
    await unmount(feed.tree);
  }
});

test('a picture still waiting when FrameFeed goes away (the camera was flipped) is let go of, never shown', async () => {
  const { FrameFeed, state } = loadFrameFeed();
  const feed = await renderFeed(FrameFeed, { facing: 'front' });
  state.options.onFrame(cameraFrame(21n));
  const onFrame = state.options.onFrame;
  await unmount(feed.tree);
  assert.deepEqual(state.released, [21n]);
  assert.equal(feed.shot.value, null);
  // A picture the old camera still sends afterwards goes straight back to the camera (its buffer is never taken).
  const late = cameraFrame(22n);
  onFrame(late);
  assert.equal(late.taken, false);
  assert.equal(late.disposed, true);
  assert.equal(feed.shot.value, null);
});
