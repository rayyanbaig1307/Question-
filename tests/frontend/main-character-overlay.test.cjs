const test = require('node:test');
const assert = require('node:assert/strict');
const { React, renderer, act, loadScreen, loadPure, host, unmount } = require('./harness.cjs');

// Main Character Mode 🌆, the live poster (src/components/mainCharacter/MainCharacterOverlay.tsx) and the lite way's
// moving camera view (src/components/mainCharacter/CameraFollow.tsx). Built like the face filters' LensOverlay, with
// the same hard-won rules, checked here:
// - nothing is drawn until the poster and the view size are there; the size comes from SoftGlowCamera's onLayout
//   (`viewSize`), never the Canvas's own size; the poster is put on the view first ("cover");
// - the very first drawing (on the JS thread) never uses the camera picture; later ones do, placed exactly like the
//   camera view, only while the camera pictures are in use;
// - each finished drawing is let go of two drawings later, and the last two when it closes; `drawn` goes up by one
//   for each drawing (the art cache's clock); everything made for a drawing is let go of right after it;
// - a drawing that fails pauses the camera picture part (the lite drawing goes on), and never closes the app;
// - the screen's ask for the poster is answered from the drawing thread with exactly what is shown (or null);
// - CameraFollow never gives the camera view a broken number: no transform before the first good one, and a missing
//   or broken one keeps the last good one.

const config = loadPure('src/lib/mainCharacter/config.ts');
const fitFor = (cfg) => loadScreen('src/components/mainCharacter/fit.ts', { '@/lib/mainCharacter/config': cfg }).exports;
const fit = fitFor(config);

// Invented face spots for a character: eyes, forehead, nose, chin and a round hole of 36 points (art 0–1).
function anchors() {
  const hole = [];
  for (let i = 0; i < 36; i++) {
    const a = (i * Math.PI) / 18 - Math.PI / 2;
    hole.push([0.49 + 0.12 * Math.cos(a), 0.15 + 0.08 * Math.sin(a)]);
  }
  return {
    eyes: [[0.43, 0.12], [0.55, 0.12]], nose: [0.49, 0.15], chin: [0.49, 0.23], forehead: [0.49, 0.07],
    hole, faceWidth: 0.25, skinTone: [205, 140, 110], toneSure: true,
  };
}

// 478 face points (view points) with the eye corners round (cx ± gap/2, cy) and the top of the forehead above.
function facePoints(cx, cy, gap) {
  const pts = new Array(478 * 2).fill(0);
  const put = (i, x, y) => { pts[i * 2] = x; pts[i * 2 + 1] = y; };
  put(33, cx - gap / 2 - 8, cy);
  put(133, cx - gap / 2 + 8, cy);
  put(263, cx + gap / 2 + 8, cy);
  put(362, cx + gap / 2 - 8, cy);
  put(10, cx, cy - gap * 0.9);
  return pts;
}
const face = (cx, cy, gap) => ({ pts: facePoints(cx, cy, gap), blinkLeft: 0, blinkRight: 0, smile: 0, light: [], lightAt: 0 });

const shared = (value) => ({ value, get() { return this.value; }, set(v) { this.value = v; } });
const scene = () => ({ key: 'app:street|app:neon', character: { name: 'character' }, background: { name: 'scene' }, art: fit.placeArt(anchors()) });

// The stand-ins every reanimated hook here needs: every render stands for one drawing-thread frame.
const reanimated = (more = {}) => ({
  useSharedValue: (initial) => React.useRef(shared(initial)).current,
  useDerivedValue: (updater) => { const ref = React.useRef({ value: null }); ref.current.value = updater(); return ref.current; },
  useAnimatedReaction: (prepare, react) => { const last = React.useRef(null); const value = prepare(); react(value, last.current); last.current = value; },
  ...more,
});

