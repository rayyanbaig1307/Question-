import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, expect, it } from 'vitest';

// Main Character Mode 🌆: the art cache (src/components/mainCharacter/artCache.ts). It reads the character and
// scene pictures all the way on the JS thread and keeps a few. Checked here, with a pretend Skia that notes every
// picture it makes and lets go of:
// - a picture is always read all the way (drawn into a plain 1080 × 1920 picture) before it is handed out, never
//   the "size only" picture Skia's MakeImageFromEncoded gives (that one would be read on the drawing thread on
//   first use: a jolt on every swipe);
// - it never lets go of a picture that is in the poster on screen or the one before it, held by a poster being
//   made, or left the screen fewer than 2 drawings ago – and does let go of it after;
// - it keeps at most 5 (plus held ones); a picture wanted again before it was let go of comes back without being
//   read again; a picture that can't be read is left out (said once); a replaced online picture is read again;
// - when the screen closes, everything is let go of a moment later (unless a poster still holds it).

const require = createRequire(import.meta.url);
const React = require('react');
const renderer = require('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const root = resolve(import.meta.dirname, '../..');

function transpile(file) {
  return ts.transpileModule(readFileSync(join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
}

// Loads an app file with `mocks` for its imports; '@/…' and './…' files not in `mocks` are loaded for real (they
// must be plain ones: config.ts, fit.ts).
function load(file, mocks, globals = {}) {
  const loaded = new Map();
  function run(path) {
    if (loaded.has(path)) return loaded.get(path).exports;
    const module = { exports: {} };
    loaded.set(path, module);
    vm.runInNewContext(transpile(path), {
      module, exports: module.exports, console, Promise, Math, Number, Map, Set, Uint8Array, ArrayBuffer, TextDecoder, String,
      ...globals,
      require: (id) => {
        if (id in mocks) return mocks[id];
        if (id.startsWith('@/')) return run(`src/${id.slice(2)}.ts`);
        if (id.startsWith('./')) return run(join(dirname(path), `${id.slice(2)}.ts`));
        throw new Error(`unexpected import ${id} in ${path}`);
      },
    });
    return module.exports;
  }
  return run(file);
}

// A pretend Skia. `sizes`: the size each file's picture says it is (default 1080 × 1920). A file whose name has
// "broken" in it can't be read.
function fakeSkia({ sizes = {} } = {}) {
  const made = { headers: [], decoded: [], surfaces: [], data: [], draws: [] };
  const text = (bytes) => new TextDecoder().decode(bytes);
  const disposable = (thing) => Object.assign(thing, { disposed: false, dispose() { this.disposed = true; } });
  const Skia = {
    Data: { fromBytes: (bytes) => { const data = disposable({ uri: text(bytes) }); made.data.push(data); return data; } },
    Image: {
      MakeImageFromEncoded: (data) => {
        if (data.uri.includes('broken')) return null;
        const [w, h] = sizes[data.uri] ?? [1080, 1920];
        const header = disposable({ kind: 'size only', uri: data.uri, width: () => w, height: () => h });
        made.headers.push(header);
        return header;
      },
    },
    Surface: {
      Make: (w, h) => {
        const surface = disposable({
          w, h, drawn: [],
          getCanvas: () => ({
            clear() {},
            drawImageRectOptions: (image, src, dest) => { surface.drawn.push(image); made.draws.push({ image, src, dest }); },
          }),
          flush() {},
          makeImageSnapshot: () => {
            const from = surface.drawn[0];
            const image = disposable({ kind: 'read', uri: from?.uri, width: () => w, height: () => h, readWhile: from && !from.disposed });
            made.decoded.push(image);
            return image;
          },
        });
        made.surfaces.push(surface);
        return surface;
      },
    },
    Paint: () => disposable({ setAntiAlias() {} }),
    XYWHRect: (x, y, width, height) => ({ x, y, width, height }),
    Color: (c) => c,
  };
  return { made, module: { Skia, FilterMode: { Linear: 1 }, MipmapMode: { None: 0 } } };
}

// Loads artCache.ts on a pretend phone. Bundled pictures are numbers (`require` ids): the app's copy is
// file:///bundle/<id>.webp. The half-second check is run by hand (`check()`).
// `gates`: files whose reading waits until the test opens the gate (a promise).
function loadCache(options = {}) {
  const skia = fakeSkia(options);
  const gates = options.gates ?? {};
  const warned = [];
  const intervals = new Map();
  const reads = [];
  const mod = load('src/components/mainCharacter/artCache.ts', {
    react: React,
    '@shopify/react-native-skia': skia.module,
    'expo-asset': { Asset: { fromModule: (id) => ({ localUri: null, async downloadAsync() { this.localUri = `file:///bundle/${id}.webp`; } }) } },
    'expo-file-system': {
      File: class {
        constructor(uri) { this.uri = uri; }
        async arrayBuffer() {
          reads.push(this.uri);
          if (gates[this.uri]) await gates[this.uri];
          return new TextEncoder().encode(this.uri).buffer;
        }
      },
    },
  }, {
    console: { ...console, warn: (...args) => warned.push(args.map(String).join(' ')) },
    setInterval: (run) => { const id = Symbol('check'); intervals.set(id, run); return id; },
    clearInterval: (id) => intervals.delete(id),
  });
  return { ...mod, skia, warned, reads, check: () => { for (const run of [...intervals.values()]) run(); }, checking: () => intervals.size > 0 };
}

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
const character = (n, file = n) => ({ key: `app:c${n}`, slug: `c${n}`, name: `C${n}`, from: 'app', file, anchors: {}, scene: null });
const sceneArt = (n, file = 100 + n) => ({ key: `app:s${n}`, slug: `s${n}`, name: `S${n}`, from: 'app', file });

// Shows a pretend screen that wants `want` (change it with set()); `answer()` is the hook's newest answer.
async function screen(cache, want) {
  let answer = null;
  function Screen({ list }) {
    answer = cache.useArtImages(list);
    return null;
  }
  let tree;
  await renderer.act(async () => { tree = renderer.create(React.createElement(Screen, { list: want })); });
  await settle();
  return {
    answer: () => answer,
    set: async (next) => { await renderer.act(async () => { tree.update(React.createElement(Screen, { list: next })); }); await settle(); },
    close: async () => { await renderer.act(async () => { tree.unmount(); }); },
  };
}

// A poster as MainCharacterCamera makes it.
const poster = (characterImage, sceneImage) => ({ key: `${characterImage?.uri}|${sceneImage?.uri}`, character: characterImage, background: sceneImage });

const open = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
});

it('hands out only pictures read all the way into a 1080 × 1920 picture, never the "size only" one', async () => {
  const cache = loadCache({ sizes: { 'file:///bundle/2.webp': [1520, 2688] } });
  const s = await screen(cache, [character(1), character(2)]);
  open.push(s);
  await s.set([character(1), character(2)]);
  const { images, loading } = s.answer();
  expect(loading).toBe(false);
  for (const key of ['app:c1', 'app:c2']) {
    const image = images.get(key);
    expect(image.kind).toBe('read');
    expect(image.width()).toBe(1080);
    expect(image.height()).toBe(1920);
    // It was drawn from the size-only picture while that was still there.
    expect(image.readWhile).toBe(true);
  }
  // The size-only pictures, the bytes and the surfaces were let go of straight away.
  expect(cache.skia.made.headers.every((h) => h.disposed)).toBe(true);
  expect(cache.skia.made.data.every((d) => d.disposed)).toBe(true);
  expect(cache.skia.made.surfaces.every((x) => x.disposed)).toBe(true);
  // A picture that isn't 1080 × 1920 gets its middle 9:16 part (what the anchors are measured on).
  const odd = cache.skia.made.draws.find((d) => d.image.uri === 'file:///bundle/2.webp');
  expect(odd.src).toEqual({ x: 4, y: 0, width: 1512, height: 2688 });
  expect(odd.dest).toEqual({ x: 0, y: 0, width: 1080, height: 1920 });
});

it('never lets go of a picture in the poster on screen or the one before it; does after it left 2 drawings ago', async () => {
  const cache = loadCache();
  const s = await screen(cache, [character(1), sceneArt(1)]);
  open.push(s);
  const c1 = s.answer().images.get('app:c1');
  const s1 = s.answer().images.get('app:s1');
  const first = poster(c1, s1);
  cache.noteShown(first, 0);
  // The screen moves on to 6 other pictures: c1 and s1 drop out of the cache (only 5 are kept)…
  await s.set([2, 3, 4, 5, 6, 7].map((n) => character(n)));
  expect(s.answer().images.size).toBe(6);
  let drawings = 0;
  // …but they are on screen: kept however many drawings and checks pass.
  for (let i = 0; i < 5; i++) { drawings += 3; cache.noteShown(first, drawings); cache.check(); }
  expect(c1.disposed).toBe(false);
  expect(s1.disposed).toBe(false);
  // A new poster: the old one is "the one before", still kept.
  const images = s.answer().images;
  const second = poster(images.get('app:c2'), null);
  cache.noteShown(second, (drawings += 1));
  for (let i = 0; i < 3; i++) { cache.noteShown(second, (drawings += 2)); cache.check(); }
  expect(c1.disposed).toBe(false);
  // Another new poster: now it has left the screen. Not let go of after 1 drawing…
  const third = poster(images.get('app:c3'), null);
  cache.noteShown(third, (drawings += 1));
  cache.noteShown(third, (drawings += 1));
  cache.check();
  expect(c1.disposed).toBe(false);
  expect(s1.disposed).toBe(false);
  // …only after the second.
  cache.noteShown(third, (drawings += 1));
  cache.check();
  expect(c1.disposed).toBe(true);
  expect(s1.disposed).toBe(true);
  // Pictures still in the cache are never let go of.
  expect([...images.values()].every((image) => !image.disposed)).toBe(true);
  // Nothing left waiting: the half-second check stops.
  expect(cache.checking()).toBe(false);
});

it('never lets go of a picture a poster being made holds, and does once it is done', async () => {
  const cache = loadCache();
  const s = await screen(cache, [character(1), sceneArt(1)]);
  open.push(s);
  const c1 = s.answer().images.get('app:c1');
  const s1 = s.answer().images.get('app:s1');
  const pressed = poster(c1, s1);
  cache.noteShown(pressed, 0);
  const release = cache.holdScene(pressed);
  // Swiped on while the poster is made: the pictures leave the screen and the cache.
  await s.set([2, 3, 4, 5, 6, 7].map((n) => character(n)));
  const images = s.answer().images;
  cache.noteShown(poster(images.get('app:c2'), null), 10);
  cache.noteShown(poster(images.get('app:c3'), null), 11);
  for (let d = 12; d < 30; d += 2) { cache.noteShown(poster(images.get('app:c3'), null), d); cache.check(); }
  expect(c1.disposed).toBe(false);
  expect(s1.disposed).toBe(false);
  // Done: let go of now. Releasing twice changes nothing.
  release();
  release();
  expect(c1.disposed).toBe(true);
  expect(s1.disposed).toBe(true);
});

it('keeps at most 5 pictures, plus the ones held', async () => {
  const cache = loadCache();
  const live = () => cache.skia.made.decoded.filter((image) => !image.disposed).length;
  const s = await screen(cache, [character(1)]);
  open.push(s);
  const held = cache.holdScene(poster(s.answer().images.get('app:c1'), null));
  let drawings = 0;
  for (let n = 2; n <= 12; n++) {
    await s.set([character(n)]);
    for (let i = 0; i < 2; i++) { cache.noteShown(null, (drawings += 2)); cache.check(); }
    expect(live()).toBeLessThanOrEqual(5 + 1);
  }
  // The 5 newest are kept, plus the held one.
  expect(live()).toBe(6);
  held();
  expect(live()).toBe(5);
});

it('a picture wanted again before it was let go of comes back without being read again', async () => {
  const cache = loadCache();
  const s = await screen(cache, [character(1)]);
  open.push(s);
  const c1 = s.answer().images.get('app:c1');
  await s.set([2, 3, 4, 5, 6].map((n) => character(n)));
  expect(s.answer().images.has('app:c1')).toBe(false);
  // Swiped back before it went.
  await s.set([character(1), character(2)]);
  expect(s.answer().images.get('app:c1')).toBe(c1);
  expect(c1.disposed).toBe(false);
  expect(cache.reads.filter((uri) => uri === 'file:///bundle/1.webp').length).toBe(1);
});

it('a picture that can\'t be read is left out (said once, never tried again), and the rest still load', async () => {
  const cache = loadCache();
  const bad = { ...character(9), file: 'file:///online/broken.png', from: 'online', key: 'online:broken' };
  const s = await screen(cache, [bad, character(1)]);
  open.push(s);
  await s.set([bad, character(1)]);
  const answer = s.answer();
  expect(answer.loading).toBe(false);
  expect(answer.failed.has('online:broken')).toBe(true);
  expect(answer.images.has('online:broken')).toBe(false);
  expect(answer.images.has('app:c1')).toBe(true);
  expect(cache.warned.length).toBe(1);
  expect(cache.warned[0]).toMatch(/online:broken/);
  await s.set([bad]);
  await s.set([bad, character(1)]);
  expect(cache.reads.filter((uri) => uri.includes('broken')).length).toBe(1);
  expect(cache.warned.length).toBe(1);
});

it('a picture the screen no longer wants by its turn is not read at all (a quick swipe past it)', async () => {
  let openGate;
  const gate = new Promise((resolve) => { openGate = resolve; });
  const cache = loadCache({ gates: { 'file:///bundle/1.webp': gate } });
  const s = await screen(cache, [character(1)]);
  open.push(s);
  // While 1 is still being read, the screen asks for 2 and then straight away only for 3.
  await s.set([character(2)]);
  await s.set([character(3)]);
  openGate();
  await settle();
  expect(s.answer().images.has('app:c3')).toBe(true);
  expect(s.answer().loading).toBe(false);
  // 2 was never read; 1 was read but not wanted any more, so it was let go of at once (nobody ever had it).
  expect(cache.reads).not.toContain('file:///bundle/2.webp');
  const c1 = cache.skia.made.decoded.find((image) => image.uri === 'file:///bundle/1.webp');
  expect(c1.disposed).toBe(true);
});

it('an online picture replaced under the same name is read again (its file changed)', async () => {
  const cache = loadCache();
  const v1 = { key: 'online:surfer', slug: 'surfer', name: 'Surfer', from: 'online', file: 'file:///cache/surfer-aaaa.png', anchors: {}, scene: null };
  const v2 = { ...v1, file: 'file:///cache/surfer-bbbb.png' };
  const s = await screen(cache, [v1]);
  open.push(s);
  const first = s.answer().images.get('online:surfer');
  expect(first.uri).toBe('file:///cache/surfer-aaaa.png');
  await s.set([v2]);
  const second = s.answer().images.get('online:surfer');
  expect(second.uri).toBe('file:///cache/surfer-bbbb.png');
  expect(second).not.toBe(first);
});

it('when the screen closes, every picture is let go of a moment later – unless a poster still holds it', async () => {
  const cache = loadCache();
  const s = await screen(cache, [character(1), character(2), sceneArt(1)]);
  const images = s.answer().images;
  const shown = poster(images.get('app:c1'), images.get('app:s1'));
  cache.noteShown(shown, 5);
  const release = cache.holdScene(shown);
  await s.close();
  // Not at once (the last drawing may still be on its way).
  expect([...images.values()].some((image) => image.disposed)).toBe(false);
  cache.check();
  cache.check();
  expect(images.get('app:c2').disposed).toBe(true);
  // The poster being made still has its pictures.
  expect(images.get('app:c1').disposed).toBe(false);
  expect(images.get('app:s1').disposed).toBe(false);
  release();
  expect(images.get('app:c1').disposed).toBe(true);
  expect(images.get('app:s1').disposed).toBe(true);
  expect(cache.checking()).toBe(false);
});

it('the drawing clock comes from the live drawing (useDrawingClock), for the half-second check', async () => {
  const cache = loadCache();
  const drawn = { value: 0, get() { return this.value; } };
  function Clock() { cache.useDrawingClock(drawn); return null; }
  let clock;
  await renderer.act(async () => { clock = renderer.create(React.createElement(Clock)); });
  const s = await screen(cache, [character(1)]);
  open.push(s);
  const c1 = s.answer().images.get('app:c1');
  cache.noteShown(poster(c1, null), 0);
  // Two newer posters (with other pictures): c1 is in neither the one on screen nor the one before it.
  cache.noteShown(poster({ uri: 'other-1' }, null), 0);
  cache.noteShown(poster({ uri: 'other-2' }, null), 0);
  await s.set([2, 3, 4, 5, 6, 7].map((n) => character(n)));
  cache.check();
  expect(c1.disposed).toBe(false);
  // The live drawing draws on; only the half-second check looks.
  drawn.value = 1;
  cache.check();
  expect(c1.disposed).toBe(false);
  drawn.value = 3;
  cache.check();
  expect(c1.disposed).toBe(true);
  await renderer.act(async () => { clock.unmount(); });
});

// ---------------------------------------------------------------------------
// Getting online pictures ready (src/components/mainCharacter/analyseArt.ts): the `normalise` and `analyse` steps
// the online library uses. Checked here, with a pretend Skia that reads sizes from a list:
// - a picture too small, too big or not tall enough is refused before anything is decoded (nothing drawn);
// - a good one becomes a 1080 × 1920 copy of its middle 9:16 part (characters PNG, scenes JPEG 90) next to the
//   download, and the download is deleted;
// - one that is already exactly 1080 × 1920 (what the art script's `online` step makes) is handed back as it is:
//   nothing drawn, saved or deleted, so the live camera never stops for it;
// - a character's .json wins when it is complete and sensible; anything odd in it → the hole is guessed instead;
// - the guess (the app's own hole finder, on a 270 × 480 copy) only accepts a hole with the usual face shape.
// ---------------------------------------------------------------------------

// A 270 × 480 picture (RGBA): skin-coloured paint everywhere except a see-through oval `w` × `h` pixels round (cx, cy).
function paintedWithHole({ cx = 135, cy = 96, w = 65, h = 70 } = {}) {
  const W = 270;
  const H = 480;
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const inHole = ((x + 0.5 - cx) / (w / 2)) ** 2 + ((y + 0.5 - cy) / (h / 2)) ** 2 <= 1;
      rgba.set(inHole ? [0, 0, 0, 0] : [210, 150, 120, 255], i);
    }
  }
  return rgba;
}

