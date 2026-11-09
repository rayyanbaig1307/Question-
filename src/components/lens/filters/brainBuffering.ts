import { Skia, TileMode, type SkCanvas, type SkColor, type SkRect } from '@shopify/react-native-skia';

import { MESH } from '@/lib/faceMesh';

import type { LensFace } from '../lensPaint';
import { addDigits, addPill, clamp01, faceGeom, faceOk, fillPaint, hash01, num, radialPaint, rgba, strokePaint } from './kit';

// ---------------------------------------------------------------------------
// 🧠 Brain Buffering (Peekaboo+): a loading spinner floats above your forehead. Hold still and your brain
// slowly loads to 100 % (about 9 seconds); move and it drains again. At 100 % the ring turns green, a tick
// shows and the picture flashes green for a moment. Shake your head to restart. How far it has loaded
// (face.progress), the flash (face.flash) and whether you hold still (face.still) are worked out in
// faceTrack.ts; this file only draws them.
//
// No text: the number is drawn with straight bars like a clock radio, and the web version's caption is three
// "loading" dots in a little dark pill (green when loaded, lilac while you hold still, peach while you move).
// The spinner stays upright on screen so the number is always easy to read.
// ---------------------------------------------------------------------------

// How fast the spinner turns (radians a second). One fixed speed, so it never jumps.
const SPIN = 3;
// How long a "lit" loading dot stays lit before the next one lights (seconds).
const DOT_STEP = 1 / 3;
// The 12 spinner pieces, from bright pink-white (the first) to faint purple (the last), as in the web version.
const SPINNER_BANDS: string[] = [];
for (let i = 0; i < 12; i++) {
  const alpha = 0.25 + (0.75 * (12 - i)) / 12;
  SPINNER_BANDS.push(`rgba(${Math.round(200 + (55 * i) / 12)},${Math.round(140 + 60 * alpha)},255,${Math.round(alpha * 1000) / 1000})`);
}

