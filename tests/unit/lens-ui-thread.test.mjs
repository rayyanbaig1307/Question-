import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { beforeAll, expect, it } from 'vitest';

// The face filters run on the camera's drawing thread (the "UI thread") on the phone. There, every 'worklet'
// function is rebuilt from a copy of its code with the outside things it uses packed alongside – and a
// function that is NOT a worklet can't be called at all: the call throws, and the filter stops drawing.
// worklet-order.test.mjs checks the order of the copies; this test runs the real drawing the way the phone's
// drawing thread does in a release build (babel-preset-expo, Hermes, not dev), with a do-nothing Skia that
// only counts calls, for every look, with 0, 1 and 2 faces, at several moments. The same faces drawn the normal
// way (as on the photo, bakeLook.ts) must give exactly the same calls.
// The 4 stretchy filters (warp/paintWarp.ts) are drawn with a pretend camera picture and GPU programs, and the
// camera-picture placing (warp/frameMatrix.ts, used by LensOverlay and FrameFeed on the drawing thread) must
// give the same numbers there too.

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const root = resolve(import.meta.dirname, '../..');

function transform(file) {
  return babel.transformSync(readFileSync(file, 'utf8'), {
    presets: ['babel-preset-expo'],
    filename: file,
    cwd: root,
    babelrc: false,
    configFile: false,
    caller: { name: 'metro', platform: 'ios', bundler: 'metro', isDev: false, supportsReactCompiler: true, engine: 'hermes' },
  }).code;
}

// A stand-in for Skia's native objects: every property and call gives another stand-in, and each call is noted.
const HOST = Symbol('host');
const calls = [];
function hostProxy(name) {
  const fn = function () { calls.push(name); return hostProxy(`${name}()`); };
  return new Proxy(fn, {
    get(target, key) {
      if (key === HOST) return true;
      if (key === 'then') return undefined;
      if (key === Symbol.toPrimitive) return () => 0;
      return hostProxy(`${name}.${String(key)}`);
    },
  });
}
const skiaModule = {
  Skia: hostProxy('Skia'),
  BlurStyle: { Normal: 0, Solid: 1, Outer: 2, Inner: 3 }, ClipOp: { Difference: 0, Intersect: 1 }, FillType: { Winding: 0, EvenOdd: 1 },
  PaintStyle: { Fill: 0, Stroke: 1 }, TileMode: { Clamp: 0, Repeat: 1, Mirror: 2, Decal: 3 }, StrokeCap: { Butt: 0, Round: 1, Square: 2 },
  StrokeJoin: { Miter: 0, Round: 1, Bevel: 2 },
};

// Loads a file the way the app's bundle does, following its imports of files next to it.
const loaded = new Map();
function load(file) {
  if (loaded.has(file)) return loaded.get(file).exports;
  const module = { exports: {} };
  loaded.set(file, module);
  const req = (id) => {
    if (id === '@shopify/react-native-skia') return skiaModule;
    if (id === '@/lib/faceMesh') return load(join(root, 'src/lib/faceMesh.ts'));
    if (id === '@/lib/goldenLight') return load(join(root, 'src/lib/goldenLight.ts'));
    if (id === 'react') return { useEffect() {}, useMemo: (f) => f(), useRef: (v) => ({ current: v }) };
    if (id === 'react-native') return { TurboModuleRegistry: { get: () => null } };
    if (id.startsWith('.')) return load(`${join(dirname(file), id)}.ts`);
    throw new Error(`unexpected import ${id}`);
  };
  new Function('exports', 'require', 'module', transform(file))(module.exports, req, module);
  return module.exports;
}

// "Moves" a value to the drawing thread, like the phone does: a worklet is rebuilt from its code string with its
// packed outside things; anything else that is a function can't be called there.
const cache = new Map();
function toUI(value) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  if (value[HOST]) return value;
  if (cache.has(value)) return cache.get(value);
  if (typeof value === 'function') {
    if (value.__workletHash === undefined) {
      const remote = () => { throw new Error(`non-worklet function called on the drawing thread: ${value.name}`); };
      cache.set(value, remote);
      return remote;
    }
    const holder = { __closure: null, __workletHash: value.__workletHash };
    const fn = (0, eval)(value.__initData.code).bind(holder);
    cache.set(value, fn);
    holder.__closure = Array.isArray(value.__closure) ? value.__closure.map(toUI) : toUI(value.__closure ?? {});
    return fn;
  }
  const copy = Array.isArray(value) ? [] : {};
  cache.set(value, copy);
  for (const key of Object.keys(value)) copy[key] = toUI(value[key]);
  return copy;
}

let paintJS;
let paintUI;
let looks;
let warpLooks;
let face;
let frameMatrix;

