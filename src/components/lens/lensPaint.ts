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
// ✨ Soft Glow: a soft warm glow on the skin (not the eyes, brows or lips), light blush (a bit stronger when
//    you smile), brighter eyes with a small catchlight (hidden while you blink), a few tiny twinkling sparkles.
// 🌅 Golden Hour: low evening sun from the top-left. Warm light on the side of the face that turns toward it
//    (worked out from the face's 3D shape, lib/goldenLight.ts), a soft golden rim on that edge, a gentle haze
//    and flare from the top-left corner, and a slightly warmer picture overall.
//
// Everything is faint on purpose: it should look like good light, not like a sticker.
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
const SKIN_GLOW = 0.13;
const BLUSH = 0.16;
const EYE_BRIGHT = 0.12;
const CATCHLIGHT = 0.5;
const SPARKLE = 0.75;

// Golden Hour strengths (0–1).
const WARM_WASH = 0.07; // the whole picture, a touch warmer
const VIGNETTE = 0.2; // slightly darker, warmer corners
const SUN_LIGHT = 0.26; // warm light on the lit side of the face
const SHADE = 0.09; // the side away from the sun, a touch deeper
const RIM = 0.5; // the golden edge
const HAZE = 0.34; // the glow from the top-left corner
const FLARE = 0.08; // the little lens-flare circles

// Draws `look` for these faces. `width`/`height` is the camera view. `fill` is the area the whole-picture
// parts (warm wash, corners) must cover – the view itself live, the whole photo when saving. `time` is in
// seconds (for the twinkle and a slow shimmer).
export function paintLook(canvas: SkCanvas, look: LensLook, faces: LensFace[], width: number, height: number, time: number, fill?: SkRect) {
  'worklet';
  if (width <= 0 || height <= 0) return;
  if (look === 'golden') paintGoldenHour(canvas, faces, width, height, time, fill ?? Skia.XYWHRect(0, 0, width, height));
  else for (const face of faces) paintSoftGlow(canvas, face, time);
}

// ---------------------------------------------------------------------------
// ✨ Soft Glow
// ---------------------------------------------------------------------------

function paintSoftGlow(canvas: SkCanvas, face: LensFace, time: number) {
  'worklet';
  const w = distance(face.pts, MESH.leftFaceSide, MESH.rightFaceSide);
  if (w < 4) return;

  // Skin glow: warm white, very faint, soft edges. The face outline with the eyes, brows and lips cut out.
  const skin = Skia.PathBuilder.Make();
  skin.setFillType(FillType.EvenOdd);
  addSmoothLoop(skin, face.pts, MESH.faceOval, 0.97);
  addSmoothLoop(skin, face.pts, MESH.leftEye, 1.35);
  addSmoothLoop(skin, face.pts, MESH.rightEye, 1.35);
  addSmoothLoop(skin, face.pts, MESH.leftBrow, 1.25);
  addSmoothLoop(skin, face.pts, MESH.rightBrow, 1.25);
  addSmoothLoop(skin, face.pts, MESH.lips, 1.12);
  canvas.drawPath(skin.detach(), soft('#FFF1E8', SKIN_GLOW, Math.max(2, w * 0.05)));

  // Blush on the apples of the cheeks.
  const blush = soft('#FF7A8F', BLUSH * (0.85 + 0.35 * face.smile), Math.max(2, w * 0.07));
  for (const [cheek, side] of [[MESH.leftCheek, MESH.leftFaceSide], [MESH.rightCheek, MESH.rightFaceSide]] as const) {
    const x = face.pts[cheek * 2] * 0.85 + face.pts[side * 2] * 0.15;
    const y = face.pts[cheek * 2 + 1] * 0.85 + face.pts[side * 2 + 1] * 0.15;
    canvas.drawCircle(x, y, w * 0.11, blush);
  }

  // Brighter eyes and a catchlight, only inside the open eyes.
  const eyes = Skia.PathBuilder.Make();
  const leftOpen = face.blinkLeft < 0.5;
  const rightOpen = face.blinkRight < 0.5;
  if (leftOpen) addSmoothLoop(eyes, face.pts, MESH.leftEye, 1);
  if (rightOpen) addSmoothLoop(eyes, face.pts, MESH.rightEye, 1);
  if (leftOpen || rightOpen) {
    const eyePath = eyes.detach();
    const eyeBlur = Math.max(1, w * 0.012);
    canvas.save();
    canvas.clipPath(eyePath, ClipOp.Intersect, true);
    canvas.drawPath(eyePath, soft('#FFFFFF', EYE_BRIGHT, eyeBlur));
    const catchlight = soft('#FFFFFF', CATCHLIGHT, eyeBlur);
    if (leftOpen) drawCatchlight(canvas, face.pts, MESH.leftIris, MESH.leftIrisEdge, catchlight);
    if (rightOpen) drawCatchlight(canvas, face.pts, MESH.rightIris, MESH.rightIrisEdge, catchlight);
    canvas.restore();
  }

  // A few sparkles near the temples and cheekbones. Each twinkles on its own rhythm and is sometimes gone.
  const sparkles = Skia.PathBuilder.Make();
  const spots = [MESH.leftTemple, MESH.rightCheekbone, MESH.leftCheekbone, MESH.rightTemple];
  const nx = face.pts[MESH.noseTip * 2];
  const ny = face.pts[MESH.noseTip * 2 + 1];
  for (let i = 0; i < spots.length; i++) {
    const twinkle = Math.max(0, Math.sin(time * (1.3 + i * 0.37) + i * 1.9));
    if (twinkle < 0.15) continue;
    const px = face.pts[spots[i] * 2];
    const py = face.pts[spots[i] * 2 + 1];
    // Nudge each sparkle a little outward and upward from its point.
    addSparkle(sparkles, px + (px - nx) * 0.18, py + (py - ny) * 0.18 - w * 0.03, w * 0.028 * twinkle);
  }
  canvas.drawPath(sparkles.detach(), soft('#FFFDF7', SPARKLE, Math.max(0.5, w * 0.003), BlurStyle.Solid));
}

function drawCatchlight(canvas: SkCanvas, pts: number[], iris: number, edge: number, paint: ReturnType<typeof soft>) {
  'worklet';
  const cx = pts[iris * 2];
  const cy = pts[iris * 2 + 1];
  const radius = distance(pts, iris, edge);
  canvas.drawCircle(cx - radius * 0.3, cy - radius * 0.35, Math.max(0.8, radius * 0.22), paint);
}

// ---------------------------------------------------------------------------
// 🌅 Golden Hour
// ---------------------------------------------------------------------------

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
}

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

// ---------------------------------------------------------------------------
// Little drawing helpers.
// ---------------------------------------------------------------------------

// A fill paint with a colour, a see-through amount and a soft edge.
function soft(color: string, alpha: number, blur: number, style: BlurStyle = BlurStyle.Normal) {
  'worklet';
  const paint = Skia.Paint();
  paint.setAntiAlias(true);
  paint.setColor(Skia.Color(color));
  paint.setAlphaf(Math.max(0, Math.min(1, alpha)));
  if (blur > 0) paint.setMaskFilter(Skia.MaskFilter.MakeBlur(style, blur, true));
  return paint;
}

function distance(pts: number[], a: number, b: number) {
  'worklet';
  return Math.hypot(pts[a * 2] - pts[b * 2], pts[a * 2 + 1] - pts[b * 2 + 1]);
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
