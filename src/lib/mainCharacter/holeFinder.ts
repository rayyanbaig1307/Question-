// ---------------------------------------------------------------------------
// Main Character Mode 🌆: finding the face hole in a character picture, and the small naming rules for online
// art (docs/MAIN_CHARACTER.md).
//
// Plain maths on plain arrays: no Skia, no React Native, nothing runs when this file loads. So the tests and the
// phone run exactly the same code. scripts/make-main-character-assets.py has a Python copy of findFaceHole,
// holeLooksRight, skinToneAround and anchorsFromHole for its `online` step: change both together.
//
// Every place and size here is in 0–1 of the picture (0,0 top left, 1,1 bottom right), the "art 0–1" of types.ts.
// ---------------------------------------------------------------------------
import { HOLE, HOLE_CHECK } from './config';
import type { ArtAnchors, Pt } from './types';

// The see-through face hole in a picture: 36 points round it (x, y, x, y, … – the first one straight up from its
// middle, then every 10° clockwise on screen), the box round it, and how much of that box it fills (an oval
// fills about 0.785, the 6 bundled face holes 0.83–0.87).
export type HoleShape = { points: number[]; box: { x: number; y: number; w: number; h: number }; fill: number };

type Tone = { rgb: [number, number, number]; sure: boolean };

const SEE_THROUGH = 128;   // alpha below this = see-through
const RAYS = 36;           // one point round the hole every 10°
const RAY_STEP = 0.25;     // how far a ray moves per look, in pixels
const SOLID = 250;         // alpha above this = solid paint (skin colour is only read from these)
const RING = 1.25;         // the skin ring round the hole reaches out to 1.25 × the hole's own size
const MIN_SKIN = 200;      // fewer skin-coloured pixels than this in the ring = not sure of the skin colour
// Skin colour (YCbCr): wider than the usual photo range (Cr 135–180, Cb 85–135), because painted sunset light
// makes skin much redder – the 6 bundled faces measure Cr 190–204, Cb 82–90.
const SKIN_CR = [135, 215];
const SKIN_CB = [70, 135];
const NO_TONE: [number, number, number] = [200, 150, 120];   // only when the ring has no paint at all

