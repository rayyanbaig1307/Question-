import { ClipOp, Skia, TileMode, type SkCanvas, type SkRect, type SkRuntimeEffect } from '@shopify/react-native-skia';

import { MESH } from '@/lib/faceMesh';
import type { WarpLook } from '@/lib/lensLooks';

import { addPill, clamp01, faceOk, hash01, num, rgba, softEdge } from '../filters/kit';
import type { LensFace } from '../lensPaint';
import { addPixelText, pixelTextWidth } from './pixelText';
import { MAX_SLICES } from './shaders';
import type { Disposable, WarpSource } from './warpEffects';

// ---------------------------------------------------------------------------
// The 4 stretchy Peekaboo+ filters (from the web version, branch claude/wonderful-planck-oe81zm). Unlike the
// other filters, these change the camera picture itself: they draw the camera's own pixels moved around
// (with the GPU programs in shaders.ts), on top of the camera picture.
//
// 😃 Big Mouth: your mouth blown up like a balloon (about 1.9× with a still face, 2× with it open wide). It
//    bounces when it changes size.
// 🫥 Tiny Face: your face shrunk into the middle of a smooth, blurred "egg" head. Talking makes it even
//    tinier, and it bobs as you talk.
// 🗿 Gigachin: everything under your lower lip stretched down and a bit wider. Pout to charge the chin up to
//    full power (a "CHIN POWER 87%" meter above your head; "GIGACHIN" at 100 %).
// 👾 Pixel Panic: your face in big pixels, torn slices shoved sideways with magenta and cyan ghosts, data
//    bars, a flashing ERROR tag and now and then a glitch line across the whole picture. Raise your brows to
//    glitch it up.
//
// `src` is the camera picture (or the saved photo) as a shader in screen points, plus the GPU programs. With
// no picture (none came from the camera lately) nothing is drawn at all, and the normal camera view shows.
// The memory (the mouth's bounce, the talking, the chin's power, the glitch) is worked out in warp/warpTrack.ts
// and kept on each face, so the saved photo matches the screen.
//
// The same rules as the other filters (docs/FACE_MESH.md): every function is a 'worklet' and sits above the
// ones that use it, no parameter defaults, no Math.random, no fonts (words are made of squares, pixelText.ts),
// no blend modes, and only `import type` from '../lensPaint'.
// ---------------------------------------------------------------------------

// MediaPipe face-mesh points used here that have no name in MESH: the bottom edge of the lower lip.
const LOWER_LIP_BOTTOM = 17;

// 🫥 Tiny Face sizes (as in the web version): the blurred egg is the face outline made a little bigger, the
// tiny face is taken from a tighter crop (no hair or ears).
const EGG_GROW = 1.04;
const TINY_FEATHER = 0.5;
// 🗿 Gigachin's meter and highlight colours.
const CHIN_GOLD = '#FFE36B';
// 👾 Pixel Panic: how soft the pixel oval's edge is, and how thick the glitch line across the picture is.
const PIXEL_FEATHER = 0.3;
const GLITCH_LINE = 2.4;

// A number that is safe to use as a size or a place on the screen.
function okNumber(x: number) {
  'worklet';
  return typeof x === 'number' && Number.isFinite(x) && Math.abs(x) < 1e7;
}

// The head's own directions, so the warps turn with the head: `down` goes from the top of the forehead to the
// chin, `axis` goes across the face. W is the face's width, H its height. null if the points are broken.
function headFrame(pts: number[]) {
  'worklet';
  const dx = pts[MESH.chin * 2] - pts[MESH.forehead * 2];
  const dy = pts[MESH.chin * 2 + 1] - pts[MESH.forehead * 2 + 1];
  const H = Math.hypot(dx, dy);
  const W = Math.hypot(pts[MESH.leftFaceSide * 2] - pts[MESH.rightFaceSide * 2], pts[MESH.leftFaceSide * 2 + 1] - pts[MESH.rightFaceSide * 2 + 1]);
  if (!okNumber(H) || !okNumber(W) || H < 2 || W < 4) return null;
  const downX = dx / H;
  const downY = dy / H;
  return { downX, downY, axisX: -downY, axisY: downX, W, H };
}