beforeAll(() => {
  const lens = load(join(root, 'src/components/lens/lensPaint.ts'));
  looks = load(join(root, 'src/lib/lensLooks.ts')).LENS_LOOKS.map((look) => look.key);
  warpLooks = load(join(root, 'src/lib/lensLooks.ts')).LENS_LOOKS.filter((look) => look.needsFrames).map((look) => look.key);
  frameMatrix = load(join(root, 'src/components/lens/warp/frameMatrix.ts'));
  paintJS = lens.paintLook;
  paintUI = toUI(paintJS);
  const { MESH } = load(join(root, 'src/lib/faceMesh.ts'));
  // A face about 300 wide in the middle of a 390 × 844 view, with its main points where a face has them.
  const pts = [];
  for (let i = 0; i < 478; i++) { const a = (i / 478) * Math.PI * 2; pts.push(195 + Math.cos(a) * 120, 422 + Math.sin(a) * 160); }
  const set = (i, x, y) => { pts[i * 2] = x; pts[i * 2 + 1] = y; };
  for (const [key, x, y] of [
    ['rightFaceSide', 45, 422], ['leftFaceSide', 345, 422], ['forehead', 195, 222], ['chin', 195, 622], ['noseTip', 195, 440], ['noseBottom', 195, 470],
    ['rightEyeOuter', 105, 380], ['rightEyeInner', 165, 380], ['rightEyeBottom', 135, 392], ['rightIris', 137, 380],
    ['leftEyeOuter', 285, 380], ['leftEyeInner', 225, 380], ['leftEyeBottom', 255, 392], ['leftIris', 253, 380],
    ['upperLipInner', 195, 520], ['lowerLipInner', 195, 532], ['mouthRightCorner', 150, 525], ['mouthLeftCorner', 240, 525],
    ['rightBlush', 110, 470], ['leftBlush', 280, 470],
  ]) set(MESH[key], x, y);
  // The bottom of the lower lip (the stretchy chin starts under it).
  set(17, 195, 545);
  face = {
    pts, blinkLeft: 0, blinkRight: 0, smile: 0.3, light: [], rim: 0,
    browUp: 0.4, squint: 0.5, jawOpen: 0.6, pucker: 0.7, seed: 3, pop: 1.47, popSpeed: 0.2, wobbleX: 0.05, wobbleY: -0.03,
    wobbleSpeedX: 0, wobbleSpeedY: 0, motion: 0.05, still: 1, progress: 0.62, flash: 0.5, charge: 1,
    mouth: 1.9, mouthSpeed: 0.1, tiny: 0.8, chin: 1, glitch: 1, warpLevel: 0.9,
  };
}, 60_000);

// The stretchy filters' camera picture and GPU programs, as the drawing thread has them (native objects).
const warpSource = () => ({
  image: hostProxy('camera'),
  fx: { balloon: hostProxy('fx.balloon'), shrink: hostProxy('fx.shrink'), stretch: hostProxy('fx.stretch'), pixel: hostProxy('fx.pixel') },
  trash: [],
});

function drawCalls(paint, look, faces, time) {
  calls.length = 0;
  paint(hostProxy('canvas'), look, faces, 390, 844, time, undefined, warpLooks.includes(look) ? warpSource() : undefined);
  return calls.filter((c) => c.startsWith('canvas.')).length;
}

it('every face filter draws on the drawing thread exactly as it does for the photo', () => {
  expect(looks.length).toBeGreaterThanOrEqual(7);
  const second = { ...face, seed: 4, progress: 1, flash: 0, pts: face.pts.map((v, i) => (i % 2 === 0 ? v * 0.5 + 200 : v * 0.5 + 100)) };
  for (const look of looks) {
    for (const faces of [[], [face], [face, second]]) {
      for (const t of [0, 0.37, 1.9, 7.5, 33.3]) {
        let ui;
        let js;
        expect(() => { js = drawCalls(paintJS, look, faces, t); }, `${look} on the photo, ${faces.length} faces, t=${t}`).not.toThrow();
        expect(() => { ui = drawCalls(paintUI, look, faces, t); }, `${look} live, ${faces.length} faces, t=${t}`).not.toThrow();
        expect(ui).toBe(js);
        if (faces.length > 0) expect(ui).toBeGreaterThan(0);
      }
    }
  }
});

