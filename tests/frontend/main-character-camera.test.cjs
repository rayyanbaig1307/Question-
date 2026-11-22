const test = require('node:test');
const assert = require('node:assert/strict');
const { React, renderer, act, loadScreen, loadPure, host, unmount } = require('./harness.cjs');

// Main Character Mode 🌆, the live camera and the saved poster (src/components/mainCharacter/MainCharacterCamera.tsx).
// Checked here, with stand-ins for SoftGlowCamera, the art cache and the bakes:
// - the poster shows only when the character and its scene are read (no empty sky), unless the scene can't be read;
//   a swipe keeps the old poster on screen until the new one is ready;
// - SoftGlowCamera gets one look, made once: the module-level overlay and wrapper, camera pictures wanted, the wait
//   time, zoom 0 (a plain number) and no flash;
// - the scene is copied at the press: swiping while the poster is made doesn't change the character in it;
// - the poster from the screen is used when the drawing thread answers; the photo way when it answers null or
//   doesn't answer in time (a late answer is let go of); the pictures are held until it is done, also on errors;
// - no face seen in the last second → 'no-face'; the face-seen callback hears only changes.

const config = loadPure('src/lib/mainCharacter/config.ts');
const fit = loadScreen('src/components/mainCharacter/fit.ts', { '@/lib/mainCharacter/config': config }).exports;

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
const character = (slug, scene) => ({ key: `app:${slug}`, slug, name: slug, from: 'app', file: 1, anchors: anchors(), scene });
const sceneArt = (slug) => ({ key: `app:${slug}`, slug, name: slug, from: 'app', file: 2 });
const picture = (name) => ({ name, disposed: false, dispose() { this.disposed = true; }, width: () => 1080, height: () => 1920 });

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
const face = { pts: facePoints(195, 400, 60), blinkLeft: 0, blinkRight: 0, smile: 0, light: [], lightAt: 0 };

// `bakeFails`: the photo bake throws.
function loadCamera({ bakeFails = false } = {}) {
  // The art cache stand-in: `ready` (key → picture) and `failed` keys; what was held, released and shown.
  const art = { ready: new Map(), failed: new Set(), holds: [], released: [], shown: [] };
  const camera = { props: null, captures: [] };
  const bakes = [];
  const encoded = [];
  const fx = { name: 'comic' };
  function SoftGlowCamera(props) {
    camera.props = props;
    React.useImperativeHandle(props.ref, () => ({
      async capture(press) {
        camera.captures.push({ press, active: camera.props.active });
        return { uri: await props.custom.bake('file:///photo.jpg', [face], { width: 390, height: 844 }, press) };
      },
    }), [props.custom]);
    return React.createElement('SoftGlowCamera', props);
  }
  const screen = loadScreen('src/components/mainCharacter/MainCharacterCamera.tsx', {
    'react-native-reanimated': { useSharedValue: (initial) => React.useRef({ value: initial, get() { return this.value; }, set(v) { this.value = v; } }).current },
    '@/lib/mainCharacter/config': config,
    '../lens/SoftGlowCamera': { SoftGlowCamera },
    './artCache': {
      useArtImages: (want) => {
        const images = new Map();
        const failed = new Set();
        let loading = false;
        for (const item of want) {
          if (art.ready.has(item.key)) images.set(item.key, art.ready.get(item.key));
          else if (art.failed.has(item.key)) failed.add(item.key);
          else loading = true;
        }
        art.lastWant = Array.from(want, (item) => item.key);
        return { images, loading, failed };
      },
      holdScene: (scene) => { art.holds.push(scene); return () => art.released.push(scene); },
      noteShown: (scene) => art.shown.push(scene),
      useDrawingClock: () => {},
    },
    './bakeMainCharacter': {
      bakeMainCharacter: async (uri, faces, view, scene, effect) => {
        bakes.push({ uri, faces, view, scene, fx: effect });
        if (bakeFails) throw new Error('Could not read the photo');
        return 'file:///baked.jpg';
      },
      encodePoster: async (image) => { encoded.push(image); return 'file:///snap.jpg'; },
    },
    './CameraFollow': { CameraFollow: host('CameraFollow') },
    './MainCharacterOverlay': { MainCharacterOverlay: host('MainCharacterOverlay') },
    './comicEffect': { comicEffect: () => fx },
    './fit': fit,
  });
  const clock = { now: 5_000_000 };
  screen.getBinding('Date').now = () => clock.now;
  return { MainCharacterCamera: screen.exports.MainCharacterCamera, art, camera, bakes, encoded, fx, clock, calls: screen.calls };
}

