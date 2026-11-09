import { Skia, type SkCanvas } from '@shopify/react-native-skia';

import { MESH } from '@/lib/faceMesh';

import type { LensFace } from '../lensPaint';
import { addTear, clamp01, eyeOf, faceGeom, faceOk, fillPaint, hash01, num, radialPaint, rgba, strokePaint } from './kit';
import { cryTrigger, levelOf } from './triggers';

// ---------------------------------------------------------------------------
// 😭 Crybaby (Peekaboo+): fountains of cartoon tears gush out sideways from both eyes and fall away, with a
// puffy pink glow under each eye. Squint (or scrunch your eyes shut) for many more and bigger tears.
//
// The tears are not remembered from frame to frame. Each one is worked out from the time and a fixed
// "random" number (hash01), the way a firework show follows a script: the same moment always shows the same
// tears, so the saved photo has them exactly where you saw them. Every tear of a face is in one shape, so a
// face costs only 5 draws, however many tears there are.
// ---------------------------------------------------------------------------

// Tear "slots" a second for each eye; each slot may hold one tear. At most about RATE × (LIFE + LIFE_SPREAD)
// tears per eye are alive at once.
const RATE = 40;
// How long a tear lives (seconds): LIFE plus up to LIFE_SPREAD more.
const LIFE = 0.55;
const LIFE_SPREAD = 0.3;
// The share of slots used with a still face (about 18 tears a second per eye); a full squint uses them all.
const REST_SHARE = 0.45;
// How much bigger the tears are than in the web version (we draw fewer of them).
const TEAR_SIZE = 1.5;
// true: each tear's point leads the way it flies (as in the web version); false: its round end leads.
const TIP_LEADS = true;

function drawCrying(canvas: SkCanvas, face: LensFace, now: number) {
  'worklet';
  const pts = face.pts;
  const g = faceGeom(pts);
  const trigger = cryTrigger(face);
  const cry = levelOf(trigger);
  const share = REST_SHARE + (1 - REST_SHARE) * trigger;
  const right = eyeOf(pts, MESH.rightEyeOuter, MESH.rightEyeInner, MESH.rightIris);
  const left = eyeOf(pts, MESH.leftEyeOuter, MESH.leftEyeInner, MESH.leftIris);
  const ew = right.w;
  const mx = (right.x + left.x) / 2;
  const my = (right.y + left.y) / 2;
  const seed = num(face.seed);
  const gravity = g.H * 3.2;
  const body = Skia.PathBuilder.Make();
  const gloss = Skia.PathBuilder.Make();
  let count = 0;

  for (let e = 0; e < 2; e++) {
    const eye = e === 0 ? right : left;
    const bottom = e === 0 ? MESH.rightEyeBottom : MESH.leftEyeBottom;
    const bx = pts[bottom * 2];
    const by = pts[bottom * 2 + 1];
    // "Out" is away from the point between the eyes (works mirrored or not).
    const ol = Math.hypot(eye.x - mx, eye.y - my);
    const outX = ol > 1e-6 ? (eye.x - mx) / ol : e === 0 ? -1 : 1;
    const outY = ol > 1e-6 ? (eye.y - my) / ol : 0;
    const s = seed * 2 + e;
    const first = Math.floor((now - LIFE - LIFE_SPREAD) * RATE);
    const last = Math.floor(now * RATE);
    for (let k = first; k <= last; k++) {
      const born = (k + hash01(s, k, 0)) / RATE;
      const age = now - born;
      const life = LIFE + LIFE_SPREAD * hash01(s, k, 1);
      if (age < 0 || age >= life) continue;
      // A slot fades in or out (by size) when the share changes, instead of popping.
      const keep = clamp01((share - hash01(s, k, 2)) / 0.08);
      if (keep <= 0) continue;
      const speed = g.H * (0.9 + 1.6 * cry) * (0.7 + 0.6 * hash01(s, k, 3));
      const along = speed * (0.35 + 0.35 * hash01(s, k, 4)) + speed * 0.25 * (hash01(s, k, 5) - 0.5) * 0.9;
      const rise = speed * (0.1 + 0.3 * hash01(s, k, 6));
      const spread = (hash01(s, k, 7) - 0.5) * 0.6 * ew;
      const vx = outX * along + g.upX * rise;
      const vy0 = outY * along + g.upY * rise;
      // Thrown out of the eye, then falling (gravity is straight down the screen).
      const x = bx + outX * spread + vx * age;
      const y = by + outY * spread + vy0 * age + 0.5 * gravity * age * age;
      const vy = vy0 + gravity * age;
      const r =
        g.W * (0.018 + 0.03 * hash01(s, k, 8)) * (0.6 + 0.6 * cry) * TEAR_SIZE * keep *
        (1 - (0.35 * age) / life) * Math.min(1, (life - age) / 0.12);
      if (!(r > 0.2)) continue;
      const stretch = 1 + Math.min(1.2, Math.hypot(vx, vy) / (g.H * 2));
      addTear(body, x, y, r, Math.atan2(vy, vx) + (TIP_LEADS ? Math.PI / 2 : -Math.PI / 2), stretch);
      gloss.addCircle(x - r * 0.3, y - r * 0.3, r * 0.28);
      count++;
    }
  }

  // The tears: watery blue, a deeper blue edge and a little shine on each.
  if (count > 0) {
    const tears = body.detach();
    canvas.drawPath(tears, fillPaint('#5AB4FF', 0.9));
    canvas.drawPath(tears, strokePaint('#1E6EE6', 0.7, Math.max(0.5, g.W * 0.005)));
    canvas.drawPath(gloss.detach(), fillPaint('#EBF8FF', 0.9));
  }

  // The puffy, wet pink glow under each eye (drawn after the tears, as in the web version).
  for (let e = 0; e < 2; e++) {
    const bottom = e === 0 ? MESH.rightEyeBottom : MESH.leftEyeBottom;
    const gx = pts[bottom * 2] - g.upX * ew * 0.3;
    const gy = pts[bottom * 2 + 1] - g.upY * ew * 0.3;
    canvas.drawCircle(gx, gy, ew * 0.9, radialPaint(gx, gy, ew * 0.9, [rgba('255,120,140', 0.9 * 0.35 * cry), rgba('255,120,140', 0)], [0, 1]));
  }
}

export function paintCrybaby(canvas: SkCanvas, faces: LensFace[], now: number) {
  'worklet';
  for (const face of faces) {
    if (faceOk(face)) drawCrying(canvas, face, now);
  }
}
