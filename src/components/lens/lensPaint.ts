import {
  BlurStyle,
  ClipOp,
  FillType,
  PaintStyle,
  Skia,
  TileMode,
  type SkCanvas,
  type SkPathBuilder,
  type SkRect,
} from '@shopify/react-native-skia';

import { MESH } from '@/lib/faceMesh';
import { LIGHT_SPOTS, SUN_ON_SCREEN, spotBrightness, spotShade } from '@/lib/goldenLight';

// ---------------------------------------------------------------------------
// The drawing for the face filters, in one place. The same code draws the live camera (LensOverlay.tsx)
// and the saved photo (bakeLook.ts), so the photo looks just like what you saw.
//
// ✨ Soft Glow ("heavenly gold", the owner's ask, 5 Nov): golden light falling on the whole face from above –
//    a warm gold glow on the skin (not the eyes, brows or lips) that is brightest at the forehead, soft light
//    rays and a glow above the head, golden highlights on the cheekbones, nose and forehead, warm blush (a bit
//    stronger when you smile), warmer eyes with a small catchlight (hidden while you blink), twinkling gold
//    glitter on the skin and gold sparkles all around the face. Both sides of the face get the same light.
// 🌅 Golden Hour: low evening sun from the top-left. Warm light on the side of the face that turns toward it
//    (worked out from the face's 3D shape, lib/goldenLight.ts), a soft golden rim on that edge, a gentle haze
//    and flare from the top-left corner, a slightly warmer picture overall, and twinkling gold sparkles around
//    the head and in the sunbeam (the owner: "perfect, just add more sparkles").
//
// The light is soft on purpose: it should look like real light, not like a sticker.
// These run on the drawing thread too, hence 'worklet'.
//
// Note: this is drawn OVER the camera picture, so it can tint, brighten and add light, but it can't truly
// blur or relight the pixels underneath (see docs/FACE_MESH.md).
// ---------------------------------------------------------------------------

export type LensLook = 'glow' | 'golden';

// One face, ready to draw: screen points (x0, y0, x1, y1, …), how closed each eye is, how big the smile is,
// and (for Golden Hour) how much each light spot faces the sun and how much the face edge catches it.
export type LensFace = {
  pts: number[];
  blinkLeft: number;
  blinkRight: number;
  smile: number;
  light: number[];
  rim: number;
};

export const MAX_LENS_FACES = 2;

// Soft Glow strengths (0–1).
const GOLD_SKIN = 0.17; // gold over the whole face
const TOP_LIGHT = 0.22; // the light from above, brightest at the forehead
const HEAVEN = 0.3; // the glow above the head
const RAYS = 0.09; // the soft light rays
const HIGHLIGHT = 0.22; // golden highlights (cheekbones, nose, forehead)
const BLUSH = 0.12;
const EYE_WARM = 0.06;
const CATCHLIGHT = 0.5;
const SPARKLE = 0.85;
const GLITTER = 0.9;

// Golden Hour strengths (0–1).
const WARM_WASH = 0.07; // the whole picture, a touch warmer
const VIGNETTE = 0.2; // slightly darker, warmer corners
const SUN_LIGHT = 0.26; // warm light on the lit side of the face
const SHADE = 0.09; // the side away from the sun, a touch deeper
const RIM = 0.5; // the golden edge
const HAZE = 0.34; // the glow from the top-left corner
const FLARE = 0.08; // the little lens-flare circles
const SUN_SPARKLE = 0.85; // the gold sparkles around the head and in the sunbeam

