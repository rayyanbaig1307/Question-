const test = require('node:test');
const assert = require('node:assert/strict');
const { React, renderer, loadScreen, act, unmount, host } = require('./harness.cjs');

// Pinch-zoom on a photo (src/components/ZoomableImage.tsx: full-screen posts, public chat, group chat, peeks).
// The owner zoomed into a friend's photo and it "snapped out" and stayed pushed half off the screen: lifting two
// fingers looked like a double tap (zoom out), and the pinch ending a moment later aimed the position at the old
// zoom while the zoom itself went back to normal. Also: a zoomed photo with black bars (not the same shape as the
// screen) could be dragged until a big black bar covered part of the screen, and it stayed there.
//
// These stand-ins behave like the real animations: an animated value keeps its old value until the test says
// the animations are finished (`finish()`), so a gesture that ends in the middle of an animation is tested too.

const W = 390;
const H = 650;

async function renderZoomable(props = {}) {
  const gestures = {};
  const values = [];
  let styleOf = () => ({});
  const zoomChanges = [];
  const makeShared = (initial) => ({
    value: initial, goal: initial,
    get() { return this.value; },
    set(next) {
      if (next && typeof next === 'object' && 'animateTo' in next) this.goal = next.animateTo; // starts gliding
      else { this.value = next; this.goal = next; } // jumps (and stops any glide)
    },
  });
  // Each shared value lasts for the whole life of the component, like the real one.
  const useSharedValue = (initial) => {
    const ref = React.useRef(null);
    if (ref.current === null) {
      ref.current = makeShared(initial);
      values.push(ref.current);
    }
    return ref.current;
  };
  const screen = loadScreen('src/components/ZoomableImage.tsx', {
    'expo-image': { Image: host('ExpoImage') },
    'react-native-reanimated': {
      __esModule: true,
      default: { View: host('AnimatedView') },
      useSharedValue,
      useAnimatedStyle: (callback) => { styleOf = callback; return callback(); },
      withTiming: (to) => ({ animateTo: to }),
    },
    'react-native-gesture-handler': {
      GestureDetector: host('GestureDetector'),
      usePinchGesture: (config) => { gestures.pinch = config; return {}; },
      usePanGesture: (config) => { gestures.pan = config; return {}; },
      useTapGesture: (config) => { gestures.tap = config; return {}; },
      useSimultaneousGestures: () => ({}),
    },
    'react-native-worklets': { scheduleOnRN: (fn, ...args) => fn(...args) },
  });
  let tree;
  await act(async () => {
    tree = renderer.create(React.createElement(screen.exports.ZoomableImage, {
      uri: 'https://example.invalid/photo.jpg',
      onZoomChange: (zoomed) => zoomChanges.push(zoomed),
      ...props,
    }));
  });
  // The frame measures itself (a phone-sized photo area).
  const frame = tree.root.findAll((node) => node.type === 'View' && typeof node.props.onLayout === 'function')[0];
  frame.props.onLayout({ nativeEvent: { layout: { width: W, height: H } } });
  // Where the photo is drawn right now.
  const now = () => {
    const [{ translateX }, { translateY }, { scale }] = styleOf().transform;
    return { scale, x: translateX, y: translateY };
  };
  // Let every running animation reach its end.
  const finish = () => { for (const shared of values) shared.value = shared.goal; };
  // The photo finishes loading: expo-image tells its real size (in pixels).
  const load = (width, height) => {
    const image = tree.root.findAll((node) => node.type === 'ExpoImage')[0];
    image.props.onLoad({ cacheType: 'none', source: { url: 'https://example.invalid/photo.jpg', width, height, mediaType: 'image/jpeg' } });
  };
  return { tree, gestures, now, finish, zoomChanges, load };
}

// Where the photo itself sits on screen (its edges), for a photo drawn `shownW` × `shownH` at normal size in the
// middle of the frame. RN zooms around the frame's centre, then moves it by x/y.
function photoEdges({ scale, x, y }, shownW, shownH) {
  return {
    left: W / 2 + x - (shownW * scale) / 2,
    right: W / 2 + x + (shownW * scale) / 2,
    top: H / 2 + y - (shownH * scale) / 2,
    bottom: H / 2 + y + (shownH * scale) / 2,
  };
}

