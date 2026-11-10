import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';

// The 4 stretchy Peekaboo+ filters (src/components/lens/warp/paintWarp.ts, through lensPaint.ts paintLook), drawn
// on a pretend canvas with a pretend Skia that writes down every draw, every blur and every GPU program it is
// handed (with its numbers). They must never stop the live camera, draw nothing without a camera picture, hand
// each GPU program exactly the numbers it takes, stay cheap, and draw the same thing for the same moment (so the
// saved photo matches the screen).

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

const WARP_LOOKS = ['tinyFace', 'gigachin', 'bigMouth', 'pixelPanic'];
const { UNIFORM_FLOATS } = compile('src/components/lens/warp/shaders.ts', {});
const { LENS_LOOKS, isWarpLook } = compile('src/lib/lensLooks.ts', {});

function load() {
  const log = [];
  const skia = {
    BlurStyle: { Normal: 0, Solid: 1 }, ClipOp: { Intersect: 1, Difference: 0 }, FillType: { EvenOdd: 1, Winding: 0 }, PaintStyle: { Stroke: 1, Fill: 0 },
    StrokeCap: { Butt: 0, Round: 1, Square: 2 }, StrokeJoin: { Miter: 0, Round: 1, Bevel: 2 }, TileMode: { Clamp: 0 },
    Skia: {
      Paint: () => {
        const p = { alpha: 1, color: '', blur: false, imageFilter: false, shader: null, filter: null };
        log.push({ kind: 'paint', paint: p });
        return Object.assign(p, {
          setAntiAlias() {}, setColor(c) { p.color = c; }, setAlphaf(a) { p.alpha = a; }, setMaskFilter(m) { p.blur = !!m; },
          setShader(s) { p.shader = s; }, setImageFilter(f) { p.imageFilter = !!f; p.filter = f; }, setStyle() {}, setStrokeWidth() {}, setStrokeCap() {}, setStrokeJoin() {},
          setBlendMode() { throw new Error('blend modes cannot work over the live camera'); },
        });
      },
      Color: (c) => c,
      XYWHRect: (x, y, width, height) => ({ x, y, width, height }),
      PathBuilder: {
        Make: () => {
          const shape = { cmds: 0, rects: 0 };
          const note = () => { shape.cmds++; };
          return {
            setFillType() {}, moveTo: note, lineTo: note, quadTo: note, cubicTo: note, close: note, addCircle: note, addOval: note, addArc: note,
            addRect: (r) => { shape.rects++; for (const v of [r.x, r.y, r.width, r.height]) if (!Number.isFinite(v)) throw new Error('broken rect'); },
            detach: () => shape,
          };
        },
      },
      MaskFilter: { MakeBlur: () => ({}) },
      ImageFilter: { MakeBlur: (sx, sy) => { const filter = { blur: sx }; log.push({ kind: 'blurFilter', sigma: sx, filter }); return filter; } },
      Shader: {
        MakeRadialGradient: () => ({ kind: 'gradient' }),
        MakeLinearGradient: () => ({ kind: 'gradient' }),
        MakeTwoPointConicalGradient: () => ({ kind: 'gradient' }),
        MakeSweepGradient: () => ({ kind: 'gradient' }),
      },
    },
  };
  const faceMesh = compile('src/lib/faceMesh.ts', { react: {}, 'react-native': { TurboModuleRegistry: { get: () => null } } });
  const lens = compile('src/components/lens/lensPaint.ts', { '@shopify/react-native-skia': skia, '@/lib/faceMesh': faceMesh, '@/lib/goldenLight': {} });
  return { lens, log, MESH: faceMesh.MESH };
}

// A pretend GPU program: notes each time it is used, with its numbers.
function fakeEffects(log) {
  const make = (name) => ({
    makeShaderWithChildren(uniforms, children) {
      const shader = { kind: 'warp', name };
      log.push({ kind: 'effect', name, uniforms: [...uniforms], children: children.length, shader, child: children[0] });
      return shader;
    },
  });
  return { balloon: make('BALLOON'), shrink: make('SHRINK'), stretch: make('STRETCH'), pixel: make('PIXEL') };
}