type Head = { downX: number; downY: number; axisX: number; axisY: number; W: number; H: number };

// How far a group of face points spreads along the head's directions: its middle on the screen (cx, cy), its
// width across the face and its height down the face.
function extents(pts: number[], loop: readonly number[], head: Head) {
  'worklet';
  const ox = pts[MESH.noseTip * 2];
  const oy = pts[MESH.noseTip * 2 + 1];
  let u0 = 1e9;
  let u1 = -1e9;
  let v0 = 1e9;
  let v1 = -1e9;
  for (let k = 0; k < loop.length; k++) {
    const dx = pts[loop[k] * 2] - ox;
    const dy = pts[loop[k] * 2 + 1] - oy;
    const u = dx * head.axisX + dy * head.axisY;
    const v = dx * head.downX + dy * head.downY;
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
    v0 = Math.min(v0, v);
    v1 = Math.max(v1, v);
  }
  const cu = (u0 + u1) / 2;
  const cv = (v0 + v1) / 2;
  return { cx: ox + head.axisX * cu + head.downX * cv, cy: oy + head.axisY * cu + head.downY * cv, w: u1 - u0, h: v1 - v0 };
}

// The face outline's box on the screen (not turned with the head), made `grow` bigger on each side:
// [x, y, width, height]. null if the points are broken.
function screenBox(pts: number[], grow: number) {
  'worklet';
  let x0 = 1e9;
  let x1 = -1e9;
  let y0 = 1e9;
  let y1 = -1e9;
  const loop = MESH.faceOval;
  for (let k = 0; k < loop.length; k++) {
    x0 = Math.min(x0, pts[loop[k] * 2]);
    x1 = Math.max(x1, pts[loop[k] * 2]);
    y0 = Math.min(y0, pts[loop[k] * 2 + 1]);
    y1 = Math.max(y1, pts[loop[k] * 2 + 1]);
  }
  const w = x1 - x0;
  const h = y1 - y0;
  if (!okNumber(x0) || !okNumber(y0) || !okNumber(w) || !okNumber(h) || w < 2 || h < 2) return null;
  return [x0 - w * grow, y0 - h * grow, w * (1 + 2 * grow), h * (1 + 2 * grow)];
}

// Puts a Skia object made from the camera picture on this picture's trash list (see WarpSource in
// warpEffects.ts: it is let go of right after the picture is drawn) and gives it back. Always call this as soon
// as the object is made, before drawing with it, so it is let go of even if the drawing fails.
function binned<T extends Disposable>(src: WarpSource, thing: T): T {
  'worklet';
  src.trash.push(thing);
  return thing;
}

// One warp: the GPU program with its numbers, looking at the camera picture, drawn over the box from
// (x0, y0) to (x1, y1). Skipped if any number is broken, so a bad frame never draws garbage.
function warpPass(canvas: SkCanvas, effect: SkRuntimeEffect, uniforms: number[], src: WarpSource, x0: number, y0: number, x1: number, y1: number) {
  'worklet';
  for (let i = 0; i < uniforms.length; i++) if (!okNumber(uniforms[i])) return;
  if (!okNumber(x0) || !okNumber(y0) || !okNumber(x1) || !okNumber(y1) || !(x1 > x0) || !(y1 > y0)) return;
  const shader = binned(src, effect.makeShaderWithChildren(uniforms, [src.image]));
  const paint = binned(src, Skia.Paint());
  paint.setShader(shader);
  canvas.drawRect(Skia.XYWHRect(x0, y0, x1 - x0, y1 - y0), paint);
}

// ---------------------------------------------------------------------------
// 😃 Big Mouth
// ---------------------------------------------------------------------------

