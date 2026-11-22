import { CHARACTER_SCALE, FIT, POSTER_H, POSTER_W } from '@/lib/mainCharacter/config';
import type { ArtAnchors } from '@/lib/mainCharacter/types';

// ---------------------------------------------------------------------------
// Main Character Mode 🌆: where things go (docs/MAIN_CHARACTER.md).
//
// Three kinds of places (the same words everywhere in the Main Character files):
// - "view points": the camera view's own points. Your face points come in these (already turned and mirrored
//   like the camera view on screen).
// - "poster pixels": the poster, 0…1080 across and 0…1920 down. All Main Character drawing happens in these.
// - "art 0–1": a character picture's own 0–1 space (after its centred 9:16 crop). placeArt turns it into
//   poster pixels.
//
// The poster never moves: your face is moved into the character's face hole. faceFit works out how, from your
// two eye middles only (each one the middle of the eye's two corners): it turns, scales and moves your face so
// your eye middle lands on the character's and your eye line lies along the character's eye line. Not the
// chin (it moves when you talk) and not the irises (they move when you look around, so the face would swim).
// The height can follow the top of your forehead (point 10, which the jaw doesn't move), but only a little.
//
// A matrix here is 6 numbers [a, b, c, d, e, f]: x' = a·x + b·y + c and y' = d·x + e·y + f
// (the same as components/lens/warp/frameMatrix.ts).
//
// Every function is a 'worklet' (they also run on the drawing thread) and sits above the ones that use it
// (tests/unit/worklet-order.test.mjs). tests/unit/main-character-fit.test.mjs checks the sums.
// ---------------------------------------------------------------------------

// The character's face spots, in poster pixels (placeArt makes this once per character).
export type PosterArt = {
  eyes: number[];      // 4: picture-left x,y then picture-right x,y – poster pixels
  forehead: number[];  // 2
  chin: number[];      // 2
  nose: number[];      // 2
  hole: number[];      // 72: 36 points
  tone: number[];      // 3: skin 0–1
  toneSure: boolean;
};

// Turn + scale + move: your eye middle → the art's, your eye line → the art's eye line.
export type FaceFit = {
  ux: number; uy: number;      // your eye middle (view points)
  turnUser: number;            // angle of your eye line (radians)
  sx: number; sy: number;      // scale along your eye line / across it
  turnArt: number;             // angle of the art's eye line
  px: number; py: number;      // the art's eye middle (poster pixels)
};

// What the camera view gets in the lite way (CameraFollow.tsx): a plain React Native transform list.
export type LiteTransform = [{ translateX: number }, { translateY: number }, { rotate: string },
  { scaleX: number }, { scaleY: number }, { rotate: string }];

// The face points used here (MediaPipe's numbers): the corners of each eye and the top of the forehead.
const EYE_ONE_OUTER = 33;
const EYE_ONE_INNER = 133;
const EYE_TWO_OUTER = 263;
const EYE_TWO_INNER = 362;
const FOREHEAD = 10;
// The forehead height is only used when it is at least this many points (a smaller one can't be trusted).
const MIN_HEIGHT = 1;

// Is every number in the list a real number?
function allFinite(list: number[]) {
  'worklet';
  for (let i = 0; i < list.length; i++) if (!Number.isFinite(list[i])) return false;
  return true;
}

// Two matrices in one: `p` after `q` (first q, then p).
export function mul(p: number[], q: number[]): number[] {
  'worklet';
  return [
    p[0] * q[0] + p[1] * q[3],
    p[0] * q[1] + p[1] * q[4],
    p[0] * q[2] + p[1] * q[5] + p[2],
    p[3] * q[0] + p[4] * q[3],
    p[3] * q[1] + p[4] * q[4],
    p[3] * q[2] + p[4] * q[5] + p[5],
  ];
}