// `paint(trash, src)` (optional) runs inside the pretend paintMainCharacter (it may put things on trash, or fail).
// `snap` (optional) stands in for snapPoster. `worklet`: the drawing runs on the drawing thread.
function loadOverlay({ paint, snap, worklet = true } = {}) {
  const painted = [];
  const pictures = [];
  const concat = [];
  const matrices = [];
  const placed = [];
  const snaps = [];
  const screen = loadScreen('src/components/mainCharacter/MainCharacterOverlay.tsx', {
    '@shopify/react-native-skia': {
      Canvas: host('Canvas'),
      Picture: host('Picture'),
      createPicture: (draw) => {
        draw({ concat: (m) => concat.push(m) });
        const picture = { name: `picture${pictures.length + 1}`, disposed: false, frees: 0, dispose() { this.disposed = true; this.frees += 1; } };
        pictures.push(picture);
        return picture;
      },
      Skia: { Matrix: (m) => { const matrix = { m, disposed: false, dispose() { this.disposed = true; } }; matrices.push(matrix); return matrix; } },
    },
    'react-native-reanimated': reanimated(),
    'react-native-worklets': { scheduleOnUI: (work) => work(), scheduleOnRN: (fn, ...args) => fn(...args) },
    '@/lib/frameAccess': { FRAME_PLACEMENT: 'rule', LOOK_COOL_DOWN_MS: 1500, LOOK_MAX_FAILS: 5 },
    '../lens/warp/frameMatrix': {
      placeShot: (frame, vw, vh, axes, placement) => { placed.push({ frame, vw, vh, axes, placement }); return { m: ['placed', vw, vh], how: 0 }; },
      toMatrix9: (m) => [...m, 'm9'],
    },
    './fit': fit,
    './free': loadPure('src/components/mainCharacter/free.ts'),
    './paintScene': {
      paintMainCharacter: (canvas, sceneNow, faceNow, fitNow, src, live, fx, trash) => {
        painted.push({ scene: sceneNow, face: faceNow, fit: fitNow, src, live, fx, trash });
        if (paint) paint(trash, src);
      },
    },
    './snapPoster': { snapPoster: (...args) => { snaps.push(args); return snap ? snap(...args) : { name: 'poster' }; } },
  });
  if (worklet) screen.getBinding('globalThis')._WORKLET = true;
  const clock = { now: 50_000 };
  screen.getBinding('Date').now = () => clock.now;
  return { MainCharacterOverlay: screen.exports.MainCharacterOverlay, screen, painted, pictures, concat, matrices, placed, snaps, clock };
}

// What SoftGlowCamera hands the overlay (CustomLookProps) with Main Character's extra values.
function lookProps({ framesOn = true, withScene = true, size = { width: 390, height: 844 } } = {}) {
  const snapped = [];
  const image = { name: 'camera picture' };
  const extra = {
    scene: shared(withScene ? scene() : null),
    fx: { name: 'comic' },
    cameraPictures: shared(true),
    drawn: shared(0),
    snapAsk: shared(0),
    onSnap: (ask, poster) => snapped.push({ ask, poster }),
  };
  return {
    snapped,
    props: {
      faces: shared([face(195, 400, 60)]),
      shot: shared({ image, w: 1920, h: 1440, turn: 270, mirror: true, label: 90, front: true }),
      framesOn,
      viewSize: shared(size),
      axes: shared(null),
      extra,
    },
  };
}

async function show(Overlay, props) {
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(Overlay, props)); });
  return {
    tree,
    // One more drawing-thread frame (with changed props, if any).
    draw: (more = {}) => act(async () => { Object.assign(props, more); tree.update(React.createElement(Overlay, { ...props })); }),
  };
}

test('nothing is drawn until the poster and the view size are there; the poster is put on the view first (cover)', async () => {
  const { MainCharacterOverlay, painted, concat, matrices } = loadOverlay();
  const { props } = lookProps({ withScene: false, size: { width: 0, height: 0 } });
  const { tree, draw } = await show(MainCharacterOverlay, props);
  try {
    assert.equal(painted.length, 0, 'no poster yet');
    props.extra.scene.value = scene();
    await draw();
    assert.equal(painted.length, 0, 'the view is not laid out yet');
    // SoftGlowCamera's onLayout size (never the Canvas's own: it has no onSize).
    assert.equal(tree.root.findByType('Canvas').props.onSize, undefined);
    props.viewSize.value = { width: 390, height: 844 };
    await draw();
    assert.equal(painted.length, 1);
    assert.deepEqual(concat.at(-1).m, [...fit.posterToView(390, 844), 'm9']);
    // The matrix was only needed for this drawing.
    assert.ok(matrices.every((m) => m.disposed));
    assert.equal(painted[0].live, true);
    assert.equal(painted[0].fx, props.extra.fx);
    assert.equal(painted[0].scene, props.extra.scene.value);
    assert.equal(tree.root.findByType('Canvas').props.pointerEvents, 'none');
  } finally {
    await unmount(tree);
  }
});

