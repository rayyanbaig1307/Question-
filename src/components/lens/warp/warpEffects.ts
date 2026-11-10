import { Skia, type SkRuntimeEffect, type SkShader } from '@shopify/react-native-skia';

import { BALLOON, PIXEL, SHRINK, STRETCH, UNIFORM_FLOATS } from './shaders';

// ---------------------------------------------------------------------------
// The 4 stretchy filters' GPU programs (shaders.ts), made ready for Skia once, on the app's main thread, the
// first time a stretchy filter is used. The live drawing (LensOverlay.tsx) and the saved photo (bakeLook.ts)
// then hand them to the drawing code (paintWarp.ts) with the camera picture.
//
// If any of them can't be made (it never should), this gives null and the stretchy filters switch off
// (lib/frameAccess.ts markFramesBroken) instead of drawing something wrong.
// ---------------------------------------------------------------------------

export type WarpEffects = {
  balloon: SkRuntimeEffect;
  shrink: SkRuntimeEffect;
  stretch: SkRuntimeEffect;
  pixel: SkRuntimeEffect;
};

// Something Skia made that must be let go of on purpose (dispose).
export type Disposable = { dispose: () => void };

// What the stretchy filters draw from: the camera picture (or the saved photo) as a shader in screen points,
// and the GPU programs.
// `trash`: every Skia object the drawing makes from `image` (shaders, paints) goes on this list, and whoever
// made `src` lets go of all of them as soon as the picture is drawn (LensOverlay.tsx, bakeLook.ts). Why: the
// live camera picture lives on the graphics chip and belongs to the drawing thread. Left to the garbage
// collector, these objects would hold on to camera pictures for too long (the camera runs out of them) and
// could let go of them on another thread, which can crash the app.
export type WarpSource = {
  image: SkShader;
  fx: WarpEffects;
  trash: Disposable[];
};

let made: WarpEffects | null | undefined;

function makeOne(source: string, floats: number): SkRuntimeEffect | null {
  try {
    const effect = Skia.RuntimeEffect.Make(source);
    if (!effect) return null;
    // The drawing code hands over exactly this many numbers; anything else would draw garbage.
    if (effect.getUniformFloatCount() !== floats) return null;
    return effect;
  } catch (error) {
    console.warn('Stretchy filter shader', error);
    return null;
  }
}

// The 4 effects, made once (null if any of them failed).
export function warpEffects(): WarpEffects | null {
  if (made !== undefined) return made;
  const balloon = makeOne(BALLOON, UNIFORM_FLOATS.BALLOON);
  const shrink = makeOne(SHRINK, UNIFORM_FLOATS.SHRINK);
  const stretch = makeOne(STRETCH, UNIFORM_FLOATS.STRETCH);
  const pixel = makeOne(PIXEL, UNIFORM_FLOATS.PIXEL);
  made = balloon && shrink && stretch && pixel ? { balloon, shrink, stretch, pixel } : null;
  return made;
}
