// Main Character Mode 🌆: the app's own hole finder (src/lib/mainCharacter/holeFinder.ts) must agree with what the
// art script measured on the painted faces (src/lib/mainCharacter/art.generated.ios.ts). The app only uses the
// finder for online characters that come without their .json, so this keeps that guess honest: on the 6
// characters that come inside the app it must put the eyes and the forehead within 5 % of the hole's width of the
// measured ones (with the HOLE numbers in config.ts), find the same hole, pass its own shape check
// (HOLE_CHECK), and read a skin colour within 30 of the painted cheeks. The pictures are decoded with Skia's own
// web version (CanvasKit) and looked at in a 270 × 480 copy, the way the phone does it. Local files only.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../..');
const POSTER_W = 1080;
const POSTER_H = 1920;
const SMALL_W = 270;
const SMALL_H = 480;

// The generated list, with each picture's require() turned into its file path.
function loadArtList(file) {
  const path = resolve(root, 'src/lib/mainCharacter', file);
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: (id) => resolve(dirname(path), id) });
  return module.exports;
}

// Even-odd inside test for an outline of [x, y] points.
function inside(outline, px, py) {
  let yes = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [xi, yi] = outline[i];
    const [xj, yj] = outline[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) yes = !yes;
  }
  return yes;
}

// How much two outlines (in poster pixels) cover the same ground: shared area ÷ area of either.
function overlap(a, b) {
  const xs = [...a, ...b].map((p) => p[0]);
  const ys = [...a, ...b].map((p) => p[1]);
  let both = 0;
  let either = 0;
  for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
    for (let x = Math.floor(Math.min(...xs)); x <= Math.ceil(Math.max(...xs)); x++) {
      const inA = inside(a, x + 0.5, y + 0.5);
      const inB = inside(b, x + 0.5, y + 0.5);
      if (inA && inB) both++;
      if (inA || inB) either++;
    }
  }
  return both / either;
}

const poster = ([x, y]) => [x * POSTER_W, y * POSTER_H];
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

let CK;
let finder;
let characters;
const measured = {};

beforeAll(async () => {
  const ckPath = require.resolve('canvaskit-wasm/bin/canvaskit.js');
  CK = await require(ckPath)({ locateFile: (file) => resolve(dirname(ckPath), file) });
  finder = loadLibrary('mainCharacter/holeFinder');
  characters = loadArtList('art.generated.ios.ts').BUNDLED_CHARACTERS;
  for (const character of characters) {
    // As analyseArt.ts on the phone: the centred 9:16 part, drawn into 270 × 480, read back not premultiplied.
    const image = CK.MakeImageFromEncoded(readFileSync(character.image));
    const w = image.width();
    const h = image.height();
    const cropW = Math.min(w, (h * 9) / 16);
    const cropH = Math.min(h, (w * 16) / 9);
    const surface = CK.MakeSurface(SMALL_W, SMALL_H);
    const canvas = surface.getCanvas();
    canvas.clear(CK.TRANSPARENT);
    const paint = new CK.Paint();
    canvas.drawImageRect(image, CK.XYWHRect((w - cropW) / 2, (h - cropH) / 2, cropW, cropH), CK.XYWHRect(0, 0, SMALL_W, SMALL_H), paint, false);
    const snapshot = surface.makeImageSnapshot();
    const rgba = snapshot.readPixels(0, 0, {
      width: SMALL_W, height: SMALL_H, colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB,
    });
    const shape = finder.findFaceHole(rgba, SMALL_W, SMALL_H);
    const tone = shape ? finder.skinToneAround(rgba, SMALL_W, SMALL_H, shape) : null;
    measured[character.slug] = { shape, tone, guess: shape ? finder.anchorsFromHole(shape, tone) : null };
    [snapshot, surface, image].forEach((thing) => thing.delete());
    paint.delete();
  }
}, 60_000);

describe('the app finds the face hole in every bundled character the way the art script measured it', () => {
  it('there are 6 bundled characters to check', () => {
    expect(characters.map((c) => c.slug)).toEqual(['street-boss', 'getaway-driver', 'beach-hustler', 'night-rider', 'rich-mogul', 'mall-cop']);
  });

  it('finds a hole in each, and each hole passes the app\'s own shape check (HOLE_CHECK)', () => {
    for (const { slug } of characters) {
      const { shape } = measured[slug];
      expect(shape, slug).not.toBeNull();
      expect(shape.points).toHaveLength(72);
      expect({ slug, looksRight: finder.holeLooksRight(shape), box: shape.box, fill: shape.fill }).toMatchObject({ looksRight: true });
    }
  });

  it('finds the same hole (the two outlines overlap by more than 90 %)', () => {
    for (const { slug, anchors } of characters) {
      const found = [];
      for (let i = 0; i < 72; i += 2) found.push(poster([measured[slug].shape.points[i], measured[slug].shape.points[i + 1]]));
      const share = overlap(found, anchors.hole.map(poster));
      expect(share, slug).toBeGreaterThan(0.9);
    }
  });

  it('guesses both eye middles and the forehead within 5 % of the hole width (the HOLE numbers in config.ts)', () => {
    for (const { slug, anchors } of characters) {
      const { guess } = measured[slug];
      const holeX = anchors.hole.map((p) => p[0] * POSTER_W);
      const limit = 0.05 * (Math.max(...holeX) - Math.min(...holeX));
      const misses = {
        eyeA: distance(poster(guess.eyes[0]), poster(anchors.eyes[0])),
        eyeB: distance(poster(guess.eyes[1]), poster(anchors.eyes[1])),
        forehead: distance(poster(guess.forehead), poster(anchors.forehead)),
      };
      for (const [what, miss] of Object.entries(misses)) expect(miss, `${slug} ${what} (limit ${limit.toFixed(1)} px)`).toBeLessThanOrEqual(limit);
      // The rest of the guess has the right shape too.
      expect(guess.hole).toHaveLength(36);
      expect(guess.eyes[0][0]).toBeLessThan(guess.eyes[1][0]);
      expect(guess.faceWidth / anchors.faceWidth, slug).toBeGreaterThan(0.95);
      expect(guess.faceWidth / anchors.faceWidth, slug).toBeLessThan(1.05);
    }
  });

  it('reads a skin colour round the hole within 30 of the painted cheeks, and is sure of it', () => {
    for (const { slug, anchors } of characters) {
      const { tone } = measured[slug];
      expect(tone.sure, slug).toBe(true);
      const worst = Math.max(...tone.rgb.map((v, i) => Math.abs(v - anchors.skinTone[i])));
      expect(worst, `${slug}: ring ${tone.rgb} vs cheeks ${anchors.skinTone}`).toBeLessThanOrEqual(30);
    }
  });
});
