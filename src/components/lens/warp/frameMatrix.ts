import type { SkImage } from '@shopify/react-native-skia';

// ---------------------------------------------------------------------------
// Where a camera picture goes on the screen, for the stretchy filters (🫥 🗿 😃 👾).
//
// The camera hands over its pictures sideways (turning a picture costs time), and not mirrored. The normal
// camera view on screen is upright, mirrored for selfies and "zoomed to fill" (cover). These turn a camera
// picture's pixels into screen points (the same units as the face points), in that order:
//   1. stand the picture up for the screen (the app only works upright),
//   2. mirror it for the selfie camera,
//   3. scale it to fill the view and cut off the overflow equally on both sides ("cover").
// A matrix here is 6 numbers [a, b, c, d, e, f]: x' = a·x + b·y + c and y' = d·x + e·y + f.
//
// Step 1 on iPhone (iosShotTurn below): the camera package (VisionCamera 5.2.4) says how each picture is turned,
// but for the SELFIE camera that label is wrong. It reads the selfie camera's own label ("landscape left") with
// the same table as the back camera's, so it says "turned 90°". But the selfie camera faces you, so its label
// counts the other way round: its pictures need the same quarter turn (270°) as the back camera's. Following the
// label drew the selfie picture upside down (the owner's screenshots, 12 Nov). So on iPhone we use a rule:
//   back camera:   the turn the label gives (C),
//   selfie camera: 360° − C, and mirrored.
// On every iPhone today both give 270°. As a second opinion, the camera view's own converter (the one the face
// points use) gives a turn too (turnFromAxes); placeShot uses it only where the rule can't decide, and the
// testing readout shows whether the two agree (✓) or not (✗).
//
// Every function is a 'worklet' (they run on the drawing thread) and sits above the ones that use it.
// tests/unit/frame-matrix.test.mjs checks the corners, the middle, the turns, the mirror and the owner's phone.
// ---------------------------------------------------------------------------

// The selfie camera's pictures are drawn mirrored, like the normal camera view (the camera's own pictures
// aren't mirrored, the view is). If the stretched picture ever moves the wrong way when you move your head on
// the selfie camera, change this (an app update is enough).
export const MIRROR_FRONT = true;

// One camera picture ready to draw (FrameFeed.tsx makes it on the drawing thread, LensOverlay.tsx draws it).
export type FrameShot = {
  image: SkImage;
  // The picture's own size in pixels, as the camera gave it (not turned).
  w: number;
  h: number;
  // How far the picture must be turned to stand up on the screen: 0, 90, 180 or 270 degrees. −1 when the rule
  // can't decide (an odd picture size or label): placeShot then asks the camera view's converter.
  turn: number;
  // Drawn mirrored (the selfie camera's pictures, when MIRROR_FRONT). It comes with the picture, so after you
  // flip the camera an older picture is still drawn the way its own camera needs.
  mirror: boolean;
  // The camera connection's own angle (the camera package's label, the most common one seen), for the readout.
  label: number;
  // From the selfie camera.
  front: boolean;
};

// The camera view's converter, as three pairs of numbers (lib/faceMesh.ts cameraAxes): where the camera's point (0,0)
// lands on the screen (ox, oy), and how far the screen point moves for the camera's x going 0 → 1 (ax, ay) and
// its y going 0 → 1 (bx, by). `front`: which camera they were read for.
export type ViewAxes = { ox: number; oy: number; ax: number; ay: number; bx: number; by: number; front: boolean };

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

// The camera package's label for a picture, in degrees. The camera says how a picture is turned compared with
// its output's own orientation, which follows the phone, while the app's screen never turns. So the output's
// orientation is added back. On iPhone the pictures are never turned by the camera, so this is the camera
// connection's own angle (connectionTurn below is the same thing, by its right name).
export function screenTurn(frameOrientation: string, outputOrientation: string) {
  'worklet';
  return (((orientationDegrees(frameOrientation) + orientationDegrees(outputOrientation)) % 360) + 360) % 360;
}

// The camera connection's own angle (NOT always the turn the screen needs: see iosShotTurn).
export function connectionTurn(frameOrientation: string, outputOrientation: string) {
  'worklet';
  return screenTurn(frameOrientation, outputOrientation);
}

// iPhone: the turn a picture needs to stand up, from the connection's angle `connection` (connectionTurn) –
// see the top of this file. Only for sideways pictures (wider than tall) with a sideways label: anything else
// gives −1 ("the rule can't decide").
export function iosShotTurn(connection: number, front: boolean, w: number, h: number) {
  'worklet';
  if (!(w > h) || (connection !== 90 && connection !== 270)) return -1;
  return front ? (360 - connection) % 360 : connection;
}

// Camera picture pixels → screen points (see the top of this file). `width`/`height` is the picture as the
// camera gave it, `turn` how far it must be turned, `mirror` true for the selfie camera, `viewW`/`viewH` the view.
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