async function renderCamera(MainCharacterCamera, props) {
  let tree;
  const ref = React.createRef();
  const told = { seen: [], loading: [] };
  let current = {
    ref, active: true, facing: 'front', character: null, scene: null, nearby: [], forceLite: false,
    onFaceSeen: (seen) => told.seen.push(seen), onLoading: (loading) => told.loading.push(loading), ...props,
  };
  await act(async () => { tree = renderer.create(React.createElement(MainCharacterCamera, current)); });
  return {
    tree, ref, told,
    update: (more = {}) => act(async () => { current = { ...current, ...more }; tree.update(React.createElement(MainCharacterCamera, current)); }),
  };
}

// Everything ready for Street Boss on the neon street, with a face in view.
async function readyCamera(options = {}, props = {}) {
  const loaded = loadCamera(options);
  const { art, camera } = loaded;
  const boss = character('street-boss', 'neon-street');
  const neon = sceneArt('neon-street');
  art.ready.set(boss.key, picture('boss'));
  art.ready.set(neon.key, picture('neon'));
  const shown = await renderCamera(loaded.MainCharacterCamera, { character: boss, scene: neon, ...props });
  await act(async () => { camera.props.custom.onFaces([face]); });
  return { ...loaded, ...shown, boss, neon, extra: () => camera.props.custom.extra };
}

test('the poster shows only once the character and its scene are read; a swipe keeps the old poster until the new one is ready', async () => {
  const { MainCharacterCamera, art, camera } = loadCamera();
  const boss = character('street-boss', 'neon-street');
  const neon = sceneArt('neon-street');
  const driver = character('getaway-driver', 'coast-highway');
  const coast = sceneArt('coast-highway');
  const { tree, update, told } = await renderCamera(MainCharacterCamera, { character: boss, scene: neon, nearby: [driver] });
  const live = () => camera.props.custom.extra.scene.value;
  try {
    // The character and its scene are read first, then the neighbours.
    assert.deepEqual(art.lastWant, ['app:street-boss', 'app:neon-street', 'app:getaway-driver']);
    assert.equal(live(), null);
    assert.deepEqual(told.loading, [true]);
    art.ready.set(boss.key, picture('boss'));
    await update();
    assert.equal(live(), null, 'not without its scene (no empty sky)');
    art.ready.set(neon.key, picture('neon'));
    await update();
    assert.equal(live().key, 'app:street-boss|app:neon-street');
    assert.equal(live().character, art.ready.get(boss.key));
    assert.equal(live().background, art.ready.get(neon.key));
    assert.deepEqual({ ...live().characterCrop }, { x: 0, y: 0, w: 1080, h: 1920 });
    assert.deepEqual(JSON.parse(JSON.stringify(live().art)), JSON.parse(JSON.stringify(fit.placeArt(boss.anchors))));
    assert.equal(art.shown.at(-1), live());
    assert.equal(told.loading.at(-1), false);
    // Swiped to the next character: its scene isn't read yet, so the old poster stays.
    art.ready.set(driver.key, picture('driver'));
    await update({ character: driver, scene: coast, nearby: [boss] });
    assert.equal(live().key, 'app:street-boss|app:neon-street');
    // Its scene can't be read: shown without one rather than not at all.
    art.failed.add(coast.key);
    await update();
    assert.equal(live().key, 'app:getaway-driver|no-scene');
    assert.equal(live().background, null);
  } finally {
    await unmount(tree);
  }
});