// `sizes`: the size each file says it is. `pixels`: what the 270 × 480 copy reads back.
function loadAnalyse({ sizes = {}, pixels = null } = {}) {
  const made = { surfaces: [], encoded: [], written: [], deleted: [], reads: [] };
  const text = (bytes) => new TextDecoder().decode(bytes);
  const disposable = (thing) => Object.assign(thing, { disposed: false, dispose() { this.disposed = true; } });
  const Skia = {
    Data: { fromBytes: (bytes) => disposable({ uri: text(bytes) }) },
    Image: {
      MakeImageFromEncoded: (data) => {
        if (!(data.uri in sizes)) return null;
        const [w, h] = sizes[data.uri];
        return disposable({ uri: data.uri, width: () => w, height: () => h });
      },
    },
    Surface: {
      Make: (w, h) => {
        const surface = disposable({
          w, h, draws: [],
          getCanvas: () => ({ clear() {}, drawImageRectOptions: (image, src, dest) => surface.draws.push({ image, src, dest }) }),
          flush() {},
          makeImageSnapshot: () => disposable({
            width: () => w,
            height: () => h,
            readPixels: (x, y, info) => { made.reads.push(info); return pixels; },
            encodeToBytes: (format, quality) => { made.encoded.push({ format, quality, w, h }); return new Uint8Array([1, 2, 3]); },
          }),
        });
        made.surfaces.push(surface);
        return surface;
      },
    },
    Paint: () => disposable({ setAntiAlias() {} }),
    XYWHRect: (x, y, width, height) => ({ x, y, width, height }),
    Color: (c) => c,
  };
  const mod = load('src/components/mainCharacter/analyseArt.ts', {
    '@shopify/react-native-skia': {
      Skia, FilterMode: { Linear: 1 }, MipmapMode: { None: 0 }, ImageFormat: { JPEG: 3, PNG: 4 },
      ColorType: { RGBA_8888: 4 }, AlphaType: { Unpremul: 3 },
    },
    'expo-file-system': {
      File: class {
        constructor(uri) { this.uri = uri; }
        async arrayBuffer() { return new TextEncoder().encode(this.uri).buffer; }
        async write(bytes) { made.written.push({ uri: this.uri, bytes }); }
        delete() { made.deleted.push(this.uri); }
      },
    },
  }, { console: { ...console, warn() {} } });
  return { ...mod, made };
}

