import type { SkImage } from '@shopify/react-native-skia';

// ---------------------------------------------------------------------------
// Where a camera picture goes on the screen, for the stretchy filters (🫥 🗿 😃 👾).
//
// The camera hands over its pictures sideways or upside down (turning a picture costs time), and not
// mirrored. The normal camera view on screen is upright, mirrored for selfies and "zoomed to fill" (cover).
// These turn a camera picture's pixels into screen points (the same units as the face points), in that order:
//   1. stand the picture up for the screen (the app only works upright),
//   2. mirror it for the selfie camera,
//   3. scale it to fill the view and cut off the overflow equally on both sides ("cover").
// A matrix here is 6 numbers [a, b, c, d, e, f]: x' = a·x + b·y + c and y' = d·x + e·y + f.
//
// Every function is a 'worklet' (they run on the drawing thread) and sits above the ones that use it.
// tests/unit/frame-matrix.test.mjs checks the corners, the middle, the turns and the mirror.
// ---------------------------------------------------------------------------

// The selfie camera's pictures are drawn mirrored, like the normal camera view (the camera's own pictures
// aren't mirrored, the view is). This is the one thing only a phone can confirm: if the stretched picture
// moves the wrong way when you move your head on the selfie camera, change this (an app update is enough).
export const MIRROR_FRONT = true;

// One camera picture ready to draw (FrameFeed.tsx makes it on the drawing thread, LensOverlay.tsx draws it).
export type FrameShot = {
  image: SkImage;
  // The picture's own size in pixels, as the camera gave it (not turned).
  w: number;
  h: number;
  // How far the picture is turned compared with the screen: 0, 90, 180 or 270 degrees.
  turn: number;
  // Drawn mirrored (the selfie camera's pictures, when MIRROR_FRONT). It comes with the picture, so after you
  // flip the camera an older picture is still drawn the way its own camera needs.
  mirror: boolean;
};

// A camera orientation in degrees: up 0, right 90, down 180, left 270 (anything else counts as up).
export function orientationDegrees(orientation: string) {
  'worklet';
  switch (orientation) {
    case 'right':
      return 90;
    case 'down':
      return 180;
    case 'left':
      return 270;
    default:
      return 0;
  }
}

// How far a camera picture is turned compared with the screen. The camera says how it is turned compared
// with its output's own orientation, which follows the phone (the camera is set to follow the phone), while
// the app's screen never turns. So the output's orientation is added back.
export function screenTurn(frameOrientation: string, outputOrientation: string) {
  'worklet';
  return (((orientationDegrees(frameOrientation) + orientationDegrees(outputOrientation)) % 360) + 360) % 360;
}

// Camera picture pixels → screen points (see the top of this file). `width`/`height` is the picture as the
// camera gave it, `turn` from screenTurn, `mirror` true for the selfie camera, `viewW`/`viewH` the view.
export function frameToView(width: number, height: number, turn: number, mirror: boolean, viewW: number, viewH: number): number[] {
  'worklet';
  const sideways = turn === 90 || turn === 270;
  // The size once stood up.
  const uw = sideways ? height : width;
  const uh = sideways ? width : height;
  // 1. Picture pixels → upright pixels.
  let m: number[];
  if (turn === 90) m = [0, 1, 0, -1, 0, width]; // (x, y) → (y, width − x)
  else if (turn === 180) m = [-1, 0, width, 0, -1, height]; // (x, y) → (width − x, height − y)
  else if (turn === 270) m = [0, -1, height, 1, 0, 0]; // (x, y) → (height − y, x)
  else m = [1, 0, 0, 0, 1, 0];
  // 2. Mirror inside the upright picture (left and right swap, up and down stay).
  if (mirror) m = [-m[0], -m[1], uw - m[2], m[3], m[4], m[5]];
  // 3. Cover: scale until it fills the view, centred.
  const s = uw > 0 && uh > 0 ? Math.max(viewW / uw, viewH / uh) : 0;
  const ox = (viewW - uw * s) / 2;
  const oy = (viewH - uh * s) / 2;
  return [m[0] * s, m[1] * s, m[2] * s + ox, m[3] * s, m[4] * s, m[5] * s + oy];
}

// The saved photo (already upright, and mirrored like the screen for selfies) → screen points, exactly as
// bakeLook.ts draws it: the photo is first made `k` times smaller (rounded to whole pixels), then shown
// "cover" in the view.
export function photoToView(photoW: number, photoH: number, k: number, viewW: number, viewH: number): number[] {
  'worklet';
  const width = Math.round(photoW * k);
  const height = Math.round(photoH * k);
  if (!(width > 0) || !(height > 0) || !(photoW > 0) || !(photoH > 0)) return [1, 0, 0, 0, 1, 0];
  const s = Math.max(viewW / width, viewH / height);
  const sx = (width / photoW) * s;
  const sy = (height / photoH) * s;
  return [sx, 0, viewW / 2 - (width * s) / 2, 0, sy, viewH / 2 - (height * s) / 2];
}

// A 6-number matrix as the 9 numbers Skia.Matrix() takes.
export function toMatrix9(m: number[]): number[] {
  'worklet';
  return [m[0], m[1], m[2], m[3], m[4], m[5], 0, 0, 1];
}

// Where a point goes through a 6-number matrix (for the tests and for checks).
export function applyMatrix(m: number[], x: number, y: number): [number, number] {
  'worklet';
  return [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
}