// The turn and mirror a matrix's first four numbers stand for (a, b from x' and d, e from y'), or null when they
// aren't a clean quarter turn (skewed, or nothing at all). Only the signs count, so the size doesn't matter.
export function turnFromAxes(a: number, b: number, d: number, e: number): { turn: number; mirror: boolean } | null {
  'worklet';
  if (![a, b, d, e].every(Number.isFinite)) return null;
  const top = Math.max(Math.abs(a), Math.abs(b));
  const bottom = Math.max(Math.abs(d), Math.abs(e));
  if (!(top > 1e-9) || !(bottom > 1e-9)) return null;
  // "About zero": below 2 % of the other number.
  const LIMIT = 0.02;
  if (Math.abs(b) < LIMIT * Math.abs(a) && Math.abs(d) < LIMIT * Math.abs(e)) {
    // Not turned sideways: x stays x, y stays y.
    if (a > 0 && e > 0) return { turn: 0, mirror: false };
    if (a < 0 && e > 0) return { turn: 0, mirror: true };
    if (a < 0 && e < 0) return { turn: 180, mirror: false };
    return { turn: 180, mirror: true };
  }
  if (Math.abs(a) < LIMIT * Math.abs(b) && Math.abs(e) < LIMIT * Math.abs(d)) {
    // Turned sideways: the picture's y goes across the screen, its x goes down.
    if (b > 0 && d < 0) return { turn: 90, mirror: false };
    if (b < 0 && d < 0) return { turn: 90, mirror: true };
    if (b < 0 && d > 0) return { turn: 270, mirror: false };
    return { turn: 270, mirror: true };
  }
  return null;
}

// The camera view's converter as a picture-pixels → screen-points matrix, for a picture `w` × `h` (it works in
// 0–1 camera points, so the pixels are divided by the size first). null without a size.
export function axesMatrix(axes: ViewAxes, w: number, h: number): number[] | null {
  'worklet';
  if (!(w > 0) || !(h > 0)) return null;
  return [axes.ax / w, axes.bx / h, axes.ox, axes.ay / w, axes.by / h, axes.oy];
}

// Where to draw one camera picture in a view `viewW` × `viewH`: its matrix `m`, the turn and mirror used, and
// `how` it was decided: 0 = the rule (iosShotTurn), 1 = the camera view's converter, 2 = a fixed 270° (neither
// could decide). `placement` (lib/frameAccess.ts FRAME_PLACEMENT, changeable by app update): 'rule' asks the rule
// first, 'converter' asks the converter first. Only the converter's turn and mirror are ever used: the size and
// place always come from the view ("cover"), so a zoomed or old converter can't move or shrink the picture.
export function placeShot(
  shot: { w: number; h: number; turn: number; mirror: boolean; front: boolean },
  viewW: number,
  viewH: number,
  axes: ViewAxes | null,
  placement: string,
): { m: number[]; how: number; turn: number; mirror: boolean } {
  'worklet';
  let fromAxes: { turn: number; mirror: boolean } | null = null;
  if (axes && axes.front === shot.front) {
    const mc = axesMatrix(axes, shot.w, shot.h);
    if (mc) fromAxes = turnFromAxes(mc[0], mc[1], mc[3], mc[4]);
  }
  const ruleFirst = placement !== 'converter';
  if (ruleFirst && shot.turn >= 0) {
    return { m: frameToView(shot.w, shot.h, shot.turn, shot.mirror, viewW, viewH), how: 0, turn: shot.turn, mirror: shot.mirror };
  }
  if (fromAxes) {
    return { m: frameToView(shot.w, shot.h, fromAxes.turn, fromAxes.mirror, viewW, viewH), how: 1, turn: fromAxes.turn, mirror: fromAxes.mirror };
  }
  if (shot.turn >= 0) {
    return { m: frameToView(shot.w, shot.h, shot.turn, shot.mirror, viewW, viewH), how: 0, turn: shot.turn, mirror: shot.mirror };
  }
  return { m: frameToView(shot.w, shot.h, 270, shot.mirror, viewW, viewH), how: 2, turn: 270, mirror: shot.mirror };
}

// Where a point goes through a 6-number matrix (for the tests and for checks).
export function applyMatrix(m: number[], x: number, y: number): [number, number] {
  'worklet';
  return [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
}

// Do two placings of a `w` × `h` picture agree? Checked on three corners: 'same' (all within `tol` screen points,
// 3 if not given), 'turn' (the same turn and mirror, but a different size or place – expected while zoomed in) or
// 'differ' (a different turn or mirror).
export function compareMatrices(m: number[], mc: number[], w: number, h: number, tol?: number): 'same' | 'turn' | 'differ' {
  'worklet';
  const limit = tol ?? 3;
  const corners = [0, 0, w, 0, 0, h];
  let same = true;
  for (let i = 0; i < corners.length; i += 2) {
    const p = applyMatrix(m, corners[i], corners[i + 1]);
    const q = applyMatrix(mc, corners[i], corners[i + 1]);
    if (!(Math.abs(p[0] - q[0]) <= limit) || !(Math.abs(p[1] - q[1]) <= limit)) same = false;
  }
  if (same) return 'same';
  const one = turnFromAxes(m[0], m[1], m[3], m[4]);
  const two = turnFromAxes(mc[0], mc[1], mc[3], mc[4]);
  if (one && two && one.turn === two.turn && one.mirror === two.mirror) return 'turn';
  return 'differ';
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
