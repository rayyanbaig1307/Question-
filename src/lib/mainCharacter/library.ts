import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { useEffect, useSyncExternalStore } from 'react';

import { checkClean } from '../cleanWords';
import { supabase } from '../supabase';
import { BUNDLED_CHARACTERS, BUNDLED_SCENES } from './art.generated';
import { BLOCKED_HASHES, wordForms } from './blockedWords';
import {
  ART_BUCKET, ART_TALL, CHARACTER_FOLDER, LIST_REFRESH_MS, LIST_TIMEOUT_MS, MAX_ART_BYTES, MAX_ART_SIDE, MIN_ART_SIDE,
  ONLINE_PER_VISIT, SCENE_FOLDER,
} from './config';
import { artExtension, nameFromSlug, pickOnePerSlug, slugFromFile } from './holeFinder';
import type { ArtAnchors, CharacterArt, SceneArt } from './types';

// ---------------------------------------------------------------------------
// Main Character Mode 🌆: the characters and scenes you can pick (docs/MAIN_CHARACTER.md).
//
// Two kinds:
//   * the ones that come inside the app (art.generated.ios.ts on iPhone; Android and web get an empty list);
//   * online ones: the owner uploads them to the Supabase folder "main-character" and they show up in the app by
//     themselves, with no app update.
//
// Online pictures are only downloaded while someone has Main Character Mode open, a few per visit, newest first.
// Each one is checked before it is used:
//   * its name: no bad words (the app's usual check) and none of the owner's banned words (blockedWords.ts);
//   * its file: not over 1.5 MB, and the downloaded file must be exactly the size the listing said, with the
//     same fingerprint (md5), so a broken or old copy is never used;
//   * its picture size, read from the first bytes of the file before anything is decoded (a small file can hold
//     a giant picture that would use up the phone's memory).
// Then the screen's own picture steps make one 1080 × 1920 copy (and, for a character, find where the face goes),
// and that copy is kept on the phone in the cache folder (cache, not documents: no iCloud backup).
//
// No Skia here: the picture steps (`normalise`, `analyse`) come in from the screen, so this file loads on every
// download and in the tests. Nothing runs when this file loads, and nothing here ever throws at the screen.
// ---------------------------------------------------------------------------

export type ArtFolder = 'characters' | 'backgrounds';

// One picture in the online folder, as listed.
export type OnlineItem = {
  folder: ArtFolder;
  slug: string;            // 'street-boss' (from the file name)
  name: string;            // 'Street Boss'
  path: string;            // 'characters/street-boss.webp' – where it is in the folder
  ext: string;             // 'webp' | 'png' | 'jpg'
  url: string;             // the download address, with ?v=<etag> so a new version always has a new address
  etag: string;            // the file's version (for normal uploads: its md5)
  size: number;            // bytes
  updatedAt: string;       // when it was uploaded (newest first)
  sidecar: string | null;  // characters: the download address of its .json ("where the face goes"), or null
};

// The two picture steps the screen hands in (they use Skia, see components/mainCharacter/analyseArt.ts).
export type LibrarySteps = {
  // Makes the 1080 × 1920 copy of a checked download (the file at `fileUri`). Returns the copy's file://, or null
  // when the picture isn't usable (it is then never tried again for that version).
  normalise: (fileUri: string, folder: ArtFolder) => Promise<string | null>;
  // Where the face goes in a character copy (the .json wins when there is one). null = leave the character out.
  analyse: (fileUri: string, sidecar: Partial<ArtAnchors> | null) => Promise<ArtAnchors | null>;
};

export type Library = { characters: CharacterArt[]; scenes: SceneArt[]; checking: boolean };

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

const BLOCKED = new Set(BLOCKED_HASHES);

