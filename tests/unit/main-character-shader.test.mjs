import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { beforeAll, expect, it } from 'vitest';

// Main Character Mode 🌆: the comic look on your face (src/components/mainCharacter/comicShader.ts), compiled and
// run with Skia's own web version (CanvasKit, the same Skia family as the app), and comicEffect.ts, which makes
// it ready once and falls back to the plain face when it can't. Invented pictures only.

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../..');

function compile(path, mods = {}, context = {}) {
  const full = resolve(root, path);
  const code = ts.transpileModule(readFileSync(full, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, Math, Number, ...context,
    require: (id) => {
      if (id in mods) return mods[id];
      if (id.startsWith('.') && mods['.']) return mods['.'](join(dirname(full), id));
      throw new Error(`${path} must not load ${id}`);
    },
  });
  return module.exports;
}

const shader = compile('src/components/mainCharacter/comicShader.ts');
const { COMIC, COMIC_LIVE, COMIC_SHADER, COMIC_UNIFORM_FLOATS, comicUniforms } = shader;

const SIZE = 64;
let CK;
let effect;

beforeAll(async () => {
  const ckPath = require.resolve('canvaskit-wasm/bin/canvaskit.js');
  CK = await require(ckPath)({ locateFile: (file) => resolve(dirname(ckPath), file) });
  let error = '';
  effect = CK.RuntimeEffect.Make(COMIC_SHADER, (e) => { error = e; });
  if (!effect) throw new Error(`the comic shader did not compile: ${error}`);
}, 60_000);

// A picture from a function (x, y) → [r, g, b, a] (0–255).
function picture(width, height, colour) {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = colour(x, y);
      const i = (y * width + x) * 4;
      // Premultiplied, as Skia keeps it.
      pixels[i] = Math.round((r * a) / 255);
      pixels[i + 1] = Math.round((g * a) / 255);
      pixels[i + 2] = Math.round((b * a) / 255);
      pixels[i + 3] = a;
    }
  }
  return CK.MakeImage({ width, height, alphaType: CK.AlphaType.Premul, colorType: CK.ColorType.RGBA_8888, colorSpace: CK.ColorSpace.SRGB }, pixels, width * 4);
}

// Draws the comic look over a picture with these numbers; gives the pixels (RGBA, not premultiplied).
function render(colour, uniforms, width = SIZE, height = SIZE) {
  const image = picture(width, height, colour);
  const surface = CK.MakeSurface(width, height);
  const canvas = surface.getCanvas();
  canvas.clear(CK.TRANSPARENT);
  const child = image.makeShaderOptions(CK.TileMode.Clamp, CK.TileMode.Clamp, CK.FilterMode.Linear, CK.MipmapMode.None, CK.Matrix.identity());
  const paint = new CK.Paint();
  paint.setShader(effect.makeShaderWithChildren(uniforms, [child]));
  canvas.drawRect(CK.XYWHRect(0, 0, width, height), paint);
  surface.flush();
  const snap = surface.makeImageSnapshot();
  const out = snap.readPixels(0, 0, { width, height, alphaType: CK.AlphaType.Unpremul, colorType: CK.ColorType.RGBA_8888, colorSpace: CK.ColorSpace.SRGB });
  snap.delete();
  paint.delete();
  surface.delete();
  image.delete();
  return out;
}

const at = (pixels, width, x, y) => Array.from(pixels.slice((y * width + x) * 4, (y * width + x) * 4 + 4));

// The numbers with only some parts of the look on: the rest set to "no change".
function only(parts) {
  const base = { ...COMIC, toneMix: 0, saturation: 1, contrast: 1, posterMix: 0, warm: [1, 1, 1], inkAmount: 0, soften: 0, tone: [0.5, 0.5, 0.5], ...parts };
  return [base.edge, ...base.tone, base.toneMix, base.saturation, base.contrast, base.levels, base.posterMix, base.bandSoft, ...base.warm, base.inkAmount, ...base.inkEdge, base.soften];
}