it('normalise: a picture too small, too big, not tall enough or not a picture is refused before anything is decoded', async () => {
  const cases = {
    'file:///dl/tiny.webp': [400, 800],
    'file:///dl/giant.webp': [5000, 9000],
    'file:///dl/square.webp': [1080, 1080],
    'file:///dl/too-tall.webp': [600, 1500],
  };
  const art = loadAnalyse({ sizes: cases });
  for (const uri of [...Object.keys(cases), 'file:///dl/not-a-picture.webp']) {
    expect(await art.normaliseArt(uri, 'characters'), uri).toBe(null);
  }
  // Nothing was ever drawn (drawing is what decodes), written or deleted.
  expect(art.made.surfaces).toEqual([]);
  expect(art.made.written).toEqual([]);
  expect(art.made.deleted).toEqual([]);
});

it('normalise: a good picture becomes a 1080 × 1920 copy of its middle (characters PNG, scenes JPEG 90); the download goes', async () => {
  const art = loadAnalyse({ sizes: { 'file:///dl/surfer-1a2b.webp': [1520, 2688], 'file:///dl/pier-9f9f.jpg': [1200, 2133] } });
  expect(await art.normaliseArt('file:///dl/surfer-1a2b.webp', 'characters')).toBe('file:///dl/surfer-1a2b.png');
  const [surface] = art.made.surfaces;
  expect([surface.w, surface.h]).toEqual([1080, 1920]);
  expect(surface.draws[0].src).toEqual({ x: 4, y: 0, width: 1512, height: 2688 });
  expect(surface.draws[0].dest).toEqual({ x: 0, y: 0, width: 1080, height: 1920 });
  expect(art.made.encoded[0]).toEqual({ format: 4, quality: 100, w: 1080, h: 1920 });
  expect(art.made.written.map((w) => w.uri)).toEqual(['file:///dl/surfer-1a2b.png']);
  expect(art.made.deleted).toEqual(['file:///dl/surfer-1a2b.webp']);
  expect(surface.disposed).toBe(true);
  // A scene: JPEG 90. A download that already has the right name is written over, not deleted.
  expect(await art.normaliseArt('file:///dl/pier-9f9f.jpg', 'backgrounds')).toBe('file:///dl/pier-9f9f.jpg');
  expect(art.made.encoded[1]).toEqual({ format: 3, quality: 90, w: 1080, h: 1920 });
  expect(art.made.deleted).toEqual(['file:///dl/surfer-1a2b.webp']);
});

