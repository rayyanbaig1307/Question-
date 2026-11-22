import {
  BlurStyle,
  ClipOp,
  FillType,
  FilterMode,
  MipmapMode,
  Skia,
  TileMode,
  type SkCanvas,
  type SkImage,
  type SkPath,
  type SkPathBuilder,
  type SkRuntimeEffect,
  type SkShader,
} from '@shopify/react-native-skia';

import { MESH } from '@/lib/faceMesh';
import { LIVE_COMIC_GENTLE, POSTER_H, POSTER_W, SKIN } from '@/lib/mainCharacter/config';

import type { LensFace } from '../lens/lensPaint';
import { toMatrix9 } from '../lens/warp/frameMatrix';
import type { Disposable } from '../lens/warp/warpEffects';
import { COMIC, comicUniforms } from './comicShader';
import { characterRect, fitMatrix, mapPoints, mul, scaleAround, type FaceFit, type PosterArt } from './fit';

// ---------------------------------------------------------------------------
// Main Character Mode 🌆: the one drawing of the poster (docs/MAIN_CHARACTER.md). The live screen
// (MainCharacterOverlay.tsx), the saved poster from the screen (snapPoster.ts) and the saved poster from the
// photo (bakeMainCharacter.ts) all use this, so they look the same.
//
// It draws in poster pixels (0…1080 × 0…1920); whoever calls it sets the canvas up for that. Back to front:
// the scene, then your face, then the character (with the see-through face hole) on top. Three ways:
// - full (a camera picture or the photo, and a fit): your face is taken from the picture, moved into the hole
//   (fit.ts) and drawn with the comic look (comicShader.ts) on a skin-coloured plate.
// - lite (live, no camera pictures on this download): the real camera view underneath has been moved so your
//   face is in the hole (CameraFollow.tsx); the scene leaves the hole open, a skin-coloured ring covers the gap
//   round your face and a warm tint goes on your skin.
// - no face: the hole is filled with the character's skin colour.
//
// The same rules as the face filters (docs/FACE_MESH.md): every function is a 'worklet' and sits above the ones
// that use it, no parameter defaults, no Math.random or Date.now, no text, no blend modes, and only
// `import type` from '../lens/lensPaint'. Every Skia object made here goes on `trash` the moment it is made, and
// the caller lets go of all of them right after the drawing (also when the drawing fails halfway).
// In Skia 2.14 a finished path can't be changed: even-odd is set on the PathBuilder before detach(), and
// shapes are grown or shrunk on the point lists (scaleAround), never on a path.
// tests/unit/main-character-paint.test.mjs checks what is drawn in each case.
// ---------------------------------------------------------------------------

// One character with its scene, ready to draw (MainCharacterCamera.tsx makes it; the pictures are already
// decoded). `key` changes when the character or the scene changes.
export type LiveScene = {
  key: string;                                   // character key + scene key (changes → redraw)
  character: SkImage; characterCrop: { x: number; y: number; w: number; h: number };
  background: SkImage | null; backgroundCrop: { x: number; y: number; w: number; h: number };
  art: PosterArt;
};

// Where your face comes from: the camera picture (or the photo) and how its pixels map to view points.
export type FaceSource = { image: SkImage; toView: number[]; mipmaps: boolean };   // picture px → view points

// The skin path (the same as Soft Glow's): the face outline a little smaller, with the eyes, brows and lips cut
// out a little bigger, so the tint and the skin colour pull never touch them.
const SKIN_FACE = 0.98;
const SKIN_EYE = 1.3;
const SKIN_BROW = 1.2;
const SKIN_LIPS = 1.1;
// The lite warm tint: the skin colour mixed with this much sunset orange, and how soft its edge is.
const SUNSET: number[] = [255, 170, 90];
const SUNSET_MIX = 0.3;
const TINT_BLUR = 6;
// Drawn where the scene picture is missing (a dark evening sky), so the poster is never see-through.
const NO_SCENE: number[] = [27, 16, 48];
// Used if a character's skin colour is ever broken.
const PLAIN_SKIN: number[] = [214, 160, 126];

