import { Skia, TileMode, type SkCanvas } from '@shopify/react-native-skia';

import { MESH } from '@/lib/faceMesh';

import type { LensFace } from '../lensPaint';
import { eyeOf, faceGeom, faceOk, fillPaint, num, radialPaint, rgba } from './kit';
import { eyesTrigger, levelOf } from './triggers';

// ---------------------------------------------------------------------------
// 👀 Peekaboo Eyes (Peekaboo+): giant glossy googly eyes over your own eyes. Raise your brows and they pop out
// bigger. The purple irises look where you really look (your own irises), and they wobble when you move your
// head. The pop and the wobble are bouncy springs worked out in faceTrack.ts (face.pop, face.wobbleX/Y); this
// file only draws them. Each eye is 6 simple draws and no blurs.
// ---------------------------------------------------------------------------

// The eyes don't draw until they've popped in a little (a new face's eyes spring in from nothing).
const MIN_POP = 0.05;
// How far the irises can move from the middle of each eye (part of the eye's size).
const MAX_GAZE = 0.45;

// One googly eye: a soft shadow under it, the white ball, the purple iris, the pupil and two shiny glints.
// (x, y) is the middle of the real eye, `w` its width, (ix, iy) the real iris, (outX, outY) the way out to the
// side of the face, `t` how far it bulges out (0.8 still … 1 brows up), (wx, wy) the wobble in points.
function drawGooglyEye(
  canvas: SkCanvas,
  x: number, y: number, w: number, ix: number, iy: number,
  outX: number, outY: number, upX: number, upY: number,
  pop: number, t: number, wx: number, wy: number,
) {
  'worklet';
  const R = w * pop + w * 0.3;
  if (!(R > 0.5)) return;
  // The ball sits a little outward and up, so it looks like it bulges out of the eye socket.
  const cx = x + outX * R * 0.12 * t + upX * R * 0.18 * t;
  const cy = y + outY * R * 0.12 * t + upY * R * 0.18 * t;

  // 1. The shadow: a soft dark patch a little lower than the ball (a gradient, not a blur, so it's cheap).
  const sx = cx - upX * R * 0.2;
  const sy = cy - upY * R * 0.2;
  canvas.drawCircle(sx, sy, R * 1.5, radialPaint(sx, sy, R * 1.5, [
    rgba('0,0,0', 0.45), rgba('0,0,0', 0.38), rgba('0,0,0', 0.225), rgba('0,0,0', 0.07), rgba('0,0,0', 0),
  ], [0, 0.5, 0.667, 0.833, 1]));

  // 2. The glossy white ball, lit from the top left.
  const ball = Skia.Paint();
  ball.setAntiAlias(true);
  ball.setShader(Skia.Shader.MakeTwoPointConicalGradient(
    { x: cx - R * 0.35, y: cy - R * 0.4 }, R * 0.1, { x: cx, y: cy }, R,
    [Skia.Color('#FFFFFF'), Skia.Color('#F4F0FA'), Skia.Color('#BDB3C9')], [0, 0.7, 1], TileMode.Clamp,
  ));
  canvas.drawCircle(cx, cy, R, ball);

  // Where the iris looks: where your real iris is in your eye, plus the wobble, kept inside the ball.
  const wobble = Math.min(0.5, Math.hypot(wx, wy) / (R * 2));
  let gx = ((ix - x) / w) * 1.8 + Math.max(-0.5, Math.min(0.5, wx / (R * 2))) * 0.8;
  let gy = ((iy - y) / w) * 1.8 + Math.max(-0.5, Math.min(0.5, wy / (R * 2))) * 0.8;
  const gaze = Math.hypot(gx, gy);
  if (gaze > MAX_GAZE) {
    gx *= MAX_GAZE / gaze;
    gy *= MAX_GAZE / gaze;
  }
  const ir = R * 0.48;
  const px = cx + gx * R;
  const py = cy + gy * R;

  // 3. The purple iris (light in the middle, deep purple at the edge).
  canvas.drawCircle(px, py, ir, radialPaint(px, py, ir, [
    Skia.Color('#C47CFF'), Skia.Color('#C47CFF'), Skia.Color('#8A2BE2'), Skia.Color('#4B0F8E'),
  ], [0, 0.1, 0.64, 1]));
  // 4. The pupil (a touch bigger while it wobbles).
  canvas.drawCircle(px, py, ir * 0.48 + wobble * ir * 0.1, fillPaint('#120618', 1));
  // 5–6. Two shiny glints, a big one at the top left and a small one at the bottom right.
  canvas.drawCircle(px - ir * 0.3, py - ir * 0.35, ir * 0.2, fillPaint('#FFFFFF', 0.95));
  canvas.drawCircle(px + ir * 0.25, py + ir * 0.3, ir * 0.08, fillPaint('#FFFFFF', 0.7));
}

function drawPeekabooFace(canvas: SkCanvas, face: LensFace) {
  'worklet';
  const pop = num(face.pop);
  if (pop < MIN_POP) return;
  const pts = face.pts;
  const g = faceGeom(pts);
  const t = levelOf(eyesTrigger(face));
  const wx = num(face.wobbleX) * g.W;
  const wy = num(face.wobbleY) * g.W;
  const a = eyeOf(pts, MESH.rightEyeOuter, MESH.rightEyeInner, MESH.rightIris);
  const b = eyeOf(pts, MESH.leftEyeOuter, MESH.leftEyeInner, MESH.leftIris);
  // "Out" for each eye is away from the point between the eyes, so it works mirrored or not.
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const aLong = Math.hypot(a.x - mx, a.y - my) || 1;
  const bLong = Math.hypot(b.x - mx, b.y - my) || 1;
  drawGooglyEye(canvas, a.x, a.y, a.w, a.ix, a.iy, (a.x - mx) / aLong, (a.y - my) / aLong, g.upX, g.upY, pop, t, wx, wy);
  drawGooglyEye(canvas, b.x, b.y, b.w, b.ix, b.iy, (b.x - mx) / bLong, (b.y - my) / bLong, g.upX, g.upY, pop, t, wx, wy);
}

export function paintPeekabooEyes(canvas: SkCanvas, faces: LensFace[], now: number) {
  'worklet';
  // (`now` isn't used: everything that moves here comes from the face itself, so it matches the photo.)
  for (const face of faces) {
    if (faceOk(face)) drawPeekabooFace(canvas, face);
  }
}
