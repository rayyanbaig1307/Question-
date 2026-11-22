import { FilterMode, ImageFormat, MipmapMode, Skia, type SkData, type SkImage, type SkRuntimeEffect, type SkSurface } from '@shopify/react-native-skia';
import { File, Paths } from 'expo-file-system';

import { NO_FACE, PHOTO_MAX_SIDE, POSTER_H, POSTER_W } from '@/lib/mainCharacter/config';

import type { LensFace } from '../lens/lensPaint';
import { photoToView } from '../lens/warp/frameMatrix';
import type { Disposable } from '../lens/warp/warpEffects';
import { biggestFace, faceFit } from './fit';
import { freeAll } from './free';
import { paintMainCharacter, type LiveScene } from './paintScene';

// ---------------------------------------------------------------------------
// Main Character Mode 🌆: the saved poster made from the real photo (docs/MAIN_CHARACTER.md). Used on downloads
// without camera pictures (App Store build 10, iOS 16, or after camera pictures failed), and whenever the poster
// can't be made from the screen (snapPoster.ts). Runs on the app's main thread.
//
// The photo is made small first (PHOTO_MAX_SIDE): the full photo is read once (with no extra smaller copies
// made of it) and drawn small, and only the small copy is kept while the camera is still running. Then the poster is drawn with the same
// drawing code as the screen (paintScene.ts), your face taken from the photo with the face points from the
// moment you pressed the shutter. The camera view and the photo show the same 4:3 area (as bakeLook.ts assumes).
// Known limit (only here, not on the full way): the photo comes a moment after the face points, so a quick move
// can shift your face a little in the hole. The white flash and the banner make people hold still.
// ---------------------------------------------------------------------------

// The JPEG quality of a saved poster.
const POSTER_QUALITY = 92;

// Gives each saved poster its own name, even two in the same millisecond.
let saved = 0;

// Lets go of one Skia object (it may already be gone).
function letGo(thing: Disposable | null | undefined) {
  if (!thing) return;
  try {
    thing.dispose();
  } catch {
    // Already gone: nothing more to do.
  }
}

// A finished poster as a JPEG file in the app's cache (quality 92). Used for the poster from the screen too.
// No watermark here: that is only added when the picture leaves the app (lib/watermark.ts).
export async function encodePoster(image: SkImage): Promise<string> {
  const bytes = image.encodeToBytes(ImageFormat.JPEG, POSTER_QUALITY);
  if (!bytes || bytes.length === 0) throw new Error('Could not save the poster');
  saved += 1;
  const file = new File(Paths.cache, `main-character-${Date.now()}-${saved}.jpg`);
  await file.write(bytes);
  return file.uri;
}

// The finished poster as a JPEG (1080 × 1920, quality 92) in the app's cache, without a watermark. Throws when
// it can't (the screen then says "try again"); throws NO_FACE ('no-face', config.ts) when there is no face to put in
// the hole (the screen then says "look at the camera").
export async function bakeMainCharacter(
  photoUri: string,                       // upright, mirrored like the screen for selfies (SoftGlowCamera made it)
  faces: LensFace[],                      // the faces at the moment of the press, view points
  view: { width: number; height: number },
  scene: LiveScene,                       // the scene copied at the press (held in the art cache until done)
  fx: SkRuntimeEffect | null,
): Promise<string> {
  if (!view || !(view.width > 0) || !(view.height > 0)) throw new Error('No camera view size');
  if (!scene) throw new Error('No character');
  // Checked first: no face means no poster, so the photo isn't even read.
  const face = biggestFace(faces);
  const fit = face ? faceFit(face.pts, scene.art) : null;
  if (!face || !fit) throw new Error(NO_FACE);

  const trash: Disposable[] = [];
  let data: SkData | null = null;
  let small: SkImage | null = null;
  let surface: SkSurface | null = null;
  try {
    data = await Skia.Data.fromURI(photoUri);
    // This only reads the photo's size here; the full photo is read once below, when it is drawn into the small copy.
    const whole = Skia.Image.MakeImageFromEncoded(data);
    if (!whole) throw new Error('Could not read the photo');
    let width = 0;
    let height = 0;
    try {
      const k = Math.min(1, PHOTO_MAX_SIDE / Math.max(whole.width(), whole.height()));
      width = Math.max(1, Math.round(whole.width() * k));
      height = Math.max(1, Math.round(whole.height() * k));
      if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error('Could not read the photo');
      const shrink = Skia.Surface.Make(width, height);
      if (!shrink) throw new Error('Could not make a drawing surface');
      try {
        const plain = Skia.Paint();
        trash.push(plain);
        plain.setAntiAlias(true);
        shrink.getCanvas().drawImageRectOptions(whole, Skia.XYWHRect(0, 0, whole.width(), whole.height()), Skia.XYWHRect(0, 0, width, height),
          FilterMode.Linear, MipmapMode.None, plain);
        shrink.flush();
        small = shrink.makeImageSnapshot();
      } finally {
        letGo(shrink);
      }
    } finally {
      letGo(whole);
    }
    if (!small) throw new Error('Could not read the photo');

    surface = Skia.Surface.MakeOffscreen(POSTER_W, POSTER_H) ?? Skia.Surface.Make(POSTER_W, POSTER_H);
    if (!surface) throw new Error('Could not make a drawing surface');
    // The small photo's pixels → view points ("cover", like the camera view showed it).
    const toView = photoToView(width, height, 1, view.width, view.height);
    paintMainCharacter(surface.getCanvas(), scene, face, fit, { image: small, toView, mipmaps: true }, false, fx, trash);
    surface.flush();
    const poster = surface.makeImageSnapshot();
    try {
      return await encodePoster(poster);
    } finally {
      letGo(poster);
    }
  } finally {
    // What the drawing made first, then the small photo, then the rest.
    freeAll(trash);
    letGo(small);
    letGo(surface);
    letGo(data);
  }
}
