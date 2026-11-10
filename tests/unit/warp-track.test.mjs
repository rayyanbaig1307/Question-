import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';

// The stretchy filters' memory (src/components/lens/warp/warpTrack.ts), stepped for every face-tracking frame:
// 😃 the mouth's bouncy size, 🫥 the talking, 🗿 the chin's power (the meter) and 👾 the glitch. All plain
// numbers on each face, in real seconds, so it behaves the same at any camera speed and the saved photo gets
// the same numbers as the screen.

function compile(path, mods, cache = new Map()) {
  if (cache.has(path)) return cache.get(path).exports;
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  cache.set(path, module);
  vm.runInNewContext(code, {
    module, exports: module.exports, Math,
    require: (id) => {
      if (id in mods) return mods[id];
      if (id.startsWith('.')) return compile(`${join(dirname(path), id)}.ts`, mods, cache);
      throw new Error(`missing ${id}`);
    },
  });
  return module.exports;
}

// warpTrack must not need Skia or anything else: only its own files.
const warp = compile('src/components/lens/warp/warpTrack.ts', {});

const face = (expr = {}) => ({ jawOpen: 0, smile: 0, pucker: 0, browUp: 0, ...warp.WARP_REST, ...expr });

// Runs `seconds` of frames at `hz` for `look` with the expression `expr(t)`; gives every frame's face.
function run(look, seconds, hz, expr, start) {
  const frames = [];
  let before = start;
  for (let f = 0; f < Math.round(seconds * hz); f++) {
    const next = warp.stepWarp(face(expr(f / hz)), before, 1 / hz, look);
    frames.push(next);
    before = next;
  }
  return frames;
}

it('a new face starts at rest, and every other look keeps the stretchy memory at rest', () => {
  expect(warp.WARP_REST).toEqual({ mouth: 1, mouthSpeed: 0, tiny: 0, chin: 0, glitch: 0, warpLevel: 0 });
  const busy = { mouth: 2.2, mouthSpeed: 3, tiny: 1, chin: 0.7, glitch: 0.9, warpLevel: 0.9 };
  for (const look of ['glow', 'golden', 'peekabooEyes', 'crybaby', 'heartEyes']) {
    const out = warp.stepWarp(face({ jawOpen: 1, pucker: 1, browUp: 1 }), busy, 0.03, look);
    for (const [key, value] of Object.entries(warp.WARP_REST)) expect(out[key], `${look} ${key}`).toBe(value);
  }
  // Switching between stretchy looks starts the new one fresh too (the chin doesn't carry over to Big Mouth).
  const out = warp.stepWarp(face(), { ...busy, chin: 1 }, 0.03, 'bigMouth');
  expect(out.chin).toBe(0);
});

it('😃 the mouth spring stays calm and bounded, even at slow camera speeds (time steps cut to 0.05 s)', () => {
  for (const hz of [10, 20, 30, 60]) {
    const frames = run('bigMouth', 6, hz, (t) => ({ jawOpen: Math.floor(t * 2) % 2 }));
    for (const f of frames) {
      expect(f.mouth).toBeGreaterThanOrEqual(0.5);
      expect(f.mouth).toBeLessThanOrEqual(3);
      expect(Number.isFinite(f.mouthSpeed)).toBe(true);
    }
  }
  // With a still face it settles near the web version's always-on size (about 1.86×).
  const still = run('bigMouth', 4, 30, () => ({}));
  expect(still.at(-1).mouth).toBeGreaterThan(1.8);
  expect(still.at(-1).mouth).toBeLessThan(1.92);
  // Wide open: about 2×.
  const open = run('bigMouth', 4, 30, () => ({ jawOpen: 1 }));
  expect(open.at(-1).mouth).toBeGreaterThan(2);
  expect(open.at(-1).mouth).toBeLessThan(2.1);
  // It bounces: on the way it goes past where it settles.
  expect(Math.max(...still.map((f) => f.mouth))).toBeGreaterThan(still.at(-1).mouth + 0.02);
  // A huge time step (the app was paused) is cut to 0.05 s.
  const jump = warp.stepWarp(face({ jawOpen: 1 }), { ...warp.WARP_REST }, 10, 'bigMouth');
  expect(jump.mouth).toBeLessThan(1.2);
});

it('🗿 the chin meter reaches 100 % after about 1.1 s of pouting, and drains when you stop', () => {
  const pout = run('gigachin', 3, 30, () => ({ pucker: 1 }));
  const full = pout.findIndex((f) => f.chin >= 1) / 30;
  expect(full).toBeGreaterThan(1.0);
  expect(full).toBeLessThan(1.4);
  // Without a pout it never charges (the meter only means something when you pout).
  expect(run('gigachin', 3, 30, () => ({ pucker: 0.1 })).at(-1).chin).toBe(0);
  // Stop pouting: empty again in under a second.
  const relax = run('gigachin', 1, 30, () => ({ pucker: 0 }), pout.at(-1));
  expect(relax.at(-1).chin).toBe(0);
  // The same at 15 frames a second.
  const slow = run('gigachin', 3, 15, () => ({ pucker: 1 }));
  expect(slow.findIndex((f) => f.chin >= 1) / 15).toBeLessThan(1.5);
});

it('🫥 talking makes the face tinier and it fades back slowly; 👾 raised brows glitch it up', () => {
  const talk = run('tinyFace', 1, 30, (t) => ({ jawOpen: t < 0.5 ? 0.5 : 0 }));
  expect(talk[14].tiny).toBeGreaterThan(0.8);
  for (const f of talk) {
    expect(f.tiny).toBeGreaterThanOrEqual(0);
    expect(f.tiny).toBeLessThanOrEqual(1);
  }
  const glitch = run('pixelPanic', 1, 30, () => ({ browUp: 1 }));
  expect(glitch.at(-1).glitch).toBe(1);
  expect(glitch.at(-1).warpLevel).toBeGreaterThan(0.9);
});

it('broken numbers never make broken memory', () => {
  const bad = { jawOpen: NaN, smile: Infinity, pucker: undefined, browUp: -Infinity };
  const broken = { mouth: NaN, mouthSpeed: Infinity, tiny: NaN, chin: undefined, glitch: NaN, warpLevel: NaN };
  for (const look of ['bigMouth', 'tinyFace', 'gigachin', 'pixelPanic']) {
    for (const dt of [NaN, -1, 0, 0.016, 100]) {
      const out = warp.stepWarp({ ...face(), ...bad }, broken, dt, look);
      for (const key of Object.keys(warp.WARP_REST)) expect(Number.isFinite(out[key]), `${look} ${key} dt=${dt}`).toBe(true);
    }
  }
});

it('easing is in real seconds: one 1/30 s step equals two 1/60 s steps', () => {
  const once = warp.easeTowards(0, 1, 0.3, 1 / 30);
  const twice = warp.easeTowards(warp.easeTowards(0, 1, 0.3, 1 / 60), 1, 0.3, 1 / 60);
  expect(once).toBeCloseTo(twice, 10);
});
