import { Skia, type SkRuntimeEffect } from '@shopify/react-native-skia';

import { COMIC_SHADER, COMIC_UNIFORM_FLOATS } from './comicShader';

// ---------------------------------------------------------------------------
// Main Character Mode 🌆: the comic look's GPU program (comicShader.ts), made ready for Skia once, on the app's
// main thread, the first time it is needed (like components/lens/warp/warpEffects.ts). The live drawing and the
// saved poster then hand it to paintScene.ts.
//
// If it can't be made (it never should), this gives null and your face is drawn without the comic look (the
// plain picture with a warm tint): still a poster, never a crash. That is said once in the log.
// ---------------------------------------------------------------------------

let made: SkRuntimeEffect | null | undefined;

// The comic look's effect, made once (null if it couldn't be made).
export function comicEffect(): SkRuntimeEffect | null {
  if (made !== undefined) return made;
  let effect: SkRuntimeEffect | null = null;
  try {
    effect = Skia.RuntimeEffect.Make(COMIC_SHADER);
    // The drawing code hands over exactly this many numbers; anything else would draw garbage.
    if (effect && effect.getUniformFloatCount() !== COMIC_UNIFORM_FLOATS) {
      console.warn('Main Character comic look: the shader takes the wrong numbers, drawing the plain face');
      effect = null;
    } else if (!effect) {
      console.warn('Main Character comic look: the shader could not be made, drawing the plain face');
    }
  } catch (error) {
    console.warn('Main Character comic look: the shader could not be made, drawing the plain face', error);
    effect = null;
  }
  made = effect;
  return made;
}