// No black where the photo could be: in each direction, a photo bigger than the screen covers it edge to edge;
// a photo still smaller than the screen sits exactly in the middle (like at normal size).
function assertNoBlackGap(position, shownW, shownH) {
  const edges = photoEdges(position, shownW, shownH);
  const tiny = 1e-9;
  if (shownW * position.scale >= W) {
    assert.ok(edges.left <= tiny && edges.right >= W - tiny, `black at the side: photo runs ${edges.left}…${edges.right} on a ${W} screen`);
  } else {
    close(position.x, 0);
  }
  if (shownH * position.scale >= H) {
    assert.ok(edges.top <= tiny && edges.bottom >= H - tiny, `black at the top or bottom: photo runs ${edges.top}…${edges.bottom} on a ${H} screen`);
  } else {
    close(position.y, 0);
  }
}

// Pinch from the middle of the screen to `zoom`, and let go.
function pinchTo(z, zoom, focalX = W / 2, focalY = H / 2) {
  z.gestures.pinch.onBegin?.();
  z.gestures.pinch.onActivate();
  z.gestures.pinch.onUpdate({ scaleChange: zoom / z.now().scale, focalX, focalY });
  z.gestures.pinch.onDeactivate();
  z.gestures.pinch.onFinalize?.();
  z.finish();
}

// Drag the zoomed photo by (dx, dy) with one finger, and let go.
function drag(z, dx, dy) {
  z.gestures.pan.onUpdate({ changeX: dx, changeY: dy });
  z.gestures.pan.onDeactivate();
  z.finish();
}

