import { Skia, TileMode, type SkCanvas, type SkPaint, type SkPath } from '@shopify/react-native-skia';

import { MESH } from '@/lib/faceMesh';

import type { LensFace } from '../lensPaint';
import { addHeart, clamp01, eyeOf, faceGeom, faceOk, fillPaint, hash01, num, radialPaint, rgba, softEdge, strokePaint } from './kit';
import { kissTrigger, levelOf } from './triggers';

// ---------------------------------------------------------------------------
// 😘 Heart Eyes (Peekaboo+): big glossy hearts over your eyes that beat, rosy blush with little anime blush
// lines on your cheeks, and little hearts floating up from your lips. Blow a kiss for many more hearts.
//
// Like Crybaby's tears, the floating hearts are not remembered from frame to frame: each one is worked out
// from the time and a fixed "random" number (hash01), so the saved photo shows them exactly where you saw them.
// ---------------------------------------------------------------------------

// Heartbeats a second (the web version's speed with a still face).
const BEATS = 2.6;
// Floating heart "slots" a second; each may hold one heart. A still face uses REST_HEARTS of them a second,
// a kiss all of them.
const RATE = 14;
const REST_HEARTS = 4;
// How long a floating heart lives (seconds): HEART_LIFE plus up to HEART_LIFE_SPREAD more.
const HEART_LIFE = 1.4;
const HEART_LIFE_SPREAD = 0.8;

// The parts of the eye hearts that are the same for every eye of every face (made once a frame).
type HeartKit = { heart: SkPath; heartPaint: SkPaint; gloss: SkPath; glossPaint: SkPaint };

// One eye heart, drawn in its own little frame (1 unit = half the heart's width): the heart with its gradient,
// then the white gloss on its top left.
function drawEyeHeart(canvas: SkCanvas, kit: HeartKit, x: number, y: number, size: number, angleDeg: number) {
  'worklet';
  canvas.save();
  canvas.translate(x, y);
  canvas.rotate(angleDeg, 0, 0);
  canvas.scale(size, size);
  canvas.drawPath(kit.heart, kit.heartPaint);
  canvas.translate(-0.45, -0.5);
  canvas.rotate(-34.4, 0, 0);
  canvas.drawPath(kit.gloss, kit.glossPaint);
  canvas.restore();
}

