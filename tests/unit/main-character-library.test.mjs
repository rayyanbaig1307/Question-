// Main Character Mode 🌆: the online library (src/lib/mainCharacter/library.ts). New characters and scenes the
// owner uploads to the Supabase folder show up in the app by themselves. These checks run the real library code
// against a made-up phone (files in memory), a made-up Storage folder and made-up picture steps – invented names
// and pictures only, no network, no Skia.
//
// What must hold: the listing only takes usable files (right type for the folder, not over 1.5 MB, a clean name);
// every download has the picture's version in its address and must match the listing's size and md5 (a wrong copy
// is deleted and simply tried again later); a picture that is too big, too small or the wrong shape is refused
// before anything decodes it, and never downloaded again; only a few new pictures are prepared per visit, newest
// first, one at a time; the phone keeps what it has when it is offline; removed pictures go away; an online
// picture only takes the place of one inside the app once it is ready; the .json wins; and nothing ever throws at
// the screen.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

const md5 = (bytes) => createHash('md5').update(bytes).digest('hex');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const BASE = 'https://store.example.invalid/storage/v1/object/public/main-character';
const MINUTE = 60_000;

// ---------------------------------------------------------------------------
// Made-up pictures: just the first bytes of a real file (where the size is), then filler.
// ---------------------------------------------------------------------------
function png(width, height, filler = '') {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const size = Buffer.alloc(8);
  size.writeUInt32BE(width, 0);
  size.writeUInt32BE(height, 4);
  return Buffer.concat([head, size, Buffer.from([8, 6, 0, 0, 0, 0, 0, 0, 0]), Buffer.from(` made-up picture ${filler}`)]);
}
function riff(kind, body) {
  const head = Buffer.alloc(20);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(12 + body.length, 4);
  head.write('WEBP', 8, 'latin1');
  head.write(kind, 12, 'latin1');
  head.writeUInt32LE(body.length, 16);
  return Buffer.concat([head, body, Buffer.from(' made-up picture')]);
}
function webpExtended(width, height) {
  const body = Buffer.alloc(10);
  body.writeUIntLE(width - 1, 4, 3);
  body.writeUIntLE(height - 1, 7, 3);
  return riff('VP8X', body);
}
function webpLossless(width, height) {
  const body = Buffer.alloc(10);
  body[0] = 0x2f;
  body.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 1);
  return riff('VP8L', body);
}
function webpLossy(width, height) {
  const body = Buffer.alloc(10);
  body.set([0x9d, 0x01, 0x2a], 3);
  body.writeUInt16LE(width, 6);
  body.writeUInt16LE(height, 8);
  return riff('VP8 ', body);
}
function jpeg(width, height) {
  const block = (kind, data) => {
    const head = Buffer.from([0xff, kind, 0, 0]);
    head.writeUInt16BE(data.length + 2, 2);
    return Buffer.concat([head, data]);
  };
  const frame = Buffer.alloc(15);
  frame[0] = 8;
  frame.writeUInt16BE(height, 1);
  frame.writeUInt16BE(width, 3);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    block(0xe0, Buffer.from('JFIF\0made-up')),
    block(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), Buffer.alloc(300, 7)])),
    block(0xdb, Buffer.alloc(65, 1)),
    block(0xc2, frame),
    block(0xda, Buffer.alloc(10, 3)),
    Buffer.from([0xff, 0xd9]),
  ]);
}

// ---------------------------------------------------------------------------
// Where the face goes (made up, in art 0–1)
// ---------------------------------------------------------------------------
function anchors(shift = 0) {
  return {
    eyes: [[0.44 + shift, 0.12], [0.54 + shift, 0.12]],
    nose: [0.49, 0.15], chin: [0.49, 0.23], forehead: [0.49, 0.07],
    hole: Array.from({ length: 36 }, (_, i) => [0.49 + 0.11 * Math.sin((i * Math.PI) / 18), 0.15 - 0.08 * Math.cos((i * Math.PI) / 18)]),
    faceWidth: 0.24, skinTone: [220, 150, 120], toneSure: true,
  };
}
const GUESSED = anchors(0.001);

// The art inside the app (made up for the test).
const INSIDE = {
  BUNDLED_CHARACTERS: [
    { slug: 'made-up-boss', name: 'Made Up Boss', image: 101, scene: 'made-up-street', anchors: anchors() },
    { slug: 'made-up-cop', name: 'Made Up Cop', image: 102, scene: 'made-up-mall', anchors: anchors() },
  ],
  BUNDLED_SCENES: [
    { slug: 'made-up-street', name: 'Made Up Street', image: 201 },
    { slug: 'made-up-mall', name: 'Made Up Mall', image: 202 },
  ],
};