it('the stretchy filters are among the looks checked above, and use their GPU programs on the drawing thread', () => {
  expect(warpLooks).toEqual(['tinyFace', 'gigachin', 'bigMouth', 'pixelPanic']);
  for (const look of warpLooks) {
    calls.length = 0;
    const src = warpSource();
    paintUI(hostProxy('canvas'), look, [face], 390, 844, 1.3, undefined, src);
    expect(calls.some((c) => c.startsWith('fx.') && c.endsWith('makeShaderWithChildren')), look).toBe(true);
    // What it made from the camera picture is on the frame's trash list there too (LensOverlay lets go of it).
    expect(src.trash.length, look).toBeGreaterThanOrEqual(2);
    // Without a camera picture: nothing at all.
    calls.length = 0;
    paintUI(hostProxy('canvas'), look, [face], 390, 844, 1.3, undefined, null);
    expect(calls.filter((c) => c.startsWith('canvas.') || c.startsWith('fx.'))).toEqual([]);
  }
});

it('placing the camera picture gives the same numbers on the drawing thread', () => {
  const ui = toUI(frameMatrix);
  for (const turn of [0, 90, 180, 270]) {
    for (const mirror of [false, true]) {
      expect(ui.frameToView(1920, 1440, turn, mirror, 390, 844)).toEqual(frameMatrix.frameToView(1920, 1440, turn, mirror, 390, 844));
    }
  }
  expect(ui.screenTurn('right', 'left')).toBe(frameMatrix.screenTurn('right', 'left'));
  expect(ui.connectionTurn('right', 'up')).toBe(90);
  expect(ui.photoToView(3024, 4032, 0.6, 390, 844)).toEqual(frameMatrix.photoToView(3024, 4032, 0.6, 390, 844));
  expect(ui.toMatrix9([1, 2, 3, 4, 5, 6])).toEqual([1, 2, 3, 4, 5, 6, 0, 0, 1]);
  // The iPhone rule, the converter's second opinion, the placing and the comparing (LensOverlay and FrameFeed run
  // these on the drawing thread).
  for (const [label, front] of [[90, true], [270, false], [270, true], [0, false]]) {
    expect(ui.iosShotTurn(label, front, 1920, 1440)).toBe(frameMatrix.iosShotTurn(label, front, 1920, 1440));
  }
  expect(ui.iosShotTurn(90, true, 1920, 1440)).toBe(270);
  expect(ui.turnFromAxes(0, 0.44, 0.44, 0)).toEqual({ turn: 270, mirror: true });
  expect(ui.turnFromAxes(1, 0.5, 0, 1)).toBeNull();
  const axes = { ox: -121.5, oy: 0, ax: 0, ay: 844, bx: 633, by: 0, front: true };
  for (const shot of [{ w: 1920, h: 1440, turn: 270, mirror: true, front: true }, { w: 1920, h: 1440, turn: -1, mirror: false, front: true }]) {
    for (const placement of ['rule', 'converter']) {
      for (const given of [axes, null]) {
        expect(ui.placeShot(shot, 390, 844, given, placement)).toEqual(frameMatrix.placeShot(shot, 390, 844, given, placement));
      }
    }
  }
  const m = frameMatrix.frameToView(1920, 1440, 270, true, 390, 844);
  const mc = frameMatrix.axesMatrix(axes, 1920, 1440);
  expect(ui.axesMatrix(axes, 1920, 1440)).toEqual(mc);
  expect(ui.compareMatrices(m, mc, 1920, 1440)).toBe('same');
  expect(ui.compareMatrices(frameMatrix.frameToView(1920, 1440, 90, true, 390, 844), mc, 1920, 1440)).toBe('differ');
});

it('FrameFeed\'s small sums give the same answers on the drawing thread', () => {
  const feed = load(join(root, 'src/components/lens/warp/feedLogic.ts'));
  const ui = toUI(feed);
  let votes = ui.newTurnVotes();
  for (const angle of [90, 90, 270, 90]) votes = ui.voteTurn(votes, angle);
  expect(votes.latched).toBe(90);
  let rate = ui.newFrameRate();
  for (let i = 0; i < 100; i++) rate = ui.nextFrameRate(rate, 1000 + i * (1000 / 30));
  expect(ui.framesPerSecondX10(rate)).toBe(300);
  expect(ui.isStale(2001, 1000, 1000)).toBe(true);
  expect(ui.errorVerdict(12, 10, 10, 0.5)).toBe(true);
  for (const [now, last, soon] of [[500, 0, false], [10_999, 1000, false], [11_000, 1000, false], [2999, 1000, true], [3000, 1000, true]]) {
    expect(ui.probeDue(now, last, soon)).toBe(feed.probeDue(now, last, soon));
  }
  expect(ui.probeDue(3000, 1000, true)).toBe(true);
});

it('an unknown look stops with a clear error on the drawing thread too (not a quiet stand-in)', () => {
  expect(() => paintUI(hostProxy('canvas'), 'nope', [face], 390, 844, 1)).toThrow(/Unknown face filter/);
});