// A face in the middle of a 400 × 800 view, symmetric left to right, with every point the filters use.
function makeFace(MESH, extra = {}) {
  const pts = new Array(478 * 2).fill(0);
  for (let i = 0; i < 478; i++) { pts[i * 2] = 200 + Math.cos(i) * 60; pts[i * 2 + 1] = 400 + Math.sin(i) * 80; }
  const set = (i, x, y) => { pts[i * 2] = x; pts[i * 2 + 1] = y; };
  const ring = (ids, cx, cy, rx, ry) => ids.forEach((id, k) => { const a = -Math.PI / 2 + (k / ids.length) * Math.PI * 2; set(id, cx + rx * Math.cos(a), cy + ry * Math.sin(a)); });
  ring(MESH.faceOval, 200, 400, 100, 130);
  ring(MESH.leftEye, 240, 370, 20, 8); ring(MESH.rightEye, 160, 370, 20, 8);
  ring(MESH.lips, 200, 460, 35, 14);
  for (const [key, x, y] of [['leftIris', 240, 370], ['rightIris', 160, 370], ['leftFaceSide', 300, 400], ['rightFaceSide', 100, 400],
    ['noseTip', 200, 420], ['chin', 200, 530], ['forehead', 200, 270], ['rightEyeOuter', 140, 370], ['rightEyeInner', 180, 370],
    ['rightEyeBottom', 160, 378], ['leftEyeOuter', 260, 370], ['leftEyeInner', 220, 370], ['leftEyeBottom', 240, 378], ['noseBottom', 200, 440],
    ['upperLipInner', 200, 457], ['lowerLipInner', 200, 463], ['mouthRightCorner', 165, 460], ['mouthLeftCorner', 235, 460],
    ['rightBlush', 150, 425], ['leftBlush', 250, 425]]) set(MESH[key], x, y);
  set(17, 200, 474);
  return {
    pts, blinkLeft: 0, blinkRight: 0, smile: 0, light: [], rim: 0, browUp: 0.3, squint: 0, jawOpen: 0.4, pucker: 0.6, seed: 3,
    pop: 0, popSpeed: 0, wobbleX: 0, wobbleY: 0, wobbleSpeedX: 0, wobbleSpeedY: 0, motion: 0, still: 1, progress: 0, flash: 0, charge: 0,
    mouth: 1.9, mouthSpeed: 0, tiny: 0.8, chin: 0.62, glitch: 1, warpLevel: 0.9, ...extra,
  };
}

// Draws one moment and gives back the draws (and the GPU programs used). `throwOn(paint)`: the pretend canvas fails
// when asked to draw with that paint (like a broken frame on the phone).
function draw(look, time, faces, withSrc = true, throwOn = () => false) {
  const { lens, log } = env;
  log.length = 0;
  const drawn = [];
  const steps = [];
  const record = (kind, paint, extra) => {
    const item = { kind, color: paint.color, alpha: paint.alpha, blur: paint.blur || paint.imageFilter, shader: paint.shader?.kind ?? null, ...extra };
    drawn.push(item);
    steps.push(item);
  };
  const canvas = {
    save() { steps.push({ kind: 'save' }); }, restore() { steps.push({ kind: 'restore' }); }, clipPath() { steps.push({ kind: 'clip' }); },
    translate(x, y) { steps.push({ kind: 'translate', x, y }); }, rotate(d) { steps.push({ kind: 'rotate', d }); }, scale(x, y) { steps.push({ kind: 'scale', x, y }); },
    drawRect: (rect, paint) => { if (throwOn(paint)) throw new Error('broken frame'); record('rect', paint, { rect }); },
    drawPath: (path, paint) => record('path', paint, { cmds: path.cmds, rects: path.rects }),
    drawCircle: (x, y, r, paint) => record('circle', paint, { x, y, r }),
  };
  const src = withSrc ? { image: { kind: 'camera' }, fx: fakeEffects(log), trash: [] } : null;
  let error = null;
  try {
    lens.paintLook(canvas, look, faces, 400, 800, time, undefined, src);
  } catch (e) {
    if (!throwOn.expected) throw e;
    error = e;
  }
  return {
    drawn, steps, error, trash: src ? src.trash : [],
    effects: log.filter((l) => l.kind === 'effect').map(({ shader, child, ...rest }) => rest),
    warpShaders: log.filter((l) => l.kind === 'effect').map((l) => ({ shader: l.shader, child: l.child })),
    blurFilters: log.filter((l) => l.kind === 'blurFilter').map(({ filter, ...rest }) => rest),
    blurObjects: log.filter((l) => l.kind === 'blurFilter').map((l) => l.filter),
    paints: log.filter((l) => l.kind === 'paint').map((l) => l.paint),
  };
}