// ---------------------------------------------------------------------------
// A made-up phone (files in memory) and a made-up Storage folder
// ---------------------------------------------------------------------------
function makeWorld() {
  const files = new Map();            // file:// → Buffer
  const bucket = new Map();           // 'characters/x.webp' → { bytes, updatedAt, size?, etag? }
  const served = new Map();           // path → bytes the download hands out instead (a stale or broken copy)
  const downloads = [];
  const fetched = [];
  const world = { files, bucket, served, downloads, fetched, listing: 'ok', online: true, now: Date.parse('2026-11-22T10:00:00Z'), listCalls: 0 };

  const join = (parts) => parts.map((p) => (typeof p === 'string' ? p : p.uri)).join('/').replace(/([^:/])\/{2,}/g, '$1/');
  class File {
    constructor(...parts) { this.uri = join(parts); }
    get name() { return this.uri.slice(this.uri.lastIndexOf('/') + 1); }
    get exists() { return files.has(this.uri); }
    get size() { return files.has(this.uri) ? files.get(this.uri).length : null; }
    create() { if (!files.has(this.uri)) files.set(this.uri, Buffer.alloc(0)); }
    textSync() {
      if (!files.has(this.uri)) throw new Error('no such file');
      return files.get(this.uri).toString('utf8');
    }
    writeSync(text) { files.set(this.uri, Buffer.from(String(text))); }
    async write(text) { this.writeSync(text); }
    async bytes() {
      if (!files.has(this.uri)) throw new Error('no such file');
      return new Uint8Array(files.get(this.uri));
    }
    delete() { if (!files.delete(this.uri)) throw new Error('no such file'); }
    async move(to) {
      if (!files.has(this.uri)) throw new Error('no such file');
      const bytes = files.get(this.uri);
      files.delete(this.uri);
      files.set(to.uri, bytes);
      this.uri = to.uri;
    }
    async digest(kind) {
      if (kind !== 'MD5') throw new Error('only md5 here');
      return md5(files.get(this.uri));
    }
    static async downloadFileAsync(url, to) {
      downloads.push(url);
      await tick();
      if (!world.online) throw new Error('The Internet connection appears to be offline.');
      const path = decodeURI(url.slice(BASE.length + 1).split('?')[0]);
      const stored = served.get(path) ?? bucket.get(path)?.bytes;
      if (!stored) throw new Error('404');
      files.set(to.uri, Buffer.from(stored));
      return new File(to.uri);
    }
  }
  class Directory {
    constructor(...parts) { this.uri = join(parts); }
    get exists() { return true; }
    create() {}
    list() {
      const start = `${this.uri}/`;
      return [...files.keys()].filter((uri) => uri.startsWith(start) && !uri.slice(start.length).includes('/')).map((uri) => new File(uri));
    }
  }
  const Paths = { get cache() { return new Directory('file:///cache'); } };

  const entry = (folder, name, file) => ({
    name, id: `id-${name}`, updated_at: file.updatedAt, created_at: file.updatedAt,
    metadata: { eTag: `"${file.etag ?? md5(file.bytes)}"`, size: file.size ?? file.bytes.length, mimetype: 'image/webp' },
  });
  const storage = {
    from(name) {
      expect(name).toBe('main-character');
      return {
        async list(folder, options) {
          world.listCalls += 1;
          expect(options).toEqual({ limit: 200, sortBy: { column: 'name', order: 'asc' } });
          await tick();
          if (world.listing === 'offline') return { data: null, error: { message: 'Network request failed' } };
          if (world.listing === 'no-bucket') return { data: null, error: { message: 'Bucket not found', statusCode: '404' } };
          if (world.listing === 'hang') return new Promise(() => {});
          if (world.listing === 'garbage') return { data: [null, 7, { name: 5 }, { name: 'x.webp', id: 'a', metadata: { eTag: '', size: 'big' } }], error: null };
          const rows = [{ name: '.emptyFolderPlaceholder', id: 'p', updated_at: '2026-01-01', metadata: { eTag: '"d41d8cd98f00b204e9800998ecf8427e"', size: 0 } },
            { name: 'old-stuff', id: null, updated_at: null, created_at: null, metadata: null }];
          for (const [path, file] of bucket) {
            const [top, name] = path.split('/');
            if (top === folder) rows.push(entry(folder, name, file));
          }
          return { data: rows.sort((a, b) => (a.name < b.name ? -1 : 1)), error: null };
        },
        getPublicUrl(path) { return { data: { publicUrl: encodeURI(`${BASE}/${path}`) } }; },
      };
    },
  };
  world.fetch = async (url) => {
    fetched.push(url);
    await tick();
    if (!world.online) throw new Error('offline');
    const path = decodeURI(url.slice(BASE.length + 1).split('?')[0]);
    const file = bucket.get(path);
    if (!file) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => file.bytes.toString('utf8') };
  };
  world.fs = { File, Directory, Paths };
  world.supabase = { storage };
  return world;
}

// The owner uploads a file (newer uploads get a later time).
let uploads = 0;
function upload(world, path, bytes, extra = {}) {
  uploads += 1;
  const updatedAt = new Date(Date.parse('2026-11-01T00:00:00Z') + uploads * MINUTE).toISOString();
  world.bucket.set(path, { bytes: Buffer.from(bytes), updatedAt, ...extra });
}

// The picture steps the screen hands in (made up: the real ones are in components/mainCharacter/analyseArt.ts).
function makeSteps(world, { normalise, analyse } = {}) {
  const calls = { normalise: [], analyse: [], busy: 0, mostAtOnce: 0 };
  const steps = {
    normalise: vi.fn(async (uri, folder) => {
      calls.busy += 1;
      calls.mostAtOnce = Math.max(calls.mostAtOnce, calls.busy);
      calls.normalise.push({ uri, folder });
      await tick();
      calls.busy -= 1;
      if (normalise) return normalise(uri, folder);
      // Like the real one: a copy next to the download, the download deleted.
      const out = `${uri.slice(0, uri.lastIndexOf('.'))}.${folder === 'characters' ? 'png' : 'jpg'}`;
      const source = world.files.get(uri);
      world.files.delete(uri);
      world.files.set(out, Buffer.concat([Buffer.from('copy of '), source]));
      return out;
    }),
    analyse: vi.fn(async (uri, sidecar) => {
      calls.analyse.push({ uri, sidecar });
      if (analyse) return analyse(uri, sidecar);
      return sidecar?.eyes ? { ...GUESSED, ...sidecar } : GUESSED;
    }),
  };
  return { steps, calls };
}