// Puts a Skia object on this drawing's trash list and gives it back. Always call this as soon as the object is
// made, before drawing with it, so it is let go of even if the drawing fails.
function bin<T extends Disposable>(trash: Disposable[], thing: T): T {
  'worklet';
  trash.push(thing);
  return thing;
}

// Is every number in the list a real number (and not absurdly big)?
function finiteList(list: number[]) {
  'worklet';
  if (!list) return false;
  for (let i = 0; i < list.length; i++) if (!Number.isFinite(list[i]) || Math.abs(list[i]) > 1e7) return false;
  return true;
}

// One loop of face points [x0, y0, x1, y1, …], picked out of all 478.
function loopPoints(pts: number[], loop: readonly number[]): number[] {
  'worklet';
  const out: number[] = [];
  for (let i = 0; i < loop.length; i++) out.push(pts[loop[i] * 2], pts[loop[i] * 2 + 1]);
  return out;
}

// A smooth closed shape through the points: curves through the midpoints, using each point as the bend.
function addLoop(builder: SkPathBuilder, flat: number[]) {
  'worklet';
  const n = Math.floor(flat.length / 2);
  if (n < 3) return;
  builder.moveTo((flat[(n - 1) * 2] + flat[0]) / 2, (flat[(n - 1) * 2 + 1] + flat[1]) / 2);
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    builder.quadTo(flat[i * 2], flat[i * 2 + 1], (flat[i * 2] + flat[next * 2]) / 2, (flat[i * 2 + 1] + flat[next * 2 + 1]) / 2);
  }
  builder.close();
}

// One path from several loops. `evenOdd`: a loop inside another one is cut out of it (a ring, a face with holes).
function pathOf(trash: Disposable[], loops: number[][], evenOdd: boolean): SkPath {
  'worklet';
  const builder = bin(trash, Skia.PathBuilder.Make());
  if (evenOdd) builder.setFillType(FillType.EvenOdd);
  for (let i = 0; i < loops.length; i++) addLoop(builder, loops[i]);
  return bin(trash, builder.detach());
}

// The character's skin colour, 0–255 whole numbers (a plain skin colour if it is broken).
function skinRgb(tone: number[]): number[] {
  'worklet';
  if (!tone || tone.length < 3 || !finiteList([tone[0], tone[1], tone[2]])) return PLAIN_SKIN;
  return [0, 1, 2].map((i) => Math.round(Math.max(0, Math.min(1, tone[i])) * 255));
}

// A plain fill paint: colour [r, g, b] (0–255), how see-through (0–1) and a soft edge (blur, 0 = none).
function fillPaint(trash: Disposable[], rgb: number[], alpha: number, blur: number) {
  'worklet';
  const paint = bin(trash, Skia.Paint());
  paint.setAntiAlias(true);
  paint.setColor(Skia.Color(`rgba(${Math.round(rgb[0])},${Math.round(rgb[1])},${Math.round(rgb[2])},1)`));
  paint.setAlphaf(Math.max(0, Math.min(1, alpha)));
  if (blur > 0) paint.setMaskFilter(bin(trash, Skia.MaskFilter.MakeBlur(BlurStyle.Normal, blur, true)));
  return paint;
}

// Is a crop box usable?
function cropOk(crop: { x: number; y: number; w: number; h: number } | null) {
  'worklet';
  return !!crop && finiteList([crop.x, crop.y, crop.w, crop.h]) && crop.w > 0 && crop.h > 0;
}

// The scene behind everything, filling the whole poster (a dark evening sky when there is no scene picture).
function drawScene(canvas: SkCanvas, scene: LiveScene, trash: Disposable[]) {
  'worklet';
  const whole = Skia.XYWHRect(0, 0, POSTER_W, POSTER_H);
  if (scene.background && cropOk(scene.backgroundCrop)) {
    const paint = bin(trash, Skia.Paint());
    paint.setAntiAlias(true);
    const crop = scene.backgroundCrop;
    canvas.drawImageRectOptions(scene.background, Skia.XYWHRect(crop.x, crop.y, crop.w, crop.h), whole, FilterMode.Linear, MipmapMode.Linear, paint);
  } else {
    canvas.drawRect(whole, fillPaint(trash, NO_SCENE, 1, 0));
  }
}