const env = load();
const face = makeFace(env.MESH);
const second = { ...face, seed: 4, pts: face.pts.map((v, i) => (i % 2 === 0 ? 290 + (v - 200) * 0.5 : 300 + (v - 400) * 0.5)) };

function numbersIn(value, out = []) {
  if (typeof value === 'number') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => numbersIn(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => numbersIn(v, out));
  return out;
}

it('the 4 stretchy looks are in the list, need the camera\'s pixels and are Peekaboo+', () => {
  expect(LENS_LOOKS.filter((l) => l.needsFrames).map((l) => l.key)).toEqual(['tinyFace', 'gigachin', 'bigMouth', 'pixelPanic']);
  for (const key of WARP_LOOKS) {
    expect(isWarpLook(key)).toBe(true);
    expect(LENS_LOOKS.find((l) => l.key === key).plus).toBe(true);
  }
  for (const key of ['glow', 'golden', 'peekabooEyes', 'crybaby', 'photo', 'nope']) expect(isWarpLook(key)).toBe(false);
});

it('every stretchy look draws with 0, 1 and 2 faces at many moments, with only real numbers', () => {
  for (const look of WARP_LOOKS) {
    for (const faces of [[], [face], [face, second]]) {
      for (let t = 0; t < 6; t += 0.37) {
        let result;
        expect(() => { result = draw(look, t, faces); }, `${look} ${faces.length} faces t=${t}`).not.toThrow();
        expect(numbersIn(result.steps).every(Number.isFinite)).toBe(true);
        expect(numbersIn(result.effects).every(Number.isFinite)).toBe(true);
        if (faces.length === 0) expect(result.drawn.filter((d) => d.shader === 'warp')).toEqual([]);
        else expect(result.effects.length, `${look} uses its GPU program once per face`).toBe(faces.length);
      }
    }
  }
});

it('with no camera picture (none came lately) a stretchy look draws nothing at all – not even a meter', () => {
  for (const look of WARP_LOOKS) {
    for (const t of [0, 1.3, 4.2]) {
      const { steps, effects } = draw(look, t, [face, second], false);
      expect(steps, look).toEqual([]);
      expect(effects).toEqual([]);
    }
  }
});

it('each GPU program gets exactly the numbers it takes, and the camera picture as its one input', () => {
  const used = { tinyFace: 'SHRINK', gigachin: 'STRETCH', bigMouth: 'BALLOON', pixelPanic: 'PIXEL' };
  for (const look of WARP_LOOKS) {
    const { effects } = draw(look, 2.5, [face]);
    expect(effects.length).toBe(1);
    expect(effects[0].name).toBe(used[look]);
    expect(effects[0].uniforms.length).toBe(UNIFORM_FLOATS[used[look]]);
    expect(effects[0].children).toBe(1);
  }
});

it('the same moment always gives the same picture; another moment glitches differently (so the photo matches)', () => {
  for (const look of WARP_LOOKS) {
    for (const t of [0.5, 3.21, 9.9]) {
      expect(JSON.stringify(draw(look, t, [face, second]))).toBe(JSON.stringify(draw(look, t, [face, second])));
    }
  }
  const a = draw('pixelPanic', 1.0, [face]).effects[0].uniforms;
  const b = draw('pixelPanic', 1.5, [face]).effects[0].uniforms;
  expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  // Another face (another seed) tears other slices.
  const c = draw('pixelPanic', 1.0, [{ ...face, seed: 9 }]).effects[0].uniforms;
  expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
});