test('the biggest face is fitted into the hole', async () => {
  const { MainCharacterOverlay, painted } = loadOverlay();
  const { props } = lookProps();
  props.faces.value = [face(100, 300, 30), face(200, 420, 70)];
  const { tree } = await show(MainCharacterOverlay, props);
  try {
    assert.equal(painted[0].face, props.faces.value[1]);
    assert.ok(painted[0].fit);
    assert.deepEqual(painted[0].fit, fit.faceFit(props.faces.value[1].pts, props.extra.scene.value.art));
    // No face: no fit (the hole is filled with skin colour).
    props.faces.value = [];
    await act(async () => { tree.update(React.createElement(MainCharacterOverlay, { ...props })); });
    assert.equal(painted.at(-1).face, null);
    assert.equal(painted.at(-1).fit, null);
  } finally {
    await unmount(tree);
  }
});

test('the very first drawing (JS thread) never uses the camera picture; later ones do, placed like the camera view', async () => {
  const { MainCharacterOverlay, painted, placed, screen } = loadOverlay({ worklet: false });
  const { props } = lookProps();
  const { tree, draw } = await show(MainCharacterOverlay, props);
  try {
    assert.equal(painted[0].src, null, 'the JS thread never holds a camera picture');
    assert.equal(placed.length, 0);
    // From now on on the drawing thread.
    screen.getBinding('globalThis')._WORKLET = true;
    await draw();
    const src = painted.at(-1).src;
    assert.equal(src.image, props.shot.value.image);
    assert.deepEqual(src.toView, ['placed', 390, 844]);
    assert.equal(src.mipmaps, false);
    assert.equal(placed.at(-1).placement, 'rule');
    assert.equal(placed.at(-1).frame, props.shot.value);
    // No fresh camera picture: the lite drawing.
    props.shot.value = null;
    await draw();
    assert.equal(painted.at(-1).src, null);
  } finally {
    await unmount(tree);
  }
});

test('the camera picture is only used while FrameFeed\'s pictures are in use and not switched off (testing LITE pill)', async () => {
  const { MainCharacterOverlay, painted } = loadOverlay();
  const { props } = lookProps({ framesOn: false });
  const { tree, draw } = await show(MainCharacterOverlay, props);
  try {
    assert.equal(painted.at(-1).src, null);
    await draw({ framesOn: true });
    assert.ok(painted.at(-1).src);
    props.extra.cameraPictures.value = false;
    await draw();
    assert.equal(painted.at(-1).src, null);
  } finally {
    await unmount(tree);
  }
});

test('each drawing is let go of two drawings later (the last two when it closes), and `drawn` goes up by one each time', async () => {
  const { MainCharacterOverlay, pictures } = loadOverlay();
  const { props } = lookProps();
  const { tree, draw } = await show(MainCharacterOverlay, props);
  assert.equal(props.extra.drawn.value, 1);
  await draw();
  assert.equal(props.extra.drawn.value, 2);
  assert.ok(pictures.every((p) => !p.disposed), 'none let go of yet');
  await draw();
  assert.equal(props.extra.drawn.value, 3);
  assert.deepEqual(pictures.map((p) => p.disposed), [true, false, false]);
  await draw();
  assert.deepEqual(pictures.map((p) => p.disposed), [true, true, false, false]);
  await unmount(tree);
  // Closed: the last two are let go of too, each once.
  assert.ok(pictures.every((p) => p.disposed));
  assert.ok(pictures.every((p) => p.frees === 1));
});