// The character in front, in its box on the poster.
function drawCharacter(canvas: SkCanvas, scene: LiveScene, trash: Disposable[]) {
  'worklet';
  if (!scene.character || !cropOk(scene.characterCrop)) return;
  const box = characterRect();
  const crop = scene.characterCrop;
  const paint = bin(trash, Skia.Paint());
  paint.setAntiAlias(true);
  canvas.drawImageRectOptions(scene.character, Skia.XYWHRect(crop.x, crop.y, crop.w, crop.h), Skia.XYWHRect(box.x, box.y, box.w, box.h),
    FilterMode.Linear, MipmapMode.Linear, paint);
}

// Your face's outline, eyes, brows and lips in poster pixels (through the fit), or null if any point is broken.
function faceShape(pts: number[], m: number[]) {
  'worklet';
  if (!pts || !(pts.length >= 478 * 2) || !finiteList(m)) return null;
  const oval = mapPoints(m, loopPoints(pts, MESH.faceOval));
  const leftEye = mapPoints(m, loopPoints(pts, MESH.leftEye));
  const rightEye = mapPoints(m, loopPoints(pts, MESH.rightEye));
  const leftBrow = mapPoints(m, loopPoints(pts, MESH.leftBrow));
  const rightBrow = mapPoints(m, loopPoints(pts, MESH.rightBrow));
  const lips = mapPoints(m, loopPoints(pts, MESH.lips));
  for (const loop of [oval, leftEye, rightEye, leftBrow, rightBrow, lips]) if (!finiteList(loop)) return null;
  return { oval, leftEye, rightEye, leftBrow, rightBrow, lips };
}

type FaceShape = { oval: number[]; leftEye: number[]; rightEye: number[]; leftBrow: number[]; rightBrow: number[]; lips: number[] };

// The skin path's loops: the face outline a little smaller, minus the eyes, brows and lips a little bigger.
function skinLoops(shape: FaceShape): number[][] {
  'worklet';
  return [
    scaleAround(shape.oval, SKIN_FACE),
    scaleAround(shape.leftEye, SKIN_EYE),
    scaleAround(shape.rightEye, SKIN_EYE),
    scaleAround(shape.leftBrow, SKIN_BROW),
    scaleAround(shape.rightBrow, SKIN_BROW),
    scaleAround(shape.lips, SKIN_LIPS),
  ];
}

// The box round some points: a rectangle to draw in (the clip does the real shape).
function boxAround(flat: number[]) {
  'worklet';
  let x0 = 1e9;
  let y0 = 1e9;
  let x1 = -1e9;
  let y1 = -1e9;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    x0 = Math.min(x0, flat[i]);
    x1 = Math.max(x1, flat[i]);
    y0 = Math.min(y0, flat[i + 1]);
    y1 = Math.max(y1, flat[i + 1]);
  }
  return Skia.XYWHRect(x0 - 2, y0 - 2, x1 - x0 + 4, y1 - y0 + 4);
}

// The lite warm tint's colour: the skin colour with a little sunset orange in it.
function tintRgb(skin: number[]): number[] {
  'worklet';
  return [0, 1, 2].map((i) => skin[i] * (1 - SUNSET_MIX) + SUNSET[i] * SUNSET_MIX);
}

