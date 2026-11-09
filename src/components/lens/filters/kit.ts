import {
  BlurStyle,
  PaintStyle,
  Skia,
  StrokeCap,
  StrokeJoin,
  TileMode,
  type SkColor,
  type SkPaint,
  type SkPathBuilder,
} from '@shopify/react-native-skia';

import { MESH } from '@/lib/faceMesh';

import type { LensFace } from '../lensPaint';

// ---------------------------------------------------------------------------
// Little drawing helpers shared by the Peekaboo+ face filters (the other files in this folder).
//
// Rules for everything in this folder (each one broke the live camera once):
// - every function starts with 'worklet', because it also runs on the drawing thread;
// - a helper sits ABOVE the functions that use it (tests/unit/worklet-order.test.mjs checks this);
// - no default values for parameters that read something from outside (write `x ?? DEFAULT` inside instead);
// - no Math.random or Date.now: the only "random" is hash01, worked out from fixed numbers, so the saved photo
//   shows the very same tears, hearts and sparks you saw on screen;
// - no blend modes and no text (no fonts on the drawing thread): only shapes, gradients and a few soft blurs;
// - only `import type` from '../lensPaint' (a normal import there would go round in a circle and crash).
// ---------------------------------------------------------------------------

// A number that is safe to draw with: anything broken (missing, not a number, endless) becomes 0.
export function num(x: number) {
  'worklet';
  return Number.isFinite(x) ? x : 0;
}

// Keeps a number between 0 and 1 (broken numbers become 0).
export function clamp01(x: number) {
  'worklet';
  return Math.max(0, Math.min(1, x)) || 0;
}

// A colour with a see-through amount: rgba('255,105,180', 0.4) → rgba(255,105,180,0.4). The amount is rounded,
// so it is never written in a form the colour reader can't follow (like 1e-7).
export function rgba(rgb: string, alpha: number) {
  'worklet';
  return Skia.Color(`rgba(${rgb},${Math.round(clamp01(alpha) * 1000) / 1000})`);
}

// A plain fill paint: a colour ('#FF3FA4') and how see-through it is (0–1).
export function fillPaint(color: string, alpha: number) {
  'worklet';
  const paint = Skia.Paint();
  paint.setAntiAlias(true);
  paint.setColor(Skia.Color(color));
  paint.setAlphaf(clamp01(alpha));
  return paint;
}

// A paint for lines, with round ends and round corners.
export function strokePaint(color: string, alpha: number, width: number) {
  'worklet';
  const paint = fillPaint(color, alpha);
  paint.setStyle(PaintStyle.Stroke);
  paint.setStrokeWidth(Math.max(0.1, num(width)));
  paint.setStrokeCap(StrokeCap.Round);
  paint.setStrokeJoin(StrokeJoin.Round);
  return paint;
}

// A paint that fades out from a middle point: `colors` go from the middle (stop 0) to the edge (stop 1).
export function radialPaint(cx: number, cy: number, r: number, colors: SkColor[], stops: number[]) {
  'worklet';
  const paint = Skia.Paint();
  paint.setAntiAlias(true);
  paint.setShader(Skia.Shader.MakeRadialGradient({ x: num(cx), y: num(cy) }, Math.max(0.001, num(r)), colors, stops, TileMode.Clamp));
  return paint;
}

// Makes a paint's edges soft (a blur). Blurs cost the most to draw, so each filter uses very few.
export function softEdge(paint: SkPaint, blur: number) {
  'worklet';
  if (num(blur) > 0.05) paint.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, blur, true));
  return paint;
}

