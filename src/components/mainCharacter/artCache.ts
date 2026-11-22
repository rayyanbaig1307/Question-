import { FilterMode, MipmapMode, Skia, type SkData, type SkImage, type SkSurface } from '@shopify/react-native-skia';
import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { useEffect, useSyncExternalStore } from 'react';

import { ART_CACHE_SIZE, MAX_ART_SIDE, POSTER_H, POSTER_W } from '@/lib/mainCharacter/config';
import type { CharacterArt, SceneArt } from '@/lib/mainCharacter/types';

import { coverCrop } from './fit';
import type { LiveScene } from './paintScene';

// ---------------------------------------------------------------------------
// Main Character Mode 🌆: the character and scene pictures, read and kept ready (docs/MAIN_CHARACTER.md).
//
// Read all the way here, on the JS thread. Skia's MakeImageFromEncoded only reads a picture's size: the real
// reading would then happen on the drawing thread the first time the picture is drawn – on every swipe (a jolt),
// and again in the photo bake. So each picture is drawn once into a plain 1080 × 1920 picture in the phone's
// memory (not the graphics chip: the photo bake on the JS thread uses the same pictures), and only that is handed
// out. A picture that can't be read is left out (said once in the log).
//
// A few are kept (ART_CACHE_SIZE: the current, next and previous character, the current scene and one spare;
// about 8 MB each). One that drops out is only let go of when it is safe – all of these:
// - it is in neither the poster on screen nor the one before it (noteShown);
// - no saved poster that is being made holds it (holdScene);
// - at least 2 drawings were made since it left the screen (the live drawing lets go of its old drawings two
//   drawings later), checked every half second while anything waits.
// When the Main Character screen closes, every picture is let go of a moment later (unless a poster still holds it).
//
// No Skia work happens when this file loads: only when the screen asks for pictures.
// ---------------------------------------------------------------------------

type Art = CharacterArt | SceneArt;

// A picture that is read and handed out. `used`: when it was last wanted (a counter, for "least recently used").
type Kept = { id: string; image: SkImage; used: number };
// A picture waiting to be let go of. `since`: the drawing count when it was last seen off the screen (null =
// still on it). `ticks`: half-second checks since the screen closed.
type Leaving = { id: string; image: SkImage; since: number | null; ticks: number };

// How often the pictures waiting to be let go of are checked (milliseconds).
const CHECK_MS = 500;
// Drawings that must be made after a picture left the screen before it is let go of.
const DRAWINGS_AFTER = 2;
// With the screen closed (nothing draws any more): checks to wait before letting go.
const CLOSED_CHECKS = 2;
// The poster's shape (width ÷ height).
const POSTER_ASPECT = POSTER_W / POSTER_H;

const kept = new Map<string, Kept>();
const leaving: Leaving[] = [];
const reading = new Set<string>();
const failed = new Set<string>();
const holds = new Map<SkImage, number>();
const listeners = new Set<() => void>();
const clocks = new Set<() => number>();
let wanted = new Set<string>();
let current: LiveScene | null = null;
let previous: LiveScene | null = null;
let drawnNow = 0;
let version = 0;
let useCount = 0;
let users = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let queue: Promise<void> = Promise.resolve();

// One picture's name in the cache: its art key and its file (an online picture can be replaced under the same name).
function idOf(art: Art): string {
  return `${art.key}@${String(art.file)}`;
}

function tell() {
  version += 1;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // One listener failing must not stop the others.
    }
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function currentVersion(): number {
  return version;
}

// Lets go of one Skia object (it may already be gone).
function letGo(thing: { dispose: () => void } | null | undefined) {
  if (!thing) return;
  try {
    thing.dispose();
  } catch {
    // Already gone: nothing more to do.
  }
}

// The newest drawing count (from the live drawing, through useDrawingClock).
function readDrawings() {
  for (const read of clocks) {
    try {
      const count = read();
      if (Number.isFinite(count) && count > drawnNow) drawnNow = count;
    } catch {
      // Keep the count we have.
    }
  }
  return drawnNow;
}