// Places on the face for glitter and sparkles, in the face's own directions (see facePoint): u from one side
// of the face (-1) to the other (1), v from the forehead (-1) to the chin (1), plus a size, a phase and a
// speed for the twinkle. Made once here, the same every time, so the saved photo matches what you saw.
function makeSpots(count: number, seed: number, areas: readonly (readonly [number, number, number, number])[]) {
  const spots: number[] = [];
  let state = seed;
  const next = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    const [u0, u1, v0, v1] = areas[i % areas.length];
    spots.push(u0 + (u1 - u0) * next(), v0 + (v1 - v0) * next(), 0.6 + 0.8 * next(), next() * 6.283, 0.9 + 1.6 * next());
  }
  return spots;
}
// Gold glitter on the skin: cheekbones (both sides), forehead, nose bridge and temples.
const GLITTER_SPOTS = makeSpots(44, 7, [
  [-0.72, -0.34, -0.02, 0.24],
  [0.34, 0.72, -0.02, 0.24],
  [-0.45, 0.45, -0.82, -0.52],
  [-0.07, 0.07, -0.34, -0.02],
  [-0.82, -0.62, -0.5, -0.22],
  [0.62, 0.82, -0.5, -0.22],
]);
// Soft Glow sparkles all around the face, the same on both sides (u, v, size, phase, speed).
const HALO_SPARKLES = [
  -1.12, -0.55, 1.0, 0.3, 1.3, 1.12, -0.55, 1.0, 2.4, 1.5, -1.06, 0.18, 0.8, 4.1, 1.1, 1.06, 0.18, 0.8, 1.2, 1.7,
  -0.58, -1.18, 0.9, 5.0, 1.4, 0.58, -1.18, 0.9, 3.3, 1.2, 0.0, -1.34, 1.1, 0.9, 1.6, -0.95, -0.98, 0.7, 2.0, 1.9,
  0.95, -0.98, 0.7, 4.6, 1.0, -0.36, -0.66, 0.45, 3.7, 2.1, 0.4, 0.06, 0.45, 5.6, 1.8, -0.42, 0.1, 0.45, 0.4, 2.3,
];
// Golden Hour sparkles around the head (face directions) and in the sunbeam (parts of the picture's width and
// height, near the sun at the top-left).
const HEAD_SPARKLES = [
  -1.15, -0.62, 1.0, 0.2, 1.4, -0.86, -1.08, 0.85, 2.6, 1.1, -0.32, -1.3, 0.9, 4.4, 1.6, 0.36, -1.24, 0.7, 1.5, 1.3,
  1.08, -0.7, 0.75, 3.1, 1.8, -1.2, 0.12, 0.7, 5.2, 1.2, 1.12, 0.05, 0.55, 0.9, 2.0, -0.52, -0.74, 0.45, 3.9, 2.2,
  -1.32, -0.25, 0.6, 1.0, 1.7, 0.85, -1.08, 0.6, 5.9, 1.5, -0.05, -1.42, 0.65, 2.9, 1.9, 0.5, -0.55, 0.4, 4.8, 2.4,
];
const BEAM_SPARKLES = [
  0.06, 0.1, 1.0, 0.5, 1.2, 0.16, 0.05, 0.8, 2.2, 1.6, 0.23, 0.17, 0.9, 4.0, 1.0, 0.1, 0.25, 0.7, 1.1, 1.9,
  0.31, 0.08, 0.6, 3.3, 1.4, 0.37, 0.23, 0.75, 5.4, 1.1, 0.19, 0.33, 0.55, 2.8, 2.1, 0.46, 0.13, 0.5, 0.2, 1.7,
  0.04, 0.36, 0.6, 4.7, 1.3, 0.27, 0.42, 0.5, 1.8, 1.8, 0.52, 0.04, 0.55, 3.6, 1.5, 0.42, 0.33, 0.45, 6.0, 2.0,
];
// Tiny gold dust floating in the sunbeam (parts of the picture's width and height).
const BEAM_DUST = makeSpots(28, 19, [[0.02, 0.5, 0.02, 0.42]]);

// Each drawing step comes after the steps it uses: the worklet copies of these functions (for the camera's
// drawing thread) are made in file order, and a step used before it is made would be missing there and
// crash the app. tests/unit/worklet-order.test.mjs checks this.

// ---------------------------------------------------------------------------
// Little drawing helpers.
// ---------------------------------------------------------------------------

