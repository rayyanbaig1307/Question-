import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

// The small white Peekaboo wordmark on pictures that leave the app (src/lib/watermark.ts):
// - where it goes (top left, 20 % wide, 5 % in; 11.5 % down on tall pictures, else 5 %);
// - it makes a NEW file and never touches (or returns) the one it was given;
// - without Skia (Expo Go, web, old downloads) or when anything fails it says null, so Save and Share use the
//   clean file;
// - on an iPhone it draws on a Display P3 surface (the photo keeps its wide colours and the JPEG says so), with the
//   plain surface as the fallback; elsewhere always the plain surface;
// - drawn for real with CanvasKit (Skia for tests): the wordmark lands in its spot, the rest of the picture is
//   untouched, and the picture keeps its size.

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../..');
const WORDMARK_ID = 4242;
const WORDMARK_URI = 'file:///bundle/wordmark-white.png';
const NOW = 1_763_800_000_000;

// A pretend phone file system: `files` maps file:// names to bytes.
function fakeFiles(files, log) {
  class File {
    constructor(...parts) {
      this.uri = parts.join('');
    }
    get exists() {
      return files.has(this.uri);
    }
    async arrayBuffer() {
      log.push(['read', this.uri]);
      if (!files.has(this.uri)) throw new Error(`no file ${this.uri}`);
      const bytes = files.get(this.uri);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    async write(bytes) {
      log.push(['write', this.uri, bytes.length]);
      files.set(this.uri, bytes);
    }
  }
  return { File, Paths: { cache: 'file:///cache/' } };
}

// Loads src/lib/watermark.ts. `skia`: the Skia module (null = this download has none). `asset`: what the
// bundled wordmark gives (its file name after downloadAsync). `os`: Platform.OS.
function loadWatermark({ skia = null, files = new Map(), asset = WORDMARK_URI, now = NOW, os = 'android' } = {}) {
  const log = [];
  const required = [];
  const mocks = {
    'react-native': { TurboModuleRegistry: { get: (name) => (name === 'RNSkiaModule' && skia ? {} : null) }, Platform: { OS: os } },
    'expo-file-system': fakeFiles(files, log),
    'expo-asset': {
      Asset: {
        fromModule: (id) => {
          log.push(['asset', id]);
          const thing = { localUri: null, downloadAsync: async () => { thing.localUri = asset; return thing; } };
          return thing;
        },
      },
    },
    '../../assets/images/wordmark-white.png': WORDMARK_ID,
  };
  if (skia) mocks['@shopify/react-native-skia'] = skia;
  // Notes every import the file asks for (the loader looks each one up in `mocks`).
  const guarded = new Proxy(mocks, {
    getOwnPropertyDescriptor: (target, id) => { required.push(id); return Object.getOwnPropertyDescriptor(target, id); },
  });
  const warnings = [];
  const lib = loadLibrary('watermark', {
    mocks: guarded,
    globals: { Date: { now: () => now }, console: { ...console, warn: (...args) => warnings.push(args) } },
  });
  return { lib, log, files, required, warnings };
}

describe('watermarkRect', () => {
  it('a 9:16 picture (the poster, phone photos): top left, 20 % wide, its top 11.5 % down', () => {
    const { lib } = loadWatermark();
    const r = lib.watermarkRect(1080, 1920);
    expect(r.x).toBeCloseTo(54, 6);
    expect(r.width).toBeCloseTo(216, 6);
    expect(r.height).toBeCloseTo(216 * 240 / 1171, 6);
    expect(r.y).toBeCloseTo(220.8, 6);
    // Below the other apps' own top bars (about the top 9 %), in the top quarter of the picture.
    expect(r.y).toBeGreaterThan(0.09 * 1920);
    expect(r.y + r.height).toBeLessThan(1920 / 4);
    // The same shape at another size gives the same spot.
    const small = lib.watermarkRect(540, 960);
    expect(small.x * 2).toBeCloseTo(r.x, 6);
    expect(small.y * 2).toBeCloseTo(r.y, 6);
    expect(small.width * 2).toBeCloseTo(r.width, 6);
  });

  it('a 3:4 picture (and a square one): 5 % down', () => {
    const { lib } = loadWatermark();
    const r = lib.watermarkRect(1080, 1440);
    expect(r.x).toBeCloseTo(54, 6);
    expect(r.y).toBeCloseTo(72, 6);
    expect(r.width).toBeCloseTo(216, 6);
    expect(lib.watermarkRect(1000, 1000).y).toBeCloseTo(50, 6);
    // A wide picture too.
    expect(lib.watermarkRect(1920, 1080).y).toBeCloseTo(54, 6);
  });

  it('"tall" starts at 1.6 times taller than wide', () => {
    const { lib } = loadWatermark();
    expect(lib.watermarkRect(1000, 1600).y).toBeCloseTo(184, 6);
    expect(lib.watermarkRect(1000, 1599).y).toBeCloseTo(79.95, 6);
  });

  it('keeps the wordmark picture\'s shape (1171 × 240) and the numbers in WATERMARK', () => {
    const { lib } = loadWatermark();
    expect(lib.WATERMARK).toEqual({ width: 0.2, side: 0.05, tallTop: 0.115, top: 0.05, opacity: 0.9 });
    const r = lib.watermarkRect(1170, 2532);
    expect(r.width / r.height).toBeCloseTo(1171 / 240, 6);
  });

  it('a picture with no real size gives all zeros (never NaN)', () => {
    const { lib } = loadWatermark();
    for (const [w, h] of [[0, 1920], [1080, 0], [-1, 5], [NaN, 100], [100, Infinity], [Infinity, Infinity]]) {
      expect(lib.watermarkRect(w, h), `${w}×${h}`).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    }
  });
});

describe('watermarkPhoto without Skia', () => {
  it('says null, never loads Skia, and leaves the file alone (Expo Go, web, old downloads)', async () => {
    const files = new Map([['file:///photo.jpg', new Uint8Array([1, 2, 3])]]);
    const { lib, log, required } = loadWatermark({ skia: null, files });
    await expect(lib.watermarkPhoto('file:///photo.jpg')).resolves.toBeNull();
    expect(required).not.toContain('@shopify/react-native-skia');
    expect(log).toEqual([]);
    expect([...files.keys()]).toEqual(['file:///photo.jpg']);
  });

  it('nothing happens when the file loads (no Skia, no asset, no file reads)', () => {
    const { log, required } = loadWatermark({ skia: null });
    expect(log).toEqual([]);
    // (The list of what it loaded works: these are the file's own imports.)
    expect(required).toEqual(expect.arrayContaining(['expo-asset', 'expo-file-system', 'react-native']));
    expect(required).not.toContain('@shopify/react-native-skia');
  });
});

// ---------------------------------------------------------------------------
// A pretend Skia that writes down what it was asked to do.
// ---------------------------------------------------------------------------
// `p3`: what Surface.MakeOffscreen(w, h, { colorSpace: 'display-p3' }) does – 'works', 'null', 'throws' or 'missing'
// (no such function).
function recordingSkia({ photoSize = [1080, 1920], decode = true, markDecode = true, encodeThrows = false, surface = true, p3 = 'works' } = {}) {
  const calls = [];
  const made = [];
  const thing = (kind, extra = {}) => {
    const object = { kind, disposed: false, dispose() { object.disposed = true; }, ...extra };
    made.push(object);
    return object;
  };
  const makeSurface = (kind) => {
    const canvas = {
      drawImage: (image, x, y) => calls.push(['drawImage', image.kind, x, y, kind]),
      drawImageRectOptions: (image, src, dst, fm, mm, paint) => calls.push(['drawImageRect', image.kind, src, dst, fm, mm, paint.state]),
    };
    return thing(kind, {
      getCanvas: () => canvas,
      flush: () => calls.push(['flush']),
      makeImageSnapshot: () => thing('snapshot', {
        encodeToBytes: (format, quality) => {
          calls.push(['encode', format, quality]);
          if (encodeThrows) throw new Error('could not encode');
          return new Uint8Array([0xff, 0xd8, 0xff, 7, 7, 7]);
        },
      }),
    });
  };
  const skia = {
    FilterMode: { Linear: 'linear' },
    MipmapMode: { Linear: 'mip-linear' },
    ImageFormat: { JPEG: 'jpeg', PNG: 'png' },
    Skia: {
      Data: { fromBytes: (bytes) => thing('data', { bytes }) },
      Image: {
        MakeImageFromEncoded: (data) => {
          const isMark = data.bytes[0] === 0x4d;
          calls.push(['decode', isMark ? 'mark' : 'photo']);
          if (isMark) return markDecode ? thing('mark', { width: () => 1171, height: () => 240 }) : null;
          return decode ? thing('photo', { width: () => photoSize[0], height: () => photoSize[1] }) : null;
        },
      },
      Surface: {
        Make: (w, h) => {
          calls.push(['surface', w, h]);
          return surface ? makeSurface('surface') : null;
        },
        ...(p3 === 'missing' ? {} : {
          MakeOffscreen: (w, h, options) => {
            calls.push(['p3 surface', w, h, options]);
            if (p3 === 'throws') throw new Error('no GPU here');
            return p3 === 'works' ? makeSurface('p3 surface') : null;
          },
        }),
      },
      ImageFilter: {
        MakeDropShadow: (dx, dy, sx, sy, color, input) => thing('shadow', { args: [dx, dy, sx, sy, color, input] }),
      },
      Color: (text) => `color(${text})`,
      Paint: () => {
        const paint = thing('paint', { state: {} });
        paint.setAntiAlias = (on) => { paint.state.antiAlias = on; };
        paint.setAlphaf = (alpha) => { paint.state.alpha = alpha; };
        paint.setImageFilter = (filter) => { paint.state.filter = filter.args; };
        return paint;
      },
      XYWHRect: (x, y, width, height) => ({ x, y, width, height }),
    },
  };
  return { skia, calls, made };
}

const PHOTO = 'file:///cache/photo-in.jpg';
const markBytes = () => new Uint8Array([0x4d, 1, 2]);
const photoBytes = () => new Uint8Array([0x50, 1, 2]);

describe('watermarkPhoto with a pretend Skia', () => {
  it('makes a NEW JPEG (quality 92) in the cache with the wordmark in its spot, and never touches the original', async () => {
    const { skia, calls, made } = recordingSkia();
    const files = new Map([[PHOTO, photoBytes()], [WORDMARK_URI, markBytes()]]);
    const { lib, log } = loadWatermark({ skia, files });
    const out = await lib.watermarkPhoto(PHOTO);
    expect(out).toBe(`file:///cache/peekaboo-${NOW}.jpg`);
    expect(out).not.toBe(PHOTO);
    // The original is only read, never written.
    expect(log.filter(([what, uri]) => what === 'write' && uri === PHOTO)).toEqual([]);
    expect(Array.from(files.get(PHOTO))).toEqual(Array.from(photoBytes()));
    expect(log.filter(([what]) => what === 'write')).toEqual([['write', out, 6]]);
    // The bundled wordmark picture.
    expect(log[0]).toEqual(['asset', WORDMARK_ID]);

    const r = lib.watermarkRect(1080, 1920);
    expect(calls).toEqual([
      ['decode', 'mark'],
      ['decode', 'photo'],
      ['surface', 1080, 1920],
      ['drawImage', 'photo', 0, 0, 'surface'],
      ['drawImageRect', 'mark', { x: 0, y: 0, width: 1171, height: 240 }, { x: r.x, y: r.y, width: r.width, height: r.height },
        'linear', 'mip-linear', { antiAlias: true, alpha: 0.9, filter: [0, 2, 3, 3, 'color(rgba(0,0,0,0.35))', null] }],
      ['flush'],
      ['encode', 'jpeg', 92],
    ]);
    // Everything made for this picture is freed (the wordmark itself is kept for next time).
    for (const object of made.filter((o) => !['mark', 'data'].includes(o.kind))) expect(object.disposed, object.kind).toBe(true);
    expect(made.find((o) => o.kind === 'mark').disposed).toBe(false);
  });

  it('a bigger picture gets a bigger shadow (the same look as on a 1080-wide one)', async () => {
    const { skia, calls } = recordingSkia({ photoSize: [2160, 2880] });
    const { lib } = loadWatermark({ skia, files: new Map([[PHOTO, photoBytes()], [WORDMARK_URI, markBytes()]]) });
    await lib.watermarkPhoto(PHOTO);
    const draw = calls.find(([what]) => what === 'drawImageRect');
    expect(draw[6].filter).toEqual([0, 4, 6, 6, 'color(rgba(0,0,0,0.35))', null]);
    expect(draw[3].y).toBeCloseTo(0.05 * 2880, 6);
  });

  it('the wordmark is read once and kept for the next picture', async () => {
    const { skia, calls } = recordingSkia();
    const { lib, log } = loadWatermark({ skia, files: new Map([[PHOTO, photoBytes()], [WORDMARK_URI, markBytes()]]) });
    const first = await lib.watermarkPhoto(PHOTO);
    const second = await lib.watermarkPhoto(PHOTO);
    expect(log.filter(([what]) => what === 'asset')).toHaveLength(1);
    expect(calls.filter(([what, kind]) => what === 'decode' && kind === 'mark')).toHaveLength(1);
    // Two pictures in the same millisecond still get two different files.
    expect(first).toBe(`file:///cache/peekaboo-${NOW}.jpg`);
    expect(second).toBe(`file:///cache/peekaboo-${NOW}-1.jpg`);
  });

  it('never hands back the file it was given, even if that has the name it would pick', async () => {
    const same = `file:///cache/peekaboo-${NOW}.jpg`;
    const { skia } = recordingSkia();
    const files = new Map([[same, photoBytes()], [WORDMARK_URI, markBytes()]]);
    const { lib, log } = loadWatermark({ skia, files });
    const out = await lib.watermarkPhoto(same);
    expect(out).not.toBe(same);
    expect(out).toBe(`file:///cache/peekaboo-${NOW}-1.jpg`);
    expect(Array.from(files.get(same))).toEqual(Array.from(photoBytes()));
    expect(log.filter(([what, uri]) => what === 'write' && uri === same)).toEqual([]);
  });

  it.each([
    ['the photo cannot be read', { decode: false }, {}],
    ['the wordmark picture cannot be read', { markDecode: false }, {}],
    ['no memory for the picture', { surface: false }, {}],
    ['the JPEG cannot be made', { encodeThrows: true }, {}],
    ['the bundled wordmark has no file', {}, { asset: null }],
    ['the photo file is missing', {}, { missingPhoto: true }],
    ['the picture has no size', { photoSize: [0, 0] }, {}],
  ])('says null (the clean file is used) when %s, and never throws', async (_what, skiaOptions, { asset = WORDMARK_URI, missingPhoto = false }) => {
    const { skia, made } = recordingSkia(skiaOptions);
    const files = new Map([[WORDMARK_URI, markBytes()]]);
    if (!missingPhoto) files.set(PHOTO, photoBytes());
    const { lib, log } = loadWatermark({ skia, files, asset });
    await expect(lib.watermarkPhoto(PHOTO)).resolves.toBeNull();
    expect(log.filter(([what]) => what === 'write')).toEqual([]);
    for (const object of made.filter((o) => ['photo', 'surface', 'snapshot', 'paint', 'shadow'].includes(o.kind))) {
      expect(object.disposed, object.kind).toBe(true);
    }
  });

  it('on an iPhone it draws on a Display P3 surface, so wide-colour photos keep their colours (and the JPEG says so)', async () => {
    const { skia, calls, made } = recordingSkia();
    const { lib } = loadWatermark({ skia, os: 'ios', files: new Map([[PHOTO, photoBytes()], [WORDMARK_URI, markBytes()]]) });
    const out = await lib.watermarkPhoto(PHOTO);
    expect(out).toBe(`file:///cache/peekaboo-${NOW}.jpg`);
    // Only the P3 surface, the same size as the photo; the photo, then the wordmark, are drawn on it.
    expect(calls.filter(([what]) => what.endsWith('surface'))).toEqual([['p3 surface', 1080, 1920, { colorSpace: 'display-p3' }]]);
    expect(calls.find(([what]) => what === 'drawImage')).toEqual(['drawImage', 'photo', 0, 0, 'p3 surface']);
    expect(calls.at(-1)).toEqual(['encode', 'jpeg', 92]);
    expect(made.find((o) => o.kind === 'p3 surface').disposed).toBe(true);
  });

  it.each([
    ['can\'t make one', 'null'],
    ['throws', 'throws'],
    ['doesn\'t have one', 'missing'],
  ])('on an iPhone whose Skia %s, it uses the plain surface (the wordmark still goes on)', async (_what, p3) => {
    const { skia, calls } = recordingSkia({ p3 });
    const { lib } = loadWatermark({ skia, os: 'ios', files: new Map([[PHOTO, photoBytes()], [WORDMARK_URI, markBytes()]]) });
    await expect(lib.watermarkPhoto(PHOTO)).resolves.toBe(`file:///cache/peekaboo-${NOW}.jpg`);
    expect(calls.find(([what]) => what === 'drawImage')).toEqual(['drawImage', 'photo', 0, 0, 'surface']);
    expect(calls.filter(([what]) => what === 'surface')).toEqual([['surface', 1080, 1920]]);
  });

  it('on Android it never asks for the P3 surface', async () => {
    const { skia, calls } = recordingSkia();
    const { lib } = loadWatermark({ skia, os: 'android', files: new Map([[PHOTO, photoBytes()], [WORDMARK_URI, markBytes()]]) });
    await lib.watermarkPhoto(PHOTO);
    expect(calls.filter(([what]) => what.endsWith('surface'))).toEqual([['surface', 1080, 1920]]);
  });

  it('a wordmark that failed once is tried again next time', async () => {
    const { skia } = recordingSkia();
    const files = new Map([[PHOTO, photoBytes()]]);
    const { lib } = loadWatermark({ skia, files });
    await expect(lib.watermarkPhoto(PHOTO)).resolves.toBeNull();
    files.set(WORDMARK_URI, markBytes());
    await expect(lib.watermarkPhoto(PHOTO)).resolves.toMatch(/^file:\/\/\/cache\/peekaboo-\d+\.jpg$/);
  });
});

// ---------------------------------------------------------------------------
// For real: CanvasKit (Skia built for tests) behind the same calls the phone's Skia has. CanvasKit can't write
// JPEGs, so the stand-in writes a PNG when a JPEG is asked for (and notes the ask) – which also lets us compare
// pixels exactly.
// ---------------------------------------------------------------------------
let CK;
beforeAll(async () => {
  const ckPath = require.resolve('canvaskit-wasm/bin/canvaskit.js');
  CK = await require(ckPath)({ locateFile: (file) => resolve(dirname(ckPath), file) });
});

// A CanvasKit surface in the Display P3 colours (what the phone's Surface.MakeOffscreen(w, h, { colorSpace:
// 'display-p3' }) makes), with its own memory.
function p3Surface(w, h) {
  const pixels = CK.Malloc(Uint8Array, w * h * 4);
  const info = { width: w, height: h, colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Premul, colorSpace: CK.ColorSpace.DISPLAY_P3 };
  const surface = CK.MakeRasterDirectSurface(info, pixels, w * 4);
  return { surface, free: () => CK.Free(pixels) };
}

function canvasKitSkia(asked, made = []) {
  const wrap = (surface, free = () => {}) => {
    if (!surface) return null;
    return {
      getCanvas: () => surface.getCanvas(),
      flush: () => surface.flush(),
      makeImageSnapshot: () => {
        const image = surface.makeImageSnapshot();
        return {
          encodeToBytes: (format, quality) => { asked.push([format, quality]); return image.encodeToBytes(CK.ImageFormat.PNG, 100); },
          dispose: () => image.delete(),
        };
      },
      dispose: () => { surface.delete(); free(); },
    };
  };
  return {
    FilterMode: { Linear: CK.FilterMode.Linear },
    MipmapMode: { Linear: CK.MipmapMode.Linear },
    ImageFormat: { JPEG: 'jpeg' },
    Skia: {
      Data: { fromBytes: (bytes) => bytes },
      Image: { MakeImageFromEncoded: (bytes) => CK.MakeImageFromEncoded(bytes) },
      Surface: {
        Make: (w, h) => { made.push('plain'); return wrap(CK.MakeSurface(w, h)); },
        MakeOffscreen: (w, h, options) => {
          if (options?.colorSpace !== 'display-p3') return null;
          made.push('p3');
          const { surface, free } = p3Surface(w, h);
          return wrap(surface, free);
        },
      },
      ImageFilter: { MakeDropShadow: (dx, dy, sx, sy, color, input) => CK.ImageFilter.MakeDropShadow(dx, dy, sx, sy, color, input) },
      Color: (text) => CK.parseColorString(text),
      Paint: () => new CK.Paint(),
      XYWHRect: (x, y, w, h) => CK.XYWHRect(x, y, w, h),
    },
  };
}

// A plain sky-blue picture w × h, as PNG bytes.
function skyPicture(w, h) {
  const surface = CK.MakeSurface(w, h);
  surface.getCanvas().clear(CK.Color(70, 130, 200, 1));
  const bytes = surface.makeImageSnapshot().encodeToBytes(CK.ImageFormat.PNG, 100);
  surface.delete();
  return bytes;
}

// A wide-colour (Display P3) photo, like an iPhone's: a plain orange w × h, as PNG bytes that say they are P3.
function wideColourPicture(w, h) {
  const { surface, free } = p3Surface(w, h);
  surface.getCanvas().clear(CK.Color(220, 120, 60, 1));
  const bytes = surface.makeImageSnapshot().encodeToBytes(CK.ImageFormat.PNG, 100);
  surface.delete();
  free();
  return bytes;
}

function pixelsOf(bytes, colorSpace = CK.ColorSpace.SRGB) {
  const image = CK.MakeImageFromEncoded(bytes);
  const w = image.width();
  const h = image.height();
  const pixels = image.readPixels(0, 0, { width: w, height: h, colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Unpremul, colorSpace });
  image.delete();
  return { w, h, at: (x, y) => Array.from(pixels.slice((y * w + x) * 4, (y * w + x) * 4 + 4)) };
}

describe('watermarkPhoto drawn for real (CanvasKit)', () => {
  it.each([[1080, 1920], [1080, 1440]])('%i × %i: the white wordmark is in its spot and nothing else changes', async (w, h) => {
    const asked = [];
    const files = new Map([
      [PHOTO, skyPicture(w, h)],
      [WORDMARK_URI, new Uint8Array(readFileSync(resolve(root, 'assets/images/wordmark-white.png')))],
    ]);
    const { lib } = loadWatermark({ skia: canvasKitSkia(asked), files });
    const out = await lib.watermarkPhoto(PHOTO);
    expect(out).toMatch(/^file:\/\/\/cache\/peekaboo-/);
    expect(asked).toEqual([['jpeg', 92]]);
    const before = pixelsOf(files.get(PHOTO));
    const after = pixelsOf(files.get(out));
    // Same size as the original.
    expect([after.w, after.h]).toEqual([w, h]);

    const r = lib.watermarkRect(w, h);
    const sky = before.at(5, 5);
    // Inside the wordmark's box: some pixels are now (nearly) white letters.
    let bright = 0;
    for (let y = Math.ceil(r.y); y < r.y + r.height; y += 2) {
      for (let x = Math.ceil(r.x); x < r.x + r.width; x += 2) {
        const [red, green, blue] = after.at(x, y);
        if (red > 220 && green > 220 && blue > 220) bright++;
      }
    }
    expect(bright).toBeGreaterThan(50);
    // Away from it (allowing a little room for the soft shadow): exactly the original picture.
    const far = [[w / 2, h / 2], [w - 10, 10], [10, h - 10], [w - 10, h - 10], [w / 2, h * 0.75], [Math.floor(r.x + r.width / 2), Math.floor(r.y + r.height + 40)]];
    for (const [x, y] of far) expect(after.at(Math.floor(x), Math.floor(y)), `${x},${y}`).toEqual(before.at(Math.floor(x), Math.floor(y)));
    expect(after.at(2, 2)).toEqual(sky);
    // The original file is unchanged.
    expect(pixelsOf(files.get(PHOTO)).at(Math.ceil(r.x) + 5, Math.ceil(r.y) + 5)).toEqual(sky);
  });
});

describe('watermarkPhoto on an iPhone, drawn for real (CanvasKit)', () => {
  it('a wide-colour (P3) photo keeps its colours, the new file says it is P3, and the wordmark is on it', async () => {
    const asked = [];
    const surfaces = [];
    const [w, h] = [1080, 1920];
    const files = new Map([
      [PHOTO, wideColourPicture(w, h)],
      [WORDMARK_URI, new Uint8Array(readFileSync(resolve(root, 'assets/images/wordmark-white.png')))],
    ]);
    const { lib } = loadWatermark({ skia: canvasKitSkia(asked, surfaces), files, os: 'ios' });
    const out = await lib.watermarkPhoto(PHOTO);
    expect(out).toMatch(/^file:\/\/\/cache\/peekaboo-/);
    expect(surfaces).toEqual(['p3']);
    // The new file carries its colour profile (a PNG here, a JPEG on the phone).
    expect(Buffer.from(files.get(out)).includes(Buffer.from('iCCP'))).toBe(true);
    // Away from the wordmark the colours are exactly the photo's, read in P3 and in normal colours.
    for (const space of [CK.ColorSpace.DISPLAY_P3, CK.ColorSpace.SRGB]) {
      const before = pixelsOf(files.get(PHOTO), space);
      const after = pixelsOf(files.get(out), space);
      for (const [x, y] of [[w / 2, h / 2], [w - 10, 10], [10, h - 10]]) {
        after.at(x, y).forEach((value, i) => expect(Math.abs(value - before.at(x, y)[i]), `${x},${y}`).toBeLessThanOrEqual(1));
      }
    }
    expect(pixelsOf(files.get(out)).at(w / 2, h / 2).slice(0, 3)).toEqual([220, 120, 60]);
    // The white letters are there.
    const r = lib.watermarkRect(w, h);
    const after = pixelsOf(files.get(out));
    let bright = 0;
    for (let y = Math.ceil(r.y); y < r.y + r.height; y += 2) {
      for (let x = Math.ceil(r.x); x < r.x + r.width; x += 2) {
        const [red, green, blue] = after.at(x, y);
        if (red > 220 && green > 220 && blue > 220) bright++;
      }
    }
    expect(bright).toBeGreaterThan(50);
  });
});