// The biggest closed see-through area in the picture, with 36 points round its edge. `rgba` is the picture's
// pixels (not premultiplied), `w` × `h` of them – the app looks at a 270 × 480 copy. See-through areas joined to
// the picture's edge are the space round the character, not a hole. Several closed areas are normal (the gaps
// between an arm and the body), and the face hole is the biggest. null = no closed see-through area at all.
export function findFaceHole(rgba: Uint8Array, w: number, h: number): HoleShape | null {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 3 || h < 3 || !rgba || rgba.length < w * h * 4) return null;
  const n = w * h;
  // 0 = paint, 1 = see-through and not looked at yet, 2 = see-through round the character, 3 = see-through inside.
  const state = new Uint8Array(n);
  for (let i = 0; i < n; i++) state[i] = rgba[i * 4 + 3] < SEE_THROUGH ? 1 : 0;
  const stack = new Int32Array(n);

  // Marks one joined see-through area (sideways and up/down neighbours) and measures it.
  const spread = (start: number, mark: number) => {
    let size = 0;
    let sumX = 0;
    let sumY = 0;
    let left = w;
    let top = h;
    let right = -1;
    let bottom = -1;
    let waiting = 0;
    stack[waiting++] = start;
    state[start] = mark;
    while (waiting > 0) {
      const i = stack[--waiting];
      const x = i % w;
      const y = (i - x) / w;
      size++;
      sumX += x;
      sumY += y;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x > 0 && state[i - 1] === 1) { state[i - 1] = mark; stack[waiting++] = i - 1; }
      if (x < w - 1 && state[i + 1] === 1) { state[i + 1] = mark; stack[waiting++] = i + 1; }
      if (y > 0 && state[i - w] === 1) { state[i - w] = mark; stack[waiting++] = i - w; }
      if (y < h - 1 && state[i + w] === 1) { state[i + w] = mark; stack[waiting++] = i + w; }
    }
    return { size, sumX, sumY, left, top, right, bottom };
  };

  // Round the character: every see-through pixel joined to the picture's edge.
  for (let x = 0; x < w; x++) {
    if (state[x] === 1) spread(x, 2);
    if (state[(h - 1) * w + x] === 1) spread((h - 1) * w + x, 2);
  }
  for (let y = 0; y < h; y++) {
    if (state[y * w] === 1) spread(y * w, 2);
    if (state[y * w + w - 1] === 1) spread(y * w + w - 1, 2);
  }
  // What is left is closed in by paint. Keep the biggest.
  let best: ReturnType<typeof spread> | null = null;
  for (let i = 0; i < n; i++) {
    if (state[i] !== 1) continue;
    const area = spread(i, 3);
    if (!best || area.size > best.size) best = area;
  }
  if (!best) return null;

  // Its middle (pixel centres sit at +0.5). An odd shape whose middle isn't inside it can't be measured.
  const midX = best.sumX / best.size + 0.5;
  const midY = best.sumY / best.size + 0.5;
  if (rgba[(Math.floor(midY) * w + Math.floor(midX)) * 4 + 3] >= SEE_THROUGH) return null;

  // The alpha between pixel centres (blended from the 4 nearest pixels), so the edge is found to a part of a pixel.
  const alphaOf = (x: number, y: number) => rgba[(Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4 + 3];
  const alphaAt = (px: number, py: number) => {
    const fx = px - 0.5;
    const fy = py - 0.5;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const upper = alphaOf(ix, iy) * (1 - tx) + alphaOf(ix + 1, iy) * tx;
    const lower = alphaOf(ix, iy + 1) * (1 - tx) + alphaOf(ix + 1, iy + 1) * tx;
    return upper * (1 - ty) + lower * ty;
  };

  // 36 rays from the middle, the first straight up, then clockwise on screen. Each stops where the alpha crosses
  // 128, worked out between its last two looks.
  const points: number[] = [];
  const far = w + h;
  for (let k = 0; k < RAYS; k++) {
    const turn = (k * 2 * Math.PI) / RAYS;
    const dx = Math.sin(turn);
    const dy = -Math.cos(turn);
    let t = 0;
    let before = alphaAt(midX, midY);
    let edge = -1;
    while (t < far) {
      const next = t + RAY_STEP;
      const px = midX + dx * next;
      const py = midY + dy * next;
      if (px < 0 || py < 0 || px > w || py > h) { edge = t; break; }
      const alpha = alphaAt(px, py);
      if (alpha >= SEE_THROUGH) {
        const part = alpha > before ? (SEE_THROUGH - before) / (alpha - before) : 1;
        edge = t + Math.min(1, Math.max(0, part)) * RAY_STEP;
        break;
      }
      before = alpha;
      t = next;
    }
    if (edge < 0) edge = t;
    points.push((midX + dx * edge) / w, (midY + dy * edge) / h);
  }

  const boxW = best.right - best.left + 1;
  const boxH = best.bottom - best.top + 1;
  return {
    points,
    box: { x: best.left / w, y: best.top / h, w: boxW / w, h: boxH / h },
    fill: best.size / (boxW * boxH),
  };
}

// Does the hole have the usual face shape and place (HOLE_CHECK in config.ts)? Anything else is skipped, never
// guessed at. The app always measures a 9:16 picture, so the box's real width:height is (w × 9) : (h × 16).
export function holeLooksRight(shape: HoleShape): boolean {
  if (!shape || !shape.box || !Array.isArray(shape.points) || shape.points.length !== RAYS * 2) return false;
  if (!shape.points.every((v) => Number.isFinite(v))) return false;
  const { x, y, w, h } = shape.box;
  const fill = shape.fill;
  if (![x, y, w, h, fill].every((v) => Number.isFinite(v)) || w <= 0 || h <= 0) return false;
  const aspect = (w * 9) / (h * 16);
  const middleX = x + w / 2;
  const middleY = y + h / 2;
  return w >= HOLE_CHECK.minWidth && w <= HOLE_CHECK.maxWidth
    && aspect >= HOLE_CHECK.minAspect && aspect <= HOLE_CHECK.maxAspect
    && fill >= HOLE_CHECK.minFill && fill <= HOLE_CHECK.maxFill
    && middleX >= HOLE_CHECK.minX && middleX <= HOLE_CHECK.maxX
    && middleY < HOLE_CHECK.maxY;
}