it('the shader compiles and takes exactly the 17 numbers comicUniforms hands it, in the same order', () => {
  expect(COMIC_UNIFORM_FLOATS).toBe(17);
  expect(effect.getUniformFloatCount()).toBe(COMIC_UNIFORM_FLOATS);
  // Where each number goes, as Skia reads the program.
  const slots = {};
  for (let i = 0; i < effect.getUniformCount(); i++) slots[effect.getUniformName(i)] = effect.getUniform(i).slot;
  expect(slots).toEqual({ edge: 0, tone: 1, toneMix: 4, saturation: 5, contrast: 6, levels: 7, posterMix: 8, bandSoft: 9, warm: 10, inkAmount: 13, inkEdge: 14, soften: 16 });
  const tone = [0.8, 0.6, 0.4];
  const still = comicUniforms(tone, 0.1, false);
  expect(still).toHaveLength(17);
  expect(still.every(Number.isFinite)).toBe(true);
  expect(still[slots.edge]).toBe(COMIC.edge);
  expect(still.slice(slots.tone, slots.tone + 3)).toEqual(tone);
  expect(still[slots.toneMix]).toBe(0.1);
  expect(still[slots.saturation]).toBe(COMIC.saturation);
  expect(still[slots.contrast]).toBe(COMIC.contrast);
  expect(still[slots.levels]).toBe(COMIC.levels);
  expect(still[slots.posterMix]).toBe(COMIC.posterMix);
  expect(still[slots.bandSoft]).toBe(COMIC.bandSoft);
  expect(still.slice(slots.warm, slots.warm + 3)).toEqual(COMIC.warm);
  expect(still[slots.inkAmount]).toBe(COMIC.inkAmount);
  expect(still.slice(slots.inkEdge, slots.inkEdge + 2)).toEqual(COMIC.inkEdge);
  expect(still[slots.soften]).toBe(COMIC.soften);
  // Live: only the banding and the ink are softer.
  const live = comicUniforms(tone, 0.1, true);
  expect(live).toHaveLength(17);
  expect(live.every(Number.isFinite)).toBe(true);
  expect(live[slots.posterMix]).toBe(COMIC_LIVE.posterMix);
  expect(live[slots.inkAmount]).toBe(COMIC_LIVE.inkAmount);
  for (let i = 0; i < 17; i++) if (i !== slots.posterMix && i !== slots.inkAmount) expect(live[i], `number ${i}`).toBe(still[i]);
  expect(COMIC_LIVE.posterMix).toBeLessThan(COMIC.posterMix);
  expect(COMIC_LIVE.inkAmount).toBeLessThan(COMIC.inkAmount);
  expect(COMIC.bandSoft).toBeGreaterThan(0);
});

it('comicUniforms always gives 17 real numbers: a broken tone means no pull towards it', () => {
  for (const [tone, mix] of [[null, 0.1], [[0.5], 0.1], [[Number.NaN, 0.5, 0.5], 0.1], [[0.5, Infinity, 0.5], 1], [[0.5, 0.5, 0.5], Number.NaN], [[2, -1, 0.5], 5]]) {
    const u = comicUniforms(tone, mix, false);
    expect(u, JSON.stringify(tone)).toHaveLength(17);
    expect(u.every(Number.isFinite), JSON.stringify(tone)).toBe(true);
    expect(u[4]).toBeGreaterThanOrEqual(0);
    expect(u[4]).toBeLessThanOrEqual(1);
  }
  expect(comicUniforms([Number.NaN, 0.5, 0.5], 0.4, false)[4]).toBe(0);
  expect(comicUniforms([2, -1, 0.5], 5, false).slice(1, 5)).toEqual([1, 0, 0.5, 1]);
});

it('a flat grey picture gets no ink, a warm tint (red up, blue down) and alpha 1', () => {
  const grey = () => [128, 128, 128, 255];
  for (const live of [false, true]) {
    const out = render(grey, comicUniforms([0.8, 0.6, 0.4], 0, live));
    const [r, g, b, a] = at(out, SIZE, 32, 32);
    expect(r).toBeGreaterThan(131);
    expect(b).toBeLessThan(125);
    expect(Math.abs(g - 128)).toBeLessThanOrEqual(3);
    expect(a).toBe(255);
    // The same everywhere: no ink lines on a flat picture.
    for (let y = 0; y < SIZE; y += 3) {
      for (let x = 0; x < SIZE; x += 3) {
        const p = at(out, SIZE, x, y);
        for (let c = 0; c < 4; c++) expect(Math.abs(p[c] - [r, g, b, a][c]), `${x},${y}`).toBeLessThanOrEqual(1);
      }
    }
  }
});

it('with toneMix 0 the tone makes no difference; above 0 it pulls towards the skin colour', () => {
  const pattern = (x, y) => [40 + x * 3, 200 - y * 2, (x * y) % 255, 255];
  const one = render(pattern, comicUniforms([1, 0.2, 0.1], 0, false));
  const two = render(pattern, comicUniforms([0.1, 0.3, 1], 0, false));
  expect(Array.from(one)).toEqual(Array.from(two));
  // Pulled all the way towards a reddish skin: a grey picture comes out redder than without the pull.
  const grey = () => [128, 128, 128, 255];
  const plain = at(render(grey, comicUniforms([0.85, 0.55, 0.45], 0, false)), SIZE, 32, 32);
  const pulled = at(render(grey, comicUniforms([0.85, 0.55, 0.45], 1, false)), SIZE, 32, 32);
  expect(pulled[0] - pulled[2]).toBeGreaterThan(plain[0] - plain[2] + 40);
});