// A "random" number from 0 to 1 that is always the same for the same three numbers. It picks where each tear,
// heart and spark goes, so the same moment always looks the same (on screen and on the saved photo).
export function hash01(a: number, b: number, c: number) {
  'worklet';
  let h = 0x2545f491;
  h = Math.imul(h ^ (a | 0), 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (b | 0), 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f);
  h = Math.imul(h ^ (c | 0), 0x165667b1);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

// The face points every filter leans on. If any of them is broken, the face is skipped this frame.
const NEEDED_POINTS = [
  MESH.rightFaceSide, MESH.leftFaceSide, MESH.forehead, MESH.chin, MESH.noseBottom, MESH.noseTip,
  MESH.rightEyeOuter, MESH.rightEyeInner, MESH.rightEyeBottom, MESH.leftEyeOuter, MESH.leftEyeInner, MESH.leftEyeBottom,
  MESH.rightIris, MESH.leftIris, MESH.upperLipInner, MESH.lowerLipInner, MESH.mouthRightCorner, MESH.mouthLeftCorner,
  MESH.rightBlush, MESH.leftBlush,
];

// Is this face safe to draw? (All its points are there, the ones we use are real numbers, and it isn't tiny.)
export function faceOk(face: LensFace) {
  'worklet';
  if (!face || !face.pts || !(face.pts.length >= 478 * 2)) return false;
  const pts = face.pts;
  for (let i = 0; i < NEEDED_POINTS.length; i++) {
    const x = pts[NEEDED_POINTS[i] * 2];
    const y = pts[NEEDED_POINTS[i] * 2 + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e6 || Math.abs(y) > 1e6) return false;
  }
  const W = Math.hypot(pts[MESH.leftFaceSide * 2] - pts[MESH.rightFaceSide * 2], pts[MESH.leftFaceSide * 2 + 1] - pts[MESH.rightFaceSide * 2 + 1]);
  return W >= 4;
}

// The size and direction of a face on screen:
// W = its width (side to side), H = its height (top of the forehead to the chin), (cx, cy) its middle,
// (upX, upY) the way "up the face" points (a length-1 step from the bottom of the nose to the top of the
// forehead) and `tilt` how far the head leans (radians, 0 = upright). These points don't move when you talk.
// The points are already on screen and mirrored for selfies, so this works the same on both cameras.
export function faceGeom(pts: number[]) {
  'worklet';
  const W = Math.hypot(pts[MESH.leftFaceSide * 2] - pts[MESH.rightFaceSide * 2], pts[MESH.leftFaceSide * 2 + 1] - pts[MESH.rightFaceSide * 2 + 1]);
  const topX = pts[MESH.forehead * 2];
  const topY = pts[MESH.forehead * 2 + 1];
  const chinX = pts[MESH.chin * 2];
  const chinY = pts[MESH.chin * 2 + 1];
  const H = Math.max(1, Math.hypot(chinX - topX, chinY - topY));
  const noseX = pts[MESH.noseBottom * 2];
  const noseY = pts[MESH.noseBottom * 2 + 1];
  const long = Math.hypot(topX - noseX, topY - noseY);
  const upX = long > 1e-6 ? (topX - noseX) / long : 0;
  const upY = long > 1e-6 ? (topY - noseY) / long : -1;
  const tilt = long > 1e-6 ? Math.atan2(noseY - topY, noseX - topX) - Math.PI / 2 : 0;
  return { W, H, cx: (topX + chinX) / 2, cy: (topY + chinY) / 2, upX, upY, tilt };
}

// One eye: its middle (x, y), its width (corner to corner) and where its iris is (ix, iy).
export function eyeOf(pts: number[], outer: number, inner: number, iris: number) {
  'worklet';
  const ox = pts[outer * 2];
  const oy = pts[outer * 2 + 1];
  const nx = pts[inner * 2];
  const ny = pts[inner * 2 + 1];
  return { x: (ox + nx) / 2, y: (oy + ny) / 2, w: Math.max(1, Math.hypot(ox - nx, oy - ny)), ix: pts[iris * 2], iy: pts[iris * 2 + 1] };
}

// The heart shape from the web version, as points of a heart 1 wide: a start point, then two curves of three
// points each.
const HEART = [0, 0.95, -1.6, -0.15, -0.9, -1.2, 0, -0.45, 0.9, -1.2, 1.6, -0.15, 0, 0.95];

// Adds a heart at (x, y), `s` = half its width, turned by `angle` (radians). Many hearts can go into one shape,
// so they are drawn in one go.
export function addHeart(b: SkPathBuilder, x: number, y: number, s: number, angle: number) {
  'worklet';
  if (!(s > 0.05)) return;
  const c = Math.cos(angle) * s;
  const n = Math.sin(angle) * s;
  const px: number[] = [];
  const py: number[] = [];
  for (let i = 0; i + 1 < HEART.length; i += 2) {
    px.push(x + HEART[i] * c - HEART[i + 1] * n);
    py.push(y + HEART[i] * n + HEART[i + 1] * c);
  }
  b.moveTo(px[0], py[0]);
  b.cubicTo(px[1], py[1], px[2], py[2], px[3], py[3]);
  b.cubicTo(px[4], py[4], px[5], py[5], px[6], py[6]);
  b.close();
}

// Adds a five-pointed star at (x, y), `r` = how far its points reach, turned by `angle` (radians).
export function addStar(b: SkPathBuilder, x: number, y: number, r: number, angle: number) {
  'worklet';
  if (!(r > 0.05)) return;
  for (let i = 0; i < 10; i++) {
    const reach = i % 2 === 0 ? r : r * 0.45;
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2 + angle;
    if (i === 0) b.moveTo(x + Math.cos(a) * reach, y + Math.sin(a) * reach);
    else b.lineTo(x + Math.cos(a) * reach, y + Math.sin(a) * reach);
  }
  b.close();
}

// Adds a cartoon tear: a round drop of radius `r` at (x, y) with a pointed end, stretched longer by `stretch`
// (1 = not stretched). `angle` (radians) turns it: at 0 the point is at the top.
export function addTear(b: SkPathBuilder, x: number, y: number, r: number, angle: number, stretch: number) {
  'worklet';
  if (!(r > 0.05)) return;
  const c = Math.cos(angle);
  const n = Math.sin(angle);
  const k = Math.max(1, num(stretch));
  // The web version's teardrop, in the drop's own directions: (across, along · stretch).
  const lx = [0, 1.05 * r, 0, -1.05 * r];
  const ly = [-1.6 * r * k, -0.2 * r * k, r * k, -0.2 * r * k];
  const sx: number[] = [];
  const sy: number[] = [];
  for (let i = 0; i < 4; i++) {
    sx.push(x + lx[i] * c - ly[i] * n);
    sy.push(y + lx[i] * n + ly[i] * c);
  }
  b.moveTo(sx[0], sy[0]);
  b.quadTo(sx[1], sy[1], sx[2], sy[2]);
  b.quadTo(sx[3], sy[3], sx[0], sy[0]);
  b.close();
}

// Adds a zig-zag lightning bolt from (x0, y0) to (x1, y1) with `segments` pieces, each bend pushed sideways by
// up to `jitter` of its length. `seed` and `salt` pick the bends (the same numbers give the same bolt).
export function addBolt(b: SkPathBuilder, x0: number, y0: number, x1: number, y1: number, segments: number, jitter: number, seed: number, salt: number) {
  'worklet';
  const len = Math.hypot(x1 - x0, y1 - y0);
  if (!(len > 0.5)) return;
  const nx = -(y1 - y0) / len;
  const ny = (x1 - x0) / len;
  b.moveTo(x0, y0);
  for (let i = 1; i < segments; i++) {
    const t = i / segments;
    const j = (hash01(seed, salt, 16 + i) - 0.5) * 2 * jitter * len;
    b.lineTo(x0 + (x1 - x0) * t + nx * j, y0 + (y1 - y0) * t + ny * j);
  }
  b.lineTo(x1, y1);
}

// Digits drawn with straight bars, like a clock radio (no fonts needed). Each bar is x, y, width, height in
// parts of the digit's height, for bars a (top) … g (middle).
const SEGMENTS = [
  0.1, 0, 0.3, 0.1, // a
  0.4, 0.1, 0.1, 0.35, // b
  0.4, 0.55, 0.1, 0.35, // c
  0.1, 0.9, 0.3, 0.1, // d
  0, 0.55, 0.1, 0.35, // e
  0, 0.1, 0.1, 0.35, // f
  0.1, 0.45, 0.3, 0.1, // g
];
// Which bars each digit 0–9 lights up (bar a = 1, b = 2, … g = 64).
const DIGIT_BITS = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f];
const DIGIT_WIDTH = 0.5;
const PERCENT_WIDTH = 0.6;
const CHAR_GAP = 0.18;