// Where the face goes, guessed from the hole's box with the HOLE numbers (measured on the 6 characters that come
// inside the app). Only for online art without its own .json.
export function anchorsFromHole(shape: HoleShape, tone: Tone): ArtAnchors {
  const { x, y, w, h } = shape.box;
  const middle = x + w / 2;
  const eyeY = y + HOLE.eyeY * h;
  const hole: Pt[] = [];
  for (let i = 0; i + 1 < shape.points.length; i += 2) hole.push([shape.points[i], shape.points[i + 1]]);
  return {
    eyes: [[middle - HOLE.eyeHalf * w, eyeY], [middle + HOLE.eyeHalf * w, eyeY]],
    nose: [middle, y + HOLE.noseY * h],
    chin: [middle, y + HOLE.chinY * h],
    forehead: [middle, y + HOLE.foreheadY * h],
    hole,
    faceWidth: HOLE.faceWidth * w,
    skinTone: [tone.rgb[0], tone.rgb[1], tone.rgb[2]],
    toneSure: tone.sure,
  };
}

// Skin colour: warm (more red than green, more green than blue) and in the YCbCr skin range, not too dark.
// Red, pink and blue cloth, neon-lit hair, lips, sky and dark hair fail it.
function looksLikeSkin(r: number, g: number, b: number): boolean {
  if (!(r > g && g > b)) return false;
  const light = 0.299 * r + 0.587 * g + 0.114 * b;
  const blue = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const red = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return red >= SKIN_CR[0] && red <= SKIN_CR[1] && blue >= SKIN_CB[0] && blue <= SKIN_CB[1] && light > 40;
}

// The middle value (for an even count, the two middle ones averaged and rounded).
function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const half = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[half] : Math.round((sorted[half - 1] + sorted[half]) / 2);
}

// Is the point inside the outline (x, y, x, y, …)? The usual even-odd crossing count.
function inside(outline: number[], px: number, py: number): boolean {
  let yes = false;
  const count = outline.length >> 1;
  for (let i = 0, j = count - 1; i < count; j = i++) {
    const xi = outline[i * 2];
    const yi = outline[i * 2 + 1];
    const xj = outline[j * 2];
    const yj = outline[j * 2 + 1];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) yes = !yes;
  }
  return yes;
}