it('normalise: a picture that is already 1080 × 1920 (the online step\'s size) is used as it is – nothing is drawn, saved or deleted', async () => {
  const sizes = {
    'file:///dl/disco-queen-1a2b.download.webp': [1080, 1920],
    'file:///dl/night-pier-9f9f.download.jpg': [1080, 1920],
    'file:///dl/night-pier-png-7e7e.download.png': [1080, 1920],
  };
  const art = loadAnalyse({ sizes });
  expect(await art.normaliseArt('file:///dl/disco-queen-1a2b.download.webp', 'characters')).toBe('file:///dl/disco-queen-1a2b.download.webp');
  expect(await art.normaliseArt('file:///dl/night-pier-9f9f.download.jpg', 'backgrounds')).toBe('file:///dl/night-pier-9f9f.download.jpg');
  expect(await art.normaliseArt('file:///dl/night-pier-png-7e7e.download.png', 'backgrounds')).toBe('file:///dl/night-pier-png-7e7e.download.png');
  // Only the size was read: no drawing surface (drawing is what decodes the whole picture), no PNG or JPEG made,
  // nothing written or deleted.
  expect(art.made.surfaces).toEqual([]);
  expect(art.made.encoded).toEqual([]);
  expect(art.made.written).toEqual([]);
  expect(art.made.deleted).toEqual([]);
  // One pixel off is still drawn and saved (and still refused when it isn't tall enough).
  const near = loadAnalyse({ sizes: { 'file:///dl/near-1.webp': [1080, 1921], 'file:///dl/near-2.webp': [1081, 1920] } });
  expect(await near.normaliseArt('file:///dl/near-1.webp', 'characters')).toBe('file:///dl/near-1.png');
  expect(await near.normaliseArt('file:///dl/near-2.webp', 'characters')).toBe('file:///dl/near-2.png');
  expect(near.made.encoded).toHaveLength(2);
});