function bigMouthPass(canvas: SkCanvas, face: LensFace, head: Head, src: WarpSource) {
  'worklet';
  const pts = face.pts;
  // How big the mouth is blown up: the bouncy spring from warpTrack.ts, never smaller than normal.
  const s = Math.max(1, Math.min(3, num(face.mouth)));
  const lips = extents(pts, MESH.lips, head);
  const mouthW = Math.hypot(
    pts[MESH.mouthRightCorner * 2] - pts[MESH.mouthLeftCorner * 2],
    pts[MESH.mouthRightCorner * 2 + 1] - pts[MESH.mouthLeftCorner * 2 + 1],
  );
  // A wide oval round the lips, so the soft edge looks natural.
  const w = Math.max(1.9 * lips.w, 1.9 * mouthW);
  const h = Math.max(1.9 * lips.h, 1.1 * mouthW);
  // The balloon's middle sits a little above the lips, so the mouth grows down more than up.
  const lift = 0.15 * h * (s - 1);
  const cx = lips.cx - head.downX * lift;
  const cy = lips.cy - head.downY * lift;
  const rx = 0.5 * w * s;
  const ry = 0.5 * h * s;
  const reach = Math.max(rx, ry);
  warpPass(canvas, src.fx.balloon, [cx, cy, head.axisX, head.axisY, rx, ry, s], src, cx - reach, cy - reach, cx + reach, cy + reach);
}

// ---------------------------------------------------------------------------
// 🫥 Tiny Face
// ---------------------------------------------------------------------------

