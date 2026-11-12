import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';

// Where a camera picture goes on the screen for the stretchy filters (src/components/lens/warp/frameMatrix.ts):
// stood up for the (never turning) screen, mirrored for the selfie camera, then "zoomed to fill" like the normal
// camera view. And the saved photo placed exactly like bakeLook.ts draws it. If this is wrong, the stretched
// picture sits beside or upside down from the face points.

function load() {
  const code = ts.transpileModule(readFileSync(resolve(import.meta.dirname, '../../src/components/lens/warp/frameMatrix.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, Math, require: (id) => { throw new Error(`frameMatrix.ts must not import ${id} for real`); } });
  return module.exports;
}

const {
  applyMatrix, axesMatrix, compareMatrices, connectionTurn, frameToView, iosShotTurn, photoToView, placeShot, screenTurn, toMatrix9,
  turnFromAxes, MIRROR_FRONT,
} = load();
const VIEW = [390, 844];
const close = (a, b) => {
  expect(Math.abs(a[0] - b[0]), `${a} vs ${b}`).toBeLessThan(1e-6);
  expect(Math.abs(a[1] - b[1]), `${a} vs ${b}`).toBeLessThan(1e-6);
};

it('the picture\'s turn adds the output\'s own turn back (the camera follows the phone, the screen does not)', () => {
  expect(screenTurn('right', 'up')).toBe(90);
  // Phone held sideways: the camera says 'up' compared with an output that is turned 'right'.
  expect(screenTurn('up', 'right')).toBe(90);
  expect(screenTurn('left', 'right')).toBe(0);
  expect(screenTurn('down', 'left')).toBe(90);
  expect(screenTurn('down', 'down')).toBe(0);
  // Anything unknown counts as upright.
  expect(screenTurn('sideways', undefined)).toBe(0);
});

it('an upright picture fills the view like the camera view (cover, centred)', () => {
  const m = frameToView(1440, 1920, 0, false, ...VIEW);
  const s = 844 / 1920;
  close(applyMatrix(m, 0, 0), [(390 - 1440 * s) / 2, 0]);
  close(applyMatrix(m, 1440, 1920), [390 - (390 - 1440 * s) / 2, 844]);
  close(applyMatrix(m, 720, 960), [195, 422]);
});

it('a picture turned 90 is stood up: its top-left corner goes to the bottom-left', () => {
  const m = frameToView(1920, 1440, 90, false, ...VIEW);
  const s = 844 / 1920;
  const ox = (390 - 1440 * s) / 2;
  close(applyMatrix(m, 0, 0), [ox, 844]);
  close(applyMatrix(m, 1920, 0), [ox, 0]);
  close(applyMatrix(m, 960, 720), [195, 422]);
});

it('turn 270 is the opposite of 90, and 180 is upside down', () => {
  const a = frameToView(1920, 1440, 90, false, ...VIEW);
  const b = frameToView(1920, 1440, 270, false, ...VIEW);
  close(applyMatrix(a, 0, 0), applyMatrix(b, 1920, 1440));
  const up = frameToView(1440, 1920, 0, false, ...VIEW);
  const down = frameToView(1440, 1920, 180, false, ...VIEW);
  close(applyMatrix(up, 0, 0), applyMatrix(down, 1440, 1920));
});

it('the selfie mirror swaps left and right but keeps up and down', () => {
  for (const turn of [0, 90, 180, 270]) {
    const plain = frameToView(1920, 1440, turn, false, ...VIEW);
    const mirrored = frameToView(1920, 1440, turn, true, ...VIEW);
    const [px, py] = applyMatrix(plain, 300, 200);
    const [mx, my] = applyMatrix(mirrored, 300, 200);
    expect(Math.abs(px + mx - 390)).toBeLessThan(1e-6);
    expect(Math.abs(py - my)).toBeLessThan(1e-6);
  }
  expect(MIRROR_FRONT).toBe(true);
});

it('the saved photo is placed exactly like bakeLook draws it (made smaller first, then cover)', () => {
  const m = photoToView(1800, 2400, 1, ...VIEW);
  const s = Math.max(390 / 1800, 844 / 2400);
  close(applyMatrix(m, 900, 1200), [195, 422]);
  close(applyMatrix(m, 0, 0), [195 - 900 * s, 422 - 1200 * s]);
  // A big photo made smaller (k): the same place on the screen for the same spot in the photo.
  const big = photoToView(3024, 4032, 2400 / 4032, ...VIEW);
  const width = Math.round(3024 * (2400 / 4032));
  const height = Math.round(4032 * (2400 / 4032));
  const sb = Math.max(390 / width, 844 / height);
  close(applyMatrix(big, 0, 0), [195 - (width * sb) / 2, 422 - (height * sb) / 2]);
  close(applyMatrix(big, 3024, 4032), [195 + (width * sb) / 2, 422 + (height * sb) / 2]);
  // Broken sizes never give broken numbers.
  expect(photoToView(0, 0, 1, ...VIEW).every(Number.isFinite)).toBe(true);
  expect(frameToView(0, 0, 0, false, ...VIEW).every(Number.isFinite)).toBe(true);
  expect(toMatrix9([1, 2, 3, 4, 5, 6])).toEqual([1, 2, 3, 4, 5, 6, 0, 0, 1]);
});

// ---------------------------------------------------------------------------
// The owner's iPhone (12 Nov, TestFlight build 11): camera pictures 1920 × 1440 (sideways), the camera view
// 390 × 844 points. The selfie picture was drawn upside down and only 92 % big. scratchpad/warpfix/nums.mjs has the
// same numbers worked out by hand.
// ---------------------------------------------------------------------------

const W = 1920;
const H = 1440;
const S = 844 / 1920; // cover: the long side fills the view's height
const OX = (390 - 1440 * S) / 2; // −121.5: the overflow cut off equally left and right

it('iPhone rule: the back camera follows its label, the selfie camera turns the other way (its label counts the other way round)', () => {
  // Back camera: VisionCamera says 'left' (270) on every iPhone today; 'right' (90) is followed too.
  expect(iosShotTurn(270, false, W, H)).toBe(270);
  expect(iosShotTurn(90, false, W, H)).toBe(90);
  // Selfie camera: VisionCamera says 'right' (90), but the pictures need the same 270 as the back camera.
  expect(iosShotTurn(90, true, W, H)).toBe(270);
  expect(iosShotTurn(270, true, W, H)).toBe(90);
  // Not sideways labels, or a picture that is already upright: the rule can't decide (−1).
  for (const label of [0, 180]) {
    expect(iosShotTurn(label, false, W, H)).toBe(-1);
    expect(iosShotTurn(label, true, W, H)).toBe(-1);
  }
  expect(iosShotTurn(90, true, 1440, 1920)).toBe(-1);
  expect(iosShotTurn(270, false, 1080, 1080)).toBe(-1);
  // The label itself is the camera's 'right'/'left' plus the output's own turn (same as before).
  expect(connectionTurn('right', 'up')).toBe(90);
  expect(connectionTurn('left', 'up')).toBe(270);
  expect(connectionTurn('right', 'right')).toBe(screenTurn('right', 'right'));
});

it('the selfie picture on the owner\'s phone: upright, mirrored and filling the whole view', () => {
  const m = frameToView(W, H, iosShotTurn(90, true, W, H), MIRROR_FRONT, 390, 844);
  close(applyMatrix(m, 0, 0), [OX, 0]);
  close(applyMatrix(m, W, 0), [OX, 844]);
  close(applyMatrix(m, 0, H), [390 - OX, 0]);
  close(applyMatrix(m, W / 2, H / 2), [195, 422]);
  // It is the plain swap of x and y (the "transpose"), scaled: [0, s, ox, s, 0, oy].
  const expected = [0, S, OX, S, 0, 0];
  m.forEach((v, i) => expect(Math.abs(v - expected[i]), `m[${i}]`).toBeLessThan(1e-9));
  expect(OX).toBeCloseTo(-121.5, 9);
  expect(S).toBeCloseTo(0.439583, 6);
});

it('the back-camera picture on the same phone: upright, not mirrored, filling the view', () => {
  const m = frameToView(W, H, iosShotTurn(270, false, W, H), false, 390, 844);
  close(applyMatrix(m, 0, 0), [390 - OX, 0]);
  close(applyMatrix(m, W, 0), [390 - OX, 844]);
  close(applyMatrix(m, 0, H), [OX, 0]);
  close(applyMatrix(m, W / 2, H / 2), [195, 422]);
});

it('regression (the owner\'s screenshots): the old selfie placing was the right one turned upside down, and 92 % big', () => {
  const now = frameToView(W, H, 270, true, 390, 844);
  const old = frameToView(W, H, 90, true, 390, 844);
  for (const [x, y] of [[0, 0], [100, 50], [W, H], [700, 1300], [W / 2, H / 2 + 10]]) {
    const [nx, ny] = applyMatrix(now, x, y);
    const [ox, oy] = applyMatrix(old, x, y);
    expect(Math.abs(ox - (390 - nx)), `x at ${x},${y}`).toBeLessThan(1e-6);
    expect(Math.abs(oy - (844 - ny)), `y at ${x},${y}`).toBeLessThan(1e-6);
  }
  // With the 0.92 size the overlay used to get (Canvas onSize includes the pager's shrink animation), the middle of
  // the picture landed up and to the left of the middle of the screen – the strips on the right and at the bottom.
  const shrunk = frameToView(W, H, 90, true, 390 * 0.92, 844 * 0.92);
  const [cx, cy] = applyMatrix(shrunk, W / 2, H / 2);
  expect(cx).toBeCloseTo(179.4, 1);
  expect(cy).toBeCloseTo(388.24, 1);
});

// The camera view's converter on the owner's phone (where the camera's 0–1 points land), as expected for each camera.
const FRONT_AXES = { ox: OX, oy: 0, ax: 0, ay: 844, bx: 390 - 2 * OX, by: 0, front: true };
const BACK_AXES = { ox: 390 - OX, oy: 0, ax: 0, ay: 844, bx: -(390 - 2 * OX), by: 0, front: false };

it('turnFromAxes reads all 8 quarter turns and mirrors from a matrix, and refuses skewed or empty ones', () => {
  for (const turn of [0, 90, 180, 270]) {
    for (const mirror of [false, true]) {
      const m = frameToView(W, H, turn, mirror, 390, 844);
      expect(turnFromAxes(m[0], m[1], m[3], m[4]), `${turn} ${mirror}`).toEqual({ turn, mirror });
    }
  }
  expect(turnFromAxes(1, 0.5, 0, 1)).toBeNull(); // skewed
  expect(turnFromAxes(0.5, 0.5, 0.5, 0.5)).toBeNull();
  expect(turnFromAxes(0, 0, 0, 1)).toBeNull(); // nothing on one side
  expect(turnFromAxes(0, 0, 0, 0)).toBeNull();
  expect(turnFromAxes(NaN, 1, 1, 0)).toBeNull();
  // A tiny wobble (below 2 %) still counts as a clean turn.
  expect(turnFromAxes(0.001, 0.44, 0.44, -0.001)).toEqual({ turn: 270, mirror: true });
  // The converter's expected numbers give 270 + mirror (selfie) and 270 (back).
  const f = axesMatrix(FRONT_AXES, W, H);
  expect(turnFromAxes(f[0], f[1], f[3], f[4])).toEqual({ turn: 270, mirror: true });
  const b = axesMatrix(BACK_AXES, W, H);
  expect(turnFromAxes(b[0], b[1], b[3], b[4])).toEqual({ turn: 270, mirror: false });
  expect(axesMatrix(FRONT_AXES, 0, H)).toBeNull();
});

const frontShot = { w: W, h: H, turn: 270, mirror: true, front: true };

it('placeShot: the rule wins when it applies, the converter only where the rule can\'t decide, else a fixed 270', () => {
  // The rule decides (how 0), even when a converter disagrees.
  const skewed = { ...FRONT_AXES, bx: -FRONT_AXES.bx };
  const byRule = placeShot(frontShot, 390, 844, skewed, 'rule');
  expect(byRule.how).toBe(0);
  expect(byRule.m).toEqual(frameToView(W, H, 270, true, 390, 844));
  expect([byRule.turn, byRule.mirror]).toEqual([270, true]);
  // The rule can't decide: the converter's turn and mirror (how 1).
  const unknown = { ...frontShot, turn: -1, mirror: false };
  const byConverter = placeShot(unknown, 390, 844, FRONT_AXES, 'rule');
  expect(byConverter.how).toBe(1);
  expect([byConverter.turn, byConverter.mirror]).toEqual([270, true]);
  // A converter for the other camera is never used.
  const otherCamera = placeShot(unknown, 390, 844, { ...FRONT_AXES, front: false }, 'rule');
  expect(otherCamera.how).toBe(2);
  // Neither: a fixed 270 with the picture's own mirror (how 2).
  const fixed = placeShot(unknown, 390, 844, null, 'rule');
  expect(fixed.how).toBe(2);
  expect(fixed.m).toEqual(frameToView(W, H, 270, false, 390, 844));
});

it('placeShot with FRAME_PLACEMENT \'converter\' asks the converter first, and never uses its size or place', () => {
  const mirrored = placeShot({ ...frontShot, turn: 90 }, 390, 844, FRONT_AXES, 'converter');
  expect(mirrored.how).toBe(1);
  expect([mirrored.turn, mirrored.mirror]).toEqual([270, true]);
  // No converter yet: the rule.
  expect(placeShot(frontShot, 390, 844, null, 'converter').how).toBe(0);
  // A zoomed-in converter (twice as big, moved) still gives the same cover placing, filling the view.
  const zoomed = { ...FRONT_AXES, ox: FRONT_AXES.ox * 2 - 195, oy: -422, ay: 844 * 2, bx: FRONT_AXES.bx * 2 };
  const placed = placeShot({ ...frontShot, turn: -1 }, 390, 844, zoomed, 'rule');
  expect(placed.how).toBe(1);
  expect(placed.m).toEqual(frameToView(W, H, 270, true, 390, 844));
});

it('compareMatrices: the same placing, the same turn at another size, or a different turn', () => {
  const m = frameToView(W, H, 270, true, 390, 844);
  expect(compareMatrices(m, axesMatrix(FRONT_AXES, W, H), W, H)).toBe('same');
  // Within 3 points is still the same; a zoomed converter is "same turn, other size".
  expect(compareMatrices(m, axesMatrix({ ...FRONT_AXES, ox: FRONT_AXES.ox + 2 }, W, H), W, H)).toBe('same');
  expect(compareMatrices(m, axesMatrix({ ...FRONT_AXES, ay: 1688, bx: FRONT_AXES.bx * 2 }, W, H), W, H)).toBe('turn');
  // The old upside-down placing, or the back camera's: a different turn or mirror.
  expect(compareMatrices(frameToView(W, H, 90, true, 390, 844), axesMatrix(FRONT_AXES, W, H), W, H)).toBe('differ');
  expect(compareMatrices(m, axesMatrix(BACK_AXES, W, H), W, H)).toBe('differ');
  expect(compareMatrices(frameToView(W, H, 270, false, 390, 844), axesMatrix(BACK_AXES, W, H), W, H)).toBe('same');
  // A tighter limit.
  expect(compareMatrices(m, axesMatrix({ ...FRONT_AXES, ox: FRONT_AXES.ox + 2 }, W, H), W, H, 1)).toBe('turn');
});
