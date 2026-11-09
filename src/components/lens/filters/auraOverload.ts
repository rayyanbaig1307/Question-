import { Skia, type SkCanvas, type SkRect } from '@shopify/react-native-skia';

import { MESH } from '@/lib/faceMesh';

import type { LensFace } from '../lensPaint';
import {
  addBolt, addStar, clamp01, eyeOf, faceGeom, faceOk, fillPaint, hash01, num, radialPaint, rgba, softEdge, strokePaint,
} from './kit';

// ---------------------------------------------------------------------------
// ⚡ Aura Overload (Peekaboo+): your aura bursts out – a pulsing purple ring round your head, crackling
// lightning bolts, little stars orbiting your head, glowing eyes and a purple glow in the corners of the
// picture. It is on as soon as it sees you; open your mouth to charge it up to full power (more and longer
// bolts, brighter everything). The charge (face.charge) is worked out in faceTrack.ts.
//
// The web version brightened the camera picture itself ("screen"/"lighter" blending). That can't work over
// the live camera, so here every layer is simply see-through colour.
// ---------------------------------------------------------------------------

// How often the lightning changes shape (times a second). Lower it if it ever feels too busy.
const BOLT_HZ = 18;
// How strong the purple glow in the corners of the picture is.
const TINT = 0.38;
// How many stars orbit each head.
const STARS = 7;

// How strong a face's aura is: 0.8 with a closed mouth, 1 fully charged.
function auraLevel(face: LensFace) {
  'worklet';
  return 0.8 + 0.2 * clamp01(num(face.charge));
}

// The middle of the aura: a little above the middle of the face.
function hubOf(pts: number[]) {
  'worklet';
  const g = faceGeom(pts);
  return { x: g.cx + g.upX * g.H * 0.08, y: g.cy + g.upY * g.H * 0.08, headR: g.W * 0.62 };
}

