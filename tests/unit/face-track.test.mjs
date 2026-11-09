import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';

// Following faces from frame to frame (src/components/lens/faceTrack.ts): it reads the expressions, smooths the
// face and steps the Peekaboo+ filters' memory – the googly eyes' bounce (👀), the brain loading (🧠) and the
// aura's charge (⚡). All of it is plain numbers on each face, so the saved photo gets the same as the screen.

function compile(path, mods, cache = new Map()) {
  if (cache.has(path)) return cache.get(path).exports;
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  cache.set(path, module);
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require: (id) => {
      if (id in mods) return mods[id];
      if (id.startsWith('.')) return compile(`${join(dirname(path), id)}.ts`, mods, cache);
      throw new Error(`missing ${id}`);
    },
  });
  return module.exports;
}

const faceMesh = compile('src/lib/faceMesh.ts', { react: {}, 'react-native': { TurboModuleRegistry: { get: () => null } } });
const { MESH, BLENDSHAPE } = faceMesh;
// faceTrack must not need Skia (or anything else): only the face mesh numbers and its own files.
const track = compile('src/components/lens/faceTrack.ts', { '@/lib/faceMesh': { MESH, BLENDSHAPE } });

// MediaPipe's 52 expression scores, in their standard order (the native part puts each score at this index).
const NAMES = [
  '_neutral', 'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'cheekPuff', 'cheekSquintLeft',
  'cheekSquintRight', 'eyeBlinkLeft', 'eyeBlinkRight', 'eyeLookDownLeft', 'eyeLookDownRight', 'eyeLookInLeft', 'eyeLookInRight',
  'eyeLookOutLeft', 'eyeLookOutRight', 'eyeLookUpLeft', 'eyeLookUpRight', 'eyeSquintLeft', 'eyeSquintRight', 'eyeWideLeft', 'eyeWideRight',
  'jawForward', 'jawLeft', 'jawOpen', 'jawRight', 'mouthClose', 'mouthDimpleLeft', 'mouthDimpleRight', 'mouthFrownLeft', 'mouthFrownRight',
  'mouthFunnel', 'mouthLeft', 'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthPressLeft', 'mouthPressRight', 'mouthPucker', 'mouthRight',
  'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper', 'mouthSmileLeft', 'mouthSmileRight', 'mouthStretchLeft',
  'mouthStretchRight', 'mouthUpperUpLeft', 'mouthUpperUpRight', 'noseSneerLeft', 'noseSneerRight',
];

// A face 200 wide with its nose at (x, y).
function rawFace(x = 200, y = 420, shapes = {}) {
  const pts = new Array(478 * 2).fill(0);
  for (let i = 0; i < 478; i++) {
    pts[i * 2] = x + Math.cos(i) * 80;
    pts[i * 2 + 1] = y + Math.sin(i) * 100;
  }
  const set = (i, px, py) => { pts[i * 2] = px; pts[i * 2 + 1] = py; };
  set(MESH.noseTip, x, y);
  set(MESH.rightFaceSide, x - 100, y - 20);
  set(MESH.leftFaceSide, x + 100, y - 20);
  const scores = new Array(52).fill(0);
  for (const [name, value] of Object.entries(shapes)) scores[NAMES.indexOf(name)] = value;
  return { pts, shapes: scores };
}

// Runs `seconds` of camera frames at `hz` with the faces `at(t)` gives; returns the last frame's faces.
function run(look, seconds, hz, at, memory = track.newTrackMemory(), start = 100) {
  let out = [];
  const frames = Math.round(seconds * hz);
  for (let f = 1; f <= frames; f++) {
    const t = start + f / hz;
    out = track.trackFaces(at(t), memory, look, t);
  }
  return { out, memory, end: start + frames / hz };
}