test('a character and a scene with the same file name (their keys differ, lib/mainCharacter/library.ts): both are read, the scene is the scene', async () => {
  const { MainCharacterCamera, art, camera } = loadCamera();
  // Keys as the library makes them: 'online:<name>' for a character, 'online-scene:<name>' for a scene.
  const beachCharacter = { key: 'online:beach', slug: 'beach', name: 'Beach', from: 'online', file: 'file:///c/beach.webp', anchors: anchors(), scene: null };
  const beachScene = { key: 'online-scene:beach', slug: 'beach', name: 'Beach', from: 'online', file: 'file:///b/beach.webp' };
  const { tree } = await renderCamera(MainCharacterCamera, { character: beachCharacter, scene: beachScene });
  try {
    assert.deepEqual(art.lastWant, ['online:beach', 'online-scene:beach']);
    art.ready.set(beachCharacter.key, picture('beach character'));
    art.ready.set(beachScene.key, picture('beach scene'));
    await act(async () => { tree.update(React.createElement(MainCharacterCamera, { ...tree.root.findByType(MainCharacterCamera).props })); });
    const live = camera.props.custom.extra.scene.value;
    assert.equal(live.character.name, 'beach character');
    assert.equal(live.background.name, 'beach scene', 'never the character\'s own picture behind it');
  } finally {
    await unmount(tree);
  }
});

test('SoftGlowCamera gets one look, made once: the overlay and wrapper, camera pictures wanted, the wait time, zoom 0, no flash', async () => {
  const { camera, update, tree, fx } = await readyCamera();
  try {
    const look = camera.props.custom;
    assert.equal(look.Overlay.name, 'Host');
    assert.equal(camera.props.zoom, 0);
    assert.equal(camera.props.flash, 'off');
    assert.equal(camera.props.facing, 'front');
    assert.equal(camera.props.active, true);
    assert.equal(look.wantsFrames, config.LIVE_FACE_FROM_CAMERA);
    assert.equal(look.frameWaitMs, config.FRAME_WAIT_MS);
    assert.equal(look.extra.fx, fx);
    assert.equal(tree.root.findByType('SoftGlowCamera').props.custom, look);
    // Other props change: the very same look and values (the camera and its overlay are never rebuilt).
    await update({ facing: 'back', active: false, nearby: [character('beach-hustler', 'beach-drive')] });
    assert.equal(camera.props.custom, look);
    assert.equal(camera.props.custom.extra, look.extra);
    assert.equal(camera.props.facing, 'back');
    assert.equal(camera.props.active, false);
  } finally {
    await unmount(tree);
  }
});

test('no face seen in the last second: \'no-face\', and nothing is held', async () => {
  const { ref, clock, art, tree } = await readyCamera();
  try {
    clock.now += 1_500;
    await assert.rejects(() => ref.current.capture(), (error) => error.message === config.NO_FACE && config.NO_FACE === 'no-face');
    assert.equal(art.holds.length, 0);
  } finally {
    await unmount(tree);
  }
});

test('the poster from the screen: used when the drawing thread answers; the picture is let go of and the hold released', async () => {
  const { ref, extra, art, camera, encoded, bakes, tree, clock } = await readyCamera();
  try {
    clock.now += 400;
    const pressed = extra().scene.value;
    const making = ref.current.capture();
    assert.equal(extra().snapAsk.value, 1, 'asked the drawing thread');
    assert.deepEqual(art.holds, [pressed]);
    const image = picture('poster');
    extra().onSnap(1, image);
    const result = await making;
    assert.deepEqual({ ...result }, { uri: 'file:///snap.jpg' });
    assert.deepEqual(encoded, [image]);
    assert.equal(image.disposed, true);
    assert.equal(camera.captures.length, 0, 'no photo needed');
    assert.equal(bakes.length, 0);
    assert.deepEqual(art.released, [pressed]);
  } finally {
    await unmount(tree);
  }
});