it('they are cheap enough to draw every frame, even with two faces', () => {
  for (const look of WARP_LOOKS) {
    for (let t = 0; t < 6; t += 0.25) {
      const { drawn, blurFilters } = draw(look, t, [face, second]);
      expect(drawn.length, look).toBeLessThanOrEqual(20);
      expect(drawn.filter((d) => d.blur).length, look).toBeLessThanOrEqual(4);
      expect(blurFilters.length).toBeLessThanOrEqual(2);
    }
  }
});

it('😃 Big Mouth: the balloon sits on the mouth, a bit above its middle, bigger with a bigger mouth', () => {
  const small = draw('bigMouth', 1, [{ ...face, mouth: 1.2 }]).effects[0].uniforms;
  const big = draw('bigMouth', 1, [{ ...face, mouth: 2 }]).effects[0].uniforms;
  // [center x, center y, axis x, axis y, radius across, radius down, scale]
  expect(big[0]).toBeCloseTo(200, 6);
  expect(big[1]).toBeLessThan(460);
  expect(big[1]).toBeGreaterThan(400);
  expect(big[6]).toBe(2);
  expect(big[4]).toBeGreaterThan(small[4]);
  // Never smaller than normal, and never wildly big (broken memory).
  expect(draw('bigMouth', 1, [{ ...face, mouth: 0.3 }]).effects[0].uniforms[6]).toBe(1);
  expect(draw('bigMouth', 1, [{ ...face, mouth: 40 }]).effects[0].uniforms[6]).toBe(3);
  // A face without the stretchy memory (made by an older app part) still draws, at normal size.
  const bare = { ...face };
  for (const key of ['mouth', 'mouthSpeed', 'tiny', 'chin', 'glitch', 'warpLevel']) delete bare[key];
  for (const look of WARP_LOOKS) expect(() => draw(look, 1, [bare])).not.toThrow();
});

it('🫥 Tiny Face: a blurred egg clipped to the face, soft shading, and the tiny face (about a third) in the middle', () => {
  const { steps, effects, blurFilters } = draw('tinyFace', 1, [face]);
  expect(steps.filter((s) => s.kind === 'clip').length).toBe(1);
  expect(blurFilters.length).toBe(1);
  expect(blurFilters[0].sigma).toBeGreaterThanOrEqual(7);
  // The egg is the camera picture blurred (no blend mode, no paint colour).
  expect(steps.find((s) => s.kind === 'rect' && s.blur).shader).toBe('camera');
  // [from x, from y, to x, to y, axis x, axis y, radius across, radius down, scale, feather]
  const u = effects[0].uniforms;
  expect(u[8]).toBeGreaterThan(0.25);
  expect(u[8]).toBeLessThan(0.45);
  expect(u[3]).toBeGreaterThan(u[1]);
  expect(u[9]).toBe(0.5);
});

it('🗿 Gigachin: the stretch starts under the lower lip, and the meter shows CHIN POWER, then GIGACHIN in gold', () => {
  const { effects, drawn } = draw('gigachin', 1, [face]);
  // [top x, top y, axis x, axis y, down x, down y, half width, height, sx, sy, release]
  const u = effects[0].uniforms;
  expect(u[1]).toBeGreaterThan(474);
  expect(u[1]).toBeLessThan(530);
  expect(u[9]).toBeCloseTo(1.15 + 0.6 * 0.62, 6);
  // The meter: a blurred glow, the purple pill and the words (one shape made of little squares).
  const words = drawn.filter((d) => d.kind === 'path' && d.rects > 10);
  expect(words.length).toBe(1);
  expect(words[0].color).toBe('#FFFFFF');
  const full = draw('gigachin', 1, [{ ...face, chin: 1 }]).drawn.filter((d) => d.kind === 'path' && d.rects > 10);
  expect(full[0].color).toBe('#FFE36B');
  // No power: no meter and no highlight, but still a big chin (the web version's always-on).
  const none = draw('gigachin', 1, [{ ...face, chin: 0 }]);
  expect(none.drawn.filter((d) => d.kind === 'path')).toEqual([]);
  expect(none.effects[0].uniforms[9]).toBeCloseTo(1.15 + 0.6 * 0.35, 6);
});