// The photo never shows a gap: at normal size it is exactly in place; zoomed in, its edges stay outside the frame.
function assertInsideFrame({ scale, x, y }) {
  assert.ok(scale >= 1, `zoom ${scale} is smaller than normal`);
  if (scale === 1) {
    assert.equal(x, 0, 'back at normal size but moved sideways');
    assert.equal(y, 0, 'back at normal size but moved up or down');
    return;
  }
  assert.ok(Math.abs(x) <= (W * (scale - 1)) / 2 + 1e-9, `moved ${x} sideways at zoom ${scale}: a gap shows`);
  assert.ok(Math.abs(y) <= (H * (scale - 1)) / 2 + 1e-9, `moved ${y} up/down at zoom ${scale}: a gap shows`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

// A pinch towards the top left of the photo, like in the owner's screenshot.
function pinchTopLeft(g) {
  g.pinch.onBegin?.();
  g.pinch.onActivate();
  g.pinch.onUpdate({ scaleChange: 1.8, focalX: 60, focalY: 100 });
}

test('a double tap needs two taps in about the same spot, and is switched off where a tap does something else', async () => {
  const z = await renderZoomable();
  assert.equal(z.gestures.tap.numberOfTaps, 2);
  assert.equal(z.gestures.tap.maxDistance, 24);
  assert.equal(z.gestures.tap.enabled, true);
  await unmount(z.tree);
  const peek = await renderZoomable({ doubleTapZoom: false });
  assert.equal(peek.gestures.tap.enabled, false);
  await unmount(peek.tree);
});

test('the owner\'s bug: fingers lifting at the end of a pinch (looks like a double tap) don\'t zoom out or push the photo off screen', async () => {
  const z = await renderZoomable();
  pinchTopLeft(z.gestures);
  // The spot under the fingers stays in place: the photo moves right and down by (focus - centre) × (1 - zoom).
  close(z.now().scale, 1.8);
  close(z.now().x, (60 - W / 2) * (1 - 1.8));
  close(z.now().y, (100 - H / 2) * (1 - 1.8));
  // The first finger lifts: the phone thinks it was a double tap.
  z.gestures.tap.onActivate({ x: W / 2, y: H / 2 });
  // The second finger lifts a moment later: the pinch ends.
  z.gestures.pinch.onDeactivate();
  z.gestures.pinch.onFinalize?.();
  z.finish();
  const end = z.now();
  // (Before the fix: back at normal size, but still moved right and down – the black gap in the screenshot.)
  assertInsideFrame(end);
  close(end.scale, 1.8);
  assert.deepEqual(z.zoomChanges, [true]);
  await unmount(z.tree);
});

test('a drag ending while the photo springs back still leaves it centred', async () => {
  const z = await renderZoomable();
  pinchTopLeft(z.gestures);
  z.gestures.pinch.onDeactivate();
  z.gestures.pinch.onFinalize?.();
  z.finish();
  // A real double tap (well after the pinch) zooms back out...
  await wait(PINCH_QUIET_MS() + 50);
  z.gestures.tap.onActivate({ x: W / 2, y: H / 2 });
  // ...and while it's still springing back, a drag ends too (this used to aim the position at the old zoom).
  z.gestures.pan.onDeactivate();
  z.finish();
  assert.deepEqual(z.now(), { scale: 1, x: 0, y: 0 });
  assert.deepEqual(z.zoomChanges.at(-1), false);
  await unmount(z.tree);
});

test('a double tap zooms in on the tapped spot (even if a drag ends while it glides there) and back out', async () => {
  const z = await renderZoomable();
  z.gestures.tap.onActivate({ x: W / 2 + 100, y: H / 2 - 40 });
  // A drag ends while the zoom is still gliding in: it heads for the same place.
  z.gestures.pan.onDeactivate();
  z.finish();
  const zoomedIn = z.now();
  close(zoomedIn.scale, 2.5);
  close(zoomedIn.x, -100 * 1.5);
  close(zoomedIn.y, 40 * 1.5);
  assertInsideFrame(zoomedIn);
  z.gestures.tap.onActivate({ x: W / 2, y: H / 2 });
  z.finish();
  assert.deepEqual(z.now(), { scale: 1, x: 0, y: 0 });
  assert.deepEqual(z.zoomChanges, [true, false]);
  await unmount(z.tree);
});

test('a double tap right after a pinch is ignored, but works again a moment later', async () => {
  const z = await renderZoomable();
  pinchTopLeft(z.gestures);
  z.gestures.pinch.onDeactivate();
  z.gestures.pinch.onFinalize?.();
  z.finish();
  await wait(300);
  z.gestures.tap.onActivate({ x: W / 2, y: H / 2 });
  z.finish();
  close(z.now().scale, 1.8);
  await wait(PINCH_QUIET_MS() - 300 + 100);
  z.gestures.tap.onActivate({ x: W / 2, y: H / 2 });
  z.finish();
  assert.deepEqual(z.now(), { scale: 1, x: 0, y: 0 });
  await unmount(z.tree);
});

test('dragging a zoomed photo far away springs back to its edge; pinching nearly back to normal springs back centred', async () => {
  const z = await renderZoomable();
  z.gestures.pinch.onBegin?.();
  z.gestures.pinch.onActivate();
  z.gestures.pinch.onUpdate({ scaleChange: 3, focalX: 0, focalY: 0 });
  z.gestures.pinch.onDeactivate();
  z.finish();
  z.gestures.pan.onUpdate({ changeX: 5000, changeY: -5000 });
  z.gestures.pan.onDeactivate();
  z.finish();
  const dragged = z.now();
  close(dragged.x, W);
  close(dragged.y, -H);
  assertInsideFrame(dragged);
  // Pinch back out to just above normal size, off-centre: it springs back to exactly normal.
  z.gestures.pinch.onBegin?.();
  z.gestures.pinch.onActivate();
  z.gestures.pinch.onUpdate({ scaleChange: 1.02 / 3, focalX: 10, focalY: 600 });
  z.gestures.pinch.onDeactivate();
  z.finish();
  assert.deepEqual(z.now(), { scale: 1, x: 0, y: 0 });
  assert.equal(z.zoomChanges.at(-1), false);
  await unmount(z.tree);
});

// ---------------------------------------------------------------------------
// Photos that aren't the same shape as the screen (full-screen posts, Public chat and group chat show the whole
// photo, with black bars above and below a tall photo, or above and below a wide one). The zoom limits must
// follow the photo's own edges, not the frame's – otherwise dragging a zoomed photo pulls that black bar onto
// the screen and it stays there after you let go.
// ---------------------------------------------------------------------------

// A 3:4 photo (a phone photo) in the 390 × 650 frame: drawn 390 × 520, with 65 of black above and below.
const TALL = { width: 1500, height: 2000, shownW: W, shownH: (W * 4) / 3 };
// A 4:3 photo (a landscape one from the camera roll): drawn 390 × 292.5, with 178.75 of black above and below.
const WIDE = { width: 2000, height: 1500, shownW: W, shownH: (W * 3) / 4 };

test('a tall photo with black bars: zoomed in and dragged to its top or bottom, it stops at the photo\'s edge', async () => {
  const z = await renderZoomable();
  z.load(TALL.width, TALL.height);
  pinchTo(z, 2);
  // Drag down as far as it goes (to look at the top of the photo) and to the right.
  drag(z, 5000, 5000);
  let end = z.now();
  close(end.scale, 2);
  // (Before the fix: y = 325, which left 2 × 65 = 130 of black above the photo for good.)
  close(end.y, (TALL.shownH * 2 - H) / 2);
  close(end.x, (W * 2 - W) / 2);
  assertNoBlackGap(end, TALL.shownW, TALL.shownH);
  close(photoEdges(end, TALL.shownW, TALL.shownH).top, 0);
  // And the other way (the bottom of the photo).
  drag(z, -9000, -9000);
  end = z.now();
  assertNoBlackGap(end, TALL.shownW, TALL.shownH);
  close(photoEdges(end, TALL.shownW, TALL.shownH).bottom, H);
  // All the way in (5×): still no black.
  pinchTo(z, 5);
  drag(z, 9000, 9000);
  assertNoBlackGap(z.now(), TALL.shownW, TALL.shownH);
  close(z.now().y, (TALL.shownH * 5 - H) / 2);
  await unmount(z.tree);
});

test('a tall photo: a pinch with your fingers on the black bar above it doesn\'t leave the black bar on screen', async () => {
  const z = await renderZoomable();
  z.load(TALL.width, TALL.height);
  for (const zoom of [1.5, 2, 3.5]) {
    pinchTo(z, 1);
    pinchTo(z, zoom, 200, 30);
    assertNoBlackGap(z.now(), TALL.shownW, TALL.shownH);
    close(z.now().scale, zoom);
  }
  await unmount(z.tree);
});

test('a wide photo: while the zoomed photo is still shorter than the screen it stays centred up and down', async () => {
  const z = await renderZoomable();
  z.load(WIDE.width, WIDE.height);
  // 2× is 585 tall on a 650 screen: it can't move up or down at all, only sideways (to its edges).
  pinchTo(z, 2, 60, 100);
  let end = z.now();
  close(end.y, 0);
  close(end.x, (195 - 60) * (2 - 1));
  assertNoBlackGap(end, WIDE.shownW, WIDE.shownH);
  drag(z, 5000, 5000);
  end = z.now();
  close(end.y, 0);
  close(end.x, (W * 2 - W) / 2);
  // (Before the fix a drag could leave 325 of black above it – half the screen.)
  assertNoBlackGap(end, WIDE.shownW, WIDE.shownH);
  // 3× is taller than the screen: it can move up and down, but only to the photo's top and bottom.
  pinchTo(z, 3);
  drag(z, -5000, 5000);
  end = z.now();
  close(end.y, (WIDE.shownH * 3 - H) / 2);
  assertNoBlackGap(end, WIDE.shownW, WIDE.shownH);
  await unmount(z.tree);
});

test('a wide photo: a double tap near the top zooms in without pulling the black bar onto the screen', async () => {
  const z = await renderZoomable();
  z.load(WIDE.width, WIDE.height);
  z.gestures.tap.onActivate({ x: 80, y: 40 });
  z.finish();
  const end = z.now();
  close(end.scale, 2.5);
  close(end.y, (WIDE.shownH * 2.5 - H) / 2);
  assertNoBlackGap(end, WIDE.shownW, WIDE.shownH);
  await unmount(z.tree);
});

test('a photo that fills the frame (peeks) can be dragged to the frame\'s edges; before a photo loads, the frame counts', async () => {
  // 'cover': the photo fills the whole frame (and the rest is cut off), so the frame's edges are the photo's.
  const peek = await renderZoomable({ contentFit: 'cover', doubleTapZoom: false });
  peek.load(TALL.width, TALL.height);
  pinchTo(peek, 2);
  drag(peek, 5000, 5000);
  close(peek.now().x, (W * 2 - W) / 2);
  close(peek.now().y, (H * 2 - H) / 2);
  await unmount(peek.tree);
  // Not loaded yet (or the phone didn't say its size): the whole frame counts, like before.
  const z = await renderZoomable();
  z.load(0, 0);
  pinchTo(z, 2);
  drag(z, 5000, 5000);
  close(z.now().y, (H * 2 - H) / 2);
  await unmount(z.tree);
});

// The quiet time after a pinch, read from the component (so the test follows it if it changes).
function PINCH_QUIET_MS() {
  const source = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../../src/components/ZoomableImage.tsx'), 'utf8');
  return Number(source.match(/const PINCH_QUIET_MS = (\d+);/)?.[1] ?? 700);
}
