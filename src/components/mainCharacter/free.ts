import type { SkPicture } from '@shopify/react-native-skia';

import type { Disposable } from '../lens/warp/warpEffects';

// ---------------------------------------------------------------------------
// Main Character Mode 🌆: letting go of Skia objects on purpose (docs/MAIN_CHARACTER.md).
//
// Copies of freeAll and freePicture in components/lens/LensOverlay.tsx (that file is left as it is, so the face
// filters don't change). Skia objects made from the camera picture must be let go of straight away, on the
// thread that made them: left to the garbage collector they hold on to camera pictures for too long (the camera
// runs out of them and freezes) and could be let go of on another thread, which can crash the app.
// ---------------------------------------------------------------------------

// Lets go of Skia objects made for one drawing, newest first. Each one on its own: one that fails never keeps
// the others. The list is empty afterwards.
export function freeAll(things: Disposable[]) {
  'worklet';
  for (let i = things.length - 1; i >= 0; i--) {
    try {
      things[i].dispose();
    } catch {
      // Already gone, or not a Skia object: nothing more to do.
    }
  }
  things.length = 0;
}

// Lets go of one finished drawing (it may already be gone).
export function freePicture(picture: SkPicture | null) {
  'worklet';
  if (!picture) return;
  try {
    picture.dispose();
  } catch {
    // Already gone: nothing more to do.
  }
}
