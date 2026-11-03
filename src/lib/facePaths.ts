import { PathOp, Skia, type SkPath } from '@shopify/react-native-skia';

import type { FaceShape, Pt } from './faceLens';

// ---------------------------------------------------------------------------
// Turns a face's outlines (from the face tracker) into smooth shapes for drawing makeup and glow.
// Used for the live camera and for painting onto the finished photo. Only loaded where Skia exists.
// `map` moves a screen point to wherever it's being drawn (the photo's own pixels, for example).
// ---------------------------------------------------------------------------

type Map = (p: Pt) => Pt;
const same: Map = (p) => p;

// A smooth closed (or open) curve through the points – no corners, so lips and faces look natural.
export function smoothPath(points: Pt[], closed: boolean, map: Map = same): SkPath | null {
  if (points.length < 3) return null;
  const pts = points.map(map);
  const path = Skia.PathBuilder.Make();
  const mid = (a: Pt, b: Pt) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  if (closed) {
    const start = mid(pts[pts.length - 1], pts[0]);
    path.moveTo(start.x, start.y);
    for (let i = 0; i < pts.length; i++) {
      const next = mid(pts[i], pts[(i + 1) % pts.length]);
      path.quadTo(pts[i].x, pts[i].y, next.x, next.y);
    }
    path.close();
  } else {
    path.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const next = mid(pts[i], pts[i + 1]);
      path.quadTo(pts[i].x, pts[i].y, next.x, next.y);
    }
    path.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  }
  return path.build();
}

// Both lips as one shape (the mouth gap between them stays clear).
export function lipsPath(shape: FaceShape, map: Map = same): SkPath | null {
  const upper = smoothPath(shape.upperLip, true, map);
  const lower = smoothPath(shape.lowerLip, true, map);
  if (!upper || !lower) return upper ?? lower;
  return Skia.Path.MakeFromOp(upper, lower, PathOp.Union);
}

// The top lid of an eye (the half of its outline that's higher up), outer corner last – for eyeliner.
export function upperLid(eye: Pt[], outerIsLeft: boolean): Pt[] {
  if (eye.length < 6) return [];
  const half = Math.floor(eye.length / 2);
  const a = eye.slice(0, half + 1);
  const b = [...eye.slice(half), eye[0]];
  const meanY = (list: Pt[]) => list.reduce((sum, p) => sum + p.y, 0) / list.length;
  const lid = meanY(a) < meanY(b) ? a : b;
  // Order it from the inner corner to the outer corner.
  const sorted = [...lid].sort((p, q) => p.x - q.x);
  return outerIsLeft ? sorted.reverse() : sorted;
}

// Eyeliner along the top lid with a small wing flicking up and out at the outer corner.
export function linerPath(eye: Pt[], outerIsLeft: boolean, faceWidth: number, map: Map = same): SkPath | null {
  const lid = upperLid(eye, outerIsLeft);
  if (lid.length < 3) return null;
  const outer = lid[lid.length - 1];
  const before = lid[lid.length - 2];
  const dx = outer.x - before.x;
  const dy = outer.y - before.y;
  const length = Math.hypot(dx, dy) || 1;
  const wing = faceWidth * 0.045;
  const tip = { x: outer.x + (dx / length) * wing, y: outer.y - wing * 0.55 };
  return smoothPath([...lid, tip], false, map);
}

// Skin to smooth: the face, minus the eyes, eyebrows and lips (they stay sharp).
export function skinPath(shape: FaceShape, map: Map = same): SkPath | null {
  let face = smoothPath(shape.face, true, map);
  if (!face) return null;
  const cut = (hole: SkPath | null) => {
    if (face && hole) face = Skia.Path.MakeFromOp(face, hole, PathOp.Difference) ?? face;
  };
  for (const part of [shape.leftEye, shape.rightEye, shape.leftBrow, shape.rightBrow]) {
    cut(smoothPath(grow(part, 1.45), true, map));
  }
  cut(lipsPath({ ...shape, upperLip: grow(shape.upperLip, 1.15), lowerLip: grow(shape.lowerLip, 1.15) }, map));
  return face;
}

// The same outline, a bit bigger around its middle (so the sharp bits keep a little room).
function grow(points: Pt[], factor: number): Pt[] {
  if (points.length === 0) return points;
  const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  return points.map((p) => ({ x: cx + (p.x - cx) * factor, y: cy + (p.y - cy) * factor }));
}

// Where the blush goes on a cheek: the tracker's cheek point, nudged a little towards the ear.
export function blushSpot(shape: FaceShape, side: 'left' | 'right'): Pt | null {
  const cheek = side === 'left' ? shape.leftCheek : shape.rightCheek;
  if (!cheek) return null;
  const faceMidX = shape.face.length > 0 ? shape.face.reduce((sum, p) => sum + p.x, 0) / shape.face.length : cheek.x;
  const away = cheek.x < faceMidX ? -1 : 1;
  return { x: cheek.x + away * shape.width * 0.04, y: cheek.y - shape.width * 0.02 };
}