// A fill paint with a colour, a see-through amount and a soft edge.
// (No `style = BlurStyle.Normal` default here: on the camera's drawing thread a default like that is worked out
// before BlurStyle exists and the live filter stops drawing. tests/unit/worklet-order.test.mjs checks this.)
function soft(color: string, alpha: number, blur: number, style?: BlurStyle) {
  'worklet';
  const paint = Skia.Paint();
  paint.setAntiAlias(true);
  paint.setColor(Skia.Color(color));
  paint.setAlphaf(Math.max(0, Math.min(1, alpha)));
  if (blur > 0) paint.setMaskFilter(Skia.MaskFilter.MakeBlur(style ?? BlurStyle.Normal, blur, true));
  return paint;
}

function distance(pts: number[], a: number, b: number) {
  'worklet';
  return Math.hypot(pts[a * 2] - pts[b * 2], pts[a * 2 + 1] - pts[b * 2 + 1]);
}

// A point in the face's own directions, so it follows the face when it tilts or turns: u goes across the face
// (-1 and 1 are its two sides), v goes down it (-1 is the top of the forehead, 1 the chin, 0 the middle).
function facePoint(pts: number[], u: number, v: number): [number, number] {
  'worklet';
  const ax = (pts[MESH.leftFaceSide * 2] - pts[MESH.rightFaceSide * 2]) / 2;
  const ay = (pts[MESH.leftFaceSide * 2 + 1] - pts[MESH.rightFaceSide * 2 + 1]) / 2;
  const tx = pts[MESH.forehead * 2];
  const ty = pts[MESH.forehead * 2 + 1];
  const bx = pts[MESH.chin * 2];
  const by = pts[MESH.chin * 2 + 1];
  return [(tx + bx) / 2 + ax * u + ((bx - tx) / 2) * v, (ty + by) / 2 + ay * u + ((by - ty) / 2) * v];
}

// How bright a twinkle is right now (0 = gone), from its phase and speed.
function twinkleAt(time: number, phase: number, speed: number) {
  'worklet';
  return Math.max(0, Math.sin(time * speed + phase));
}

// A smooth closed shape through the given points, grown or shrunk around its middle by `scale`.
function addSmoothLoop(builder: SkPathBuilder, pts: number[], loop: readonly number[], scale: number) {
  'worklet';
  const n = loop.length;
  if (n < 3) return;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += pts[loop[i] * 2];
    cy += pts[loop[i] * 2 + 1];
  }
  cx /= n;
  cy /= n;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < n; i++) {
    xs.push(cx + (pts[loop[i] * 2] - cx) * scale);
    ys.push(cy + (pts[loop[i] * 2 + 1] - cy) * scale);
  }
  // Curves through the midpoints, using each point as the bend – no sharp corners.
  builder.moveTo((xs[n - 1] + xs[0]) / 2, (ys[n - 1] + ys[0]) / 2);
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    builder.quadTo(xs[i], ys[i], (xs[i] + xs[next]) / 2, (ys[i] + ys[next]) / 2);
  }
  builder.close();
}

// A four-pointed sparkle with thin, curved arms.
function addSparkle(builder: SkPathBuilder, x: number, y: number, size: number) {
  'worklet';
  if (size <= 0.5) return;
  const waist = size * 0.16;
  builder.moveTo(x, y - size);
  builder.quadTo(x + waist, y - waist, x + size, y);
  builder.quadTo(x + waist, y + waist, x, y + size);
  builder.quadTo(x - waist, y + waist, x - size, y);
  builder.quadTo(x - waist, y - waist, x, y - size);
  builder.close();
}

// Twinkling gold sparkles: a soft glow and a sharp four-pointed star for each. `spots` holds (x, y, size, phase,
// speed) per sparkle, already on screen; `base` is the size of a size-1 sparkle.
function drawSparkles(canvas: SkCanvas, spots: number[], base: number, time: number, strength: number, color: string) {
  'worklet';
  const stars = Skia.PathBuilder.Make();
  const halo = soft(color, strength * 0.45, base * 0.6);
  for (let i = 0; i + 4 < spots.length; i += 5) {
    const twinkle = twinkleAt(time, spots[i + 3], spots[i + 4]);
    if (twinkle < 0.12) continue;
    const size = base * spots[i + 2] * (0.55 + 0.45 * twinkle);
    addSparkle(stars, spots[i], spots[i + 1], size);
    canvas.drawCircle(spots[i], spots[i + 1], size * 0.45, halo);
  }
  canvas.drawPath(stars.detach(), soft('#FFEDB5', strength, Math.max(0.5, base * 0.06), BlurStyle.Solid));
}