test('everything made for a drawing is let go of right after it, also when the drawing fails halfway', async () => {
  let fail = false;
  const made = [];
  const { MainCharacterOverlay } = loadOverlay({
    paint: (trash) => {
      const thing = { disposed: false, dispose() { this.disposed = true; } };
      made.push(thing);
      trash.push(thing);
      if (fail) throw new Error('broken drawing');
    },
  });
  const { props } = lookProps();
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const { tree, draw } = await show(MainCharacterOverlay, props);
    fail = true;
    await draw();
    assert.equal(made.length, 2);
    assert.ok(made.every((thing) => thing.disposed));
    await unmount(tree);
  } finally {
    console.warn = originalWarn;
  }
});

test('a drawing with the camera picture that fails pauses it for 1.5 s (lite drawing meanwhile); after 5 failures it stays lite', async () => {
  const { MainCharacterOverlay, painted, clock } = loadOverlay({ paint: (trash, src) => { if (src) throw new Error('camera picture broke'); } });
  const { props } = lookProps();
  const warned = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warned.push(args.map(String).join(' '));
  try {
    const { tree, draw } = await show(MainCharacterOverlay, props);
    assert.ok(painted.at(-1).src, 'tried with the camera picture');
    assert.equal(warned.length, 1);
    // Paused: the lite drawing (no camera picture), no new warning.
    await draw();
    assert.equal(painted.at(-1).src, null);
    clock.now += 1_000;
    await draw();
    assert.equal(painted.at(-1).src, null);
    // After the pause it tries again.
    for (let fails = 2; fails <= 5; fails++) {
      clock.now += 1_600;
      await draw();
      assert.ok(painted.at(-1).src, `try ${fails}`);
    }
    assert.equal(warned.length, 2, 'said again when it gave up');
    clock.now += 60_000;
    await draw();
    await draw();
    assert.equal(painted.at(-1).src, null, 'stays lite until the screen closes');
    await unmount(tree);
  } finally {
    console.warn = originalWarn;
  }
});

test('when even the lite drawing keeps failing it stops drawing instead of closing the app', async () => {
  const { MainCharacterOverlay, painted } = loadOverlay({ paint: () => { throw new Error('broken'); } });
  const { props } = lookProps({ framesOn: false });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const { tree, draw } = await show(MainCharacterOverlay, props);
    for (let i = 0; i < 8; i++) await draw();
    assert.equal(painted.length, 5);
    await unmount(tree);
  } finally {
    console.warn = originalWarn;
  }
});

test('the screen\'s ask for the poster is answered from the drawing thread with exactly what is shown (null on the lite way)', async () => {
  const { MainCharacterOverlay, snaps } = loadOverlay();
  const { props, snapped } = lookProps();
  const { tree, draw } = await show(MainCharacterOverlay, props);
  try {
    // Being shown is not an ask.
    assert.deepEqual(snapped, []);
    props.extra.snapAsk.value = 1;
    await draw();
    assert.equal(snaps.length, 1);
    const [sceneNow, facesNow, shotNow, viewNow, axesNow, fx] = snaps[0];
    assert.equal(sceneNow, props.extra.scene.value);
    assert.equal(facesNow, props.faces.value);
    assert.equal(shotNow, props.shot.value);
    assert.equal(viewNow, props.viewSize.value);
    assert.equal(axesNow, props.axes.value);
    assert.equal(fx, props.extra.fx);
    assert.deepEqual(snapped, [{ ask: 1, poster: { name: 'poster' } }]);
    // Drawn again with the same ask: no second poster.
    await draw();
    assert.equal(snaps.length, 1);
    // The lite way (no camera pictures in use): null straight away, so the screen uses the photo.
    props.extra.snapAsk.value = 2;
    await draw({ framesOn: false });
    assert.equal(snaps.length, 1);
    assert.deepEqual(snapped.at(-1), { ask: 2, poster: null });
  } finally {
    await unmount(tree);
  }
});

test('a poster that fails to be made off screen answers null (the photo way), and a newly shown overlay never answers an old ask', async () => {
  const { MainCharacterOverlay } = loadOverlay({ snap: () => { throw new Error('no surface'); } });
  const { props, snapped } = lookProps();
  props.extra.snapAsk.value = 4;
  const { tree, draw } = await show(MainCharacterOverlay, props);
  try {
    assert.deepEqual(snapped, [], 'ask 4 came before this was shown');
    props.extra.snapAsk.value = 5;
    await draw();
    assert.deepEqual(snapped, [{ ask: 5, poster: null }]);
  } finally {
    await unmount(tree);
  }
});

