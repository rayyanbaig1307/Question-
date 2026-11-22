// Main Character Mode 🌆: the art that comes inside the app (scripts/make-main-character-assets.py writes all of
// it). The iPhone list (src/lib/mainCharacter/art.generated.ios.ts) must name exactly the pictures in
// assets/main-character/, each a 1080 × 1920 WebP that Skia can decode – characters with see-through parts,
// scenes without – with sensible anchors. The Android and web list (art.generated.ts) must be empty, so their
// updates carry no art. And no picture may carry anything but picture data: the source files had the art tool's
// job id in them, and nothing like that may reach the app. Local files only.
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../..');
const ART = resolve(root, 'assets/main-character');

// A generated list, with each require() turned into the file path it points at (and the ids it asked for kept).
function loadArtList(file) {
  const path = resolve(root, 'src/lib/mainCharacter', file);
  const source = readFileSync(path, 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  const asked = [];
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    require: (id) => { asked.push(id); return resolve(dirname(path), id); },
  });
  return { ...module.exports, source, asked };
}

// The chunks of a WebP file (RIFF): name, size and where its data starts. Throws on a broken file.
function webpChunks(bytes) {
  if (bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WEBP') throw new Error('not a WebP file');
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) throw new Error('the RIFF size does not match the file (extra bytes at the end?)');
  const chunks = [];
  let at = 12;
  while (at < bytes.length) {
    const name = bytes.toString('latin1', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    chunks.push({ name, size, start: at + 8 });
    at += 8 + size + (size & 1);
  }
  if (at !== bytes.length) throw new Error('broken chunks');
  return chunks;
}

let CK;
let finder;
let config;
let ios;
let empty;
const decoded = new Map();   // file → { width, height, alpha: Uint8Array of alpha values }

beforeAll(async () => {
  const ckPath = require.resolve('canvaskit-wasm/bin/canvaskit.js');
  CK = await require(ckPath)({ locateFile: (file) => resolve(dirname(ckPath), file) });
  finder = loadLibrary('mainCharacter/holeFinder');
  config = loadLibrary('mainCharacter/config');
  ios = loadArtList('art.generated.ios.ts');
  empty = loadArtList('art.generated.ts');
  for (const file of [...ios.BUNDLED_CHARACTERS, ...ios.BUNDLED_SCENES].map((art) => art.image)) {
    const image = CK.MakeImageFromEncoded(readFileSync(file));
    if (!image) continue;
    const pixels = image.readPixels(0, 0, {
      width: image.width(), height: image.height(), colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB,
    });
    const alpha = new Uint8Array(pixels.length / 4);
    for (let i = 0; i < alpha.length; i++) alpha[i] = pixels[i * 4 + 3];
    decoded.set(file, { width: image.width(), height: image.height(), alpha });
    image.delete();
  }
}, 60_000);

describe('the iPhone list names exactly the bundled pictures', () => {
  it('6 characters and 6 scenes, in the planned order, every require() pointing at a real file', () => {
    expect(ios.BUNDLED_CHARACTERS.map((c) => c.slug)).toEqual(['street-boss', 'getaway-driver', 'beach-hustler', 'night-rider', 'rich-mogul', 'mall-cop']);
    expect(ios.BUNDLED_SCENES.map((s) => s.slug)).toEqual(['beach-drive', 'neon-street', 'marina', 'rooftop', 'coast-highway', 'mall-plaza']);
    expect(ios.asked).toHaveLength(12);
    for (const id of ios.asked) expect(id).toMatch(/^\.\.\/\.\.\/\.\.\/assets\/main-character\/(characters|backgrounds)\/[a-z0-9-]+\.webp$/);
    for (const art of [...ios.BUNDLED_CHARACTERS, ...ios.BUNDLED_SCENES]) expect(existsSync(art.image), art.image).toBe(true);
  });

  it('assets/main-character holds those 12 files and nothing else', () => {
    const onDisk = [];
    for (const folder of readdirSync(ART)) {
      expect(['characters', 'backgrounds']).toContain(folder);
      for (const file of readdirSync(resolve(ART, folder))) onDisk.push(`${folder}/${file}`);
    }
    const listed = [...ios.BUNDLED_CHARACTERS, ...ios.BUNDLED_SCENES].map((art) => relative(ART, art.image).split('\\').join('/'));
    expect(onDisk.sort()).toEqual(listed.sort());
    for (const c of ios.BUNDLED_CHARACTERS) expect(relative(ART, c.image).split('\\').join('/')).toBe(`characters/${c.slug}.webp`);
    for (const s of ios.BUNDLED_SCENES) expect(relative(ART, s.image).split('\\').join('/')).toBe(`backgrounds/${s.slug}.webp`);
  });

  it('names come from the file names, every slug is used once, and every character\'s own scene exists', () => {
    const scenes = new Set(ios.BUNDLED_SCENES.map((s) => s.slug));
    for (const art of [...ios.BUNDLED_CHARACTERS, ...ios.BUNDLED_SCENES]) {
      expect(art.name).toBe(finder.nameFromSlug(art.slug));
      expect(finder.slugFromFile(`${art.slug}.webp`)).toBe(art.slug);
    }
    expect(new Set(ios.BUNDLED_CHARACTERS.map((c) => c.slug)).size).toBe(6);
    expect(scenes.size).toBe(6);
    for (const c of ios.BUNDLED_CHARACTERS) expect(scenes.has(c.scene), `${c.slug} → ${c.scene}`).toBe(true);
    // Each scene is some character's own scene.
    expect(new Set(ios.BUNDLED_CHARACTERS.map((c) => c.scene))).toEqual(scenes);
  });

  it('both lists say they are made by the script', () => {
    for (const list of [ios, empty]) expect(list.source.startsWith('// Made by scripts/make-main-character-assets.py')).toBe(true);
  });
});

describe('Android and web get no art', () => {
  it('art.generated.ts is the empty list and asks for no files', () => {
    expect(empty.BUNDLED_CHARACTERS).toEqual([]);
    expect(empty.BUNDLED_SCENES).toEqual([]);
    expect(empty.asked).toEqual([]);
    expect(empty.source).not.toMatch(/require\s*\(/);
    expect(Object.keys(empty).filter((k) => k.startsWith('BUNDLED')).sort()).toEqual(Object.keys(ios).filter((k) => k.startsWith('BUNDLED')).sort());
  });
});

describe('the pictures', () => {
  it('each decodes (as Skia does on the phone) to 1080 × 1920 and is no bigger than the online limit', () => {
    for (const art of [...ios.BUNDLED_CHARACTERS, ...ios.BUNDLED_SCENES]) {
      const picture = decoded.get(art.image);
      expect(picture, art.slug).toBeDefined();
      expect([picture.width, picture.height], art.slug).toEqual([config.POSTER_W, config.POSTER_H]);
      expect(statSync(art.image).size, art.slug).toBeLessThanOrEqual(config.MAX_ART_BYTES);
    }
  });

  it('characters have see-through parts (round them and the face hole), scenes have none', () => {
    for (const c of ios.BUNDLED_CHARACTERS) {
      const { alpha } = decoded.get(c.image);
      const clear = alpha.reduce((n, a) => n + (a === 0 ? 1 : 0), 0);
      expect(clear / alpha.length, c.slug).toBeGreaterThan(0.1);
      // The face hole itself: the middle of the eyes is see-through.
      const [[ax, ay], [bx, by]] = c.anchors.eyes;
      const x = Math.round(((ax + bx) / 2) * config.POSTER_W);
      const y = Math.round(((ay + by) / 2) * config.POSTER_H);
      expect(alpha[y * config.POSTER_W + x], `${c.slug} between the eyes`).toBe(0);
    }
    for (const s of ios.BUNDLED_SCENES) {
      const { alpha } = decoded.get(s.image);
      expect(alpha.every((a) => a === 255), s.slug).toBe(true);
    }
  });

  it('every WebP holds picture data only: no EXIF, XMP, colour profile, text or anything after the picture', () => {
    for (const art of [...ios.BUNDLED_CHARACTERS, ...ios.BUNDLED_SCENES]) {
      const bytes = readFileSync(art.image);
      const chunks = webpChunks(bytes);
      for (const chunk of chunks) expect(['VP8 ', 'VP8L', 'VP8X', 'ALPH'], `${art.slug}: ${JSON.stringify(chunk.name)}`).toContain(chunk.name);
      const extended = chunks.find((chunk) => chunk.name === 'VP8X');
      if (extended) {
        // Flags: 0x20 colour profile, 0x10 alpha, 0x08 EXIF, 0x04 XMP, 0x02 animation – only alpha may be on.
        expect(bytes[extended.start] & 0x2e, art.slug).toBe(0);
      }
      expect(chunks.some((chunk) => chunk.name === 'ALPH'), art.slug).toBe(ios.BUNDLED_CHARACTERS.includes(art));
      // Belt and braces: no job-id-like text anywhere in the file.
      const text = bytes.toString('latin1');
      expect(text, art.slug).not.toMatch(/job-id|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    }
  });
});

describe('the anchors (where the face goes)', () => {
  const isUnit = (v) => Number.isFinite(v) && v >= 0 && v <= 1;
  const isPoint = (p) => Array.isArray(p) && p.length === 2 && p.every(isUnit);

  it('are finite, in 0–1, with 36 hole points, a sure skin tone and a sensible face width', () => {
    for (const { slug, anchors: a } of ios.BUNDLED_CHARACTERS) {
      expect(a.eyes.every(isPoint) && [a.nose, a.chin, a.forehead].every(isPoint), slug).toBe(true);
      expect(a.hole, slug).toHaveLength(36);
      expect(a.hole.every(isPoint), slug).toBe(true);
      expect(a.faceWidth, slug).toBeGreaterThan(0.15);
      expect(a.faceWidth, slug).toBeLessThan(0.4);
      expect(a.skinTone, slug).toHaveLength(3);
      expect(a.skinTone.every((v) => Number.isInteger(v) && v >= 0 && v <= 255), slug).toBe(true);
      expect(a.toneSure, slug).toBe(true);
    }
  });

  it('have the face in order: eyes picture-left first, then forehead above the eyes, nose, chin', () => {
    for (const { slug, anchors: a } of ios.BUNDLED_CHARACTERS) {
      expect(a.eyes[0][0], slug).toBeLessThan(a.eyes[1][0]);
      const eyeY = (a.eyes[0][1] + a.eyes[1][1]) / 2;
      expect(a.forehead[1], slug).toBeLessThan(eyeY);
      expect(a.nose[1], slug).toBeGreaterThan(eyeY);
      expect(a.chin[1], slug).toBeGreaterThan(a.nose[1]);
      // Eyes and nose sit inside the hole's box.
      const xs = a.hole.map((p) => p[0]);
      const ys = a.hole.map((p) => p[1]);
      for (const [x, y] of [...a.eyes, a.nose]) {
        expect(x > Math.min(...xs) && x < Math.max(...xs) && y > Math.min(...ys) && y < Math.max(...ys), slug).toBe(true);
      }
    }
  });

  it('list the hole from the top, clockwise on screen', () => {
    for (const { slug, anchors: a } of ios.BUNDLED_CHARACTERS) {
      const top = Math.min(...a.hole.map((p) => p[1]));
      expect(a.hole[0][1] - top, slug).toBeLessThan(0.002);
      let turn = 0;   // > 0 = clockwise when y points down (in poster pixels, so the picture's shape counts)
      for (let i = 0; i < 36; i++) {
        const [x1, y1] = a.hole[i];
        const [x2, y2] = a.hole[(i + 1) % 36];
        turn += x1 * config.POSTER_W * y2 * config.POSTER_H - x2 * config.POSTER_W * y1 * config.POSTER_H;
      }
      expect(turn, slug).toBeGreaterThan(0);
    }
  });
});