// Your two eye middles [ax, ay, bx, by]: the middle of points 33 and 133, then of 263 and 362. Which one is on
// the left of the screen depends on the camera (selfie or back), so faceFit never trusts the order.
// null when the points are missing or broken.
export function eyeMiddles(pts: number[]): number[] | null {
  'worklet';
  if (!pts || !(pts.length >= 478 * 2)) return null;
  const out = [
    (pts[EYE_ONE_OUTER * 2] + pts[EYE_ONE_INNER * 2]) / 2,
    (pts[EYE_ONE_OUTER * 2 + 1] + pts[EYE_ONE_INNER * 2 + 1]) / 2,
    (pts[EYE_TWO_OUTER * 2] + pts[EYE_TWO_INNER * 2]) / 2,
    (pts[EYE_TWO_OUTER * 2 + 1] + pts[EYE_TWO_INNER * 2 + 1]) / 2,
  ];
  return allFinite(out) ? out : null;
}

// How far point (x, y) is from the line through (mx, my) going along (dx, dy) (a length-1 step), measured across
// that line.
function across(x: number, y: number, mx: number, my: number, dx: number, dy: number) {
  'worklet';
  return Math.abs((x - mx) * -dy + (y - my) * dx);
}

// How to move your face into the character's hole: see the top of this file. null when it can't be done safely
// (no eyes, eyes too close together, a scale outside the FIT limits, or any broken number).
export function faceFit(pts: number[], art: PosterArt): FaceFit | null {
  'worklet';
  const eyes = eyeMiddles(pts);
  if (!eyes || !art || !art.eyes || !(art.eyes.length >= 4)) return null;
  const a1x = art.eyes[0];
  const a1y = art.eyes[1];
  const a2x = art.eyes[2];
  const a2y = art.eyes[3];
  if (!allFinite([a1x, a1y, a2x, a2y])) return null;
  const adx = a2x - a1x;
  const ady = a2y - a1y;
  let u1x = eyes[0];
  let u1y = eyes[1];
  let u2x = eyes[2];
  let u2y = eyes[3];
  // Your eyes in the same order as the art's: swapped if they point the other way (no mirroring, just the order).
  if ((u2x - u1x) * adx + (u2y - u1y) * ady < 0) {
    u1x = eyes[2];
    u1y = eyes[3];
    u2x = eyes[0];
    u2y = eyes[1];
  }
  const udx = u2x - u1x;
  const udy = u2y - u1y;
  const du = Math.hypot(udx, udy);
  const da = Math.hypot(adx, ady);
  if (!(du >= FIT.minEyeGap) || !(da > 0)) return null;
  const ux = (u1x + u2x) / 2;
  const uy = (u1y + u2y) / 2;
  const px = (a1x + a2x) / 2;
  const py = (a1y + a2y) / 2;
  const turnUser = Math.atan2(udy, udx);
  const turnArt = Math.atan2(ady, adx);
  let sx = da / du;
  let sy = sx;
  if (FIT.useForehead && art.forehead && art.forehead.length >= 2) {
    // The height: from the eye middle to the top of the forehead, measured across the eye line, on you and on
    // the art. Neither moves when you talk. The overall size is the middle of the two, and the stretch between
    // them is kept within FIT.maxStretch, so the eye middle always lands exactly.
    const hu = across(pts[FOREHEAD * 2], pts[FOREHEAD * 2 + 1], ux, uy, udx / du, udy / du);
    const ha = across(art.forehead[0], art.forehead[1], px, py, adx / da, ady / da);
    if (Number.isFinite(hu) && Number.isFinite(ha) && hu >= MIN_HEIGHT && ha >= MIN_HEIGHT) {
      const sy0 = ha / hu;
      const size = Math.sqrt(sx * sy0);
      const stretch = Math.max(1 / FIT.maxStretch, Math.min(FIT.maxStretch, sy0 / sx));
      sx = size / Math.sqrt(stretch);
      sy = size * Math.sqrt(stretch);
    }
  }
  const s = Math.sqrt(sx * sy);
  if (!(s >= FIT.minScale) || !(s <= FIT.maxScale)) return null;
  if (!allFinite([ux, uy, turnUser, sx, sy, turnArt, px, py])) return null;
  return { ux, uy, turnUser, sx, sy, turnArt, px, py };
}