function tinyFacePass(canvas: SkCanvas, face: LensFace, head: Head, src: WarpSource, now: number) {
  'worklet';
  const pts = face.pts;
  const oval = extents(pts, MESH.faceOval, head);
  // The face with a little room round it, and a tighter crop for the tiny face (no hair or ears).
  const fw = oval.w * 1.1;
  const fh = oval.h * 1.1;
  const iw = oval.w * 0.9;
  const ih = oval.h * 0.9;
  if (!okNumber(fw) || !okNumber(fh) || fw < 4 || fh < 4 || !okNumber(oval.cx) || !okNumber(oval.cy)) return;
  const tiny = clamp01(num(face.tiny));
  // About a third of the size with a still face, smaller while you talk, bobbing with your jaw.
  const s = 0.42 - 0.14 * tiny + 0.015 * tiny * Math.sin(now * 14);
  const sigma = Math.max(7, fw * 0.12);

  // 1. The "egg": the face outline (a little bigger) filled with a blurred copy of the face, so the eyes,
  //    nose and mouth melt away into smooth skin.
  const egg = Skia.PathBuilder.Make();
  let x0 = 1e9;
  let x1 = -1e9;
  let y0 = 1e9;
  let y1 = -1e9;
  const loop = MESH.faceOval;
  for (let k = 0; k < loop.length; k++) {
    const x = oval.cx + (pts[loop[k] * 2] - oval.cx) * EGG_GROW;
    const y = oval.cy + (pts[loop[k] * 2 + 1] - oval.cy) * EGG_GROW;
    if (k === 0) egg.moveTo(x, y);
    else egg.lineTo(x, y);
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  egg.close();
  if (!okNumber(x0) || !okNumber(y0) || !okNumber(x1 - x0) || !okNumber(y1 - y0)) return;
  canvas.save();
  canvas.clipPath(egg.detach(), ClipOp.Intersect, true);
  const blurred = binned(src, Skia.Paint());
  blurred.setShader(src.image);
  blurred.setImageFilter(binned(src, Skia.ImageFilter.MakeBlur(sigma, sigma, TileMode.Clamp, null)));
  canvas.drawRect(Skia.XYWHRect(x0 - 3 * sigma, y0 - 3 * sigma, x1 - x0 + 6 * sigma, y1 - y0 + 6 * sigma), blurred);
  // 2. Soft shading, so the egg still looks like a round head: lighter near the top, darker at the edge.
  const shade = Skia.Paint();
  shade.setAntiAlias(true);
  shade.setShader(
    Skia.Shader.MakeTwoPointConicalGradient(
      { x: oval.cx - head.downX * fh * 0.1, y: oval.cy - head.downY * fh * 0.1 },
      fw * 0.2,
      { x: oval.cx, y: oval.cy },
      fw * 0.75,
      [rgba('255,255,255', 0.1), rgba('0,0,0', 0.18)],
      [0, 1],
      TileMode.Clamp,
    ),
  );
  canvas.drawRect(Skia.XYWHRect(x0 - 4, y0 - 4, x1 - x0 + 8, y1 - y0 + 8), shade);
  canvas.restore();

  // 3. The tiny face, put back a touch below the middle with a soft edge.
  const tx = oval.cx + head.downX * fh * 0.04;
  const ty = oval.cy + head.downY * fh * 0.04;
  const rx = 0.5 * iw * s;
  const ry = 0.5 * ih * s;
  const reach = Math.max(rx, ry);
  warpPass(
    canvas, src.fx.shrink, [oval.cx, oval.cy, tx, ty, head.axisX, head.axisY, rx, ry, s, TINY_FEATHER], src,
    tx - reach, ty - reach, tx + reach, ty + reach,
  );
}

// ---------------------------------------------------------------------------
// 🗿 Gigachin
// ---------------------------------------------------------------------------

// The chin's shape for this face: where the stretch starts (just under the lower lip), how tall the part
// that is stretched is, and how much it is stretched down (sy) and across (sx). null if the points are broken.
function chinShape(face: LensFace, head: Head) {
  'worklet';
  const pts = face.pts;
  const lipX = pts[LOWER_LIP_BOTTOM * 2];
  const lipY = pts[LOWER_LIP_BOTTOM * 2 + 1];
  const gap = (pts[MESH.chin * 2] - lipX) * head.downX + (pts[MESH.chin * 2 + 1] - lipY) * head.downY;
  if (!okNumber(gap) || !okNumber(lipX) || !okNumber(lipY) || gap < 1) return null;
  // Always a big chin (the web version's always-on), even bigger with power.
  const power = Math.max(clamp01(num(face.chin)), 0.35);
  const sy = 1.15 + 0.6 * power;
  const sx = 1 + 0.15 * power;
  const height = 1.15 * gap;
  return { lipX, lipY, topX: lipX + head.downX * gap * 0.08, topY: lipY + head.downY * gap * 0.08, height, sx, sy, release: 0.35 * height * sy };
}

function gigachinPass(canvas: SkCanvas, face: LensFace, head: Head, src: WarpSource) {
  'worklet';
  const chin = chinShape(face, head);
  if (!chin) return;
  const halfWidth = 0.5 * head.W;
  // Only the part that changes is drawn: half a face width to each side, from under the lip to where the
  // stretch has eased back to normal.
  const reach = chin.height * chin.sy + chin.release;
  const ax = head.axisX * halfWidth;
  const ay = head.axisY * halfWidth;
  const bx = chin.topX + head.downX * reach;
  const by = chin.topY + head.downY * reach;
  const x0 = Math.min(chin.topX - ax, chin.topX + ax, bx - ax, bx + ax) - 1;
  const x1 = Math.max(chin.topX - ax, chin.topX + ax, bx - ax, bx + ax) + 1;
  const y0 = Math.min(chin.topY - ay, chin.topY + ay, by - ay, by + ay) - 1;
  const y1 = Math.max(chin.topY - ay, chin.topY + ay, by - ay, by + ay) + 1;
  warpPass(
    canvas, src.fx.stretch,
    [chin.topX, chin.topY, head.axisX, head.axisY, head.downX, head.downY, halfWidth, chin.height, chin.sx, chin.sy, chin.release],
    src, x0, y0, x1, y1,
  );
}

// A soft highlight along the new chin (stronger with more power), and the power meter above the head.
function gigachinOverlay(canvas: SkCanvas, face: LensFace, head: Head, now: number) {
  'worklet';
  const chin = chinShape(face, head);
  if (!chin) return;
  const power = clamp01(num(face.chin));
  const W = head.W;
  // 1. The highlight: an oval on the new chin, lit from above.
  if (power > 0.01) {
    const endX = chin.topX + head.downX * chin.height * chin.sy;
    const endY = chin.topY + head.downY * chin.height * chin.sy;
    const cx = endX - head.downX * W * 0.096;
    const cy = endY - head.downY * W * 0.096;
    const oval = Skia.PathBuilder.Make();
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const x = cx + head.axisX * Math.cos(a) * W * 0.2 + head.downX * Math.sin(a) * W * 0.096;
      const y = cy + head.axisY * Math.cos(a) * W * 0.2 + head.downY * Math.sin(a) * W * 0.096;
      if (k === 0) oval.moveTo(x, y);
      else oval.lineTo(x, y);
    }
    oval.close();
    const light = Skia.Paint();
    light.setAntiAlias(true);
    light.setShader(
      Skia.Shader.MakeLinearGradient(
        { x: chin.lipX, y: chin.lipY },
        { x: endX, y: endY },
        [rgba('255,255,255', 0), rgba('255,255,255', 0.6), rgba('0,0,0', 0.4)],
        [0, 0.8, 1],
        TileMode.Clamp,
      ),
    );
    light.setAlphaf(clamp01(0.25 * power));
    canvas.drawPath(oval.detach(), light);
  }
  // 2. The meter, above the head: "CHIN POWER 87%", then "GIGACHIN" in gold at full power (with a wiggle).
  if (power <= 0.02) return;
  const pct = Math.round(power * 100);
  const full = pct >= 100;
  const text = full ? 'GIGACHIN' : `CHIN POWER ${pct}%`;
  const x = face.pts[MESH.forehead * 2] - head.downX * head.H * 0.12;
  const y = face.pts[MESH.forehead * 2 + 1] - head.downY * head.H * 0.12;
  if (!okNumber(x) || !okNumber(y)) return;
  const cap = Math.max(6, W * 0.09);
  const cell = cap / 7;
  const pillW = pixelTextWidth(text, cell) + cap * 1.4;
  const pillH = cap * 1.9;
  const wiggle = full ? 0.03 * Math.sin(now * 30) : 0;
  canvas.save();
  canvas.translate(x, y);
  canvas.rotate((wiggle * 180) / Math.PI, 0, 0);
  const pill = Skia.PathBuilder.Make();
  addPill(pill, 0, 0, pillW, pillH);
  const pillPath = pill.detach();
  // A pink glow behind the pill, then the purple pill, then the words.
  const glow = Skia.Paint();
  glow.setAntiAlias(true);
  glow.setColor(rgba('225,29,255', 0.8));
  canvas.drawPath(pillPath, softEdge(glow, cap * 0.6));
  const back = Skia.Paint();
  back.setAntiAlias(true);
  back.setColor(rgba('138,43,226', 0.75));
  canvas.drawPath(pillPath, back);
  const words = Skia.PathBuilder.Make();
  addPixelText(words, text, 0, 0, cell);
  const ink = Skia.Paint();
  ink.setAntiAlias(true);
  ink.setColor(Skia.Color(full ? CHIN_GOLD : '#FFFFFF'));
  canvas.drawPath(words.detach(), ink);
  canvas.restore();
}

