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

const { applyMatrix, frameToView, photoToView, screenTurn, toMatrix9, MIRROR_FRONT } = load();
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

it('a sideways back-camera picture (turn 90) is stood up: its top-left corner goes to the bottom-left', () => {
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
