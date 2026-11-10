import { Canvas, FilterMode, MipmapMode, Picture, Skia, TileMode, createPicture, useClock } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { useAnimatedReaction, useDerivedValue, useSharedValue, type SharedValue } from 'react-native-reanimated';

import { isWarpLook } from '@/lib/lensLooks';

import { paintLook, type LensFace, type LensLook } from './lensPaint';
import { frameToView, toMatrix9, type FrameShot } from './warp/frameMatrix';
import { warpEffects, type Disposable, type WarpSource } from './warp/warpEffects';

// ---------------------------------------------------------------------------
// The live face filter, drawn on top of the camera every frame. The drawing itself is in lensPaint.ts – the
// same code that puts the look on the saved photo (bakeLook.ts), so both look the same.
//
// The 4 stretchy filters (🫥 🗿 😃 👾) change the camera picture itself. For them this also draws the whole
// camera picture (`shot`, from warp/FrameFeed.tsx) over the normal camera view, placed exactly like it, and
// the filter stretches that. With no fresh picture it draws nothing, so the normal camera view shows.
// ---------------------------------------------------------------------------

// Lets go of Skia objects made for one drawing, newest first, right here on the drawing thread (see WarpSource
// in warp/warpEffects.ts for why this can't wait for the garbage collector). Each one on its own: one that
// fails never keeps the others.
function freeAll(things: Disposable[]) {
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

// `shownTime` (optional) is told the moment on screen (in seconds), so a photo taken now can use the very same moment
// of the moving shine and twinkles as you saw.
// `shot` is only used by the stretchy filters: the camera picture to draw (it says itself whether it is
// mirrored, so a picture from before you flipped the camera is never drawn the wrong way round).
export function LensOverlay({ faces, look, shownTime, shot }: {
  faces: SharedValue<LensFace[]>;
  look: LensLook;
  shownTime?: SharedValue<number>;
  shot?: SharedValue<FrameShot | null>;
}) {
  const clock = useClock();
  const size = useSharedValue({ width: 0, height: 0 });
  useAnimatedReaction(
    () => clock.value,
    (now) => {
      shownTime?.set(now / 1000);
    },
  );
  // Worked out here (not on the drawing thread): is this a stretchy filter, and its GPU programs (made once,
  // the first time one is used).
  const warp = isWarpLook(look);
  const fx = useMemo(() => (warp ? warpEffects() : null), [warp]);
  // Safety net: if the drawing ever fails, that filter stops drawing instead of closing the app (an error on
  // the drawing thread would otherwise stop the whole app). Only the look that failed stops: switching to
  // another filter still draws it (this overlay stays the same when you switch looks).
  const brokenLooks = useSharedValue<string[]>([]);
  const picture = useDerivedValue(() =>
    createPicture((canvas) => {
      if (brokenLooks.value.includes(look)) return;
      // The Skia objects made from the camera picture for this one drawing: let go of right after it (finally).
      const trash: Disposable[] = [];
      try {
        const width = size.value.width;
        const height = size.value.height;
        let src: WarpSource | null = null;
        if (warp && fx && shot && width > 0 && height > 0) {
          const frame = shot.value;
          if (frame) {
            // The camera picture, placed on the screen exactly like the normal camera view, drawn over it.
            const placed = frameToView(frame.w, frame.h, frame.turn, frame.mirror, width, height);
            const image = frame.image.makeShaderOptions(TileMode.Clamp, TileMode.Clamp, FilterMode.Linear, MipmapMode.None, Skia.Matrix(toMatrix9(placed)));
            trash.push(image);
            const backdrop = Skia.Paint();
            trash.push(backdrop);
            backdrop.setShader(image);
            canvas.drawRect(Skia.XYWHRect(0, 0, width, height), backdrop);
            src = { image, fx, trash };
          }
        }
        paintLook(canvas, look, faces.value, width, height, clock.value / 1000, undefined, src);
      } catch (error) {
        // Say why once, so a filter that stops drawing is never a silent mystery again.
        brokenLooks.value = [...brokenLooks.value, look];
        console.warn(`Face filter "${look}" stopped drawing`, error);
      } finally {
        // The drawing keeps what it needs itself, so these can go now (the camera picture they hold goes back to
        // the camera sooner, and on the right thread).
        freeAll(trash);
      }
    }),
  );
  return (
    <Canvas style={StyleSheet.absoluteFill} pointerEvents="none" onSize={size}>
      <Picture picture={picture} />
    </Canvas>
  );
}