// ---------------------------------------------------------------------------
// 👾 Pixel Panic
// ---------------------------------------------------------------------------

// How glitched a face is right now (0–1): its smoothed brows, or the glitch it has built up.
function glitchLevel(face: LensFace) {
  'worklet';
  return Math.max(clamp01(num(face.warpLevel)), clamp01(num(face.glitch)));
}

function pixelPanicPass(canvas: SkCanvas, face: LensFace, src: WarpSource, now: number) {
  'worklet';
  const box = screenBox(face.pts, 0.12);
  if (!box) return;
  const lv = glitchLevel(face);
  // The pixel size: tiny with no glitch, about a tenth of the face at full glitch.
  const block = lv > 0.03 ? 1.2 + lv * Math.max(4, box[2] * 0.09) : 0;
  // The torn slices change 12 times a second; the same moment always gives the same slices.
  const tick = Math.floor(now * 12);
  const seed = num(face.seed);
  const count = Math.min(MAX_SLICES, Math.max(0, Math.round(lv * 7)));
  const uniforms = [box[0], box[1], box[2], box[3], block, PIXEL_FEATHER, lv, count];
  for (let k = 0; k < MAX_SLICES; k++) {
    if (k < count) {
      uniforms.push(
        box[1] + hash01(tick, seed, k * 4) * box[3],
        box[3] * (0.03 + 0.08 * hash01(tick, seed, k * 4 + 1)),
        (hash01(tick, seed, k * 4 + 2) - 0.5) * 0.35 * box[2] * lv,
        hash01(tick, seed, k * 4 + 3) < 0.5 ? 0 : 1,
      );
    } else {
      uniforms.push(0, 0, 0, 0);
    }
  }
  // The slices and their ghosts can be shoved up to a quarter of the box sideways, and reach a little below it.
  warpPass(canvas, src.fx.pixel, uniforms, src, box[0] - box[2] * 0.25 - 1, box[1] - 1, box[0] + box[2] * 1.25 + 1, box[1] + box[3] * 1.12 + 1);
}