function drawBrain(canvas: SkCanvas, face: LensFace, now: number) {
  'worklet';
  const pts = face.pts;
  const g = faceGeom(pts);
  const r = 0.16 * g.W;
  if (!(r > 0.5)) return;
  const cx = pts[MESH.forehead * 2] + g.upX * r * 0.4;
  const cy = pts[MESH.forehead * 2 + 1] + g.upY * r * 0.4;
  const progress = clamp01(num(face.progress));
  const loaded = progress >= 1;
  const still = num(face.still) > 0.5;
  const seed = num(face.seed);

  // 1. A soft purple glow round it (a gradient, not a blur).
  canvas.drawCircle(cx, cy, r * 1.6, radialPaint(cx, cy, r * 1.6, [
    rgba('177,76,255', 0.9), rgba('177,76,255', 0.8), rgba('177,76,255', 0.45), rgba('177,76,255', 0.14), rgba('177,76,255', 0),
  ], [0, 0.44, 0.625, 0.81, 1]));
  // 2. The dark disc behind it.
  canvas.drawCircle(cx, cy, r, fillPaint('#1E0832', 0.65));

  // 3. The spinner: 12 short arcs going round, in one shape, coloured by a gradient that goes round with them.
  canvas.save();
  canvas.translate(cx, cy);
  canvas.rotate((((now * SPIN) % (Math.PI * 2)) * 180) / Math.PI, 0, 0);
  const ring = Skia.PathBuilder.Make();
  const ro = r * 0.82;
  for (let i = 0; i < 12; i++) ring.addArc(Skia.XYWHRect(-ro, -ro, ro * 2, ro * 2), i * 30 + 6, 18);
  const ringPaint = strokePaint(loaded ? '#78FFAA' : '#FFFFFF', 1, r * 0.16);
  if (!loaded) {
    const colors: SkColor[] = [];
    const stops: number[] = [];
    for (let i = 0; i < 12; i++) {
      const color = Skia.Color(SPINNER_BANDS[i]);
      colors.push(color, color);
      stops.push(i / 12, (i + 1) / 12);
    }
    ringPaint.setShader(Skia.Shader.MakeSweepGradient(0, 0, colors, stops, TileMode.Clamp));
  }
  canvas.drawPath(ring.detach(), ringPaint);
  canvas.restore();

  // 4. How far it has loaded: an arc inside the spinner, going round clockwise from the top.
  if (progress > 0.005) {
    const arc = Skia.PathBuilder.Make();
    const pr = r * 0.58;
    arc.addArc(Skia.XYWHRect(cx - pr, cy - pr, pr * 2, pr * 2), -90, 360 * Math.min(progress, 0.9999));
    canvas.drawPath(arc.detach(), strokePaint(loaded ? '#7DFFB0' : '#FF4FD8', 1, r * 0.07));
  }

  // 5. Little "data" squares drifting round the outside (their sizes change six times a second).
  const tick = Math.floor(now * 6);
  const turn = (now * SPIN * 0.6) % (Math.PI * 2);
  const pink = Skia.PathBuilder.Make();
  const lilac = Skia.PathBuilder.Make();
  for (let i = 0; i < 8; i++) {
    const a = turn + (i * Math.PI) / 4;
    const rad = r * (1.35 + 0.25 * Math.sin(now * 2 + i));
    const side = r * (0.07 + 0.06 * hash01(seed, tick, i));
    const x = cx + Math.cos(a) * rad;
    const y = cy + Math.sin(a) * rad;
    (hash01(seed, tick, i + 8) < 0.5 ? pink : lilac).addRect(Skia.XYWHRect(x - side / 2, y - side / 2, side, side));
  }
  canvas.drawPath(pink.detach(), fillPaint('#C45AFF', 0.75));
  canvas.drawPath(lilac.detach(), fillPaint('#E6AAFF', 0.9));

  // 6. In the middle: the number (like "37%") while loading, a green tick when loaded – each with a soft
  //    dark copy just behind it so it stands out.
  if (!loaded) {
    const text = `${Math.round(progress * 100)}%`;
    const h = r * 0.4;
    const shade = Skia.PathBuilder.Make();
    addDigits(shade, text, cx + r * 0.03, cy + r * 0.05, h);
    canvas.drawPath(shade.detach(), fillPaint('#000000', 0.5));
    const digits = Skia.PathBuilder.Make();
    addDigits(digits, text, cx, cy + r * 0.02, h);
    canvas.drawPath(digits.detach(), fillPaint('#FFFFFF', 1));
  } else {
    const tickMark = Skia.PathBuilder.Make();
    tickMark.moveTo(cx - r * 0.315, cy);
    tickMark.lineTo(cx - r * 0.09, cy + r * 0.225);
    tickMark.lineTo(cx + r * 0.342, cy - r * 0.27);
    const path = tickMark.detach();
    canvas.save();
    canvas.translate(r * 0.03, r * 0.03);
    canvas.drawPath(path, strokePaint('#000000', 0.5, r * 0.11));
    canvas.restore();
    canvas.drawPath(path, strokePaint('#7DFFB0', 1, r * 0.11));
  }

  // 7. Under it: three loading dots in a dark pill. One dot is lit at a time while loading; all of them when
  //    loaded.
  const dotsY = cy + r * 1.35;
  const pill = Skia.PathBuilder.Make();
  addPill(pill, cx, dotsY, r * 0.95, r * 0.36);
  canvas.drawPath(pill.detach(), fillPaint('#000000', 0.5));
  const color = loaded ? '#7DFFB0' : still ? '#E8D6FF' : '#FFD9B3';
  const lit = Math.floor(now / DOT_STEP) % 3;
  const dim = Skia.PathBuilder.Make();
  const bright = Skia.PathBuilder.Make();
  let dimCount = 0;
  for (let i = 0; i < 3; i++) {
    const on = loaded || i === lit;
    (on ? bright : dim).addCircle(cx + (i - 1) * r * 0.25, dotsY, r * 0.07);
    if (!on) dimCount++;
  }
  if (dimCount > 0) canvas.drawPath(dim.detach(), fillPaint(color, 0.35));
  canvas.drawPath(bright.detach(), fillPaint(color, 1));
}

// `area` is the whole picture (the camera view live, the whole photo when saving), for the green flash.
export function paintBrainBuffering(canvas: SkCanvas, faces: LensFace[], now: number, area: SkRect) {
  'worklet';
  let flash = 0;
  for (const face of faces) {
    if (!faceOk(face)) continue;
    drawBrain(canvas, face, now);
    flash = Math.max(flash, clamp01(num(face.flash)));
  }
  // The green flash just after a brain loads: once for the whole picture, however many faces.
  if (flash > 0.01) canvas.drawRect(area, fillPaint('#9DFFC8', 0.35 * flash));
}