function drawAura(canvas: SkCanvas, face: LensFace, now: number) {
  'worklet';
  const pts = face.pts;
  const g = faceGeom(pts);
  const hub = hubOf(pts);
  const charge = clamp01(num(face.charge));
  const a = auraLevel(face);
  const headR = hub.headR;
  const seed = num(face.seed);
  // The face's own directions, so the aura leans with the head: across (c, s) and down (-s, c).
  const c = Math.cos(g.tilt);
  const s = Math.sin(g.tilt);

  // 1. The pulsing ring round the head.
  const pulse = 1 + 0.05 * a * Math.sin(now * 9);
  const r1 = headR * 1.35 * pulse;
  const inner = 0.85 / 1.35;
  canvas.drawCircle(hub.x, hub.y, r1, radialPaint(hub.x, hub.y, r1, [
    rgba('177,76,255', 0), rgba('177,76,255', 0), rgba('225,29,255', 0.45 * a), rgba('138,43,226', 0),
  ], [0, inner, inner + 0.35 * (1 - inner), 1]));

  // 2. Lightning bolts bursting out of the head. They flicker: each one is redrawn BOLT_HZ times a second.
  const bolts = Math.round(6 + 8 * charge);
  const frame = Math.floor(now * BOLT_HZ);
  const spin = (now * 0.4) % (Math.PI * 2);
  const zap = Skia.PathBuilder.Make();
  for (let i = 0; i < bolts; i++) {
    const salt = frame * 64 + i;
    if (hash01(seed, salt, 0) > 0.5 + 0.5 * a) continue;
    const ang = (i / bolts) * Math.PI * 2 + 0.5 * hash01(seed, salt, 1) + spin;
    const r0 = headR * (0.7 + 0.2 * hash01(seed, salt, 2));
    const rEnd = headR * (1.1 + 0.7 * a * hash01(seed, salt, 3));
    const lx0 = Math.cos(ang) * r0;
    const ly0 = Math.sin(ang) * r0 * 1.15;
    const lx1 = Math.cos(ang + (hash01(seed, salt, 4) - 0.5) * 0.8) * rEnd;
    const ly1 = Math.sin(ang + (hash01(seed, salt, 5) - 0.5) * 0.8) * rEnd * 1.15;
    addBolt(
      zap,
      hub.x + lx0 * c - ly0 * s, hub.y + lx0 * s + ly0 * c,
      hub.x + lx1 * c - ly1 * s, hub.y + lx1 * s + ly1 * c,
      5 + Math.floor(4 * hash01(seed, salt, 6)), 0.22, seed, salt,
    );
  }
  const path = zap.detach();
  canvas.drawPath(path, softEdge(strokePaint('#E11DFF', Math.min(1, 0.9 * a), g.W * 0.03), g.W * 0.04));
  canvas.drawPath(path, strokePaint('#E6AAFF', 0.9 * a, g.W * 0.016));
  canvas.drawPath(path, strokePaint('#FFFFFF', 0.9 * a, g.W * 0.006));

  // 3. Stars orbiting the head, each with a soft pink glow.
  const stars = Skia.PathBuilder.Make();
  let sizes = 0;
  for (let i = 0; i < STARS; i++) {
    const ang = (now * (0.9 + 0.07 * i) + (i * Math.PI * 2) / STARS) % (Math.PI * 2);
    const rad = headR * (1.25 + 0.2 * Math.sin(now * 1.7 + i));
    const lx = Math.cos(ang) * rad;
    const ly = Math.sin(ang) * rad * 1.1;
    const sr = g.W * (0.03 + 0.025 * Math.sin(now * 5 + i * 2)) * (0.5 + a);
    sizes += sr;
    addStar(stars, hub.x + lx * c - ly * s, hub.y + lx * s + ly * c, sr, (now * 2 + i) % (Math.PI * 2));
  }
  const starPath = stars.detach();
  canvas.drawPath(starPath, softEdge(fillPaint('#FF4FD8', 0.9), (sizes / STARS) * 0.75));
  canvas.drawPath(starPath, fillPaint('#FFFFFF', 0.6 + 0.4 * a));

  // 4. Glowing eyes.
  const right = eyeOf(pts, MESH.rightEyeOuter, MESH.rightEyeInner, MESH.rightIris);
  const left = eyeOf(pts, MESH.leftEyeOuter, MESH.leftEyeInner, MESH.leftIris);
  const er = right.w * (0.55 + 0.9 * a) * (1 + Math.sin(now * 20) * 0.05 * a);
  for (let e = 0; e < 2; e++) {
    const x = e === 0 ? right.x : left.x;
    const y = e === 0 ? right.y : left.y;
    canvas.drawCircle(x, y, er, radialPaint(x, y, er, [
      rgba('255,255,255', 0.95 * (0.3 + a)), rgba('221,160,255', 0.9 * (0.3 + a)), rgba('138,43,226', 0),
    ], [0, 0.35, 1]));
  }
}

// `area` is the whole picture (the camera view live, the whole photo when saving) and width × height the camera
// view, so the corner glow looks the same on the photo as it did on screen.
export function paintAuraOverload(canvas: SkCanvas, faces: LensFace[], now: number, area: SkRect, width: number, height: number) {
  'worklet';
  // The purple glow in the corners: once for the whole picture, round all the faces, never on a face.
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  let level = 0;
  for (const face of faces) {
    if (!faceOk(face)) continue;
    const hub = hubOf(face.pts);
    sumX += hub.x;
    sumY += hub.y;
    level = Math.max(level, auraLevel(face));
    count++;
  }
  if (count > 0) {
    const mx = sumX / count;
    const my = sumY / count;
    let clear = 0;
    for (const face of faces) {
      if (!faceOk(face)) continue;
      const hub = hubOf(face.pts);
      clear = Math.max(clear, Math.hypot(hub.x - mx, hub.y - my) + hub.headR * 0.8);
    }
    const outer = Math.max(width, height) * 0.9;
    if (outer > clear + 1) {
      canvas.drawRect(area, radialPaint(mx, my, outer, [
        rgba('190,110,255', 0), rgba('190,110,255', 0), rgba('190,110,255', TINT * level),
      ], [0, clear / outer, 1]));
    }
  }
  for (const face of faces) {
    if (faceOk(face)) drawAura(canvas, face, now);
  }
}