// Draws the whole poster (see the top of this file). `face`/`fit`: the biggest face and how it fits the hole
// (null = no face). `src`: the camera picture or the photo (null = none: the lite way when `live`). `live`:
// drawn on the live screen (the softer comic numbers when LIVE_COMIC_GENTLE). `fx`: the comic look (null = the
// plain picture with a warm tint). Every Skia object made goes on `trash`.
export function paintMainCharacter(
  canvas: SkCanvas,
  scene: LiveScene,
  face: LensFace | null,
  fit: FaceFit | null,
  src: FaceSource | null,
  live: boolean,
  fx: SkRuntimeEffect | null,
  trash: Disposable[],
): void {
  'worklet';
  if (!scene || !scene.art) return;
  const art = scene.art;
  const skin = skinRgb(art.tone);
  // The hole, a little bigger (the character covers the extra), or null if the art's points are broken.
  const grown = art.hole && art.hole.length >= 6 ? scaleAround(art.hole, SKIN.plateGrow) : [];
  const plate = grown.length >= 6 && finiteList(grown) ? grown : null;
  // Your face moved into the hole: view points → poster pixels.
  const m = fit ? fitMatrix(fit) : null;
  const shape = face && m && plate ? faceShape(face.pts, m) : null;
  // The camera picture's (or the photo's) pixels → poster pixels.
  const toPoster = shape && m && src && src.image ? mul(m, src.toView) : null;
  const full = !!toPoster && finiteList(toPoster);
  const lite = !full && !!shape && live;

  if (full && shape && plate && src && toPoster) {
    // 1. The scene. 2. A skin-coloured plate in the hole, so no gap shows round your face.
    drawScene(canvas, scene, trash);
    canvas.drawPath(pathOf(trash, [plate], false), fillPaint(trash, skin, 1, SKIN.edgeBlur));
    // 3. Your face from the picture, moved into the hole, with the comic look and a soft edge.
    const matrix = bin(trash, Skia.Matrix(toMatrix9(toPoster)));
    const picture: SkShader = bin(trash, src.image.makeShaderOptions(TileMode.Clamp, TileMode.Clamp, FilterMode.Linear,
      src.mipmaps ? MipmapMode.Linear : MipmapMode.None, matrix));
    const gentle = live && LIVE_COMIC_GENTLE;
    const facePaint = bin(trash, Skia.Paint());
    facePaint.setAntiAlias(true);
    facePaint.setShader(fx ? bin(trash, fx.makeShaderWithChildren(comicUniforms(art.tone, 0, gentle), [picture])) : picture);
    facePaint.setMaskFilter(bin(trash, Skia.MaskFilter.MakeBlur(BlurStyle.Normal, SKIN.edgeBlur, true)));
    canvas.drawPath(pathOf(trash, [scaleAround(shape.oval, SKIN.faceGrow)], false), facePaint);
    // 4. On the skin only: the same look pulled a little towards the character's skin colour. Without the comic
    //    look, the warm tint instead (no soft edge here: at most 2 blurs per drawing).
    const loops = skinLoops(shape);
    if (fx && art.toneSure && COMIC.toneMix > 0) {
      const skinPath = pathOf(trash, loops, true);
      const skinPaint = bin(trash, Skia.Paint());
      skinPaint.setAntiAlias(true);
      skinPaint.setShader(bin(trash, fx.makeShaderWithChildren(comicUniforms(art.tone, COMIC.toneMix, gentle), [picture])));
      canvas.save();
      try {
        canvas.clipPath(skinPath, ClipOp.Intersect, true);
        canvas.drawRect(boxAround(loops[0]), skinPaint);
      } finally {
        canvas.restore();
      }
    } else if (!fx) {
      canvas.drawPath(pathOf(trash, loops, true), fillPaint(trash, tintRgb(skin), SKIN.liteTint, 0));
    }
    // 5. The character on top.
    drawCharacter(canvas, scene, trash);
    return;
  }

  if (lite && shape && plate) {
    // 1. The scene with the hole left open, so the real camera view (moved to fit) shows through.
    canvas.save();
    try {
      canvas.clipPath(pathOf(trash, [plate], false), ClipOp.Difference, true);
      drawScene(canvas, scene, trash);
    } finally {
      canvas.restore();
    }
    // 2. A skin-coloured ring between the hole's edge and your face (hair, ears and the room behind you).
    const ring = pathOf(trash, [plate, scaleAround(shape.oval, SKIN.liteFaceShrink)], true);
    canvas.drawPath(ring, fillPaint(trash, skin, 1, SKIN.edgeBlur));
    // 3. A warm tint on your skin only (not the eyes, brows or lips).
    canvas.drawPath(pathOf(trash, skinLoops(shape), true), fillPaint(trash, tintRgb(skin), SKIN.liteTint, TINT_BLUR));
    // 4. The character on top.
    drawCharacter(canvas, scene, trash);
    return;
  }

  // No face (or nothing to take it from): the hole is filled with the character's skin colour.
  drawScene(canvas, scene, trash);
  if (plate) canvas.drawPath(pathOf(trash, [plate], false), fillPaint(trash, skin, 1, 0));
  drawCharacter(canvas, scene, trash);
}
