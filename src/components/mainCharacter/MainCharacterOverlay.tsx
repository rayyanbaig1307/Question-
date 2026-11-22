import { Canvas, Picture, Skia, createPicture, type SkImage, type SkPicture, type SkRuntimeEffect } from '@shopify/react-native-skia';
import { useEffect, useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { useAnimatedReaction, useDerivedValue, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN, scheduleOnUI } from 'react-native-worklets';

import { FRAME_PLACEMENT, LOOK_COOL_DOWN_MS, LOOK_MAX_FAILS } from '@/lib/frameAccess';

import type { CustomLookProps } from '../lens/SoftGlowCamera';
import { placeShot, toMatrix9 } from '../lens/warp/frameMatrix';
import type { Disposable } from '../lens/warp/warpEffects';
import { biggestFace, faceFit, posterToView } from './fit';
import { freeAll, freePicture } from './free';
import { paintMainCharacter, type FaceSource, type LiveScene } from './paintScene';
import { snapPoster } from './snapPoster';

// ---------------------------------------------------------------------------
// Main Character Mode 🌆: the live poster, drawn over the camera every frame (docs/MAIN_CHARACTER.md). SoftGlowCamera
// draws this instead of the face filters' LensOverlay (its `custom` look, made by MainCharacterCamera.tsx).
//
// The drawing itself is paintScene.ts, the same code that makes the saved poster, so both look the same. The
// poster (1080 × 1920 "poster pixels") fills the camera view like the camera picture does ("cover"); your face is
// moved into the character's face hole:
// - full way (downloads with camera pictures): the camera's own picture (FrameFeed's `shot`) is drawn into the
//   hole with the comic look;
// - lite way (no camera pictures, or while they pause): the hole is left open and CameraFollow.tsx moves the real
//   camera view underneath so your face shows through it.
//
// Built like LensOverlay.tsx (the same hard-won rules):
// - one drawing per change, recorded on the drawing thread; every Skia object made for it is let go of right
//   after it (`trash`, in a finally);
// - each finished drawing is let go of two drawings later (the garbage collector is far too slow: the camera ran
//   out of pictures), and the last two when this closes;
// - the very first drawing runs on the JS thread: it never uses the camera picture;
// - the view size comes from SoftGlowCamera's onLayout (`viewSize`), never the Canvas's own size;
// - a drawing that fails pauses the camera picture part for LOOK_COOL_DOWN_MS (the lite drawing goes on), and after
//   LOOK_MAX_FAILS failures the camera picture part stays off until this closes. Never a crash.
// Each drawing adds 1 to `drawn` (the art cache waits two drawings before it lets go of a picture). When the
// screen asks (`snapAsk` goes up), the poster is drawn once more off screen from exactly what is shown now
// (snapPoster.ts) and handed to `onSnap` on the JS thread (null when it can't: the photo way is used then).
// ---------------------------------------------------------------------------

// What MainCharacterCamera hands this (and CameraFollow) through SoftGlowCamera's `custom.extra`. Made once.
export type McExtra = {
  scene: SharedValue<LiveScene | null>;              // the character and scene to draw (null = not ready yet)
  fx: SkRuntimeEffect | null;                        // the comic look (null = the plain face with a warm tint)
  cameraPictures: SharedValue<boolean>;              // false = never use the camera picture (testing FULL/LITE pill)
  drawn: SharedValue<number>;                        // how many drawings were made (the art cache's clock)
  snapAsk: SharedValue<number>;                      // goes up by 1 for each poster the screen asks for
  onSnap: (ask: number, image: SkImage | null) => void;   // JS thread: the poster for that ask (or null)
};

// How the drawing is doing: when the camera picture part may be used again (milliseconds), how many times a
// drawing with it failed, and how many times one without it failed.
type Trouble = { until: number; fails: number; liteFails: number };

export function MainCharacterOverlay({ faces, shot, framesOn, viewSize, axes, extra }: CustomLookProps<McExtra>) {
  const { scene, fx, cameraPictures, drawn, snapAsk, onSnap } = extra;
  const trouble = useSharedValue<Trouble>({ until: 0, fails: 0, liteFails: 0 });
  const picture = useDerivedValue(() =>
    createPicture((canvas) => {
      const live = scene.value;
      const width = viewSize.value.width;
      const height = viewSize.value.height;
      // Nothing to draw yet (the pictures are still being read, or the view isn't laid out): the screen shows a
      // spinner meanwhile.
      if (!live || !(width > 0) || !(height > 0)) return;
      const before = trouble.value;
      // Even the drawing without the camera picture keeps failing: stop drawing (the plain camera shows).
      if (before.liteFails >= LOOK_MAX_FAILS) return;
      const now = Date.now();
      const cameraPartOff = before.fails >= LOOK_MAX_FAILS || now < before.until;
      // The Skia objects made for this one drawing: let go of right after it (finally).
      const trash: Disposable[] = [];
      let usedCamera = false;
      try {
        // Draw in poster pixels: the poster fills the camera view like the camera picture does.
        const toView = Skia.Matrix(toMatrix9(posterToView(width, height)));
        trash.push(toView);
        canvas.concat(toView);
        const face = biggestFace(faces.value);
        const fit = face ? faceFit(face.pts, live.art) : null;
        // The very first drawing runs on the JS thread (not the drawing thread): never put a camera picture in
        // that one (the JS thread's garbage collector would then let go of the camera's picture, on the wrong
        // thread).
        const onDrawingThread = globalThis._WORKLET === true;
        const frame = framesOn && cameraPictures.value && onDrawingThread && !cameraPartOff ? shot.value : null;
        let src: FaceSource | null = null;
        if (frame) {
          // The camera picture placed exactly like the camera view shows it (camera pixels → view points).
          const placed = placeShot(frame, width, height, axes.value, FRAME_PLACEMENT);
          src = { image: frame.image, toView: placed.m, mipmaps: false };
          usedCamera = true;
        }
        paintMainCharacter(canvas, live, face, fit, src, true, fx, trash);
      } catch (error) {
        if (usedCamera) {
          const fails = before.fails + 1;
          trouble.value = { until: now + LOOK_COOL_DOWN_MS, fails, liteFails: before.liteFails };
          // Say why (first time and when it gives up), so it is never a silent mystery.
          if (fails === 1) console.warn('Main Character: the live poster failed to draw, pausing the camera picture for a moment', error);
          if (fails === LOOK_MAX_FAILS) console.warn('Main Character: the live poster stopped using the camera picture', error);
        } else {
          const liteFails = before.liteFails + 1;
          trouble.value = { until: before.until, fails: before.fails, liteFails };
          if (liteFails === 1) console.warn('Main Character: the live poster failed to draw', error);
          if (liteFails === LOOK_MAX_FAILS) console.warn('Main Character: the live poster stopped drawing', error);
        }
      } finally {
        // Only needed while recording this drawing (it keeps its own hold on what it drew), so they can go now,
        // on the right thread.
        freeAll(trash);
      }
    }),
  );
  // The drawings made 1 and 2 frames ago, let go of two drawings later (see LensOverlay.tsx: each one holds its
  // camera picture, and the main thread may still be reading the one before). Each new drawing also moves the
  // art cache's clock on.
  const spare = useSharedValue<SkPicture | null>(null);
  useAnimatedReaction(
    () => picture.value,
    (next, prev) => {
      if (next === prev) return;
      drawn.set(drawn.get() + 1);
      const old = spare.value;
      spare.value = prev ?? null;
      if (old && old !== next && old !== prev) freePicture(old);
    },
  );
  // The screen asked for the poster (the shutter): draw it once more off screen, from exactly what is shown now,
  // here on the drawing thread, and hand it to the JS thread. null (the photo way) when the camera picture isn't
  // in use, or anything fails.
  useAnimatedReaction(
    () => snapAsk.value,
    (ask, before) => {
      // The first look (when this is shown) is not a new ask.
      if (before === null || before === undefined || ask === before || !(ask > 0)) return;
      let image: SkImage | null = null;
      try {
        const live = scene.value;
        const now = Date.now();
        const state = trouble.value;
        const cameraPartOff = state.fails >= LOOK_MAX_FAILS || now < state.until;
        if (live && framesOn && cameraPictures.value && !cameraPartOff && globalThis._WORKLET === true) {
          image = snapPoster(live, faces.value, shot.value, viewSize.value, axes.value, fx);
        }
      } catch {
        image = null;
      }
      scheduleOnRN(onSnap, ask, image);
    },
  );
  // Closing (the result screen, or leaving the mode): let go of the last two drawings too, so their camera pictures
  // go back to the camera now (the same as LensOverlay.tsx).
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
  // Made once: changes re-draw through `picture` on the drawing thread, never by re-building the canvas here.
  const content = useMemo(() => <Picture picture={picture} />, [picture]);
  return (
    <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
      {content}
    </Canvas>
  );
}