// The fit as a matrix: view points → poster pixels.
// translate(px, py) · rotate(turnArt) · scale(sx, sy) · rotate(−turnUser) · translate(−ux, −uy)
export function fitMatrix(f: FaceFit): number[] {
  'worklet';
  const cu = Math.cos(f.turnUser);
  const su = Math.sin(f.turnUser);
  const ca = Math.cos(f.turnArt);
  const sa = Math.sin(f.turnArt);
  const toMiddle = [1, 0, -f.ux, 0, 1, -f.uy];
  const unturn = [cu, su, 0, -su, cu, 0];
  const scale = [f.sx, 0, 0, 0, f.sy, 0];
  const turn = [ca, -sa, 0, sa, ca, 0];
  const toArt = [1, 0, f.px, 0, 1, f.py];
  return mul(toArt, mul(turn, mul(scale, mul(unturn, toMiddle))));
}

// Poster pixels → view points: the poster fills the view ("cover", centred; the overflow is cut off equally on
// both sides). Live drawing puts this on the canvas, then draws in poster pixels.
export function posterToView(viewW: number, viewH: number): number[] {
  'worklet';
  const s = Math.max(viewW / POSTER_W, viewH / POSTER_H);
  return [s, 0, (viewW - POSTER_W * s) / 2, 0, s, (viewH - POSTER_H * s) / 2];
}

// The lite way (no camera pictures on this download): the camera view itself is moved so your face shows
// through the hole. React Native turns and scales a view about its middle, so this works out the list that puts
// every camera view point p exactly where the poster shows it: posterToView(fitMatrix(p)). null when anything is
// off (no fit, no view size, a scale outside the FIT limits, any broken number): a broken number in a native
// view's transform can close the app on iPhone, so the caller then keeps the last good one.
export function liteTransform(f: FaceFit | null, viewW: number, viewH: number): LiteTransform | null {
  'worklet';
  if (!f || !Number.isFinite(viewW) || !Number.isFinite(viewH) || !(viewW > 0) || !(viewH > 0)) return null;
  if (!allFinite([f.ux, f.uy, f.turnUser, f.sx, f.sy, f.turnArt, f.px, f.py])) return null;
  if (!(f.sx >= FIT.minScale) || !(f.sx <= FIT.maxScale) || !(f.sy >= FIT.minScale) || !(f.sy <= FIT.maxScale)) return null;
  const c = posterToView(viewW, viewH);
  const k = c[0];
  // A = k · turn(turnArt) · scale(sx, sy) · turn(−turnUser): what the list below does about the view's middle.
  const a = mul([Math.cos(f.turnArt), -Math.sin(f.turnArt), 0, Math.sin(f.turnArt), Math.cos(f.turnArt), 0],
    mul([k * f.sx, 0, 0, 0, k * f.sy, 0], [Math.cos(f.turnUser), Math.sin(f.turnUser), 0, -Math.sin(f.turnUser), Math.cos(f.turnUser), 0]));
  const ox = viewW / 2;
  const oy = viewH / 2;
  // Where the art's eye middle is on the screen.
  const bigPx = c[0] * f.px + c[2];
  const bigPy = c[4] * f.py + c[5];
  // t = P − O + A·(O − u)
  const tx = bigPx - ox + a[0] * (ox - f.ux) + a[1] * (oy - f.uy);
  const ty = bigPy - oy + a[3] * (ox - f.ux) + a[4] * (oy - f.uy);
  const scaleX = k * f.sx;
  const scaleY = k * f.sy;
  if (!allFinite([tx, ty, scaleX, scaleY]) || !(scaleX > 0) || !(scaleY > 0)) return null;
  return [{ translateX: tx }, { translateY: ty }, { rotate: `${f.turnArt}rad` }, { scaleX }, { scaleY }, { rotate: `${-f.turnUser}rad` }];
}