// The library as one app start sees it (a new start = the module loaded again, on the same phone).
function startApp(world, { blocked, timers = (ms) => ms } = {}) {
  const effects = [];
  const warnings = [];
  const realBlocked = loadLibrary('mainCharacter/blockedWords');
  const mocks = {
    '../supabase': { supabase: world.supabase },
    'expo-file-system': world.fs,
    'expo-crypto': {
      CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
      digestStringAsync: async (kind, text) => { expect(kind).toBe('SHA-256'); return sha256(text); },
    },
    './art.generated': INSIDE,
    react: {
      useSyncExternalStore: (subscribe, read) => { world.subscribe = subscribe; return read(); },
      useEffect: (run) => { effects.push(run); },
    },
  };
  if (blocked) mocks['./blockedWords'] = { BLOCKED_HASHES: blocked.map(sha256), wordForms: realBlocked.wordForms };
  const lib = loadLibrary('mainCharacter/library', {
    mocks,
    globals: {
      fetch: (...args) => world.fetch(...args),
      Date: { now: () => world.now },
      setTimeout: (run, ms) => setTimeout(run, timers(ms)),
      clearTimeout,
      console: { ...console, warn: (...args) => warnings.push(args.map(String).join(' ')) },
    },
  });
  // Opens the Main Character screen: renders the hook once and runs its effects.
  lib.open = (steps) => {
    effects.length = 0;
    lib.useMainCharacterLibrary(steps);
    const cleanups = effects.splice(0).map((run) => run());
    return {
      read: () => { const answer = lib.useMainCharacterLibrary(steps); effects.length = 0; return answer; },
      close: () => cleanups.forEach((cleanup) => typeof cleanup === 'function' && cleanup()),
    };
  };
  lib.warnings = warnings;
  return lib;
}

// Opens the screen, waits for the visit to finish, closes it again.
async function visit(lib, steps) {
  const screen = lib.open(steps);
  await lib.onlineArtSettled();
  const answer = screen.read();
  screen.close();
  return answer;
}
const keys = (list) => list.map((item) => item.key);
const cacheFiles = (world) => [...world.files.keys()].filter((uri) => uri.startsWith('file:///cache/main-character/')).sort();