// Magenta and cyan data bars floating round the head, and a flickering ERROR tag by the forehead.
function pixelPanicOverlay(canvas: SkCanvas, face: LensFace, head: Head, now: number) {
  'worklet';
  const lv = glitchLevel(face);
  if (lv < 0.05) return;
  const box = screenBox(face.pts, 0.12);
  if (!box) return;
  const tick = Math.floor(now * 12);
  const seed = num(face.seed);
  // 1. The data bars (each colour in one shape, so they are drawn in two goes).
  const pink = Skia.PathBuilder.Make();
  const cyan = Skia.PathBuilder.Make();
  const bars = Math.round(4 + lv * 10);
  for (let i = 0; i < bars; i++) {
    const salt = 100 + i * 8;
    if (hash01(tick, seed, salt) > 0.75) continue;
    const bw = box[2] * (0.08 + 0.45 * hash01(tick, seed, salt + 1));
    const bh = Math.max(1.2, box[3] * (0.012 + 0.02 * hash01(tick, seed, salt + 2)));
    const bx = box[0] - box[2] * 0.4 + hash01(tick, seed, salt + 3) * box[2] * 1.8;
    const by = box[1] - box[3] * 0.2 + hash01(tick, seed, salt + 4) * box[3] * 1.3;
    (hash01(tick, seed, salt + 5) < 0.8 ? pink : cyan).addRect(Skia.XYWHRect(bx, by, bw, bh));
  }
  const pinkPaint = Skia.Paint();
  pinkPaint.setColor(rgba('225,29,255', 0.8));
  canvas.drawPath(pink.detach(), pinkPaint);
  const cyanPaint = Skia.Paint();
  cyanPaint.setColor(rgba('0,229,255', 0.7));
  canvas.drawPath(cyan.detach(), cyanPaint);

  // 2. The ERROR tag: white with dark letters, beside the top of the forehead, flickering off now and then.
  if (lv <= 0.35 || Math.floor(now * 5) % 7 === 3) return;
  const pts = face.pts;
  const sideX = pts[MESH.leftFaceSide * 2] - pts[MESH.rightFaceSide * 2];
  const sideY = pts[MESH.leftFaceSide * 2 + 1] - pts[MESH.rightFaceSide * 2 + 1];
  const side = Math.hypot(sideX, sideY);
  if (!(side > 1)) return;
  const x = pts[MESH.forehead * 2] + (sideX / side) * head.W * 0.42;
  const y = pts[MESH.forehead * 2 + 1] + (sideY / side) * head.W * 0.42;
  if (!okNumber(x) || !okNumber(y)) return;
  const cap = Math.max(5, head.W * 0.075);
  const cell = cap / 7;
  const tagW = pixelTextWidth('ERROR', cell) + cap * 0.8;
  const tagH = cap * 1.6;
  const tilt = -0.12 + (hash01(tick, seed, 99) - 0.5) * 0.04;
  canvas.save();
  canvas.translate(x, y);
  canvas.rotate((tilt * 180) / Math.PI, 0, 0);
  const tag = Skia.Paint();
  tag.setAntiAlias(true);
  tag.setColor(Skia.Color('#FFFFFF'));
  canvas.drawRect(Skia.XYWHRect(-tagW / 2, -tagH / 2, tagW, tagH), tag);
  const words = Skia.PathBuilder.Make();
  addPixelText(words, 'ERROR', 0, 0, cell);
  const ink = Skia.Paint();
  ink.setColor(Skia.Color('#111111'));
  canvas.drawPath(words.detach(), ink);
  canvas.restore();
}