it('👾 Pixel Panic: torn slices and data bars come and go with the glitch, and the glitch line uses the camera picture', () => {
  const calm = draw('pixelPanic', 1, [{ ...face, glitch: 0, warpLevel: 0 }]);
  // [box (4), block, feather, level, count, 7 slices × 4]
  expect(calm.effects[0].uniforms[7]).toBe(0);
  expect(calm.effects[0].uniforms[4]).toBe(0);
  expect(calm.drawn.filter((d) => d.kind === 'path')).toEqual([]);
  const wild = draw('pixelPanic', 1, [face]).effects[0].uniforms;
  expect(wild[7]).toBe(7);
  expect(wild[4]).toBeGreaterThan(4);
  // Over many moments the glitch line shows now and then, drawn from the camera picture.
  let lines = 0;
  for (let t = 0; t < 30; t += 1 / 12) {
    const { drawn } = draw('pixelPanic', t, [face]);
    lines += drawn.filter((d) => d.kind === 'rect' && d.shader === 'camera').length;
  }
  expect(lines).toBeGreaterThan(5);
  expect(lines).toBeLessThan(200);
});

it('a face with broken points is skipped, not drawn with broken numbers', () => {
  const bad = { ...face, pts: face.pts.map((v, i) => (i === 152 * 2 ? NaN : v)) };
  for (const look of WARP_LOOKS) {
    const { steps, effects } = draw(look, 1, [bad]);
    expect(numbersIn(steps).every(Number.isFinite)).toBe(true);
    expect(numbersIn(effects).every(Number.isFinite)).toBe(true);
  }
});

// Everything Skia makes from the camera picture (the GPU programs' shaders, the paints that draw them, the blur) must
// go on the frame's trash list as soon as it is made: LensOverlay lets go of all of it right after the frame, on the
// drawing thread. Left to the garbage collector, they would hold camera pictures too long and could let go of them
// on another thread (a crash).
function uncollected(result) {
  const binned = new Set(result.trash);
  const fromCamera = (shader) => shader && (shader.kind === 'camera' || shader.kind === 'warp');
  const missing = [];
  for (const paint of result.paints) if (fromCamera(paint.shader) && !binned.has(paint)) missing.push(`paint with ${paint.shader.kind}`);
  for (const { shader } of result.warpShaders) if (!binned.has(shader)) missing.push(`${shader.name} shader`);
  for (const filter of result.blurObjects) if (!binned.has(filter)) missing.push('blur');
  return missing;
}

it('everything made from the camera picture goes on the frame\'s trash list, for every stretchy look', () => {
  let glitchLines = 0;
  for (const look of WARP_LOOKS) {
    for (let t = 0; t < 30; t += 1 / 12) {
      const result = draw(look, t, [face, second]);
      expect(uncollected(result), `${look} t=${t}`).toEqual([]);
      // Each GPU program looks at the camera picture itself.
      for (const { child } of result.warpShaders) expect(child.kind).toBe('camera');
      if (look === 'pixelPanic') glitchLines += result.drawn.filter((d) => d.kind === 'rect' && d.shader === 'camera').length;
      if (look === 'tinyFace') expect(result.blurObjects.length).toBe(2);
    }
  }
  // The glitch line (a paint with the camera picture) was really drawn, and checked, now and then.
  expect(glitchLines).toBeGreaterThan(5);
});

it('a frame that fails while drawing has still put what it made on the trash list', () => {
  for (const look of WARP_LOOKS) {
    // The canvas fails on the first warp, on the blurred egg, and on the glitch line.
    for (const kind of ['warp', 'camera']) {
      const throwOn = (paint) => paint.shader?.kind === kind;
      throwOn.expected = true;
      for (let t = 0; t < 30; t += 1 / 12) {
        const result = draw(look, t, [face, second], true, throwOn);
        if (!result.error) continue;
        expect(uncollected(result), `${look} ${kind} t=${t}`).toEqual([]);
        // The paint it was drawing with when it failed is on the list too.
        expect(result.trash.some((thing) => thing.shader?.kind === kind)).toBe(true);
      }
    }
  }
});
