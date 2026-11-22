import {
  AlphaType,
  ColorType,
  FilterMode,
  ImageFormat,
  MipmapMode,
  Skia,
  type SkData,
  type SkImage,
  type SkSurface,
} from '@shopify/react-native-skia';
import { File } from 'expo-file-system';

import { ART_TALL, MAX_ART_SIDE, MIN_ART_SIDE, POSTER_H, POSTER_W } from '@/lib/mainCharacter/config';
import { anchorsFromHole, findFaceHole, holeLooksRight, skinToneAround } from '@/lib/mainCharacter/holeFinder';
import type { ArtAnchors, Pt } from '@/lib/mainCharacter/types';

import { coverCrop } from './fit';

// ---------------------------------------------------------------------------
// Main Character Mode 🌆: getting online pictures ready (docs/MAIN_CHARACTER.md). Used by the online library
// (lib/mainCharacter/library.ts), which hands these in as its `normalise` and `analyse` steps, so the library
// itself never needs Skia.
//
// - normaliseArt: once per downloaded picture. Reads only its size first: a picture smaller than MIN_ART_SIDE,
//   bigger than MAX_ART_SIDE or not tall enough is refused before it is ever decoded (a small, highly squeezed
//   giant picture would need a huge lump of memory). A picture that is already exactly 1080 × 1920 (what the art
//   script's `online` step always makes) is used as it is: nothing is decoded, drawn or saved again, so the app
//   doesn't stop for a moment while the camera is live. Any other size: its centred 9:16 part is saved as a
//   1080 × 1920 copy (characters as PNG, which keeps the see-through hole; scenes as JPEG) and the download is
//   deleted. (This runs on the app's main thread while the Main Character screen is open, and the face points
//   reach the live poster through that same thread.)
// - analyseCharacter: where the face goes in an online character. The `.json` that comes with it (made by the
//   art script's `online` step) wins when it is complete and sensible. Without one, the hole is guessed from the
//   see-through pixels (lib/mainCharacter/holeFinder.ts), but only when it has the usual face shape: anything
//   odd leaves the character out (null).
// Neither ever throws for a bad picture: they answer null and the library marks it "failed" (never retried).
// ---------------------------------------------------------------------------

// The small copy the hole finder looks at (9:16).
const LOOK_W = 270;
const LOOK_H = 480;
// A face hole has 36 points round it.
const HOLE_POINTS = 36;
// The quality of the scenes' JPEG copy.
const SCENE_QUALITY = 90;

// Lets go of one Skia object (it may already be gone).
function letGo(thing: { dispose: () => void } | null | undefined) {
  if (!thing) return;
  try {
    thing.dispose();
  } catch {
    // Already gone: nothing more to do.
  }
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const inUnit = (value: unknown): value is number => isNumber(value) && value >= 0 && value <= 1;

// A point inside the picture (0–1), or null.
function unitPoint(value: unknown): Pt | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [x, y] = value as unknown[];
  return inUnit(x) && inUnit(y) ? [x, y] : null;
}

// The `.json` that came with a character, if every part of it is there and sensible (finite numbers, places
// inside the picture, 36 hole points, a skin colour 0–255). Anything missing or odd → null (then the hole is
// guessed instead). `toneSure` may be left out (then no skin colour pull).
export function checkSidecar(sidecar: unknown): ArtAnchors | null {
  if (!sidecar || typeof sidecar !== 'object') return null;
  const s = sidecar as Record<string, unknown>;
  if (!Array.isArray(s.eyes) || s.eyes.length !== 2) return null;
  const eyeA = unitPoint(s.eyes[0]);
  const eyeB = unitPoint(s.eyes[1]);
  const nose = unitPoint(s.nose);
  const chin = unitPoint(s.chin);
  const forehead = unitPoint(s.forehead);
  if (!eyeA || !eyeB || !nose || !chin || !forehead) return null;
  // The two eyes can't be in the same place.
  if (Math.hypot(eyeB[0] - eyeA[0], eyeB[1] - eyeA[1]) <= 0) return null;
  if (!Array.isArray(s.hole) || s.hole.length !== HOLE_POINTS) return null;
  const hole: Pt[] = [];
  for (const point of s.hole) {
    const checked = unitPoint(point);
    if (!checked) return null;
    hole.push(checked);
  }
  if (!inUnit(s.faceWidth) || !(s.faceWidth > 0)) return null;
  if (!Array.isArray(s.skinTone) || s.skinTone.length !== 3) return null;
  const tone = s.skinTone as unknown[];
  if (!tone.every((v) => isNumber(v) && v >= 0 && v <= 255)) return null;
  if (s.toneSure !== undefined && typeof s.toneSure !== 'boolean') return null;
  return {
    eyes: [eyeA, eyeB],
    nose,
    chin,
    forehead,
    hole,
    faceWidth: s.faceWidth,
    skinTone: [tone[0] as number, tone[1] as number, tone[2] as number],
    toneSure: s.toneSure === true,
  };
}

// Draws a picture's centred 9:16 part into a new plain (phone memory) surface of `w` × `h`, see-through where the
// picture is.
function drawCover(image: SkImage, w: number, h: number): SkSurface {
  const surface = Skia.Surface.Make(w, h);
  if (!surface) throw new Error('Could not make a drawing surface');
  const canvas = surface.getCanvas();
  canvas.clear(Skia.Color('transparent'));
  const crop = coverCrop(image.width(), image.height(), POSTER_W / POSTER_H);
  const paint = Skia.Paint();
  try {
    paint.setAntiAlias(true);
    canvas.drawImageRectOptions(image, Skia.XYWHRect(crop.x, crop.y, crop.w, crop.h), Skia.XYWHRect(0, 0, w, h),
      FilterMode.Linear, MipmapMode.None, paint);
  } finally {
    letGo(paint);
  }
  surface.flush();
  return surface;
}