// ---------------------------------------------------------------------------
// ✨ Soft Glow (heavenly gold)
// ---------------------------------------------------------------------------

function drawCatchlight(canvas: SkCanvas, pts: number[], iris: number, edge: number, paint: ReturnType<typeof soft>) {
  'worklet';
  const cx = pts[iris * 2];
  const cy = pts[iris * 2 + 1];
  const radius = distance(pts, iris, edge);
  canvas.drawCircle(cx - radius * 0.3, cy - radius * 0.35, Math.max(0.8, radius * 0.22), paint);
}

function paintSoftGlow(canvas: SkCanvas, face: LensFace, time: number) {
  'worklet';
  const pts = face.pts;
  const w = distance(pts, MESH.leftFaceSide, MESH.rightFaceSide);
  if (w < 4) return;
  const shimmer = 0.9 + 0.1 * Math.sin(time * 0.8);

  // 1. Light from above: a warm glow over the head and a few soft rays falling onto the face.
  const [hx, hy] = facePoint(pts, 0, -1.7);
  const heaven = Skia.Paint();
  heaven.setShader(
    Skia.Shader.MakeRadialGradient(
      { x: hx, y: hy },
      w * 1.5,
      [
        Skia.Color(`rgba(255,240,200,${HEAVEN * shimmer})`),
        Skia.Color(`rgba(255,214,140,${HEAVEN * 0.35 * shimmer})`),
        Skia.Color('rgba(255,200,120,0)'),
      ],
      [0, 0.45, 1],
      TileMode.Clamp,
    ),
  );
  canvas.drawCircle(hx, hy, w * 1.5, heaven);
  const [sx, sy] = facePoint(pts, 0, -2.6);
  const rays = Skia.PathBuilder.Make();
  for (let i = 0; i < 5; i++) {
    const u = -0.9 + i * 0.45;
    const [ax, ay] = facePoint(pts, u - 0.12, 0.7);
    const [bx, by] = facePoint(pts, u + 0.12, 0.7);
    rays.moveTo(sx, sy);
    rays.lineTo(ax, ay);
    rays.lineTo(bx, by);
    rays.close();
  }
  canvas.drawPath(rays.detach(), soft('#FFE6B0', RAYS * (0.85 + 0.15 * Math.sin(time * 0.5 + 1)), w * 0.12));

  // 2. Gold on the skin, the same on both sides, brightest at the forehead (the eyes, brows and lips cut out).
  const skin = Skia.PathBuilder.Make();
  skin.setFillType(FillType.EvenOdd);
  addSmoothLoop(skin, pts, MESH.faceOval, 0.98);
  addSmoothLoop(skin, pts, MESH.leftEye, 1.3);
  addSmoothLoop(skin, pts, MESH.rightEye, 1.3);
  addSmoothLoop(skin, pts, MESH.leftBrow, 1.2);
  addSmoothLoop(skin, pts, MESH.rightBrow, 1.2);
  addSmoothLoop(skin, pts, MESH.lips, 1.1);
  const skinPath = skin.detach();
  canvas.drawPath(skinPath, soft('#FFA632', GOLD_SKIN, Math.max(2, w * 0.05)));
  const [topX, topY] = facePoint(pts, 0, -1);
  const [chinX, chinY] = facePoint(pts, 0, 1);
  const fromAbove = Skia.Paint();
  fromAbove.setAntiAlias(true);
  fromAbove.setShader(
    Skia.Shader.MakeLinearGradient(
      { x: topX, y: topY },
      { x: chinX, y: chinY },
      [Skia.Color(`rgba(255,206,120,${TOP_LIGHT})`), Skia.Color(`rgba(255,184,90,${TOP_LIGHT * 0.3})`)],
      [0, 1],
      TileMode.Clamp,
    ),
  );
  fromAbove.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, Math.max(2, w * 0.05), true));
  canvas.drawPath(skinPath, fromAbove);

  // 3. Golden highlights where the light catches: both cheekbones, the nose and the middle of the forehead.
  const glow = soft('#FFE9B8', HIGHLIGHT, w * 0.05);
  for (const [u, v, r] of [[-0.5, 0.06, 0.08], [0.5, 0.06, 0.08], [0, -0.12, 0.045], [0, -0.66, 0.09]] as const) {
    const [x, y] = facePoint(pts, u, v);
    canvas.drawCircle(x, y, w * r, glow);
  }

  // 4. Warm blush on the apples of the cheeks.
  const blush = soft('#FF9A6B', BLUSH * (0.85 + 0.35 * face.smile), Math.max(2, w * 0.07));
  for (const cheek of [MESH.leftCheek, MESH.rightCheek]) canvas.drawCircle(pts[cheek * 2], pts[cheek * 2 + 1], w * 0.11, blush);

  // 5. Warmer eyes and a catchlight, only inside the open eyes.
  const eyes = Skia.PathBuilder.Make();
  const leftOpen = face.blinkLeft < 0.5;
  const rightOpen = face.blinkRight < 0.5;
  if (leftOpen) addSmoothLoop(eyes, pts, MESH.leftEye, 1);
  if (rightOpen) addSmoothLoop(eyes, pts, MESH.rightEye, 1);
  if (leftOpen || rightOpen) {
    const eyePath = eyes.detach();
    const eyeBlur = Math.max(1, w * 0.012);
    canvas.save();
    canvas.clipPath(eyePath, ClipOp.Intersect, true);
    canvas.drawPath(eyePath, soft('#FFE7B8', EYE_WARM, eyeBlur));
    const catchlight = soft('#FFFFFF', CATCHLIGHT, eyeBlur);
    if (leftOpen) drawCatchlight(canvas, pts, MESH.leftIris, MESH.leftIrisEdge, catchlight);
    if (rightOpen) drawCatchlight(canvas, pts, MESH.rightIris, MESH.rightIrisEdge, catchlight);
    canvas.restore();
  }

  // 6. Gold glitter on the skin: tiny dots that twinkle on their own rhythm.
  canvas.save();
  canvas.clipPath(skinPath, ClipOp.Intersect, true);
  const dot = soft('#FFE08A', GLITTER, Math.max(0.4, w * 0.003), BlurStyle.Solid);
  for (let i = 0; i + 4 < GLITTER_SPOTS.length; i += 5) {
    const twinkle = twinkleAt(time, GLITTER_SPOTS[i + 3], GLITTER_SPOTS[i + 4] * 1.4);
    if (twinkle < 0.2) continue;
    const [x, y] = facePoint(pts, GLITTER_SPOTS[i], GLITTER_SPOTS[i + 1]);
    dot.setAlphaf(GLITTER * twinkle);
    canvas.drawCircle(x, y, Math.max(0.6, w * 0.0075 * GLITTER_SPOTS[i + 2]), dot);
  }
  canvas.restore();

  // 7. Gold sparkles all around the face, on both sides.
  const around: number[] = [];
  for (let i = 0; i + 4 < HALO_SPARKLES.length; i += 5) {
    const [x, y] = facePoint(pts, HALO_SPARKLES[i], HALO_SPARKLES[i + 1]);
    around.push(x, y, HALO_SPARKLES[i + 2], HALO_SPARKLES[i + 3], HALO_SPARKLES[i + 4]);
  }
  drawSparkles(canvas, around, w * 0.045, time, SPARKLE, '#FFD27A');
}