// Adds text made of digits and '%' (like "37%"), `h` tall, with its middle at (cx, cy). Other characters are
// left out.
export function addDigits(b: SkPathBuilder, text: string, cx: number, cy: number, h: number) {
  'worklet';
  if (!(h > 0.5)) return;
  let total = 0;
  for (let i = 0; i < text.length; i++) total += (text.charCodeAt(i) === 37 ? PERCENT_WIDTH : DIGIT_WIDTH) + (i > 0 ? CHAR_GAP : 0);
  let x = cx - (total * h) / 2;
  const y = cy - h / 2;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 37) {
      b.addCircle(x + 0.15 * h, y + 0.2 * h, 0.11 * h);
      b.addCircle(x + 0.45 * h, y + 0.8 * h, 0.11 * h);
      b.moveTo(x + 0.5 * h, y);
      b.lineTo(x + 0.6 * h, y);
      b.lineTo(x + 0.1 * h, y + h);
      b.lineTo(x, y + h);
      b.close();
      x += (PERCENT_WIDTH + CHAR_GAP) * h;
    } else {
      const digit = code - 48;
      if (digit >= 0 && digit <= 9) {
        const bits = DIGIT_BITS[digit];
        for (let s = 0; s < 7; s++) {
          if ((bits >> s) & 1) {
            b.addRect(Skia.XYWHRect(x + SEGMENTS[s * 4] * h, y + SEGMENTS[s * 4 + 1] * h, SEGMENTS[s * 4 + 2] * h, SEGMENTS[s * 4 + 3] * h));
          }
        }
      }
      x += (DIGIT_WIDTH + CHAR_GAP) * h;
    }
  }
}

// Adds a pill (a rectangle with fully round ends) `w` wide and `h` tall, with its middle at (cx, cy).
export function addPill(b: SkPathBuilder, cx: number, cy: number, w: number, h: number) {
  'worklet';
  const r = h / 2;
  const half = Math.max(0, w / 2 - r);
  if (!(r > 0.05)) return;
  b.addRect(Skia.XYWHRect(cx - half, cy - r, half * 2, h));
  b.addCircle(cx - half, cy, r);
  b.addCircle(cx + half, cy, r);
}