// ---------------------------------------------------------------------------
// CameraFollow (the lite way).
// ---------------------------------------------------------------------------

function loadFollow({ move = 'follow' } = {}) {
  const cfg = { ...config, LITE_CAMERA_MOVE: move };
  const screen = loadScreen('src/components/mainCharacter/CameraFollow.tsx', {
    'react-native-reanimated': reanimated({ __esModule: true, default: { View: host('AnimatedView') }, useAnimatedStyle: (updater) => updater() }),
    '@/lib/mainCharacter/config': cfg,
    './fit': fitFor(cfg),
  });
  return screen.exports.CameraFollow;
}

async function follow(CameraFollow, props) {
  let tree;
  const element = () => React.createElement(CameraFollow, props, React.createElement('Camera'));
  await act(async () => { tree = renderer.create(element()); });
  const transform = () => tree.root.findByType('AnimatedView').props.style[1].transform;
  // (Copied into plain values: the file's own arrays come from its separate sandbox.)
  const plain = () => JSON.parse(JSON.stringify(transform()));
  return { tree, transform, plain, again: () => act(async () => { tree.update(element()); }) };
}

const allFinite = (list) => list.every((step) => Object.values(step).every((v) => (typeof v === 'string' ? Number.isFinite(parseFloat(v)) : Number.isFinite(v))));

test('CameraFollow: no transform before the first good fit, then exactly the lite transform for your face', async () => {
  const CameraFollow = loadFollow();
  const { props } = lookProps();
  props.faces.value = [];
  const { tree, transform, plain, again } = await follow(CameraFollow, props);
  try {
    // The camera view only, inside the moving view.
    assert.equal(tree.root.findByType('AnimatedView').findAllByType('Camera').length, 1);
    assert.deepEqual(plain(), []);
    props.faces.value = [face(190, 410, 64)];
    await again();
    const expected = fit.liteTransform(fit.faceFit(props.faces.value[0].pts, props.extra.scene.value.art), 390, 844);
    assert.ok(expected);
    assert.deepEqual(plain(), JSON.parse(JSON.stringify(expected)));
    assert.equal(transform().length, 6);
    assert.ok(allFinite(transform()));
  } finally {
    await unmount(tree);
  }
});

test('CameraFollow: broken face points, no face, no view size or no poster keep the last good transform (never a broken number)', async () => {
  const CameraFollow = loadFollow();
  const { props } = lookProps();
  props.faces.value = [face(190, 410, 64)];
  const { tree, transform, again } = await follow(CameraFollow, props);
  try {
    const good = transform();
    assert.equal(good.length, 6);
    const broken = [
      () => { props.faces.value = [{ ...face(190, 410, 64), pts: facePoints(NaN, 410, 64) }]; },
      () => { props.faces.value = [{ ...face(190, 410, 64), pts: facePoints(Infinity, 410, 64) }]; },
      () => { props.faces.value = [{ ...face(190, 410, 64), pts: facePoints(190, -Infinity, 64) }]; },
      () => { props.faces.value = [face(190, 410, 0)]; },
      () => { props.faces.value = []; },
      () => { props.faces.value = [face(190, 410, 64)]; props.viewSize.value = { width: 0, height: 0 }; },
      () => { props.viewSize.value = { width: NaN, height: 844 }; },
      () => { props.viewSize.value = { width: -390, height: 844 }; },
      () => { props.viewSize.value = { width: 390, height: 844 }; props.extra.scene.value = null; },
    ];
    for (const breakIt of broken) {
      breakIt();
      await again();
      assert.equal(transform(), good, 'the very same last good transform');
      assert.ok(allFinite(transform()));
    }
  } finally {
    await unmount(tree);
  }
});

test('CameraFollow with LITE_CAMERA_MOVE off never moves the camera view (a fixed hole)', async () => {
  const CameraFollow = loadFollow({ move: 'off' });
  const { props } = lookProps();
  const { tree, plain, again } = await follow(CameraFollow, props);
  try {
    assert.deepEqual(plain(), []);
    props.faces.value = [face(150, 380, 80)];
    await again();
    assert.deepEqual(plain(), []);
  } finally {
    await unmount(tree);
  }
});