// The biggest face (the widest gap between its eye middles), or null when there is none with good eyes.
export function biggestFace<T extends { pts: number[] }>(faces: T[]): T | null {
  'worklet';
  if (!faces) return null;
  let best: T | null = null;
  let widest = -1;
  for (let i = 0; i < faces.length; i++) {
    const eyes = faces[i] ? eyeMiddles(faces[i].pts) : null;
    if (!eyes) continue;
    const gap = Math.hypot(eyes[2] - eyes[0], eyes[3] - eyes[1]);
    if (gap > widest) {
      widest = gap;
      best = faces[i];
    }
  }
  return best;
}

// The biggest part of a `w` × `h` picture with the shape `aspect` (width ÷ height), in the middle: what is left
// after cutting off equal bits on both sides. All 0 for a broken size.
export function coverCrop(w: number, h: number, aspect: number): { x: number; y: number; w: number; h: number } {
  'worklet';
  if (!(w > 0) || !(h > 0) || !(aspect > 0) || !Number.isFinite(w) || !Number.isFinite(h) || !Number.isFinite(aspect)) {
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  if (w / h > aspect) {
    const cw = h * aspect;
    return { x: (w - cw) / 2, y: 0, w: cw, h };
  }
  const ch = w / aspect;
  return { x: 0, y: (h - ch) / 2, w, h: ch };
}

// The character's box on the poster: CHARACTER_SCALE of the poster's size, in the middle, standing on the
// bottom edge (x 43.2, y 153.6, w 993.6, h 1766.4).
export function characterRect(): { x: number; y: number; w: number; h: number } {
  'worklet';
  const w = POSTER_W * CHARACTER_SCALE;
  const h = POSTER_H * CHARACTER_SCALE;
  return { x: (POSTER_W - w) / 2, y: POSTER_H - h, w, h };
}

// A character's face spots (art 0–1) in poster pixels, through its box; the skin colour 0–255 becomes 0–1.
export function placeArt(a: ArtAnchors): PosterArt {
  'worklet';
  const box = characterRect();
  const x = (v: number) => box.x + v * box.w;
  const y = (v: number) => box.y + v * box.h;
  const hole: number[] = [];
  for (let i = 0; i < a.hole.length; i++) hole.push(x(a.hole[i][0]), y(a.hole[i][1]));
  const tone: number[] = [];
  for (let i = 0; i < 3; i++) {
    const v = a.skinTone[i] / 255;
    tone.push(Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
  }
  return {
    eyes: [x(a.eyes[0][0]), y(a.eyes[0][1]), x(a.eyes[1][0]), y(a.eyes[1][1])],
    forehead: [x(a.forehead[0]), y(a.forehead[1])],
    chin: [x(a.chin[0]), y(a.chin[1])],
    nose: [x(a.nose[0]), y(a.nose[1])],
    hole,
    tone,
    toneSure: a.toneSure === true,
  };
}

// Points [x0, y0, x1, y1, …] made `factor` times bigger (or smaller) about their middle (the average point).
export function scaleAround(flat: number[], factor: number): number[] {
  'worklet';
  const n = Math.floor(flat.length / 2);
  if (n === 0) return [];
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += flat[i * 2];
    cy += flat[i * 2 + 1];
  }
  cx /= n;
  cy /= n;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(cx + (flat[i * 2] - cx) * factor, cy + (flat[i * 2 + 1] - cy) * factor);
  return out;
}

// Points [x0, y0, x1, y1, …] moved through a matrix.
export function mapPoints(m: number[], flat: number[]): number[] {
  'worklet';
  const out: number[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const px = flat[i];
    const py = flat[i + 1];
    out.push(m[0] * px + m[1] * py + m[2], m[3] * px + m[4] * py + m[5]);
  }
  return out;
}