function goodSidecar() {
  const hole = [];
  for (let i = 0; i < 36; i++) hole.push([0.5 + 0.1 * Math.sin((i * Math.PI) / 18), 0.2 - 0.07 * Math.cos((i * Math.PI) / 18)]);
  return {
    eyes: [[0.45, 0.19], [0.55, 0.19]], nose: [0.5, 0.21], chin: [0.5, 0.27], forehead: [0.5, 0.13],
    hole, faceWidth: 0.24, skinTone: [200, 140, 110], toneSure: true,
  };
}

it('analyse: a complete, sensible .json wins (the picture isn\'t even read)', async () => {
  const art = loadAnalyse({ pixels: paintedWithHole() });
  const sidecar = goodSidecar();
  const anchors = await art.analyseCharacter('file:///cache/surfer.png', sidecar);
  expect(JSON.parse(JSON.stringify(anchors))).toEqual(sidecar);
  expect(art.made.surfaces).toEqual([]);
  // toneSure left out: no skin colour pull.
  const { toneSure, ...noTone } = sidecar;
  expect(toneSure).toBe(true);
  expect(art.checkSidecar(noTone).toneSure).toBe(false);
});

it('analyse: a .json with anything missing or odd is not used', () => {
  const art = loadAnalyse();
  const broken = [
    (s) => { delete s.eyes; },
    (s) => { s.eyes = [[0.4, 0.2]]; },
    (s) => { s.eyes[0] = [NaN, 0.2]; },
    (s) => { s.eyes = [[0.5, 0.2], [0.5, 0.2]]; },
    (s) => { s.nose = [1.4, 0.2]; },
    (s) => { s.forehead = [0.5, -0.1]; },
    (s) => { s.chin = 'chin'; },
    (s) => { s.hole = s.hole.slice(0, 35); },
    (s) => { s.hole[7] = [0.5, Infinity]; },
    (s) => { s.faceWidth = 0; },
    (s) => { s.faceWidth = 2; },
    (s) => { s.skinTone = [300, 100, 100]; },
    (s) => { s.skinTone = [200, 100]; },
    (s) => { s.toneSure = 'yes'; },
  ];
  expect(art.checkSidecar(goodSidecar())).not.toBe(null);
  for (const breakIt of broken) {
    const sidecar = goodSidecar();
    breakIt(sidecar);
    expect(art.checkSidecar(sidecar), breakIt.toString()).toBe(null);
  }
  for (const odd of [null, undefined, 3, 'anchors', []]) expect(art.checkSidecar(odd)).toBe(null);
});