// The character's skin colour for online art (there is no painted face left to measure): the solid paint in a
// ring round the hole (from its edge out to 1.25 × its size), skin-coloured pixels only, and of those the lit
// half (the brighter half): the paint's shadows, the neck under the jaw and brown hair are darker than the lit
// face, which is what the skin plate and the tone pull should match. The middle value of each colour of that
// half. Fewer than 200 skin pixels → not sure: the middle value of the whole ring, used only for the skin plate
// behind the face (no tone pull).
export function skinToneAround(rgba: Uint8Array, w: number, h: number, shape: HoleShape): Tone {
  const count = shape?.points?.length >> 1;
  if (!rgba || !(count >= 3) || !Number.isInteger(w) || !Number.isInteger(h) || rgba.length < w * h * 4) {
    return { rgb: [...NO_TONE], sure: false };
  }
  const hole: number[] = [];
  let midX = 0;
  let midY = 0;
  for (let i = 0; i < count; i++) {
    hole.push(shape.points[i * 2] * w, shape.points[i * 2 + 1] * h);
    midX += hole[i * 2];
    midY += hole[i * 2 + 1];
  }
  midX /= count;
  midY /= count;
  const outer: number[] = [];
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = midX + (hole[i * 2] - midX) * RING;
    const y = midY + (hole[i * 2 + 1] - midY) * RING;
    outer.push(x, y);
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }
  const fromX = Math.max(0, Math.floor(left));
  const toX = Math.min(w - 1, Math.ceil(right));
  const fromY = Math.max(0, Math.floor(top));
  const toY = Math.min(h - 1, Math.ceil(bottom));
  const ring: number[][] = [[], [], []];
  const skin: number[][] = [];   // [r, g, b, lightness]
  for (let y = fromY; y <= toY; y++) {
    const py = y + 0.5;
    for (let x = fromX; x <= toX; x++) {
      const i = (y * w + x) * 4;
      if (rgba[i + 3] <= SOLID) continue;
      const px = x + 0.5;
      if (!inside(outer, px, py) || inside(hole, px, py)) continue;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      ring[0].push(r); ring[1].push(g); ring[2].push(b);
      if (looksLikeSkin(r, g, b)) skin.push([r, g, b, 299 * r + 587 * g + 114 * b]);
    }
  }
  if (skin.length >= MIN_SKIN) {
    const lit = skin.slice().sort((a, b) => a[3] - b[3]).slice(skin.length >> 1);   // the brighter half
    return { rgb: [median(lit.map((p) => p[0])), median(lit.map((p) => p[1])), median(lit.map((p) => p[2]))], sure: true };
  }
  if (ring[0].length > 0) return { rgb: [median(ring[0]), median(ring[1]), median(ring[2])], sure: false };
  return { rgb: [...NO_TONE], sure: false };
}

// The picture types the online library takes, from a file name ('.jpeg' counts as 'jpg'). null = anything else.
export function artExtension(file: string): 'webp' | 'png' | 'jpg' | 'json' | null {
  if (typeof file !== 'string') return null;
  const name = file.slice(file.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  if (ext === 'webp' || ext === 'png' || ext === 'json') return ext;
  if (ext === 'jpg' || ext === 'jpeg') return 'jpg';
  return null;
}

// A file name → the short name the app keys it by: 'Street Boss.PNG' → 'street-boss'. Lower case, spaces and
// underscores become dashes, anything else that isn't a-z, 0-9 or a dash is dropped. null when nothing usable is
// left, when it is longer than 40, or for any other kind of file (like Supabase's '.emptyFolderPlaceholder').
export function slugFromFile(file: string): string | null {
  if (typeof file !== 'string') return null;
  const name = file.slice(file.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || artExtension(name) === null) return null;
  const slug = name.slice(0, dot).toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug.length >= 1 && slug.length <= 40 ? slug : null;
}

// 'street-boss' → 'Street Boss' (the name people see).
export function nameFromSlug(slug: string): string {
  return String(slug ?? '').split('-').filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');
}

// How much a picture type is preferred when two files share a name: webp, then png, then jpg. 0 = not a picture.
function pictureRank(ext: string): number {
  switch (ext) {
    case 'webp': return 3;
    case 'png': return 2;
    case 'jpg': return 1;
    default: return 0;
  }
}

// One picture per name in one folder: .webp wins over .png over .jpg (the newest one if both are the same type).
// A .json is never a picture – it is the "where the face goes" file that goes with the picture of the same name.
// Keeps the order it was given.
export function pickOnePerSlug<T extends { slug: string; ext: string; updatedAt: string }>(items: T[]): T[] {
  const best = new Map<string, T>();
  for (const item of items) {
    const rank = pictureRank(item.ext);
    if (rank === 0) continue;
    const had = best.get(item.slug);
    if (!had || rank > pictureRank(had.ext) || (rank === pictureRank(had.ext) && item.updatedAt > had.updatedAt)) {
      best.set(item.slug, item);
    }
  }
  return items.filter((item) => best.get(item.slug) === item);
}