test('the scene is copied at the press: swiping while the poster is made doesn\'t change it (photo way after a null answer)', async () => {
  const { ref, extra, art, camera, bakes, update, tree, fx } = await readyCamera();
  try {
    const pressed = extra().scene.value;
    const making = ref.current.capture();
    // Swiped to another character before the drawing thread answered.
    const driver = character('getaway-driver', 'coast-highway');
    art.ready.set(driver.key, picture('driver'));
    art.ready.set('app:coast-highway', picture('coast'));
    await update({ character: driver, scene: sceneArt('coast-highway') });
    assert.equal(extra().scene.value.key, 'app:getaway-driver|app:coast-highway');
    // The drawing thread can't (lite way): the photo way, with the poster as it was at the press.
    extra().onSnap(1, null);
    const result = await making;
    assert.deepEqual({ ...result }, { uri: 'file:///baked.jpg' });
    assert.equal(camera.captures.length, 1);
    assert.equal(camera.captures[0].active, true, 'the camera kept running');
    assert.equal(camera.captures[0].press.scene, pressed);
    assert.equal(bakes.length, 1);
    assert.equal(bakes[0].scene, pressed);
    assert.equal(bakes[0].scene.key, 'app:street-boss|app:neon-street');
    assert.equal(bakes[0].fx, fx);
    assert.equal(bakes[0].uri, 'file:///photo.jpg');
    assert.deepEqual(art.released, [pressed]);
  } finally {
    await unmount(tree);
  }
});

test('no answer from the drawing thread in time: the photo way; an answer that comes later is let go of', async () => {
  const { ref, extra, camera, calls, tree, art } = await readyCamera();
  try {
    const making = ref.current.capture();
    // The newest timer is the snapshot's time limit.
    const timeLimit = calls.timers.at(-1);
    timeLimit();
    const result = await making;
    assert.deepEqual({ ...result }, { uri: 'file:///baked.jpg' });
    assert.equal(camera.captures.length, 1);
    const late = picture('late poster');
    extra().onSnap(1, late);
    assert.equal(late.disposed, true);
    assert.equal(art.released.length, 1);
  } finally {
    await unmount(tree);
  }
});

test('FULL/LITE pill on LITE: the camera picture is switched off for the drawing and the photo way is used straight away', async () => {
  const { ref, extra, camera, update, tree } = await readyCamera({}, { forceLite: true });
  try {
    assert.equal(extra().cameraPictures.value, false);
    const result = await ref.current.capture();
    assert.deepEqual({ ...result }, { uri: 'file:///baked.jpg' });
    assert.equal(extra().snapAsk.value, 0, 'the drawing thread was not asked');
    assert.equal(camera.captures.length, 1);
    await update({ forceLite: false });
    assert.equal(extra().cameraPictures.value, true);
  } finally {
    await unmount(tree);
  }
});

test('a photo bake that fails: the error reaches the screen and the pictures are let go of', async () => {
  const { ref, extra, art, tree } = await readyCamera({ bakeFails: true });
  try {
    const making = ref.current.capture();
    extra().onSnap(1, null);
    await assert.rejects(making, /Could not read the photo/);
    assert.equal(art.holds.length, 1);
    assert.deepEqual(art.released, art.holds);
  } finally {
    await unmount(tree);
  }
});

test('the face-seen callback hears only changes, and "gone" a second after the last face', async () => {
  const { camera, told, calls, tree } = await readyCamera();
  try {
    assert.deepEqual(told.seen, [true]);
    await act(async () => { camera.props.custom.onFaces([face]); });
    await act(async () => { camera.props.custom.onFaces([]); });
    assert.deepEqual(told.seen, [true]);
    // The newest timer says "gone" (each face starts it again).
    await act(async () => { calls.timers.at(-1)(); });
    assert.deepEqual(told.seen, [true, false]);
    await act(async () => { camera.props.custom.onFaces([face]); });
    assert.deepEqual(told.seen, [true, false, true]);
  } finally {
    await unmount(tree);
  }
});