// Guesses where the face goes from the see-through hole (null when the hole isn't the usual face shape).
function guessFromHole(bytes: Uint8Array): ArtAnchors | null {
  let data: SkData | null = null;
  let image: SkImage | null = null;
  let surface: SkSurface | null = null;
  let small: SkImage | null = null;
  try {
    data = Skia.Data.fromBytes(bytes);
    image = Skia.Image.MakeImageFromEncoded(data);
    if (!image) return null;
    const w = image.width();
    const h = image.height();
    if (!(w > 0) || !(h > 0) || w > MAX_ART_SIDE || h > MAX_ART_SIDE) return null;
    surface = drawCover(image, LOOK_W, LOOK_H);
    small = surface.makeImageSnapshot();
    const pixels = small ? small.readPixels(0, 0, { width: LOOK_W, height: LOOK_H, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul }) : null;
    if (!(pixels instanceof Uint8Array) || pixels.length < LOOK_W * LOOK_H * 4) return null;
    const shape = findFaceHole(pixels, LOOK_W, LOOK_H);
    if (!shape || !holeLooksRight(shape)) return null;
    const tone = skinToneAround(pixels, LOOK_W, LOOK_H, shape);
    // The same checks as a .json gets, so a guess can never hand the drawing a broken number.
    return checkSidecar(anchorsFromHole(shape, tone));
  } finally {
    letGo(small);
    letGo(surface);
    letGo(image);
    letGo(data);
  }
}

// Where the face goes in one online character (a 1080 × 1920 copy made by normaliseArt). The `.json` wins; without
// a good one, a strict guess from the hole. null = leave the character out. Never throws.
export async function analyseCharacter(fileUri: string, sidecar: Partial<ArtAnchors> | null): Promise<ArtAnchors | null> {
  const fromSidecar = checkSidecar(sidecar);
  if (fromSidecar) return fromSidecar;
  try {
    const bytes = new Uint8Array(await new File(fileUri).arrayBuffer());
    return guessFromHole(bytes);
  } catch (error) {
    console.warn('Main Character: could not find the face hole in an online character', error);
    return null;
  }
}

// The file next to `uri` with another ending (".png" or ".jpg").
function withEnding(uri: string, ending: string): string {
  const slash = uri.lastIndexOf('/');
  const dot = uri.lastIndexOf('.');
  return `${dot > slash ? uri.slice(0, dot) : uri}${ending}`;
}

// One downloaded online picture → a checked 1080 × 1920 copy next to it (characters `.png`, scenes `.jpg`); the
// download is deleted. A download that is already 1080 × 1920 is handed back as it is (its own file, same name).
// null = this picture can't be used (wrong size or shape, or not a picture): the library marks it failed. Throws
// only when the phone can't write the file (the library tries again on a later visit).
export async function normaliseArt(fileUri: string, folder: 'characters' | 'backgrounds'): Promise<string | null> {
  const source = new File(fileUri);
  let encoded: Uint8Array | null = null;
  let data: SkData | null = null;
  let header: SkImage | null = null;
  let surface: SkSurface | null = null;
  let copy: SkImage | null = null;
  try {
    data = Skia.Data.fromBytes(new Uint8Array(await source.arrayBuffer()));
    // This only reads the size (nothing is decoded yet).
    header = Skia.Image.MakeImageFromEncoded(data);
    if (!header) return null;
    const w = header.width();
    const h = header.height();
    if (!(w >= MIN_ART_SIDE) || !(h >= MIN_ART_SIDE) || !(w <= MAX_ART_SIDE) || !(h <= MAX_ART_SIDE)) return null;
    const tall = h / w;
    // It must stand up (config.ts ART_TALL, the same rule the library checks before downloading it again).
    if (!(tall >= ART_TALL.min) || !(tall <= ART_TALL.max)) return null;
    // Already the poster's size (the art script's `online` step): use it as it is. Decoding, drawing and saving
    // it again would change nothing and would hold up the live camera for a moment.
    if (w === POSTER_W && h === POSTER_H) return source.uri;
    surface = drawCover(header, POSTER_W, POSTER_H);
    copy = surface.makeImageSnapshot();
    if (!copy) return null;
    encoded = folder === 'characters' ? copy.encodeToBytes(ImageFormat.PNG, 100) : copy.encodeToBytes(ImageFormat.JPEG, SCENE_QUALITY);
    if (!encoded || encoded.length === 0) return null;
  } catch (error) {
    console.warn('Main Character: an online picture could not be read', error);
    return null;
  } finally {
    letGo(copy);
    letGo(surface);
    letGo(header);
    letGo(data);
  }
  const target = withEnding(source.uri, folder === 'characters' ? '.png' : '.jpg');
  const out = new File(target);
  await out.write(encoded);
  if (target !== source.uri) {
    try {
      source.delete();
    } catch {
      // Already gone: nothing more to do.
    }
  }
  return out.uri;
}

// The library's `normalise` step under the name it uses.
export { normaliseArt as normalise };