// ---------------------------------------------------------------------------
// Reading a picture's size from its first bytes
// ---------------------------------------------------------------------------
describe('picture size from the first bytes, before any decoding', () => {
  const lib = startApp(makeWorld());

  it('reads PNG, the three kinds of WebP and JPEG (also with metadata before the size)', () => {
    expect(lib.pictureSize(new Uint8Array(png(1080, 1920)))).toEqual({ width: 1080, height: 1920 });
    expect(lib.pictureSize(new Uint8Array(webpExtended(1080, 1920)))).toEqual({ width: 1080, height: 1920 });
    expect(lib.pictureSize(new Uint8Array(webpLossless(900, 1600)))).toEqual({ width: 900, height: 1600 });
    expect(lib.pictureSize(new Uint8Array(webpLossy(720, 1280)))).toEqual({ width: 720, height: 1280 });
    expect(lib.pictureSize(new Uint8Array(jpeg(1200, 2100)))).toEqual({ width: 1200, height: 2100 });
  });

  it('says null for anything it can not read', () => {
    expect(lib.pictureSize(new Uint8Array(0))).toBeNull();
    expect(lib.pictureSize(new Uint8Array(Buffer.from('{"eyes": [], "this is": "not a picture at all"}')))).toBeNull();
    expect(lib.pictureSize(new Uint8Array(png(0, 1920)))).toBeNull();
    expect(lib.pictureSize(new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(40, 0)])))).toBeNull();
  });

  it('reads a real PNG made by Skia, and the bundled WebP pictures when they are there', async () => {
    const require = createRequire(import.meta.url);
    const CanvasKitInit = require('canvaskit-wasm');
    const CanvasKit = await CanvasKitInit({ locateFile: (file) => require.resolve(`canvaskit-wasm/bin/${file}`) });
    const surface = CanvasKit.MakeSurface(600, 1000);
    surface.getCanvas().clear(CanvasKit.Color(255, 120, 60, 1));
    const image = surface.makeImageSnapshot();
    expect(lib.pictureSize(image.encodeToBytes(CanvasKit.ImageFormat.PNG, 100))).toEqual({ width: 600, height: 1000 });
    image.delete();
    surface.delete();
    for (const file of ['characters/street-boss.webp', 'backgrounds/neon-street.webp']) {
      const path = `assets/main-character/${file}`;
      if (existsSync(path)) expect(lib.pictureSize(new Uint8Array(readFileSync(path)))).toEqual({ width: 1080, height: 1920 });
    }
  });

  it('takes only standing-up pictures between 512 and 4096 on each side', () => {
    expect(lib.pictureSizeOk({ width: 1080, height: 1920 })).toBe(true);
    expect(lib.pictureSizeOk({ width: 512, height: 1024 })).toBe(true);
    expect(lib.pictureSizeOk({ width: 2048, height: 4096 })).toBe(true);
    expect(lib.pictureSizeOk({ width: 511, height: 1000 })).toBe(false);    // too small
    expect(lib.pictureSizeOk({ width: 2400, height: 4097 })).toBe(false);   // too big
    expect(lib.pictureSizeOk({ width: 1080, height: 1080 })).toBe(false);   // square
    expect(lib.pictureSizeOk({ width: 1000, height: 2200 })).toBe(false);   // too thin
    expect(lib.pictureSizeOk(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------
describe('names', () => {
  it('lets ordinary names through and stops bad words and the banned list in every spelling', async () => {
    const lib = startApp(makeWorld(), { blocked: ['zebra', 'blue whale', 'bluewhale'] });
    for (const name of ['Made Up Boss', 'Neon Rider', 'Mall Hero 2']) expect(await lib.nameAllowed(name)).toBe(true);
    for (const name of ['Zebra', 'Big ZEBRA Boss', 'Ze Bra', 'Blue Whale', 'Bluewhale Bay', 'Shit Town', 'Dick Boss', '', '   ']) {
      expect(await lib.nameAllowed(name), name).toBe(false);
    }
  });

  it('uses the real banned list and says no when it can not check', async () => {
    const world = makeWorld();
    const lib = startApp(world);
    expect(await lib.nameAllowed('Made Up Boss')).toBe(true);
    const broken = loadLibrary('mainCharacter/library', {
      mocks: {
        '../supabase': { supabase: world.supabase }, 'expo-file-system': world.fs, './art.generated': INSIDE,
        'expo-crypto': { CryptoDigestAlgorithm: { SHA256: 'SHA-256' }, digestStringAsync: async () => { throw new Error('no crypto'); } },
      },
      globals: { console: { ...console, warn: () => {} } },
    });
    expect(await broken.nameAllowed('Made Up Boss')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Listing and downloading
// ---------------------------------------------------------------------------
describe('the listing', () => {
  it('takes only usable files: the right types per folder, 1.5 MB at most, clean names; newest first', async () => {
    const world = makeWorld();
    upload(world, 'characters/Hero One.webp', png(1080, 1920, 'hero'));
    upload(world, 'characters/hero-one.png', png(1080, 1920, 'older png'));           // same name: the .webp wins
    upload(world, 'characters/Hero One.json', JSON.stringify({ eyes: [[0.4, 0.1], [0.5, 0.1]] }));
    upload(world, 'characters/flat-face.jpg', png(1080, 1920));                       // a character can't be a JPEG
    upload(world, 'characters/huge.png', png(1080, 1920), { size: 1_572_865 });        // over 1.5 MB
    upload(world, 'characters/just-right.png', png(1080, 1920), { size: 1_572_864 });  // exactly 1.5 MB is fine
    upload(world, 'characters/zebra-king.png', png(1080, 1920));                       // on the (made-up) banned list
    upload(world, 'characters/shit-head.png', png(1080, 1920));                        // a bad word
    upload(world, 'characters/odd#name.png', png(1080, 1920));                         // can't be in an address
    upload(world, 'characters/notes.txt', 'hello');
    upload(world, 'backgrounds/Sunny Pier.jpg', png(1080, 1920));
    upload(world, 'backgrounds/sunny-pier.json', '{}');                                // backgrounds have no .json
    upload(world, 'backgrounds/no-version.png', png(1080, 1920), { etag: '' });
    const lib = startApp(world, { blocked: ['zebra'] });

    const items = await lib.listOnlineArt();
    expect(items.map((item) => item.path)).toEqual(['backgrounds/Sunny Pier.jpg', 'characters/just-right.png', 'characters/Hero One.webp']);
    const hero = items.find((item) => item.slug === 'hero-one');
    expect(hero).toMatchObject({ folder: 'characters', name: 'Hero One', ext: 'webp', size: world.bucket.get('characters/Hero One.webp').bytes.length });
    expect(hero.etag).toBe(md5(world.bucket.get('characters/Hero One.webp').bytes));
    expect(hero.url).toBe(`${BASE}/characters/Hero%20One.webp?v=${hero.etag}`);
    expect(hero.sidecar).toBe(`${BASE}/characters/Hero%20One.json?v=${md5(world.bucket.get('characters/Hero One.json').bytes)}`);
    expect(items.find((item) => item.slug === 'sunny-pier').sidecar).toBeNull();
  });

  it('a folder that does not exist yet is empty; no internet throws; odd rows are skipped', async () => {
    const world = makeWorld();
    const lib = startApp(world);
    world.listing = 'no-bucket';
    expect(await lib.listOnlineArt()).toEqual([]);
    world.listing = 'offline';
    await expect(lib.listOnlineArt()).rejects.toMatchObject({ message: 'Network request failed' });
    world.listing = 'garbage';
    expect(await lib.listOnlineArt()).toEqual([]);
  });
});

describe('downloading one picture', () => {
  async function listed(world, path) {
    const lib = startApp(world);
    const item = (await lib.listOnlineArt()).find((i) => i.path === path);
    return { lib, item };
  }

  it('asks for the exact version and keeps a file that matches the size and md5', async () => {
    const world = makeWorld();
    upload(world, 'characters/hero.webp', webpExtended(1080, 1920));
    const { lib, item } = await listed(world, 'characters/hero.webp');
    const uri = await lib.downloadOnline(item);
    expect(world.downloads).toEqual([`${BASE}/characters/hero.webp?v=${item.etag}`]);
    expect(world.files.get(uri)).toEqual(world.bucket.get('characters/hero.webp').bytes);
    expect(cacheFiles(world).filter((f) => f.endsWith('.part'))).toEqual([]);
  });

  it('deletes a copy with the wrong md5 or the wrong size, and throws', async () => {
    const world = makeWorld();
    const good = webpExtended(1080, 1920);
    upload(world, 'characters/hero.webp', good);
    const { lib, item } = await listed(world, 'characters/hero.webp');
    const stale = Buffer.from(good);
    stale[stale.length - 1] ^= 1;                                   // same size, other bytes
    world.served.set('characters/hero.webp', stale);
    await expect(lib.downloadOnline(item)).rejects.toThrow(/not the one that was listed/);
    world.served.set('characters/hero.webp', good.subarray(0, 30));   // cut short
    await expect(lib.downloadOnline(item)).rejects.toThrow(/bytes, not/);
    expect(cacheFiles(world)).toEqual([]);
  });

  it('checks only the size when the version is not an md5 (big uploads)', async () => {
    const world = makeWorld();
    upload(world, 'characters/hero.webp', webpExtended(1080, 1920), { etag: '0123abcd-2' });
    const { lib, item } = await listed(world, 'characters/hero.webp');
    expect(item.url).toBe(`${BASE}/characters/hero.webp?v=0123abcd-2`);
    expect(await lib.downloadOnline(item)).toMatch(/hero-0123abcd\.download\.webp$/);
  });
});

// ---------------------------------------------------------------------------
// The screen's list
// ---------------------------------------------------------------------------
describe('the characters and scenes the screen gets', () => {
  it('online ones first; one with the same name as an app one takes its place (and keeps its scene) only once ready', () => {
    const lib = startApp(makeWorld());
    const inside = lib.bundledArt();
    expect(keys(inside.characters)).toEqual(['app:made-up-boss', 'app:made-up-cop']);
    expect(inside.characters[0]).toMatchObject({ from: 'app', file: 101, scene: 'made-up-street', name: 'Made Up Boss' });
    const online = {
      characters: [
        { key: 'online:new-hero', slug: 'new-hero', name: 'New Hero', from: 'online', file: 'file:///a.png', anchors: anchors(), scene: null },
        { key: 'online:made-up-cop', slug: 'made-up-cop', name: 'Made Up Cop', from: 'online', file: 'file:///b.png', anchors: anchors(), scene: null },
      ],
      scenes: [{ key: 'online-scene:made-up-street', slug: 'made-up-street', name: 'Made Up Street', from: 'online', file: 'file:///c.jpg' }],
    };
    const merged = lib.mergeArt(inside, online);
    expect(keys(merged.characters)).toEqual(['online:new-hero', 'app:made-up-boss', 'online:made-up-cop']);
    expect(merged.characters[2].scene).toBe('made-up-mall');
    expect(keys(inside.scenes)).toEqual(['app-scene:made-up-street', 'app-scene:made-up-mall']);
    expect(keys(merged.scenes)).toEqual(['online-scene:made-up-street', 'app-scene:made-up-mall']);
    expect(lib.mergeArt(inside, { characters: [], scenes: [] })).toEqual(inside);
  });
});

describe('a visit to the screen', () => {
  it('shows the app art at once, then prepares at most 3 new pictures, newest first, one at a time', async () => {
    const world = makeWorld();
    for (const name of ['one', 'two', 'three', 'four']) upload(world, `characters/hero-${name}.webp`, webpExtended(1080, 1920));
    upload(world, 'backgrounds/new-town.jpg', jpeg(1080, 1920));       // the newest upload
    const lib = startApp(world);
    const { steps, calls } = makeSteps(world);

    const screen = lib.open(steps);
    const first = screen.read();
    expect(keys(first.characters)).toEqual(['app:made-up-boss', 'app:made-up-cop']);
    expect(first.checking).toBe(true);
    await lib.onlineArtSettled();
    const after = screen.read();
    screen.close();
    expect(after.checking).toBe(false);
    expect(world.downloads.map((url) => url.split('?')[0].slice(BASE.length + 1)))
      .toEqual(['backgrounds/new-town.jpg', 'characters/hero-four.webp', 'characters/hero-three.webp']);
    expect(world.downloads.every((url) => /\?v=[0-9a-f]{32}$/.test(url))).toBe(true);
    expect(calls.mostAtOnce).toBe(1);
    expect(keys(after.characters)).toEqual(['online:hero-four', 'online:hero-three', 'app:made-up-boss', 'app:made-up-cop']);
    expect(keys(after.scenes)).toEqual(['online-scene:new-town', 'app-scene:made-up-street', 'app-scene:made-up-mall']);
    expect(after.characters[0]).toMatchObject({ from: 'online', name: 'Hero Four', scene: null, anchors: GUESSED });
    // Kept under the library's own names; the downloads are gone.
    const four = after.characters[0].file;
    expect(four).toMatch(/^file:\/\/\/cache\/main-character\/characters\/hero-four-[0-9a-f]{8}\.png$/);
    expect(cacheFiles(world).some((f) => /\.download\.|\.part$/.test(f))).toBe(false);

    // The next visit prepares the rest.
    const next = await visit(lib, steps);
    expect(world.downloads).toHaveLength(5);
    expect(keys(next.characters).slice(0, 4)).toEqual(['online:hero-four', 'online:hero-three', 'online:hero-two', 'online:hero-one']);
  });

  it('stops preparing new pictures once the screen is closed', async () => {
    const world = makeWorld();
    for (const name of ['one', 'two', 'three']) upload(world, `characters/hero-${name}.webp`, webpExtended(1080, 1920));
    const lib = startApp(world);
    const { steps } = makeSteps(world);
    const screen = lib.open(steps);
    screen.close();
    await lib.onlineArtSettled();
    expect(world.downloads.length).toBeLessThanOrEqual(1);
  });

  it('refuses pictures that are too big, too small or the wrong shape before anything decodes them, for good', async () => {
    const world = makeWorld();
    upload(world, 'characters/giant.png', png(5000, 9000));
    upload(world, 'characters/tiny.webp', webpLossless(300, 600));
    upload(world, 'backgrounds/square.jpg', jpeg(2000, 2000));
    upload(world, 'backgrounds/not-a-picture.png', Buffer.from('hello, this is just some text and not a picture'));
    const lib = startApp(world);
    const { steps, calls } = makeSteps(world);
    await visit(lib, steps);
    expect(world.downloads).toHaveLength(3);                       // three tries on the first visit
    await visit(lib, steps);
    expect(world.downloads).toHaveLength(4);                       // the fourth on the next visit
    const last = await visit(lib, steps);
    await visit(startApp(world), steps);                           // and never again, also after an app start
    expect(world.downloads).toHaveLength(4);
    expect(calls.normalise).toEqual([]);
    expect(last.characters.every((c) => c.from === 'app')).toBe(true);
    expect(last.scenes.every((c) => c.from === 'app')).toBe(true);
    expect(cacheFiles(world).filter((f) => f.endsWith('.failed'))).toHaveLength(4);
  });

  it('marks a picture the steps can not use, and never tries it again', async () => {
    const world = makeWorld();
    upload(world, 'characters/no-hole.png', png(1080, 1920));
    upload(world, 'backgrounds/broken.png', png(1080, 1920, 'broken'));
    const lib = startApp(world);
    const { steps, calls } = makeSteps(world, { analyse: () => null });
    steps.normalise.mockImplementationOnce(async () => null);      // the newest (broken.png) can't be read
    await visit(lib, steps);
    await visit(lib, steps);
    expect(world.downloads).toHaveLength(2);
    expect(calls.analyse).toHaveLength(1);
  });

  it('leaves out a character whose face answer is not usable (a broken number, too few hole points)', async () => {
    const world = makeWorld();
    upload(world, 'characters/odd-one.webp', webpExtended(1080, 1920));
    upload(world, 'characters/odd-two.webp', webpExtended(1080, 1920));
    const lib = startApp(world);
    const { steps } = makeSteps(world, {
      analyse: (uri) => (uri.includes('odd-one') ? { ...GUESSED, eyes: [[Number.NaN, 0.1], [0.5, 0.1]] } : { ...GUESSED, hole: GUESSED.hole.slice(0, 10) }),
    });
    const answer = await visit(lib, steps);
    expect(answer.characters.every((c) => c.from === 'app')).toBe(true);
    expect(cacheFiles(world).filter((f) => f.endsWith('.failed'))).toHaveLength(2);
  });

  it('a wrong copy is deleted and tried again on the next visit (not marked as failed)', async () => {
    const world = makeWorld();
    const good = webpExtended(1080, 1920);
    upload(world, 'characters/hero.webp', good);
    const lib = startApp(world);
    const { steps } = makeSteps(world);
    const broken = Buffer.from(good);
    broken[broken.length - 1] ^= 1;
    world.served.set('characters/hero.webp', broken);
    const first = await visit(lib, steps);
    expect(keys(first.characters)).toEqual(['app:made-up-boss', 'app:made-up-cop']);
    expect(cacheFiles(world).filter((f) => f.includes('/characters/'))).toEqual([]);
    world.served.clear();
    const second = await visit(lib, steps);
    expect(keys(second.characters)[0]).toBe('online:hero');
    expect(world.downloads).toHaveLength(2);
  });

  it('after the owner replaces a picture (same name, new version) it downloads again and checks the md5', async () => {
    const world = makeWorld();
    upload(world, 'characters/hero.webp', webpExtended(1080, 1920));
    const lib = startApp(world);
    const { steps } = makeSteps(world);
    const before = await visit(lib, steps);
    const oldFile = before.characters[0].file;
    const oldVersion = md5(world.bucket.get('characters/hero.webp').bytes);

    upload(world, 'characters/hero.webp', Buffer.concat([webpExtended(1080, 1920), Buffer.from(' v2')]));
    const newVersion = md5(world.bucket.get('characters/hero.webp').bytes);
    // Within 30 minutes nothing is listed again: the old version stays.
    world.now += 10 * MINUTE;
    expect((await visit(lib, steps)).characters[0].file).toBe(oldFile);
    // After 30 minutes it lists again, drops the old version and fetches the new one by its new address. The first
    // copy that arrives is an old one (wrong md5): it is thrown away and fetched again on the next visit.
    world.now += 25 * MINUTE;
    world.served.set('characters/hero.webp', Buffer.concat([webpExtended(1080, 1920), Buffer.from(' v1')]));
    const during = await visit(lib, steps);
    expect(keys(during.characters)).toEqual(['app:made-up-boss', 'app:made-up-cop']);
    expect(world.downloads.at(-1)).toBe(`${BASE}/characters/hero.webp?v=${newVersion}`);
    expect(world.files.has(oldFile)).toBe(false);
    world.served.clear();
    const after = await visit(lib, steps);
    expect(after.characters[0].file).toContain(`hero-${newVersion.slice(0, 8)}.png`);
    expect(after.characters[0].file).not.toContain(oldVersion.slice(0, 8));
    expect(world.downloads.filter((url) => url.endsWith(newVersion))).toHaveLength(2);
  });

  it('the .json wins: it is handed to the face step; a new .json gives a character another go', async () => {
    const world = makeWorld();
    upload(world, 'characters/hero.webp', webpExtended(1080, 1920));
    upload(world, 'characters/hero.json', JSON.stringify(anchors(0.05)));
    upload(world, 'characters/plain.webp', webpExtended(1080, 1920));
    const lib = startApp(world);
    const { steps, calls } = makeSteps(world, { analyse: (uri, sidecar) => (sidecar?.eyes?.[0]?.[0] > 0.48 ? sidecar : null) });
    const first = await visit(lib, steps);
    expect(calls.analyse.find((c) => c.uri.includes('/hero-')).sidecar).toEqual(anchors(0.05));
    expect(calls.analyse.find((c) => c.uri.includes('/plain-')).sidecar).toBeNull();
    expect(first.characters.find((c) => c.slug === 'hero').anchors).toEqual(anchors(0.05));
    expect(first.characters.some((c) => c.slug === 'plain')).toBe(false);
    expect(world.fetched).toHaveLength(1);

    // Not tried again while nothing changes.
    await visit(lib, steps);
    expect(calls.analyse).toHaveLength(2);
    // The owner adds a .json for the one that had none: after the next listing it gets another go, without
    // downloading the picture again (its copy was kept).
    upload(world, 'characters/plain.json', JSON.stringify(anchors(0.06)));
    world.now += 31 * MINUTE;
    const downloadsBefore = world.downloads.length;
    const second = await visit(lib, steps);
    expect(second.characters.find((c) => c.slug === 'plain').anchors).toEqual(anchors(0.06));
    expect(world.downloads).toHaveLength(downloadsBefore);
    expect(calls.analyse).toHaveLength(3);
  });

  it('offline: the next app start shows what this phone already has, and downloads nothing', async () => {
    const world = makeWorld();
    upload(world, 'characters/hero.webp', webpExtended(1080, 1920));
    upload(world, 'characters/hero.json', JSON.stringify(anchors(0.02)));
    upload(world, 'backgrounds/town.jpg', jpeg(1080, 1920));
    const { steps } = makeSteps(world);
    const online = await visit(startApp(world), steps);
    expect(keys(online.characters)[0]).toBe('online:hero');

    world.online = false;
    world.listing = 'offline';
    world.now += 2 * 60 * MINUTE;
    const lib = startApp(world);
    const downloads = world.downloads.length;
    const screen = lib.open(steps);
    await lib.onlineArtSettled();
    const offline = screen.read();
    screen.close();
    expect(keys(offline.characters)).toEqual(keys(online.characters));
    expect(keys(offline.scenes)).toEqual(keys(online.scenes));
    expect(offline.characters[0].anchors).toEqual(anchors(0.02));
    expect(world.downloads).toHaveLength(downloads);
    expect(lib.warnings.some((w) => /listing/.test(w))).toBe(true);
  });

  it('a picture the owner removed goes away, with its files', async () => {
    const world = makeWorld();
    upload(world, 'characters/hero.webp', webpExtended(1080, 1920));
    upload(world, 'backgrounds/town.jpg', jpeg(1080, 1920));
    const lib = startApp(world);
    const { steps } = makeSteps(world);
    const before = await visit(lib, steps);
    expect(keys(before.characters)[0]).toBe('online:hero');
    world.bucket.delete('characters/hero.webp');
    world.now += 31 * MINUTE;
    const after = await visit(lib, steps);
    expect(keys(after.characters)).toEqual(['app:made-up-boss', 'app:made-up-cop']);
    expect(keys(after.scenes)[0]).toBe('online-scene:town');
    expect(cacheFiles(world).filter((f) => f.includes('/characters/'))).toEqual([]);
  });

  it('a character and a scene with the same file name get different keys, so the camera never mixes them up', async () => {
    const world = makeWorld();
    upload(world, 'characters/beach.webp', webpExtended(1080, 1920));
    upload(world, 'characters/beach.json', JSON.stringify(anchors(0.03)));
    upload(world, 'backgrounds/beach.webp', webpExtended(1080, 1920));
    // An online scene with the name of an app character, and an online character with the name of an app scene.
    upload(world, 'backgrounds/made-up-boss.jpg', jpeg(1080, 1920));
    upload(world, 'characters/made-up-street.webp', webpExtended(1080, 1920));
    const lib = startApp(world);
    const { steps } = makeSteps(world);
    await visit(lib, steps);
    const answer = await visit(lib, steps);
    const character = answer.characters.find((c) => c.slug === 'beach');
    const scene = answer.scenes.find((c) => c.slug === 'beach');
    expect(character.key).toBe('online:beach');
    expect(scene.key).toBe('online-scene:beach');
    expect(character.file).toContain('/characters/');
    expect(scene.file).toContain('/backgrounds/');
    // Every picture the screen can show has a key of its own (the art cache and the camera go by it).
    const all = keys([...answer.characters, ...answer.scenes]);
    expect(all).toContain('online:made-up-street');
    expect(all).toContain('online-scene:made-up-boss');
    expect(all).toContain('app:made-up-boss');
    expect(all).toContain('app-scene:made-up-street');
    expect(new Set(all).size).toBe(all.length);
  });

  it('closing and reopening the app lists the folder again at once, so a new upload shows up (docs/MAIN_CHARACTER.md)', async () => {
    const world = makeWorld();
    upload(world, 'characters/hero.webp', webpExtended(1080, 1920));
    const lib = startApp(world);
    const { steps } = makeSteps(world);
    const first = await visit(lib, steps);
    expect(keys(first.characters)[0]).toBe('online:hero');
    expect(world.listCalls).toBe(2);                              // both folders, once

    // The owner uploads a new character 2 minutes later. While the app stays open, nothing is listed again
    // within 30 minutes.
    upload(world, 'characters/new-star.webp', webpExtended(1080, 1920));
    world.now += 2 * MINUTE;
    const same = await visit(lib, steps);
    expect(world.listCalls).toBe(2);
    expect(keys(same.characters)).not.toContain('online:new-star');

    // Closed and opened again (the module loads afresh on the same phone): the first visit lists at once.
    world.now += 1 * MINUTE;
    const reopened = startApp(world);
    const after = await visit(reopened, steps);
    expect(world.listCalls).toBe(4);
    expect(keys(after.characters).slice(0, 2)).toEqual(['online:new-star', 'online:hero']);
    // The next visit in the same app start doesn't list again.
    await visit(reopened, steps);
    expect(world.listCalls).toBe(4);
    // list.json still says when it was listed (only written down, never read back).
    expect(JSON.parse(world.files.get('file:///cache/main-character/list.json').toString('utf8')).at).toBe(world.now);
  });

  it('a picture the picture step hands back as it is (already 1080 × 1920) is kept under the library\'s own name', async () => {
    const world = makeWorld();
    const picture = webpExtended(1080, 1920);
    upload(world, 'characters/hero.webp', picture);
    upload(world, 'characters/hero.json', JSON.stringify(anchors(0.02)));
    upload(world, 'backgrounds/town.png', png(1080, 1920));
    // Like analyseArt.ts normaliseArt for a picture that is already the poster's size: the download itself.
    const { steps, calls } = makeSteps(world, { normalise: (uri) => uri });
    const answer = await visit(startApp(world), steps);
    const hero = answer.characters[0];
    const town = answer.scenes[0];
    expect(hero.key).toBe('online:hero');
    expect(hero.file).toMatch(/^file:\/\/\/cache\/main-character\/characters\/hero-[0-9a-f]{8}\.webp$/);
    expect(town.file).toMatch(/^file:\/\/\/cache\/main-character\/backgrounds\/town-[0-9a-f]{8}\.png$/);
    expect(Buffer.compare(world.files.get(hero.file), Buffer.from(picture))).toBe(0);
    expect(calls.analyse[0].uri).toBe(hero.file);
    // No download is left behind.
    expect(cacheFiles(world).some((f) => /\.download\.|\.part$/.test(f))).toBe(false);
    // The next app start (offline) finds the same copies and downloads nothing.
    world.online = false;
    world.listing = 'offline';
    const downloads = world.downloads.length;
    const later = await visit(startApp(world), steps);
    expect(later.characters[0]).toMatchObject({ key: 'online:hero', file: hero.file });
    expect(later.scenes[0]).toMatchObject({ key: 'online-scene:town', file: town.file });
    expect(world.downloads).toHaveLength(downloads);
  });

  it('an online picture with the same name as an app one takes its place only once it is ready', async () => {
    const world = makeWorld();
    upload(world, 'characters/made-up-cop.webp', webpExtended(1080, 1920));
    const lib = startApp(world);
    const { steps } = makeSteps(world);
    world.online = false;                                          // the download fails this time
    const first = await visit(lib, steps);
    expect(first.characters[1]).toMatchObject({ key: 'app:made-up-cop', file: 102 });
    world.online = true;
    const second = await visit(lib, steps);
    expect(keys(second.characters)).toEqual(['app:made-up-boss', 'online:made-up-cop']);
    expect(second.characters[1]).toMatchObject({ from: 'online', scene: 'made-up-mall' });
  });

  it('a hanging listing gives up and keeps the app art', async () => {
    const world = makeWorld();
    world.listing = 'hang';
    const lib = startApp(world, { timers: () => 5 });
    const { steps } = makeSteps(world);
    const answer = await visit(lib, steps);
    expect(keys(answer.characters)).toEqual(['app:made-up-boss', 'app:made-up-cop']);
    expect(answer.checking).toBe(false);
  });

  it('never throws at the screen, whatever breaks', async () => {
    const world = makeWorld();
    upload(world, 'characters/hero.webp', webpExtended(1080, 1920));
    upload(world, 'backgrounds/town.jpg', jpeg(1080, 1920));
    const { steps } = makeSteps(world, {
      normalise: () => { throw new Error('the phone is full'); },
      analyse: () => { throw new Error('no Skia'); },
    });
    const lib = startApp(world);
    await expect(visit(lib, steps)).resolves.toMatchObject({ checking: false });
    // A throwing step is tried again later (the phone may have room next time), not marked as failed.
    expect(cacheFiles(world).filter((f) => f.endsWith('.failed'))).toEqual([]);

    // Storage itself breaks, and then the files on the phone.
    const from = world.supabase.storage.from;
    world.supabase.storage.from = () => { throw new Error('no storage'); };
    world.now += 31 * MINUTE;
    await expect(visit(lib, steps)).resolves.toBeTruthy();
    world.supabase.storage.from = from;
    Object.defineProperty(world.fs.Paths, 'cache', { get() { throw new Error('no cache folder'); } });
    const fresh = startApp(world);
    const answer = await visit(fresh, steps);
    expect(keys(answer.characters)).toEqual(['app:made-up-boss', 'app:made-up-cop']);
    // A broken saved list is ignored.
    const again = makeWorld();
    again.files.set('file:///cache/main-character/list.json', Buffer.from('{not json'));
    again.listing = 'offline';
    const answer2 = await visit(startApp(again), makeSteps(again).steps);
    expect(keys(answer2.characters)).toEqual(['app:made-up-boss', 'app:made-up-cop']);
  });

  it('tells the screen when something changes, and hands back the same lists until then', async () => {
    const world = makeWorld();
    upload(world, 'characters/hero.webp', webpExtended(1080, 1920));
    const lib = startApp(world);
    const { steps } = makeSteps(world);
    const screen = lib.open(steps);
    let changes = 0;
    const stop = world.subscribe(() => { changes += 1; });
    const a = screen.read();
    expect(screen.read()).toBe(a);
    await lib.onlineArtSettled();
    expect(changes).toBeGreaterThan(0);
    const b = screen.read();
    expect(b).not.toBe(a);
    expect(screen.read()).toBe(b);
    stop();
    screen.close();
  });
});