// ---------------------------------------------------------------------------
// 🌅 Golden Hour
// ---------------------------------------------------------------------------

function paintSunOnFace(canvas: SkCanvas, face: LensFace) {
  'worklet';
  const w = distance(face.pts, MESH.leftFaceSide, MESH.rightFaceSide);
  if (w < 4 || face.light.length !== LIGHT_SPOTS.length) return;

  // The light and shade stay on the skin: the face outline (a hair bigger), with the eyes cut out.
  const skin = Skia.PathBuilder.Make();
  skin.setFillType(FillType.EvenOdd);
  addSmoothLoop(skin, face.pts, MESH.faceOval, 1.02);
  addSmoothLoop(skin, face.pts, MESH.leftEye, 1.15);
  addSmoothLoop(skin, face.pts, MESH.rightEye, 1.15);
  canvas.save();
  canvas.clipPath(skin.detach(), ClipOp.Intersect, true);
  for (let i = 0; i < LIGHT_SPOTS.length; i++) {
    const spot = LIGHT_SPOTS[i];
    const x = face.pts[spot.point * 2];
    const y = face.pts[spot.point * 2 + 1];
    const r = w * spot.size;
    const lit = spotBrightness(face.light[i]);
    if (lit > 0.01) canvas.drawCircle(x, y, r, soft('#FFB25A', SUN_LIGHT * lit, r * 0.6));
    const shade = spotShade(face.light[i]);
    if (shade > 0.01) canvas.drawCircle(x, y, r, soft('#3C1A08', SHADE * shade, r * 0.7));
  }
  canvas.restore();

  // The golden rim: a soft line along the face edge, strongest on the side the sun comes from.
  if (face.rim > 0.02) {
    let cx = 0;
    let cy = 0;
    for (const i of MESH.faceOval) {
      cx += face.pts[i * 2];
      cy += face.pts[i * 2 + 1];
    }
    cx /= MESH.faceOval.length;
    cy /= MESH.faceOval.length;
    const edge = Skia.PathBuilder.Make();
    addSmoothLoop(edge, face.pts, MESH.faceOval, 1.0);
    const rim = Skia.Paint();
    rim.setAntiAlias(true);
    rim.setStyle(PaintStyle.Stroke);
    rim.setStrokeWidth(w * 0.028);
    rim.setShader(
      Skia.Shader.MakeLinearGradient(
        { x: cx + SUN_ON_SCREEN.x * w * 0.55, y: cy + SUN_ON_SCREEN.y * w * 0.55 },
        { x: cx - SUN_ON_SCREEN.x * w * 0.1, y: cy - SUN_ON_SCREEN.y * w * 0.1 },
        [Skia.Color('rgba(255,208,138,1)'), Skia.Color('rgba(255,208,138,0)')],
        [0, 1],
        TileMode.Clamp,
      ),
    );
    rim.setAlphaf(RIM * face.rim);
    rim.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, w * 0.018, true));
    canvas.drawPath(edge.detach(), rim);
  }
}