// May this name be shown? No bad words (checked like a username, also in lower case so "Dick" written like a real
// name doesn't slip through) and none of the owner's banned words, in any spelling blockedWords.ts knows.
// false when it can't be checked.
export async function nameAllowed(name: string): Promise<boolean> {
  try {
    if (typeof name !== 'string' || !name.trim()) return false;
    if (checkClean(name, 'name') !== null || checkClean(name.toLowerCase(), 'name') !== null) return false;
    for (const form of wordForms(name)) {
      const hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, form);
      if (BLOCKED.has(String(hash).toLowerCase())) return false;
    }
    return true;
  } catch (error) {
    warnOnce('name check', error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// The art that comes inside the app
// ---------------------------------------------------------------------------

let bundled: { characters: CharacterArt[]; scenes: SceneArt[] } | null = null;

// Each picture's own key (the art cache and the camera tell pictures apart by it). A scene's key is never the
// same as a character's, even when both have the same file name (characters/beach.webp and backgrounds/beach.webp).
const characterKey = (from: 'app' | 'online', slug: string) => `${from}:${slug}`;
const sceneKey = (from: 'app' | 'online', slug: string) => `${from}-scene:${slug}`;

// The characters and scenes inside the app, in their fixed order (made once, when first asked for).
export function bundledArt(): { characters: CharacterArt[]; scenes: SceneArt[] } {
  if (bundled) return bundled;
  const characters: CharacterArt[] = BUNDLED_CHARACTERS.map((c) => ({
    key: characterKey('app', c.slug), slug: c.slug, name: c.name, from: 'app', file: c.image, anchors: c.anchors, scene: c.scene,
  }));
  const scenes: SceneArt[] = BUNDLED_SCENES.map((s) => ({
    key: sceneKey('app', s.slug), slug: s.slug, name: s.name, from: 'app', file: s.image,
  }));
  bundled = { characters, scenes };
  return bundled;
}

// One list for the screen: online ones first (in the order given: newest first), then the ones inside the app in
// their fixed order. An online picture with the same name as one inside the app takes that one's place (so the
// owner can fix a picture without an app update) and a character keeps its own scene.
export function mergeArt(
  inside: { characters: CharacterArt[]; scenes: SceneArt[] },
  online: { characters: CharacterArt[]; scenes: SceneArt[] },
): { characters: CharacterArt[]; scenes: SceneArt[] } {
  return {
    characters: mergeList(inside.characters, online.characters, (fix, old) => ({ ...fix, scene: fix.scene ?? old.scene })),
    scenes: mergeList(inside.scenes, online.scenes, (fix) => fix),
  };
}

function mergeList<T extends { slug: string }>(inside: T[], online: T[], replace: (fix: T, old: T) => T): T[] {
  const fixes = new Map<string, T>();
  for (const item of online) if (!fixes.has(item.slug)) fixes.set(item.slug, item);
  const insideSlugs = new Set(inside.map((item) => item.slug));
  const merged: T[] = [];
  for (const item of fixes.values()) if (!insideSlugs.has(item.slug)) merged.push(item);
  for (const item of inside) {
    const fix = fixes.get(item.slug);
    merged.push(fix ? replace(fix, item) : item);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Listing the online folder
// ---------------------------------------------------------------------------

// Only plain file names: letters, digits, spaces, dots, dashes and underscores (anything else can break the
// download address).
const PLAIN_NAME = /^[A-Za-z0-9 ._-]+$/;
const MD5 = /^[0-9a-f]{32}$/i;
const MAX_SIDECAR_BYTES = 64 * 1024;          // a "where the face goes" file is about 3 KB
const DOWNLOAD_TIMEOUT_MS = 30_000;
const PICTURE_TYPES: Record<ArtFolder, string[]> = {
  // A character needs its see-through face hole, and JPEG pictures can't have see-through parts.
  characters: ['webp', 'png'],
  backgrounds: ['webp', 'png', 'jpg'],
};

type StorageEntry = {
  name?: unknown; id?: unknown; updated_at?: unknown; created_at?: unknown;
  metadata?: { eTag?: unknown; size?: unknown } | null;
};

// Every usable picture in both online folders, newest first. Throws when the folder can't be read (no internet,
// or the server said no); a folder that doesn't exist yet (the update that makes it hasn't been run) is empty.
export async function listOnlineArt(): Promise<OnlineItem[]> {
  const [characters, backgrounds] = await Promise.all([listFolder(CHARACTER_FOLDER), listFolder(SCENE_FOLDER)]);
  return newestFirst([...characters, ...backgrounds]);
}

async function listFolder(folder: ArtFolder): Promise<OnlineItem[]> {
  const { data, error } = await withTimeout(
    supabase.storage.from(ART_BUCKET).list(folder, { limit: 200, sortBy: { column: 'name', order: 'asc' } }),
    LIST_TIMEOUT_MS,
  );
  if (error) {
    if (/bucket not found/i.test(String(error.message ?? ''))) return [];
    throw error;
  }
  const pictures: OnlineItem[] = [];
  const sidecars = new Map<string, { url: string; updatedAt: string }>();
  for (const entry of (Array.isArray(data) ? data : []) as StorageEntry[]) {
    const file = readEntry(folder, entry);
    if (!file) continue;
    if (file.ext === 'json') {
      // "Where the face goes" for the character with the same name (characters only, small files only).
      const had = sidecars.get(file.slug);
      if (folder === CHARACTER_FOLDER && file.size <= MAX_SIDECAR_BYTES && (!had || file.updatedAt > had.updatedAt)) {
        sidecars.set(file.slug, { url: file.url, updatedAt: file.updatedAt });
      }
      continue;
    }
    if (!PICTURE_TYPES[folder].includes(file.ext) || file.size > MAX_ART_BYTES) continue;
    pictures.push(file);
  }
  const checked: OnlineItem[] = [];
  for (const item of pictures) if (await nameAllowed(item.name)) checked.push(item);
  return newestFirst(pickOnePerSlug(checked)).map((item) =>
    ({ ...item, sidecar: folder === CHARACTER_FOLDER ? sidecars.get(item.slug)?.url ?? null : null }));
}

// One listed file → an OnlineItem, or null when it is a folder, Supabase's placeholder, or anything odd.
function readEntry(folder: ArtFolder, entry: StorageEntry): OnlineItem | null {
  if (!entry || typeof entry.name !== 'string' || entry.id == null || !entry.metadata) return null;
  const fileName = entry.name;
  if (!PLAIN_NAME.test(fileName)) return null;
  const ext = artExtension(fileName);
  const slug = slugFromFile(fileName);
  if (!ext || !slug) return null;
  const etag = String(entry.metadata.eTag ?? '').replace(/^W\//, '').replace(/"/g, '').trim();
  const size = Number(entry.metadata.size);
  if (!/^[A-Za-z0-9-]{1,100}$/.test(etag) || !Number.isFinite(size) || size <= 0) return null;
  const updatedAt = typeof entry.updated_at === 'string' ? entry.updated_at
    : typeof entry.created_at === 'string' ? entry.created_at : '';
  const path = `${folder}/${fileName}`;
  return { folder, slug, name: nameFromSlug(slug), path, ext, url: versionedUrl(path, etag), etag, size, updatedAt, sidecar: null };
}

// The public address with the version on the end: a replaced picture gets a new address, so no copy of the old
// one (on the phone or on the way) can ever be handed back for it.
function versionedUrl(path: string, etag: string): string {
  const base = supabase.storage.from(ART_BUCKET).getPublicUrl(path).data.publicUrl;
  return `${base}${base.includes('?') ? '&' : '?'}v=${encodeURIComponent(etag)}`;
}

function newestFirst<T extends { updatedAt: string; slug: string }>(items: T[]): T[] {
  return [...items].sort((a, b) =>
    a.updatedAt === b.updatedAt ? (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0) : a.updatedAt < b.updatedAt ? 1 : -1);
}

// ---------------------------------------------------------------------------
// Downloading and checking one picture
// ---------------------------------------------------------------------------

// Files on the phone: Paths.cache/main-character/<folder>/<slug>-<first 8 of the version>.<…>
//   .png / .jpg       the 1080 × 1920 copy the app uses
//   .anchors.json     where the face goes (characters)
//   .failed           this version didn't work: it is never tried again
//   .part / .download.<ext>   a download on its way / a checked download waiting for its copy
// plus Paths.cache/main-character/list.json: the last good listing (and when it was made, which is only written
// down: each app start lists again).
function cacheFolder(folder?: ArtFolder): Directory {
  const dir = folder ? new Directory(Paths.cache, 'main-character', folder) : new Directory(Paths.cache, 'main-character');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

function fileKey(item: OnlineItem): string {
  const version = item.etag.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'none';
  return `${item.slug}-${version}`;
}

// Downloads one listed picture and checks it is exactly the file that was listed: the same size and, for normal
// uploads (where the version is the file's md5), the same md5. Returns the checked file's file://. Throws when
// the download fails or doesn't match (the bad copy is deleted and it is tried again on a later visit).
export async function downloadOnline(item: OnlineItem): Promise<string> {
  const dir = cacheFolder(item.folder);
  const part = new File(dir, `${fileKey(item)}.${item.ext}.part`);
  removeFile(part);
  // A download that hangs is stopped after DOWNLOAD_TIMEOUT_MS, so a visit always ends.
  const stop = typeof AbortController === 'function' ? new AbortController() : null;
  try {
    const got = await withTimeout(
      File.downloadFileAsync(item.url, part, stop ? { idempotent: true, signal: stop.signal } : { idempotent: true }),
      DOWNLOAD_TIMEOUT_MS,
      () => stop?.abort(),
    );
    const file = new File(got?.uri ?? part.uri);
    if (file.size !== item.size) throw new Error(`The downloaded picture is ${file.size} bytes, not ${item.size}`);
    if (MD5.test(item.etag)) {
      const md5 = String(await fileMd5(file)).toLowerCase();
      if (md5 !== item.etag.toLowerCase()) throw new Error('The downloaded picture is not the one that was listed');
    }
    const checked = new File(dir, `${fileKey(item)}.download.${item.ext}`);
    removeFile(checked);
    await file.move(checked);
    return checked.uri;
  } catch (error) {
    removeFile(part);
    throw error;
  }
}

async function fileMd5(file: File): Promise<string | null> {
  if (typeof file.digest === 'function') return file.digest('MD5');
  return file.md5 ?? null;
}

// The picture's width and height, read only from the first bytes of a PNG, JPEG or WebP file – nothing is
// decoded. null when it isn't one of those or the start of the file is broken.
export function pictureSize(bytes: Uint8Array): { width: number; height: number } | null {
  const b = bytes;
  const at = (i: number) => (i < b.length ? b[i] : -1);
  const big16 = (i: number) => at(i) * 256 + at(i + 1);
  const big32 = (i: number) => ((at(i) * 256 + at(i + 1)) * 256 + at(i + 2)) * 256 + at(i + 3);
  const little16 = (i: number) => at(i) + at(i + 1) * 256;
  const little24 = (i: number) => at(i) + at(i + 1) * 256 + at(i + 2) * 65536;
  const text = (i: number, length: number) => String.fromCharCode(...Array.from(b.subarray(i, i + length)));
  if (!b || b.length < 30) return null;
  // PNG: the size is in the first chunk (IHDR).
  if (at(0) === 0x89 && text(1, 3) === 'PNG' && text(12, 4) === 'IHDR') return sized(big32(16), big32(20));
  // WebP: one of three kinds of first chunk.
  if (text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
    const kind = text(12, 4);
    if (kind === 'VP8X') return sized(little24(24) + 1, little24(27) + 1);
    if (kind === 'VP8L' && at(20) === 0x2f) {
      const bits = at(21) + at(22) * 256 + at(23) * 65536 + at(24) * 16777216;
      return sized((bits & 0x3fff) + 1, (Math.floor(bits / 16384) & 0x3fff) + 1);
    }
    if (kind === 'VP8 ' && at(23) === 0x9d && at(24) === 0x01 && at(25) === 0x2a) {
      return sized(little16(26) & 0x3fff, little16(28) & 0x3fff);
    }
    return null;
  }
  // JPEG: walk the blocks until the one that holds the size (a "start of frame" block).
  if (at(0) === 0xff && at(1) === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (at(i) !== 0xff) return null;
      const marker = at(i + 1);
      if (marker === 0xff) { i += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      if (marker === 0xd9 || marker === 0xda) return null;   // the picture data starts and no size was seen
      const length = big16(i + 2);
      if (length < 2) return null;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return sized(big16(i + 7), big16(i + 5));
      }
      i += 2 + length;
    }
  }
  return null;
}

function sized(width: number, height: number): { width: number; height: number } | null {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 ? { width, height } : null;
}

// Pictures the app takes: each side MIN_ART_SIDE…MAX_ART_SIDE, standing up (height ART_TALL × the width, 1.5–2.1;
// the poster is 1.78).
export function pictureSizeOk(size: { width: number; height: number } | null): boolean {
  if (!size) return false;
  const { width, height } = size;
  if (Math.min(width, height) < MIN_ART_SIDE || Math.max(width, height) > MAX_ART_SIDE) return false;
  const tall = height / width;
  return tall >= ART_TALL.min && tall <= ART_TALL.max;
}

// A "where the face goes" answer the drawing can use: every number a real number, 36 points round the hole.
function anchorsUsable(a: unknown): a is ArtAnchors {
  if (!a || typeof a !== 'object') return false;
  const anchors = a as Partial<ArtAnchors>;
  const num = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  const pt = (p: unknown) => Array.isArray(p) && p.length === 2 && num(p[0]) && num(p[1]);
  return Array.isArray(anchors.eyes) && anchors.eyes.length === 2 && anchors.eyes.every(pt)
    && pt(anchors.nose) && pt(anchors.chin) && pt(anchors.forehead)
    && Array.isArray(anchors.hole) && anchors.hole.length === 36 && anchors.hole.every(pt)
    && num(anchors.faceWidth) && (anchors.faceWidth as number) > 0
    && Array.isArray(anchors.skinTone) && anchors.skinTone.length === 3 && anchors.skinTone.every(num)
    && typeof anchors.toneSure === 'boolean';
}

// ---------------------------------------------------------------------------
// What this phone has (module state, shared by every screen that uses the hook)
// ---------------------------------------------------------------------------

type Ready = { item: OnlineItem; file: string; anchors: ArtAnchors | null };

// Bump this when the checks change in a way that should give pictures marked "didn't work" another go.
const RULES = 1;

const store = {
  started: false,                      // list.json and the files on the phone have been read
  items: [] as OnlineItem[],           // the last good listing (newest first)
  listedAt: 0,
  ready: new Map<string, Ready>(),     // `${folder}/${slug}` → its prepared copy
  screensOpen: 0,
};
let running: Promise<void> | null = null;
let version = 0;
let answer: { version: number; library: Library } | null = null;
const listeners = new Set<() => void>();

function emit() {
  version += 1;
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* a screen's problem, not ours */ }
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const readVersion = () => version;

// The online characters and scenes ready on this phone, newest first.
function onlineArt(): { characters: CharacterArt[]; scenes: SceneArt[] } {
  const ready = newestFirst([...store.ready.values()].map((r) => ({ ...r, updatedAt: r.item.updatedAt, slug: r.item.slug })));
  const characters: CharacterArt[] = [];
  const scenes: SceneArt[] = [];
  for (const { item, file, anchors } of ready) {
    const base = { slug: item.slug, name: item.name, from: 'online' as const, file };
    if (item.folder === CHARACTER_FOLDER) {
      if (anchors) characters.push({ ...base, key: characterKey('online', item.slug), anchors, scene: null });
    } else {
      scenes.push({ ...base, key: sceneKey('online', item.slug) });
    }
  }
  return { characters, scenes };
}

function currentLibrary(): Library {
  if (answer?.version === version) return answer.library;
  let library: Library;
  try {
    library = { ...mergeArt(bundledArt(), onlineArt()), checking: running !== null };
  } catch (error) {
    warnOnce('library', error);
    library = { characters: [], scenes: [], checking: false };
  }
  answer = { version, library };
  return library;
}

// Waits until the online pictures have finished being listed and prepared for now (used by the tests).
export function onlineArtSettled(): Promise<void> {
  return running ?? Promise.resolve();
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

// The picture steps of the screen that is open now.
let steps: LibrarySteps | null = null;

// Every character and scene to pick from, for the Main Character screen. Starts with the art inside the app at
// once, adds the online ones already on this phone, and while the screen is open lists the folder again (on the
// first visit after each app start, then when the last listing is over 30 minutes old) and prepares a few new
// pictures, newest first, one at a time.
export function useMainCharacterLibrary(given: LibrarySteps): Library {
  // 'use no memo': the answer comes from the shared state above, which changes behind the scenes (a new picture
  // is ready). The React Compiler can't see that and would keep handing back the old list.
  // tests/unit/compiler-hooks.test.mjs checks this.
  'use no memo';
  useSyncExternalStore(subscribe, readVersion, readVersion);
  useEffect(() => {
    steps = given;
  });
  useEffect(() => {
    store.screensOpen += 1;
    if (!running) {
      running = visit().finally(() => {
        running = null;
        emit();
      });
      emit();
    }
    return () => {
      store.screensOpen = Math.max(0, store.screensOpen - 1);
    };
  }, []);
  return currentLibrary();
}

// One visit: read what this phone has, list the folder if that is due (the first visit after each app start, or
// 30 minutes after the last listing), then prepare up to ONLINE_PER_VISIT new pictures, newest first, while the
// screen is open. Never throws.
async function visit(): Promise<void> {
  try {
    if (!store.started) {
      store.started = true;
      await restore();
      emit();
    }
    if (store.listedAt === 0 || Date.now() - store.listedAt > LIST_REFRESH_MS) {
      try {
        const items = await listOnlineArt();
        store.items = items;
        store.listedAt = Date.now();
        dropUnlisted();
        saveList();
        emit();
      } catch (error) {
        // No internet, or the server said no: keep what this phone has.
        warnOnce('listing', error);
      }
    }
    let tries = 0;
    for (const item of store.items) {
      if (tries >= ONLINE_PER_VISIT || store.screensOpen === 0) break;
      if (isReady(item) || failedBefore(item)) continue;
      tries += 1;
      await prepare(item);
      emit();
    }
  } catch (error) {
    warnOnce('visit', error);
  }
}

const readyKey = (item: { folder: string; slug: string }) => `${item.folder}/${item.slug}`;

function isReady(item: OnlineItem): boolean {
  const ready = store.ready.get(readyKey(item));
  return !!ready && ready.item.etag === item.etag && ready.item.sidecar === item.sidecar;
}

// Turns one listed picture into its prepared copy. A download that fails or doesn't match is tried again on a
// later visit; a picture that isn't usable is marked and never tried again (for this version).
async function prepare(item: OnlineItem): Promise<void> {
  const use = steps;
  if (!use) return;
  const dir = cacheFolder(item.folder);
  const key = fileKey(item);
  let copy = preparedCopy(item);
  if (!copy) {
    let download: string;
    try {
      download = await downloadOnline(item);
    } catch (error) {
      warnOnce(`download ${item.path}`, error);
      return;
    }
    try {
      // The picture's size, from its first bytes: a picture that is too big, too small or the wrong shape is
      // refused before anything decodes it.
      if (!pictureSizeOk(pictureSize(await new File(download).bytes()))) {
        markFailed(item, 'picture');
        return;
      }
      const made = await use.normalise(download, item.folder);
      if (!made) {
        markFailed(item, 'picture');
        return;
      }
      // Keep the copy under this library's own name for it.
      const ending = made.toLowerCase();
      const ext = ending.endsWith('.png') ? 'png' : ending.endsWith('.webp') ? 'webp' : 'jpg';
      const target = new File(dir, `${key}.${ext}`);
      if (made !== target.uri) {
        removeFile(target);
        await new File(made).move(target);
      }
      copy = target.uri;
    } catch (error) {
      // The phone couldn't read or write a file (for example it is full): tried again on a later visit.
      warnOnce(`copy ${item.path}`, error);
      return;
    } finally {
      removeFile(new File(download));
    }
  }
  if (item.folder !== CHARACTER_FOLDER) {
    store.ready.set(readyKey(item), { item, file: copy, anchors: null });
    return;
  }
  let sidecar: Partial<ArtAnchors> | null = null;
  if (item.sidecar) {
    try {
      sidecar = await readSidecar(item.sidecar);
    } catch (error) {
      // No internet for the small file: the copy is kept and it is tried again next visit.
      warnOnce(`sidecar ${item.path}`, error);
      return;
    }
  }
  let anchors: ArtAnchors | null = null;
  try {
    const found = await use.analyse(copy, sidecar);
    if (anchorsUsable(found)) anchors = found;
  } catch (error) {
    warnOnce(`face ${item.path}`, error);
  }
  if (!anchors) {
    markFailed(item, 'face');
    return;
  }
  store.ready.set(readyKey(item), { item, file: copy, anchors });
  try {
    const saved = new File(dir, `${key}.anchors.json`);
    if (!saved.exists) saved.create();
    saved.writeSync(JSON.stringify({ rules: RULES, sidecar: item.sidecar, anchors }));
  } catch (error) {
    // Shown now; worked out again after the next app start.
    warnOnce('save face', error);
  }
}

// The small "where the face goes" file. null when it isn't a usable JSON object (the app then looks for the hole
// itself); throws when it can't be downloaded.
async function readSidecar(url: string): Promise<Partial<ArtAnchors> | null> {
  const response = await withTimeout(fetch(url), LIST_TIMEOUT_MS);
  if (!response.ok) throw new Error(`The face file answered ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_SIDECAR_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Partial<ArtAnchors>) : null;
  } catch {
    return null;
  }
}

// The prepared 1080 × 1920 copy of this version, if it is on the phone.
function preparedCopy(item: OnlineItem): string | null {
  const dir = cacheFolder(item.folder);
  for (const ext of ['png', 'jpg', 'webp']) {
    const file = new File(dir, `${fileKey(item)}.${ext}`);
    if (file.exists) return file.uri;
  }
  return null;
}

// Was this version marked as not usable? A character marked for its face is tried again when its .json changes.
function failedBefore(item: OnlineItem): boolean {
  const marker = new File(cacheFolder(item.folder), `${fileKey(item)}.failed`);
  if (!marker.exists) return false;
  try {
    const saved = JSON.parse(marker.textSync());
    if (saved?.rules !== RULES) return false;
    return saved.why === 'picture' || saved.sidecar === item.sidecar;
  } catch {
    return true;
  }
}

function markFailed(item: OnlineItem, why: 'picture' | 'face') {
  try {
    const marker = new File(cacheFolder(item.folder), `${fileKey(item)}.failed`);
    if (!marker.exists) marker.create();
    marker.writeSync(JSON.stringify({ rules: RULES, why, sidecar: item.sidecar }));
  } catch (error) {
    warnOnce('mark', error);
  }
}

// Reads list.json and the prepared copies already on this phone (so they show at once, also with no internet),
// and clears away downloads that were cut off last time. When the last listing was made is NOT read back: the
// first visit after each app start lists the folder again (two small requests), so a picture the owner just
// uploaded shows up after closing and reopening the app. With no internet that listing fails quietly and what
// this phone has is kept.
async function restore(): Promise<void> {
  try {
    const list = new File(cacheFolder(), 'list.json');
    if (list.exists) {
      const saved = JSON.parse(list.textSync());
      const items: OnlineItem[] = Array.isArray(saved?.items) ? saved.items.filter(looksLikeItem) : [];
      const checked: OnlineItem[] = [];
      for (const item of items) if (await nameAllowed(item.name)) checked.push(item);
      store.items = newestFirst(checked);
    }
  } catch (error) {
    warnOnce('saved list', error);
  }
  for (const folder of [CHARACTER_FOLDER, SCENE_FOLDER] as ArtFolder[]) {
    try {
      for (const entry of cacheFolder(folder).list()) {
        if (entry instanceof File && /\.part$|\.download\.[a-z]+$/.test(entry.name)) removeFile(entry);
      }
    } catch (error) {
      warnOnce('tidy', error);
    }
  }
  for (const item of store.items) {
    try {
      const copy = preparedCopy(item);
      if (!copy) continue;
      if (item.folder !== CHARACTER_FOLDER) {
        store.ready.set(readyKey(item), { item, file: copy, anchors: null });
        continue;
      }
      const saved = new File(cacheFolder(item.folder), `${fileKey(item)}.anchors.json`);
      if (!saved.exists) continue;
      const parsed = JSON.parse(saved.textSync());
      if (parsed?.rules === RULES && parsed.sidecar === item.sidecar && anchorsUsable(parsed.anchors)) {
        store.ready.set(readyKey(item), { item, file: copy, anchors: parsed.anchors });
      }
    } catch (error) {
      warnOnce('saved copy', error);
    }
  }
}

function looksLikeItem(item: unknown): item is OnlineItem {
  const i = item as OnlineItem;
  return !!i && (i.folder === CHARACTER_FOLDER || i.folder === SCENE_FOLDER)
    && [i.slug, i.name, i.path, i.ext, i.url, i.etag, i.updatedAt].every((s) => typeof s === 'string')
    && typeof i.size === 'number' && (i.sidecar === null || typeof i.sidecar === 'string')
    && slugFromFile(`${i.slug}.${i.ext}`) === i.slug && PICTURE_TYPES[i.folder].includes(i.ext);
}

// After a new listing: forget pictures that are gone (or were replaced) and delete their files.
function dropUnlisted() {
  for (const [key, ready] of [...store.ready]) {
    if (!store.items.some((item) => readyKey(item) === key && item.etag === ready.item.etag)) store.ready.delete(key);
  }
  for (const folder of [CHARACTER_FOLDER, SCENE_FOLDER] as ArtFolder[]) {
    const keep = store.items.filter((item) => item.folder === folder).map((item) => `${fileKey(item)}.`);
    try {
      for (const entry of cacheFolder(folder).list()) {
        if (entry instanceof File && !keep.some((start) => entry.name.startsWith(start))) removeFile(entry);
      }
    } catch (error) {
      warnOnce('tidy', error);
    }
  }
}

function saveList() {
  try {
    const list = new File(cacheFolder(), 'list.json');
    if (!list.exists) list.create();
    list.writeSync(JSON.stringify({ at: store.listedAt, items: store.items }));
  } catch (error) {
    warnOnce('save list', error);
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function removeFile(file: File) {
  try {
    if (file.exists) file.delete();
  } catch {
    // Already gone, or it will be cleared with the cache.
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* it is stopping anyway */ }
      reject(new Error('Main Character art: no answer in time'));
    }, ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

const warned = new Set<string>();
function warnOnce(what: string, error: unknown) {
  if (warned.has(what)) return;
  warned.add(what);
  console.warn(`Main Character art: ${what}`, error);
}