it('the expression scores are read from the right places in MediaPipe\'s list', () => {
  expect(NAMES.length).toBe(52);
  for (const [name, index] of Object.entries(BLENDSHAPE)) expect(NAMES[index]).toBe(name);
  for (const name of ['browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'eyeSquintLeft', 'eyeSquintRight', 'jawOpen', 'mouthFunnel', 'mouthPucker']) {
    expect(BLENDSHAPE[name]).toBe(NAMES.indexOf(name));
  }
});

it('reads the expressions, and empty or broken scores give zeros', () => {
  const face = track.readFace(rawFace(200, 420, { browInnerUp: 0.2, browOuterUpLeft: 0.6, browOuterUpRight: 0.8, eyeSquintLeft: 0.4, eyeSquintRight: 0.2, jawOpen: 0.5, mouthPucker: 0.3, mouthFunnel: 0.7 }));
  expect(face.browUp).toBeCloseTo(0.7, 6);
  expect(face.squint).toBeCloseTo(0.3, 6);
  expect(face.jawOpen).toBeCloseTo(0.5, 6);
  expect(face.pucker).toBeCloseTo(0.7, 6);
  for (const shapes of [[], new Array(52).fill(NaN), undefined]) {
    const empty = track.readFace({ pts: rawFace().pts, shapes });
    for (const key of ['blinkLeft', 'blinkRight', 'smile', 'browUp', 'squint', 'jawOpen', 'pucker', 'pop', 'progress', 'charge', 'flash']) expect(empty[key]).toBe(0);
  }
});

it('smoothing keeps every part of the face from the second frame on (nothing gets lost)', () => {
  const keys = Object.keys(track.readFace(rawFace())).sort();
  for (const look of ['glow', 'peekabooEyes', 'brainBuffering', 'auraOverload', 'heartEyes']) {
    const { out } = run(look, 1, 30, (t) => [rawFace(200 + Math.sin(t) * 3, 420, { jawOpen: 0.6, mouthPucker: 0.5, browInnerUp: 0.4, eyeSquintLeft: 0.3 })]);
    expect(Object.keys(out[0]).sort()).toEqual(keys);
    expect(out[0].jawOpen).toBeGreaterThan(0.5);
    expect(out[0].pucker).toBeGreaterThan(0.4);
    expect(out[0].browUp).toBeGreaterThan(0.3);
  }
});

it('🧠 holding still loads the brain to 100 % in about 9 seconds, then the green flash fades within a second', () => {
  const memory = track.newTrackMemory();
  let loadedAt = null;
  let flashAt = 0;
  for (let f = 1; f <= 30 * 12; f++) {
    const t = 100 + f / 30;
    const [face] = track.trackFaces([rawFace()], memory, 'brainBuffering', t);
    if (loadedAt === null && face.progress >= 1) { loadedAt = f / 30; flashAt = face.flash; }
    if (loadedAt !== null && f / 30 > loadedAt + 1) expect(face.flash).toBe(0);
  }
  expect(loadedAt).toBeGreaterThan(8.5);
  expect(loadedAt).toBeLessThan(10);
  expect(flashAt).toBeGreaterThan(0.9);
});

it('🧠 moving drains the brain, and shaking your head once it is loaded starts it again', () => {
  const still = run('brainBuffering', 5, 30, () => [rawFace()]);
  const halfway = still.out[0].progress;
  expect(halfway).toBeGreaterThan(0.4);
  // Moving at a whole face width a second for 2 seconds: it drains.
  const moving = run('brainBuffering', 2, 30, (t) => [rawFace(200 + (t - still.end) * 200, 420)], still.memory, still.end);
  expect(moving.out[0].still).toBeLessThan(0.5);
  expect(moving.out[0].progress).toBeLessThan(halfway - 0.3);
  // Loaded, then a quick side-to-side shake (1.5 face widths a second) restarts it.
  const loaded = run('brainBuffering', 11, 30, () => [rawFace()]);
  expect(loaded.out[0].progress).toBe(1);
  const shake = run('brainBuffering', 1, 30, (t) => [rawFace(200 + ((t - loaded.end) % 0.4 < 0.2 ? 1 : -1) * 300 * ((t - loaded.end) % 0.2), 420)], loaded.memory, loaded.end);
  expect(shake.out[0].progress).toBeLessThan(0.2);
});

it('🧠 loads at the same speed whether the camera tracks 15 or 60 times a second', () => {
  const slow = run('brainBuffering', 5, 15, () => [rawFace()]).out[0].progress;
  const fast = run('brainBuffering', 5, 60, () => [rawFace()]).out[0].progress;
  expect(Math.abs(slow - fast) / fast).toBeLessThan(0.03);
});

it('⚡ the aura charges up within half a second with the mouth open and drops back after', () => {
  const open = run('auraOverload', 0.5, 30, () => [rawFace(200, 420, { jawOpen: 0.6 })]);
  expect(open.out[0].charge).toBe(1);
  const closed = run('auraOverload', 1, 30, () => [rawFace(200, 420, { jawOpen: 0 })], open.memory, open.end);
  expect(closed.out[0].charge).toBe(0);
  // A closed mouth never charges it.
  expect(run('auraOverload', 2, 30, () => [rawFace()]).out[0].charge).toBe(0);
});

it('👀 the googly eyes pop in with a bounce, then settle at their size (bigger with raised brows)', () => {
  const memory = track.newTrackMemory();
  let biggest = 0;
  let last = 0;
  for (let f = 1; f <= 60; f++) {
    const [face] = track.trackFaces([rawFace()], memory, 'peekabooEyes', 100 + f / 30);
    biggest = Math.max(biggest, face.pop);
    last = face.pop;
  }
  const rest = 0.55 + 1.15 * 0.8;
  expect(biggest).toBeGreaterThan(rest * 1.05);
  expect(Math.abs(last - rest)).toBeLessThan(0.02);
  const brows = run('peekabooEyes', 2, 30, () => [rawFace(200, 420, { browInnerUp: 1 })]).out[0].pop;
  expect(brows).toBeGreaterThan(last + 0.15);
  // A quick head move makes the pupils wobble, and they settle again.
  const moved = run('peekabooEyes', 0.2, 30, (t) => [rawFace(200 + (t - 100) * 400, 420)]);
  expect(Math.hypot(moved.out[0].wobbleX, moved.out[0].wobbleY)).toBeGreaterThan(0.005);
  const settled = run('peekabooEyes', 3, 30, () => [rawFace(280, 420)], moved.memory, moved.end);
  expect(Math.hypot(settled.out[0].wobbleX, settled.out[0].wobbleY)).toBeLessThan(0.002);
});

it('each face keeps its own number (seed) from frame to frame, and two faces get different ones', () => {
  const memory = track.newTrackMemory();
  const first = track.trackFaces([rawFace(150, 420), rawFace(600, 420)], memory, 'crybaby', 100);
  expect(first[0].seed).not.toBe(first[1].seed);
  // The camera lists them the other way round: each keeps its own seed (it follows the face, not the place in the list).
  const next = track.trackFaces([rawFace(602, 421), rawFace(151, 420)], memory, 'crybaby', 100.033);
  expect(next[0].seed).toBe(first[1].seed);
  expect(next[1].seed).toBe(first[0].seed);
});

it('a face lost for half a second keeps its progress; one lost for 2 seconds starts again', () => {
  const before = run('brainBuffering', 5, 30, () => [rawFace()]);
  const progress = before.out[0].progress;
  const seed = before.out[0].seed;
  track.trackFaces([], before.memory, 'brainBuffering', before.end + 0.03);
  const back = track.trackFaces([rawFace()], before.memory, 'brainBuffering', before.end + 0.5);
  expect(back[0].progress).toBeGreaterThanOrEqual(progress);
  expect(back[0].seed).toBe(seed);
  const gone = run('brainBuffering', 5, 30, () => [rawFace()]);
  track.trackFaces([], gone.memory, 'brainBuffering', gone.end + 0.03);
  const fresh = track.trackFaces([rawFace()], gone.memory, 'brainBuffering', gone.end + 2);
  expect(fresh[0].progress).toBe(0);
  expect(fresh[0].seed).not.toBe(gone.out[0].seed);
});

it('switching to another look puts the other looks\' memory back to rest', () => {
  const brain = run('brainBuffering', 4, 30, () => [rawFace(200, 420, { jawOpen: 0.8 })]);
  expect(brain.out[0].progress).toBeGreaterThan(0.2);
  const aura = run('auraOverload', 0.5, 30, () => [rawFace(200, 420, { jawOpen: 0.8 })], brain.memory, brain.end);
  expect(aura.out[0].progress).toBe(0);
  expect(aura.out[0].charge).toBeGreaterThan(0.9);
  const eyes = run('peekabooEyes', 0.1, 30, () => [rawFace(200, 420, { jawOpen: 0.8 })], aura.memory, aura.end);
  expect(eyes.out[0].charge).toBe(0);
  expect(eyes.out[0].pop).toBeGreaterThan(0);
  const glow = run('glow', 0.1, 30, () => [rawFace()], eyes.memory, eyes.end);
  expect(glow.out[0].pop).toBe(0);
  expect(glow.out[0].progress).toBe(0);
});

it('a broken frame (missing points, broken numbers) never breaks the memory', () => {
  const memory = track.newTrackMemory();
  expect(track.trackFaces([{ pts: [1, 2, 3], shapes: [] }, null], memory, 'brainBuffering', 100)).toEqual([]);
  const out = track.trackFaces([rawFace(200, 420, { jawOpen: NaN })], memory, 'auraOverload', 100.03);
  expect(out[0].jawOpen).toBe(0);
  const again = track.trackFaces([rawFace()], memory, 'auraOverload', NaN);
  for (const value of Object.values(again[0])) if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
});
