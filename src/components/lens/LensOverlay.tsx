import { Canvas, FilterMode, MipmapMode, Picture, Skia, TileMode, createPicture, useClock, type SkPicture } from '@shopify/react-native-skia';
import { useEffect, useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { useAnimatedReaction, useDerivedValue, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { scheduleOnUI } from 'react-native-worklets';

import { FRAME_PLACEMENT, LOOK_COOL_DOWN_MS, LOOK_MAX_FAILS } from '@/lib/frameAccess';
import { isWarpLook } from '@/lib/lensLooks';

import { paintLook, type LensFace, type LensLook } from './lensPaint';
import { placeShot, toMatrix9, type FrameShot, type ViewAxes } from './warp/frameMatrix';
import { warpEffects, type Disposable, type WarpSource } from './warp/warpEffects';

// ---------------------------------------------------------------------------
// The live face filter, drawn on top of the camera every frame. The drawing itself is in lensPaint.ts – the
// same code that puts the look on the saved photo (bakeLook.ts), so both look the same.
//
// The 4 stretchy filters (🫥 🗿 😃 👾) change the camera picture itself. For them this also draws the whole
// camera picture (`shot`, from warp/FrameFeed.tsx) over the normal camera view, placed exactly like it
// (upright, mirrored for selfies, filling the view: warp/frameMatrix.ts placeShot), and the filter stretches
// that. With no fresh picture it draws nothing, so the normal camera view shows.
//
// The size of the view comes from SoftGlowCamera's onLayout (`viewSize`), the same size the saved photo uses.
// Not Canvas onSize: that size includes the camera page's shrink animation (0.92) because the pager animates
// on the native side, so it was 8 % too small (the picture covered only the top-left of the screen).
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

// Lets go of one finished drawing (it may already be gone).
function freePicture(picture: SkPicture | null) {
  'worklet';
  if (!picture) return;
  try {
    picture.dispose();
  } catch {
    // Already gone: nothing more to do.
  }
}

// How a look that failed is doing: when it may draw again (clock milliseconds) and how many times it failed.
type LookTrouble = Record<string, { until: number; fails: number }>;

// `shownTime` (optional) is told the moment on screen (in seconds), so a photo taken now can use the very same moment
// of the moving shine and twinkles as you saw.
// `viewSize` is the camera view's size in screen points (SoftGlowCamera's onLayout).
// `shot` is only used by the stretchy filters: the camera picture to draw (it says itself whether it is
// mirrored and how it is turned, so a picture from before you flipped the camera is never drawn wrong).
// `axes` (optional): the camera view's own converter, a second opinion on which way up the picture goes.
export function LensOverlay({ faces, look, shownTime, shot, viewSize, axes }: {
  faces: SharedValue<LensFace[]>;
  look: LensLook;
  shownTime?: SharedValue<number>;
  shot?: SharedValue<FrameShot | null>;
  viewSize: SharedValue<{ width: number; height: number }>;
  axes?: SharedValue<ViewAxes | null>;
}) {
  const clock = useClock();
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
  // Safety net: if a filter's drawing ever fails, that filter pauses for a moment (LOOK_COOL_DOWN_MS) instead of
  // closing the app (an error on the drawing thread would otherwise stop the whole app), then tries again. After
  // LOOK_MAX_FAILS failures it stays off until the camera closes. Only the look that failed pauses: switching to
  // another filter still draws it (this overlay stays the same when you switch looks).
  const trouble = useSharedValue<LookTrouble>({});
  const picture = useDerivedValue(() =>
    createPicture((canvas) => {
      const now = clock.value;
      const before = trouble.value[look];
      if (before && before.fails >= LOOK_MAX_FAILS) return;
      const coolingDown = before !== undefined && now < before.until;
      // The Skia objects made from the camera picture for this one drawing: let go of right after it (finally).
      const trash: Disposable[] = [];
      try {
        const width = viewSize.value.width;
        const height = viewSize.value.height;
        let src: WarpSource | null = null;
        // The very first drawing runs on the JS thread (not the drawing thread): never put a camera picture in
        // that one (the JS thread's garbage collector would then let go of the camera's picture, on the wrong
        // thread).
        const onDrawingThread = globalThis._WORKLET === true;
        if (warp && fx && shot && onDrawingThread && width > 0 && height > 0) {
          const frame = shot.value;
          if (frame) {
            // The camera picture, placed on the screen exactly like the normal camera view, drawn over all of it.
            // Drawn before the filter, so even while a filter pauses you see the right picture, never a jump.
            const placed = placeShot(frame, width, height, axes ? axes.value : null, FRAME_PLACEMENT);
            const image = frame.image.makeShaderOptions(TileMode.Clamp, TileMode.Clamp, FilterMode.Linear, MipmapMode.None, Skia.Matrix(toMatrix9(placed.m)));
            trash.push(image);
            const backdrop = Skia.Paint();
            trash.push(backdrop);
            backdrop.setShader(image);
            canvas.drawRect(Skia.XYWHRect(0, 0, width, height), backdrop);
            src = { image, fx, trash };
          }
        }
        if (!coolingDown) paintLook(canvas, look, faces.value, width, height, now / 1000, undefined, src);
      } catch (error) {
        const fails = (before ? before.fails : 0) + 1;
        trouble.value = { ...trouble.value, [look]: { until: now + LOOK_COOL_DOWN_MS, fails } };
        // Say why (first time and when it gives up), so a filter that stops drawing is never a silent mystery.
        if (fails === 1) console.warn(`Face filter "${look}" failed to draw, pausing it for a moment`, error);
        if (fails === LOOK_MAX_FAILS) console.warn(`Face filter "${look}" stopped drawing`, error);
      } finally {
        // These were only needed while recording this drawing (it keeps its own hold on the camera picture), so
        // they can go now, on the right thread. The camera picture itself goes back to the camera when the
        // drawing is let go of (below).
        freeAll(trash);
      }
    }),
  );
  // The drawings made 1 and 2 frames ago. Each one keeps its camera picture (and the camera's buffer) until it is
  // let go of, and the garbage collector is far too slow for that (the camera ran out of pictures and stopped:
  // the "snapping" and freezing). The screen keeps its own copy of what it shows, so letting go of our handle
  // never blanks it. Two behind, never the newest: the main thread may still be reading the one before.
  const spare = useSharedValue<SkPicture | null>(null);
  useAnimatedReaction(
    () => picture.value,
    (next, prev) => {
      if (next === prev) return;
      const old = spare.value;
      spare.value = prev ?? null;
      if (old && old !== next && old !== prev) freePicture(old);
    },
  );
  // Closing (e.g. swiping from the camera to Chat): let go of the last two drawings too, so their camera pictures
  // go back to the camera now, not whenever the garbage collector gets to them. Safe: the drawing's own updater and
  // the reaction above were stopped just before this (their clean-ups come first, in the same queue), so nothing
  // here reads them again, and the screen keeps its own copy of what it shows until it is torn down.
  useEffect(
    () => () => {
      scheduleOnUI(() => {
        'worklet';
        const old = spare.value;
        spare.value = null;
        freePicture(old);
        const newest = picture.value;
        if (newest !== old) freePicture(newest);
      });
    },
    [spare, picture],
  );
  // Made once: switching looks re-draws through `picture` on the drawing thread, never by re-building the canvas
  // on the JS thread (which would read the drawing there).
  const content = useMemo(() => <Picture picture={picture} />, [picture]);
  return (
    <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
      {content}
    </Canvas>
  );
}