function paintGoldenHour(canvas: SkCanvas, faces: LensFace[], width: number, height: number, time: number, fill: SkRect) {
  'worklet';
  // 1. The whole picture a touch warmer, with soft warm-dark corners (like late sun through a window).
  const wash = Skia.Paint();
  wash.setColor(Skia.Color('#FF9A3C'));
  wash.setAlphaf(WARM_WASH);
  canvas.drawRect(fill, wash);
  const vignette = Skia.Paint();
  vignette.setShader(
    Skia.Shader.MakeRadialGradient(
      { x: width * 0.55, y: height * 0.45 },
      Math.hypot(width, height) * 0.62,
      [Skia.Color('rgba(70,30,5,0)'), Skia.Color('rgba(70,30,5,0)'), Skia.Color(`rgba(70,30,5,${VIGNETTE})`)],
      [0, 0.55, 1],
      TileMode.Clamp,
    ),
  );
  canvas.drawRect(fill, vignette);

  // 2. Each face: sun on the side facing it, a little shade on the other side, and a golden rim.
  for (const face of faces) paintSunOnFace(canvas, face);

  // 3. The sun itself, just out of the picture at the top-left: a warm haze and a few faint flare circles.
  const sunX = -width * 0.06;
  const sunY = -height * 0.04;
  const shimmer = 0.92 + 0.08 * Math.sin(time * 0.6);
  const haze = Skia.Paint();
  haze.setShader(
    Skia.Shader.MakeRadialGradient(
      { x: sunX, y: sunY },
      width * 0.95,
      [
        Skia.Color(`rgba(255,196,120,${HAZE * shimmer})`),
        Skia.Color(`rgba(255,170,90,${HAZE * 0.35 * shimmer})`),
        Skia.Color('rgba(255,160,80,0)'),
      ],
      [0, 0.4, 1],
      TileMode.Clamp,
    ),
  );
  canvas.drawRect(fill, haze);
  const core = Skia.Paint();
  core.setShader(
    Skia.Shader.MakeRadialGradient(
      { x: sunX, y: sunY },
      width * 0.28,
      [Skia.Color(`rgba(255,244,214,${0.42 * shimmer})`), Skia.Color('rgba(255,236,200,0)')],
      [0, 1],
      TileMode.Clamp,
    ),
  );
  canvas.drawRect(fill, core);
  // Flare circles along the line from the sun through the middle of the picture, like a real lens.
  const ghosts: [number, number, string][] = [
    [0.55, 0.035, '255,214,150'],
    [0.85, 0.07, '255,180,110'],
    [1.3, 0.022, '255,226,170'],
    [1.55, 0.05, '250,170,120'],
  ];
  const midX = width / 2;
  const midY = height / 2;
  for (let i = 0; i < ghosts.length; i++) {
    const [along, size, rgb] = ghosts[i];
    const x = sunX + (midX - sunX) * along;
    const y = sunY + (midY - sunY) * along;
    const r = width * size;
    const ghost = soft(`rgb(${rgb})`, FLARE * shimmer * (i % 2 === 0 ? 1 : 0.7), r * 0.35);
    canvas.drawCircle(x, y, r, ghost);
  }

  // 4. Twinkling gold sparkles: in the sunbeam near the top-left, and around each head.
  const beam: number[] = [];
  for (let i = 0; i + 4 < BEAM_SPARKLES.length; i += 5) {
    beam.push(BEAM_SPARKLES[i] * width, BEAM_SPARKLES[i + 1] * height, BEAM_SPARKLES[i + 2], BEAM_SPARKLES[i + 3], BEAM_SPARKLES[i + 4]);
  }
  drawSparkles(canvas, beam, width * 0.03, time, SUN_SPARKLE, '#FFD58A');
  const dust = soft('#FFE3A0', SUN_SPARKLE, Math.max(0.4, width * 0.0015), BlurStyle.Solid);
  for (let i = 0; i + 4 < BEAM_DUST.length; i += 5) {
    const twinkle = twinkleAt(time, BEAM_DUST[i + 3], BEAM_DUST[i + 4] * 1.3);
    if (twinkle < 0.2) continue;
    dust.setAlphaf(SUN_SPARKLE * twinkle);
    canvas.drawCircle(BEAM_DUST[i] * width, BEAM_DUST[i + 1] * height, Math.max(0.6, width * 0.0035 * BEAM_DUST[i + 2]), dust);
  }
  for (const face of faces) {
    const w = distance(face.pts, MESH.leftFaceSide, MESH.rightFaceSide);
    if (w < 4) continue;
    const around: number[] = [];
    for (let i = 0; i + 4 < HEAD_SPARKLES.length; i += 5) {
      const [x, y] = facePoint(face.pts, HEAD_SPARKLES[i], HEAD_SPARKLES[i + 1]);
      around.push(x, y, HEAD_SPARKLES[i + 2], HEAD_SPARKLES[i + 3], HEAD_SPARKLES[i + 4]);
    }
    drawSparkles(canvas, around, w * 0.045, time, SUN_SPARKLE, '#FFD58A');
  }
}

// Draws `look` for these faces. `width`/`height` is the camera view. `fill` is the area the whole-picture
// parts (warm wash, corners) must cover – the view itself live, the whole photo when saving. `time` is in
// seconds (for the twinkle and a slow shimmer).
export function paintLook(canvas: SkCanvas, look: LensLook, faces: LensFace[], width: number, height: number, time: number, fill?: SkRect) {
  'worklet';
  if (width <= 0 || height <= 0) return;
  if (look === 'golden') paintGoldenHour(canvas, faces, width, height, time, fill ?? Skia.XYWHRect(0, 0, width, height));
  else for (const face of faces) paintSoftGlow(canvas, face, time);
}