it('analyse: without a good .json, the hole is guessed – only when it has the usual face shape', async () => {
  const sizes = { 'file:///cache/surfer.png': [1080, 1920] };
  const art = loadAnalyse({ sizes, pixels: paintedWithHole() });
  const anchors = await art.analyseCharacter('file:///cache/surfer.png', { eyes: 'broken' });
  expect(anchors).not.toBe(null);
  // Looked at a 270 × 480 copy, not premultiplied.
  expect(art.made.surfaces[0].w).toBe(270);
  expect(art.made.surfaces[0].h).toBe(480);
  expect(art.made.reads[0]).toEqual({ width: 270, height: 480, colorType: 4, alphaType: 3 });
  expect(anchors.hole.length).toBe(36);
  expect(anchors.toneSure).toBe(true);
  // The eyes sit inside the hole, left then right, level.
  expect(anchors.eyes[0][0]).toBeLessThan(0.5);
  expect(anchors.eyes[1][0]).toBeGreaterThan(0.5);
  expect(anchors.eyes[0][1]).toBeCloseTo(anchors.eyes[1][1], 6);
  // Odd holes are never guessed at: too small, square, in the bottom half, off to the side.
  for (const hole of [{ w: 20, h: 22 }, { w: 65, h: 37 }, { cy: 330 }, { cx: 40 }]) {
    const odd = loadAnalyse({ sizes, pixels: paintedWithHole(hole) });
    expect(await odd.analyseCharacter('file:///cache/surfer.png', null), JSON.stringify(hole)).toBe(null);
  }
  // A file that isn't a picture: left out, never a crash.
  expect(await art.analyseCharacter('file:///cache/missing.png', null)).toBe(null);
});