function drawHeartFace(canvas: SkCanvas, face: LensFace, now: number, kit: HeartKit) {
  'worklet';
  const pts = face.pts;
  const g = faceGeom(pts);
  const trigger = kissTrigger(face);
  const kiss = levelOf(trigger);
  const c = Math.cos(g.tilt);
  const s = Math.sin(g.tilt);

  // The heartbeat: the hearts swell a little in quick thumps (exactly the web version's beat).
  const phase = (now * BEATS) % 1;
  const thump = Math.pow(Math.sin(phase * Math.PI * 2), 8) + 0.6 * Math.pow(Math.sin((phase - 0.15) * Math.PI * 2), 8);
  const scale = 1 + thump * 0.09 + kiss * 0.12;

  // 1. Rosy blush on both cheeks, with three white "/" blush lines on each.
  const r = g.W * 0.13;
  const lines = Skia.PathBuilder.Make();
  for (let i = 0; i < 2; i++) {
    const point = i === 0 ? MESH.rightBlush : MESH.leftBlush;
    const px = pts[point * 2];
    const py = pts[point * 2 + 1];
    canvas.drawCircle(px, py, r, radialPaint(px, py, r, [rgba('255,105,180', 0.45 + 0.3 * kiss), rgba('255,105,180', 0)], [0, 1]));
    for (let k = -1; k <= 1; k++) {
      const ax = k * r * 0.28 - r * 0.12;
      const ay = r * 0.22;
      const bx = k * r * 0.28 + r * 0.12;
      const by = -r * 0.22;
      lines.moveTo(px + ax * c - ay * s, py + ax * s + ay * c);
      lines.lineTo(px + bx * c - by * s, py + bx * s + by * c);
    }
  }
  canvas.drawPath(lines.detach(), strokePaint('#FFFFFF', 0.5 + 0.4 * kiss, Math.max(1, g.W * 0.008)));

  // 2. The eye hearts: a soft pink glow behind both, then each heart, leaning with the head.
  const right = eyeOf(pts, MESH.rightEyeOuter, MESH.rightEyeInner, MESH.rightIris);
  const left = eyeOf(pts, MESH.leftEyeOuter, MESH.leftEyeInner, MESH.leftIris);
  const sizeA = right.w * 0.95 * scale;
  const sizeB = left.w * 0.95 * scale;
  // A little lower than each eye's middle, like the web version.
  const ax = right.x - g.upX * sizeA * 0.1;
  const ay = right.y - g.upY * sizeA * 0.1;
  const bx = left.x - g.upX * sizeB * 0.1;
  const by = left.y - g.upY * sizeB * 0.1;
  const glow = Skia.PathBuilder.Make();
  addHeart(glow, ax, ay, sizeA, g.tilt);
  addHeart(glow, bx, by, sizeB, g.tilt);
  canvas.drawPath(glow.detach(), softEdge(fillPaint('#FF4FD8', 0.8), ((sizeA + sizeB) / 2) * 0.3));
  const angleDeg = (g.tilt * 180) / Math.PI;
  drawEyeHeart(canvas, kit, ax, ay, sizeA, angleDeg);
  drawEyeHeart(canvas, kit, bx, by, sizeB, angleDeg);

  // 3. Little hearts floating up from the lips, drifting out to the sides.
  const mouthX = (pts[MESH.upperLipInner * 2] + pts[MESH.lowerLipInner * 2]) / 2;
  const mouthY = (pts[MESH.upperLipInner * 2 + 1] + pts[MESH.lowerLipInner * 2 + 1]) / 2;
  const mouthW = Math.hypot(
    pts[MESH.mouthRightCorner * 2] - pts[MESH.mouthLeftCorner * 2],
    pts[MESH.mouthRightCorner * 2 + 1] - pts[MESH.mouthLeftCorner * 2 + 1],
  );
  const share = (REST_HEARTS + (RATE - REST_HEARTS) * trigger) / RATE;
  const seed = num(face.seed);
  const light = Skia.PathBuilder.Make();
  const deep = Skia.PathBuilder.Make();
  const halo = Skia.PathBuilder.Make();
  let count = 0;
  const first = Math.floor((now - HEART_LIFE - HEART_LIFE_SPREAD) * RATE);
  const last = Math.floor(now * RATE);
  for (let k = first; k <= last; k++) {
    const born = (k + hash01(seed, k, 0)) / RATE;
    const age = now - born;
    const life = HEART_LIFE + HEART_LIFE_SPREAD * hash01(seed, k, 1);
    if (age < 0 || age >= life) continue;
    // A slot shrinks away (instead of popping) when the share changes.
    const keep = clamp01((share - hash01(seed, k, 11)) / 0.08);
    if (keep <= 0) continue;
    const dir = hash01(seed, k, 2) < 0.5 ? -1 : 1;
    const vx = g.W * 0.9 * dir * (0.3 + 0.4 * hash01(seed, k, 4)) + g.W * 0.4 * (hash01(seed, k, 5) - 0.5);
    const vy = -g.H * (0.5 + 0.6 * hash01(seed, k, 6));
    const x = mouthX + (hash01(seed, k, 3) - 0.5) * 0.5 * mouthW + vx * age - 0.5 * 0.35 * g.W * dir * age * age;
    const y = mouthY + vy * age - 0.5 * 0.25 * g.H * age * age;
    const size =
      g.W * (0.05 + 0.07 * hash01(seed, k, 7)) * (0.7 + 0.3 * Math.sin(age * 12)) * Math.min(1, 1.5 * (1 - age / life)) * keep;
    if (!(size > 0.2)) continue;
    const turn = (hash01(seed, k, 8) - 0.5) * 0.6 + (hash01(seed, k, 9) - 0.5) * 2 * age;
    addHeart(hash01(seed, k, 10) < 0.3 ? light : deep, x, y, size, turn);
    addHeart(halo, x, y, size, turn);
    count++;
  }
  if (count > 0) {
    canvas.drawPath(halo.detach(), softEdge(fillPaint('#FF4FD8', 0.7), g.W * 0.035));
    canvas.drawPath(deep.detach(), fillPaint('#FF3FA4', 1));
    canvas.drawPath(light.detach(), fillPaint('#FF7CC4', 1));
  }
}

export function paintHeartEyes(canvas: SkCanvas, faces: LensFace[], now: number) {
  'worklet';
  if (faces.length === 0) return;
  // Made once a frame and used for every eye: a heart 1 unit across (half-width), its pink gradient (light at
  // the top left, deep pink at the bottom) and the white gloss oval.
  const heart = Skia.PathBuilder.Make();
  addHeart(heart, 0, 0, 1, 0);
  const heartPaint = Skia.Paint();
  heartPaint.setAntiAlias(true);
  heartPaint.setShader(Skia.Shader.MakeTwoPointConicalGradient(
    { x: -0.3, y: -0.5 }, 0.1, { x: 0, y: 0 }, 1.4,
    [Skia.Color('#FF9AD5'), Skia.Color('#FF3FA4'), Skia.Color('#C2186F')], [0, 0.45, 1], TileMode.Clamp,
  ));
  const gloss = Skia.PathBuilder.Make();
  gloss.addOval(Skia.XYWHRect(-0.28, -0.16, 0.56, 0.32));
  const kit: HeartKit = { heart: heart.detach(), heartPaint, gloss: gloss.detach(), glossPaint: fillPaint('#FFFFFF', 0.8) };
  for (const face of faces) {
    if (faceOk(face)) drawHeartFace(canvas, face, now, kit);
  }
}
