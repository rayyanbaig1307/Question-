import { Skia, type SkImage, type SkRuntimeEffect, type SkSurface } from '@shopify/react-native-skia';

import { FRAME_PLACEMENT } from '@/lib/frameAccess';
import { POSTER_H, POSTER_W } from '@/lib/mainCharacter/config';

import type { LensFace } from '../lens/lensPaint';
import { placeShot, type FrameShot, type ViewAxes } from '../lens/warp/frameMatrix';
import type { Disposable } from '../lens/warp/warpEffects';
import { biggestFace, faceFit } from './fit';
import { freeAll } from './free';
import { paintMainCharacter, type LiveScene } from './paintScene';

// ---------------------------------------------------------------------------
// Main Character Mode 🌆: the saved poster, made from exactly what the screen shows (the full way, on downloads
// with camera pictures). Runs on the drawing thread when you press the shutter (MainCharacterOverlay.tsx).
//
// It draws the poster once more, off screen, at the full 1080 × 1920, from the same camera picture and the same
// face points the screen is drawing right now, with the still comic numbers (COMIC). Then it hands a plain
// (not on the graphics chip) copy to the app's main thread, which saves it (bakeMainCharacter.ts encodePoster).
// null when it can't (no fresh camera picture, no face, anything fails): the caller then uses the photo way.
// ---------------------------------------------------------------------------

// Lets go of one Skia object (it may already be gone).
function letGo(thing: Disposable | null) {
  'worklet';
  if (!thing) return;
  try {
    thing.dispose();
  } catch {
    // Already gone: nothing more to do.
  }
}

// The poster, drawn once more off screen, as a plain picture the main thread can use (or null).
export function snapPoster(scene: LiveScene, faces: LensFace[], shot: FrameShot | null,
  view: { width: number; height: number }, axes: ViewAxes | null, fx: SkRuntimeEffect | null): SkImage | null {
  'worklet';
  if (!scene || !shot || !shot.image || !view || !(view.width > 0) || !(view.height > 0)) return null;
  const face = biggestFace(faces);
  const fit = face ? faceFit(face.pts, scene.art) : null;
  if (!face || !fit) return null;
  const trash: Disposable[] = [];
  let surface: SkSurface | null = null;
  let snapshot: SkImage | null = null;
  try {
    surface = Skia.Surface.MakeOffscreen(POSTER_W, POSTER_H);
    if (!surface) return null;
    const placed = placeShot(shot, view.width, view.height, axes, FRAME_PLACEMENT);
    paintMainCharacter(surface.getCanvas(), scene, face, fit, { image: shot.image, toView: placed.m, mipmaps: false }, false, fx, trash);
    surface.flush();
    snapshot = surface.makeImageSnapshot();
    return snapshot ? snapshot.makeNonTextureImage() : null;
  } catch (error) {
    console.warn('Main Character: the poster could not be made from the screen, using the photo', error);
    return null;
  } finally {
    // The plain copy keeps its own pixels, so everything else can go now, on this thread.
    freeAll(trash);
    letGo(snapshot);
    letGo(surface);
  }
}