// Now and then a thin line across the whole picture is shoved sideways (`area` is the whole picture: the
// view live, the whole photo when saving). `lv` is the strongest glitch of all the faces.
function glitchLine(canvas: SkCanvas, src: WarpSource, area: SkRect, lv: number, now: number) {
  'worklet';
  const tick = Math.floor(now * 12);
  if (!(lv >= 0.05) || hash01(tick, 7777, 0) >= 0.2 * lv) return;
  const y = area.y + hash01(tick, 7777, 1) * area.height;
  const shift = (hash01(tick, 7777, 2) - 0.5) * 16 * lv;
  if (!okNumber(y) || !okNumber(shift) || !okNumber(area.x) || !okNumber(area.width)) return;
  const paint = binned(src, Skia.Paint());
  paint.setShader(src.image);
  canvas.save();
  canvas.translate(shift, 0);
  canvas.drawRect(Skia.XYWHRect(area.x - shift, y, area.width, GLITCH_LINE), paint);
  canvas.restore();
}

// ---------------------------------------------------------------------------
// Draws one of the 4 stretchy looks for these faces: first every face's warp, then the meters, tags and bars
// on top, then (👾) the glitch line. `now` is in seconds, `area` the whole picture. With no `src` (no camera
// picture lately) nothing is drawn. Every Skia object made from the camera picture goes on `src.trash`.
// ---------------------------------------------------------------------------
export function paintWarpLook(canvas: SkCanvas, look: WarpLook, faces: LensFace[], now: number, area: SkRect, src: WarpSource | null | undefined) {
  'worklet';
  if (!src || !src.image || !src.fx || !Array.isArray(src.trash)) return;
  const t = okNumber(now) ? now : 0;
  // 1. The warps. Each face's warp looks at the plain camera picture (so one face is never stretched twice),
  //    and is see-through wherever it changes nothing (shaders.ts), so a second face close by never paints the
  //    plain picture back over the first face's warp. Only where the two warps really overlap, the second wins.
  let strongest = 0;
  for (const face of faces) {
    if (!faceOk(face)) continue;
    const head = headFrame(face.pts);
    if (!head) continue;
    if (look === 'bigMouth') bigMouthPass(canvas, face, head, src);
    else if (look === 'tinyFace') tinyFacePass(canvas, face, head, src, t);
    else if (look === 'gigachin') gigachinPass(canvas, face, head, src);
    else if (look === 'pixelPanic') {
      pixelPanicPass(canvas, face, src, t);
      strongest = Math.max(strongest, glitchLevel(face));
    }
  }
  // 2. What goes on top.
  for (const face of faces) {
    if (!faceOk(face)) continue;
    const head = headFrame(face.pts);
    if (!head) continue;
    if (look === 'gigachin') gigachinOverlay(canvas, face, head, t);
    else if (look === 'pixelPanic') pixelPanicOverlay(canvas, face, head, t);
  }
  // 3. 👾 Last, the glitch line across the whole picture.
  if (look === 'pixelPanic') glitchLine(canvas, src, area, strongest, t);
}