function onScreen(image: SkImage): boolean {
  for (const scene of [current, previous]) {
    if (scene && (scene.character === image || scene.background === image)) return true;
  }
  return false;
}

// Lets go of every waiting picture that is safe to let go of now. `tick`: called by the half-second check.
function sweep(tick: boolean) {
  const drawings = readDrawings();
  for (let i = leaving.length - 1; i >= 0; i--) {
    const item = leaving[i];
    if (onScreen(item.image)) {
      item.since = null;
      item.ticks = 0;
      continue;
    }
    if (item.since === null) item.since = drawings;
    if (tick && users === 0) item.ticks += 1;
    if ((holds.get(item.image) ?? 0) > 0) continue;
    const settled = users === 0 ? item.ticks >= CLOSED_CHECKS : drawings - item.since >= DRAWINGS_AFTER;
    if (!settled) continue;
    leaving.splice(i, 1);
    letGo(item.image);
  }
  if (leaving.length > 0 && timer === null) {
    timer = setInterval(() => sweep(true), CHECK_MS);
  } else if (leaving.length === 0 && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

// Keeps at most ART_CACHE_SIZE pictures: the least recently wanted ones that aren't wanted now start leaving.
function trim() {
  while (kept.size > ART_CACHE_SIZE) {
    let oldest: Kept | null = null;
    for (const entry of kept.values()) {
      if (wanted.has(entry.id)) continue;
      if (!oldest || entry.used < oldest.used) oldest = entry;
    }
    if (!oldest) break;
    kept.delete(oldest.id);
    leaving.push({ id: oldest.id, image: oldest.image, since: null, ticks: 0 });
  }
  sweep(false);
}

// Reads one picture's bytes all the way into a plain 1080 × 1920 picture (its centred 9:16 part, which is what
// the anchors are measured on). Throws when it can't.
function decodeArtBytes(bytes: Uint8Array): SkImage {
  let data: SkData | null = null;
  let header: SkImage | null = null;
  let surface: SkSurface | null = null;
  try {
    data = Skia.Data.fromBytes(bytes);
    // This only reads the size; the picture itself is read by the drawing below.
    header = Skia.Image.MakeImageFromEncoded(data);
    if (!header) throw new Error('Could not read the picture');
    const w = header.width();
    const h = header.height();
    if (!(w > 0) || !(h > 0) || w > MAX_ART_SIDE || h > MAX_ART_SIDE) throw new Error(`The picture has an odd size (${w} × ${h})`);
    surface = Skia.Surface.Make(POSTER_W, POSTER_H);
    if (!surface) throw new Error('Could not make a drawing surface');
    const canvas = surface.getCanvas();
    canvas.clear(Skia.Color('transparent'));
    const crop = coverCrop(w, h, POSTER_ASPECT);
    const paint = Skia.Paint();
    try {
      paint.setAntiAlias(true);
      canvas.drawImageRectOptions(header, Skia.XYWHRect(crop.x, crop.y, crop.w, crop.h), Skia.XYWHRect(0, 0, POSTER_W, POSTER_H),
        FilterMode.Linear, MipmapMode.None, paint);
    } finally {
      letGo(paint);
    }
    surface.flush();
    const decoded = surface.makeImageSnapshot();
    if (!decoded) throw new Error('Could not read the picture');
    return decoded;
  } finally {
    letGo(header);
    letGo(surface);
    letGo(data);
  }
}

// Where a picture's bytes are: the app's own copy for pictures that come with the app, the checked copy on the
// phone for online ones.
async function artBytes(art: Art): Promise<Uint8Array> {
  let uri: string | null;
  if (typeof art.file === 'number') {
    const asset = Asset.fromModule(art.file);
    await asset.downloadAsync();
    uri = asset.localUri ?? null;
  } else {
    uri = art.file;
  }
  if (!uri) throw new Error('No file for this picture');
  return new Uint8Array(await new File(uri).arrayBuffer());
}

async function readOne(art: Art, id: string) {
  try {
    // Not wanted any more (a quick swipe past it): don't read it now.
    if (!wanted.has(id)) return;
    const image = decodeArtBytes(await artBytes(art));
    if (wanted.has(id) && !kept.has(id)) {
      kept.set(id, { id, image, used: ++useCount });
    } else {
      // Read for nothing (no longer wanted): nobody has it, so it can go at once.
      letGo(image);
    }
  } catch (error) {
    failed.add(id);
    console.warn(`Main Character: the picture "${art.key}" could not be read, leaving it out`, error);
  } finally {
    reading.delete(id);
    trim();
    tell();
  }
}

// The screen wants these pictures (in this order: the first ones are read first).
function request(want: Art[]) {
  const ids = want.map(idOf);
  wanted = new Set(ids);
  let changed = false;
  want.forEach((art, i) => {
    const id = ids[i];
    const entry = kept.get(id);
    if (entry) {
      entry.used = ++useCount;
      return;
    }
    // Wanted again before it was let go of: back into the cache, no need to read it again.
    const back = leaving.findIndex((item) => item.id === id);
    if (back >= 0) {
      const [item] = leaving.splice(back, 1);
      kept.set(id, { id, image: item.image, used: ++useCount });
      changed = true;
      return;
    }
    if (failed.has(id) || reading.has(id)) return;
    reading.add(id);
    changed = true;
    queue = queue.then(() => readOne(art, id));
  });
  trim();
  if (changed) tell();
}

// The screen closed: nothing is on screen any more, and every picture starts leaving (a moment later it is let
// go of, unless a poster being made still holds it).
function closeAll() {
  current = null;
  previous = null;
  wanted = new Set();
  for (const entry of kept.values()) leaving.push({ id: entry.id, image: entry.image, since: null, ticks: 0 });
  kept.clear();
  sweep(false);
}

// For the screen: the pictures for `want` that are ready (by art key), whether any is still being read, and the
// ones that couldn't be read (left out). Answers from the cache above, so it opts out of the React Compiler.
export function useArtImages(want: (CharacterArt | SceneArt)[]): { images: Map<string, SkImage>; loading: boolean; failed: Set<string> } {
  'use no memo';
  useSyncExternalStore(subscribe, currentVersion, currentVersion);
  useEffect(() => {
    users += 1;
    return () => {
      users -= 1;
      if (users === 0) closeAll();
    };
  }, []);
  useEffect(() => {
    request(want);
  }, [want]);
  const images = new Map<string, SkImage>();
  const missing = new Set<string>();
  let loading = false;
  for (const art of want) {
    const id = idOf(art);
    const entry = kept.get(id);
    if (entry) images.set(art.key, entry.image);
    else if (failed.has(id)) missing.add(art.key);
    else loading = true;
  }
  return { images, loading, failed: missing };
}

// A poster being made (snapshot or photo) holds its pictures until it is done: call the answer when done.
export function holdScene(scene: LiveScene): () => void {
  const images = [scene.character, scene.background].filter((image): image is SkImage => !!image);
  for (const image of images) holds.set(image, (holds.get(image) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const image of images) {
      const left = (holds.get(image) ?? 1) - 1;
      if (left > 0) holds.set(image, left);
      else holds.delete(image);
    }
    sweep(false);
  };
}

// The poster on screen changed (`drawn`: the drawing count now). The one before it stays protected too.
export function noteShown(scene: LiveScene | null, drawn: number): void {
  if (Number.isFinite(drawn) && drawn > drawnNow) drawnNow = drawn;
  if (scene !== current) {
    previous = current;
    current = scene;
  }
  sweep(false);
}

// The live drawing's count (MainCharacterOverlay.tsx adds 1 for each drawing), for the half-second check.
export function useDrawingClock(drawn: { get: () => number }): void {
  useEffect(() => {
    const read = () => drawn.get();
    clocks.add(read);
    return () => {
      clocks.delete(read);
    };
  }, [drawn]);
}