it('a hard black and white edge gets a dark ink line along it', () => {
  const edge = (x) => (x < 32 ? [0, 0, 0, 255] : [255, 255, 255, 255]);
  const out = render(edge, comicUniforms([0.5, 0.5, 0.5], 0, false));
  for (let y = 4; y < SIZE - 4; y += 5) {
    const far = at(out, SIZE, 56, y);
    const next = at(out, SIZE, 32, y);
    expect(far[1], `row ${y}`).toBeGreaterThan(200);
    // Just on the white side of the edge: much darker than the white far away.
    expect(next[1], `row ${y}`).toBeLessThan(far[1] * 0.5);
    expect(next[3]).toBe(255);
  }
});

it('the poster bands change smoothly across a step: no jump of a whole band within 1 % of the input', () => {
  // A grey ramp 0 → 255 across 256 pixels: 2 pixels are under 1 % of the input.
  const ramp = (x) => [x, x, x, 255];
  const biggestJump = (uniforms) => {
    const out = render(ramp, uniforms, 256, 4);
    let worst = 0;
    for (let x = 0; x + 2 < 256; x++) worst = Math.max(worst, Math.abs(at(out, 256, x + 2, 1)[1] - at(out, 256, x, 1)[1]));
    return worst;
  };
  const level = 255 / COMIC.levels;
  // Only the banding (all of it), with the soft steps: well under one band.
  const soft = biggestJump(only({ posterMix: 1 }));
  expect(soft).toBeLessThan(level / 2);
  // The whole still look and the whole live look: smooth too.
  expect(biggestJump(comicUniforms([0.5, 0.5, 0.5], 0, false))).toBeLessThan(level / 2);
  expect(biggestJump(comicUniforms([0.5, 0.5, 0.5], 0, true))).toBeLessThan(level / 2);
  // The check can tell: nearly hard steps jump almost a whole band at once.
  const hard = biggestJump(only({ posterMix: 1, bandSoft: 0.01 }));
  expect(hard).toBeGreaterThan(level * 0.7);
  // And the banding really bands: the flat part of a band (round the line between two bands, outside the soft
  // ramp) hardly changes, while the plain ramp goes up all the way.
  const out = render(ramp, only({ posterMix: 1 }), 256, 4);
  const lo = Math.ceil(((1 + 0.5 + COMIC.bandSoft + 0.03) / COMIC.levels) * 255);
  const hi = Math.floor(((2 + 0.5 - COMIC.bandSoft - 0.03) / COMIC.levels) * 255);
  expect(hi - lo).toBeGreaterThan(15);
  expect(at(out, 256, hi, 1)[1] - at(out, 256, lo, 1)[1]).toBeLessThan(3);
});

it('alpha is 1 everywhere, even where the picture is see-through', () => {
  const holey = (x, y) => [200, 120, 90, (x + y) % 3 === 0 ? 0 : 255];
  for (const live of [false, true]) {
    const out = render(holey, comicUniforms([0.8, 0.6, 0.4], 0.1, live));
    for (let i = 3; i < out.length; i += 4) expect(out[i]).toBe(255);
  }
});

// comicEffect.ts with a pretend Skia: made once; null (and one warning) when it can't be made or takes the wrong
// numbers; never throws.
function loadEffect(make) {
  const warnings = [];
  const calls = { make: 0 };
  const skia = { Skia: { RuntimeEffect: { Make: (source) => { calls.make++; return make(source); } } } };
  const module = compile('src/components/mainCharacter/comicEffect.ts', {
    '@shopify/react-native-skia': skia,
    '.': (path) => (path.endsWith('comicShader') ? shader : null),
  }, { console: { warn: (...args) => warnings.push(args.join(' ')) } });
  return { comicEffect: module.comicEffect, warnings, calls };
}

it('comicEffect makes the real shader once, and gives null (said once) when it can\'t', () => {
  const real = loadEffect((source) => CK.RuntimeEffect.Make(source));
  const first = real.comicEffect();
  expect(first).not.toBeNull();
  expect(first.getUniformFloatCount()).toBe(17);
  expect(real.comicEffect()).toBe(first);
  expect(real.calls.make).toBe(1);
  expect(real.warnings).toEqual([]);

  for (const make of [() => null, () => ({ getUniformFloatCount: () => 16 }), () => { throw new Error('no GPU'); }]) {
    const broken = loadEffect(make);
    expect(broken.comicEffect()).toBeNull();
    expect(broken.comicEffect()).toBeNull();
    expect(broken.calls.make).toBe(1);
    expect(broken.warnings).toHaveLength(1);
  }
});
