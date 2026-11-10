import {
  BlurStyle,
  ClipOp,
  FillType,
  Skia,
  TileMode,
  type SkCanvas,
  type SkColor,
  type SkPathBuilder,
  type SkRect,
} from '@shopify/react-native-skia';

import { MESH } from '@/lib/faceMesh';
import type { LensLook } from '@/lib/lensLooks';

import { paintAuraOverload } from './filters/auraOverload';
import { paintBrainBuffering } from './filters/brainBuffering';
import { paintCrybaby } from './filters/crybaby';
import { paintHeartEyes } from './filters/heartEyes';
import { paintPeekabooEyes } from './filters/peekabooEyes';
import { paintWarpLook } from './warp/paintWarp';
import type { WarpSource } from './warp/warpEffects';

// ---------------------------------------------------------------------------
// The drawing for the face filters, in one place. The same code draws the live camera (LensOverlay.tsx)
// and the saved photo (bakeLook.ts), so the photo looks just like what you saw.
//
// ✨ Soft Glow ("heavenly gold", the owner's ask, 5 Nov): golden light falling on the whole face from above –
//    a warm gold glow on the skin (not the eyes, brows or lips) that is brightest at the forehead, soft light
//    rays and a glow above the head, golden highlights on the cheekbones, nose and forehead, warm blush (a bit
//    stronger when you smile), warmer eyes with a small catchlight (hidden while you blink), twinkling gold
//    glitter on the skin and gold sparkles all around the face. Both sides of the face get the same light.
// 🌅 Golden Hour ("liquid gold in the low sun", the owner's ask, 6 Nov: "more golden and shiny", and not like
//    Soft Glow): your face shining like polished gold in the evening sun. A low sun sits just past the left
//    edge of the picture, below the buttons at the top: a warm glow with a long thin streak of light and
//    soft sunbeams fanning out of it. They are drawn before the gold on the faces; the streak and the
//    brightest glow fade away when a face comes near them. The whole picture gets a light, deep amber tint
//    with darker warm corners – it warms the colours without making the picture foggy. Gold covers the whole
//    face, both sides alike: rich gold over the forehead, the eyes' level and the nose, and a lighter layer of
//    the same gold over both cheeks and the sides of the nose, out to the sides of the face and down to about
//    the mouth corners. It is a tint, not paint, so the face's own light and shade still show, and it fades
//    softly into the hair, the sides of the face and the jaw, warming to amber-brown as it fades. The
//    nostrils, the moustache and the lips sit in one soft hole, so they (and a beard below them) keep their
//    own natural colour. The eyes and brows get small soft holes too, so the eyes stay clear, and the brows
//    get a touch of warm brown so they stay warm dark hair. The gold, the highlights and the gleam are placed
//    by face points that stay put when you talk, so they don't move when your mouth opens (only the hole
//    round the lips follows the lips). Polished highlights with bright middles sit on the high points
//    (forehead, nose, cheekbones, lower lip). Every few seconds a thin, bright gleam glides across the face
//    like light moving over polished gold: it crosses the forehead, the bridge of the nose and the cheeks
//    under the eyes, fades out smoothly before it reaches an eye or a brow, and stops above the nostrils. The
//    high points it passes flash a glint with one thin streak of light that stays on the face. The gleam
//    comes a little later the further a face is from the sun's side, so with two faces it passes from one to
//    the other. A few soft golden orbs drift slowly through the air, away from the sun and away from faces.
//    No star sparkles, no glitter and no glow above the head: those belong to Soft Glow.
//
// The five Peekaboo+ face filters have a file each in ./filters (👀 Peekaboo Eyes, 🧠 Brain Buffering,
// 😭 Crybaby, ⚡ Aura Overload, 😘 Heart Eyes); paintLook below picks the right one. Their bouncy springs,
// the brain's loading and the aura's charge are worked out in faceTrack.ts and kept on each face.
// The 4 stretchy Peekaboo+ filters (🫥 Tiny Face, 🗿 Gigachin, 😃 Big Mouth, 👾 Pixel Panic) are in
// ./warp/paintWarp.ts: they move the camera's own pixels, so they also need the camera picture (`src`).
//
// The light is soft on purpose: it should look like real light, not like a sticker.
// These run on the drawing thread too, hence 'worklet'.
//
// Note: this is drawn OVER the camera picture, so it can tint, brighten and add light, but it can't truly
// blur or relight the pixels underneath (see docs/FACE_MESH.md).
// ---------------------------------------------------------------------------

// The list of looks lives in lib/lensLooks.ts (no Skia there, so the mode row can use it anywhere).
export type { LensLook };

// One face, ready to draw (faceTrack.ts makes it from the camera's face points and expression scores).
export type LensFace = {
  // Screen points x0, y0, x1, y1, … (478 points, already mirrored for selfies).
  pts: number[];
  // How closed each eye is and how big the smile is (0–1).
  blinkLeft: number;
  blinkRight: number;
  smile: number;
  // Not filled any more ([] and 0) and not drawn by anything; kept so older code still fits.
  light: number[];
  rim: number;
  // Expressions, 0–1, smoothed: raised brows, squinting, an open mouth and a kiss (pursed or round lips).
  browUp: number;
  squint: number;
  jawOpen: number;
  pucker: number;
  // The face filters' memory, stepped in faceTrack.ts on the app's main thread (the drawing only reads it).
  // Stays the same while this face is followed; picks its tears, hearts and sparks.
  seed: number;
  // 👀 The googly eyes' size and its speed (a spring), and the pupils' wobble (in face widths) and its speed.
  pop: number;
  popSpeed: number;
  wobbleX: number;
  wobbleY: number;
  wobbleSpeedX: number;
  wobbleSpeedY: number;
  // 🧠 How fast the head moves (face widths a second), 1 holding still … 0 moving, how far the brain has
  //    loaded (0–1) and the green flash just after it loads (1 → 0).
  motion: number;
  still: number;
  progress: number;
  flash: number;
  // ⚡ The aura's charge (0–1).
  charge: number;
  // The stretchy filters' memory (warp/warpTrack.ts): 😃 the mouth's size (1 = normal) and its speed (a
  // spring), 🫥 how much you're talking (0–1), 🗿 the chin's power (0–1), 👾 the glitch (0–1), and the
  // smoothed expression level of the stretchy filter that is on (0–1).
  mouth: number;
  mouthSpeed: number;
  tiny: number;
  chin: number;
  glitch: number;
  warpLevel: number;
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
const HONEY = 0.065; // the light deep amber tint over the whole picture
const VIGNETTE = 0.4; // darker warm-brown corners, for the evening mood
const SUN_GLOW = 0.62; // the low sun's glow at the left edge
const SUNBEAMS = 0.065; // the soft sunbeams fanning out of the sun
const STREAK = 0.42; // the long thin streak of light running across the picture through the sun
const FACE_GOLD = 0.36; // rich gold over the forehead, the eyes' level and the nose
// The shape of that gold, measured in "eyes to the bottom of the nose" steps up and down the face and in half
// face widths across: it is strongest around GOLD_UP above the eyes, it is gone GOLD_DOWN below the eyes
// (about halfway from the bottom of the nose to the mouth corners) and at least GOLD_OVER above the top of
// the forehead, and it reaches GOLD_WIDE to each side.
const GOLD_UP = 0.6;
const GOLD_DOWN = 1.5;
const GOLD_OVER = 0.5;
const GOLD_WIDE = 1.3;
// The lower gold, over the cheeks and the sides of the nose out to the sides of the face: it starts LOW_TOP
// below the eyes (under the lower eyelids), is full from LOW_FULL to LOW_FADE and is gone by LOW_END (about
// the mouth corners), in the same "eyes to the bottom of the nose" steps.
const LOW_GOLD = 0.27;
const LOW_TOP = 0.3;
const LOW_FULL = 0.65;
const LOW_FADE = 1.1;
const LOW_END = 1.6;
// How far out toward the side of the face the lower gold reaches (1 = right to the face's outline).
const LOW_EDGE = 0.93;
const GLOSS = 0.75; // the polished highlights on the high points of the face
const SHINE = 0.8; // the thin gleam that glides across the face
const GLINT = 1; // the bright glints when the gleam passes a high point
const BOKEH = 0.22; // the soft golden orbs drifting in the air
const SHINE_EVERY = 5; // seconds from one gleam to the next
const SHINE_TAKES = 0.7; // part of that time the gleam spends crossing the face
// How much later (seconds) the gleam comes to a face at the right edge of the view than to one at its left
// edge (nearest the sun). So two faces side by side shine one after the other, as if the light passes from
// one to the next, and nothing jumps when the camera lists the faces in a different order. It is kept short,
// so moving the phone or walking across the picture hardly changes the gleam's pace.
const SHINE_SPREAD = 1.5;
// Where the low sun is, as parts of the picture's width and height: just past its left edge, a little below
// the buttons at the top (so its bright middle never sits on them).
const SUN_AT = [-0.03, 0.22];

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

// The polished highlights of Golden Hour, on the high points of the face. Each one is a soft oval: its middle
// sits between two face-mesh points (a, b, and how far from a to b), its long side points from face point c
// to face point d, then its half length and half width (compared with the face width), how bright it is, and
// whether it flashes a glint when the gleam passes over it (1 = yes). The numbers are MediaPipe face-mesh
// points; what each one is is written after it.
const GLOSS_SPOTS = [
  // forehead: between the top of the forehead (10) and its middle (151), well above the brows, lying across
  // the forehead (108 → 337, its left and right side)
  10, 151, 0.6, 108, 337, 0.16, 0.045, 0.75, 1,
  // bridge of the nose: between the upper (197) and lower (5) bridge, lying down the nose (6 → 4)
  197, 5, 0.5, 6, 4, 0.09, 0.022, 1.0, 0,
  // tip of the nose: between the top of the tip (4) and the tip (1)
  4, 1, 0.35, 6, 4, 0.04, 0.03, 1.0, 1,
  // cheekbone, the person's right: just under the eye (118), a little toward the cheekbone (116), lying out
  // to the side of the face (118 → 34). Away from the face's edge, so its glint stays on the face.
  118, 116, 0.2, 118, 34, 0.11, 0.045, 0.6, 1,
  // cheekbone, the person's left: the same on the other side (347, 345, 264)
  347, 345, 0.2, 347, 264, 0.11, 0.045, 0.6, 1,
  // a little gloss on the lower lip: between its inside (14) and outside (17) edge, lying along the mouth
  // (corners 61 → 291). (None just above the top lip: that is where a moustache grows.)
  14, 17, 0.4, 61, 291, 0.055, 0.012, 0.32, 0,
];
// The soft hole in the gold round the nostrils, the moustache and the lips (MediaPipe face-mesh points, going
// round): from just past one mouth corner (212) up the side of the moustache (216, 206) to the base of the
// nose wing (64), over the tops of the nostrils just under the tip of the nose (218, 237, 44, 19, 274, 457,
// 438) to the other nose wing (294), down the other side of the moustache (426, 436) to just past the other
// mouth corner (432) and back along the bottom of the lower lip (273, 321, 314, 17, 84, 91, 43).
const MOUTH_AREA = [212, 216, 206, 64, 218, 237, 44, 19, 274, 457, 438, 294, 426, 436, 432, 273, 321, 314, 17, 84, 91, 43];
// The tops of the nostrils (the same points as the top of that hole): over the nose the gleam stops above them.
const NOSTRIL_TOP = [218, 237, 44, 19, 274, 457, 438];
// Golden orbs drifting in the air, like sunlight out of focus in a lens: where each one starts (parts of the
// picture's width and height), its size (part of the width), how many seconds one trip takes and where in
// its trip it starts (0–1).
const BOKEH_ORBS = [
  0.05, 0.38, 0.06, 11, 0.1,
  0.22, 0.17, 0.042, 13, 0.55,
  0.6, 0.16, 0.052, 12, 0.3,
  0.06, 0.56, 0.045, 9.5, 0.8,
  0.76, 0.4, 0.065, 14, 0.65,
];
// The sunbeams: the direction of each one from the sun (degrees, 0 = straight right, 90 = straight down),
// half its width (degrees) and how bright it is. Kept in order, and away from the button at the top-left.
const SUN_RAYS = [8, 3, 0.8, 19, 4.5, 1.0, 31, 3, 0.7, 63, 5, 0.9, 76, 3, 0.6, 352, 3, 0.6];

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
// 🌅 Golden Hour (liquid gold in the low sun)
// ---------------------------------------------------------------------------

// A colour with a see-through amount, for the gold gradients ('255,200,90' and 0.4 → 'rgba(255,200,90,0.4)').
// A broken amount (not a number) becomes 0, so the colour is always valid.
function goldColor(rgb: string, alpha: number) {
  'worklet';
  const amount = Math.max(0, Math.min(1, alpha)) || 0;
  return Skia.Color(`rgba(${rgb},${amount})`);
}

// A smooth step from 0 to 1 as `t` goes from 0 to 1 (no sudden start or stop).
function ease(t: number) {
  'worklet';
  const c = Math.max(0, Math.min(1, t)) || 0;
  return c * c * (3 - 2 * c);
}

// A soft oval of light: brightest in the middle and fading to nothing at its edge, so it never has a hard
// line. (x, y) is its middle, `long` and `thin` its half sizes, `angle` (in radians) the way its long side
// points. `colors` and `stops` go from the middle (0) to the edge (1); the last colour should be see-through.
// It's a gradient, not a blur, so it costs very little to draw.
function drawSoftOval(canvas: SkCanvas, x: number, y: number, long: number, thin: number, angle: number, colors: SkColor[], stops: number[]) {
  'worklet';
  if (!(long >= 0.5) || !(thin >= 0.05) || !(Math.abs(x) + Math.abs(y) + Math.abs(angle) < 1e7)) return;
  const paint = Skia.Paint();
  paint.setAntiAlias(true);
  paint.setShader(Skia.Shader.MakeRadialGradient({ x: 0, y: 0 }, long, colors, stops, TileMode.Clamp));
  canvas.save();
  canvas.translate(x, y);
  canvas.rotate((angle * 180) / Math.PI, 0, 0);
  canvas.scale(1, thin / long);
  canvas.drawCircle(0, 0, long, paint);
  canvas.restore();
}

// A "frame" is a place, a turn and a squash: [x, y, cos of the turn, sin of the turn, squash]. In its own
// frame a tilted, stretched face becomes an upright circle, which makes the gold easy to place.
// This turns a point on the screen (or in a bigger frame) into the frame's own coordinates.
function intoFrame(x: number, y: number, frame: number[]): [number, number] {
  'worklet';
  const dx = x - frame[0];
  const dy = y - frame[1];
  return [dx * frame[2] + dy * frame[3], (-dx * frame[3] + dy * frame[2]) / frame[4]];
}

// The other way round: a point in a frame's own coordinates back on the screen.
function outOfFrame(x: number, y: number, frame: number[]): [number, number] {
  'worklet';
  const down = y * frame[4];
  return [frame[0] + x * frame[2] - down * frame[3], frame[1] + x * frame[3] + down * frame[2]];
}

// Moves the canvas into a frame, so what's drawn next is drawn in the frame's own coordinates.
function enterFrame(canvas: SkCanvas, frame: number[]) {
  'worklet';
  canvas.translate(frame[0], frame[1]);
  canvas.rotate((Math.atan2(frame[3], frame[2]) * 180) / Math.PI, 0, 0);
  canvas.scale(1, frame[4]);
}

// A smooth closed shape through face points (an eye, the lips), in a frame's own coordinates. With `inner`
// the points go through a second frame that sits inside the first one.
function addLoopInFrame(builder: SkPathBuilder, pts: number[], loop: readonly number[], scale: number, frame: number[], inner?: number[]) {
  'worklet';
  const framed: number[] = [];
  const order: number[] = [];
  for (let k = 0; k < loop.length; k++) {
    let [fx, fy] = intoFrame(pts[loop[k] * 2], pts[loop[k] * 2 + 1], frame);
    if (inner) [fx, fy] = intoFrame(fx, fy, inner);
    framed.push(fx, fy);
    order.push(k);
  }
  addSmoothLoop(builder, framed, order, scale);
}

// A brow's hole, in a frame's own coordinates. The face points sit along the middle of a brow and real brows
// are about twice as thick, so the hole's top edge is moved up and its bottom edge down by half the brow's
// thickness (this keeps the brow's own curve), and it is made a little longer.
function addBrowInFrame(builder: SkPathBuilder, pts: number[], loop: readonly number[], frame: number[], inner: number[]) {
  'worklet';
  const n = loop.length;
  if (n < 4) return;
  const framed: number[] = [];
  const order: number[] = [];
  let cx = 0;
  for (let k = 0; k < n; k++) {
    const [ax, ay] = intoFrame(pts[loop[k] * 2], pts[loop[k] * 2 + 1], frame);
    const [fx, fy] = intoFrame(ax, ay, inner);
    framed.push(fx, fy);
    order.push(k);
    cx += fx;
  }
  cx /= n;
  // The loop goes along the brow's top edge first, then back along its bottom edge.
  const edge = Math.floor(n / 2);
  let thick = 0;
  for (let k = 0; k < edge; k++) thick += framed[(n - 1 - k) * 2 + 1] - framed[k * 2 + 1];
  thick = Math.abs(thick / edge) || 0;
  for (let k = 0; k < n; k++) {
    framed[k * 2] = cx + (framed[k * 2] - cx) * 1.12;
    framed[k * 2 + 1] += (k < edge ? -0.5 : 0.5) * thick;
  }
  addSmoothLoop(builder, framed, order, 1);
}

// The gold's area: a big circle (or, inside `inner`, an oval) with small holes for the eyes and the brows, and
// one for the nostrils, the moustache and the lips (`mouth` holds its points on the screen, x0, y0, x1, y1, …,
// and `order` their numbers 0, 1, 2, …), so the eyes stay clear and the brows and lips keep their own colour.
function goldArea(pts: number[], frame: number[], inner: number[], x: number, y: number, r: number, mouth: number[], order: number[]) {
  'worklet';
  const area = Skia.PathBuilder.Make();
  area.setFillType(FillType.EvenOdd);
  area.addCircle(x, y, r);
  addLoopInFrame(area, pts, MESH.leftEye, 1.3, frame, inner);
  addLoopInFrame(area, pts, MESH.rightEye, 1.3, frame, inner);
  addBrowInFrame(area, pts, MESH.leftBrow, frame, inner);
  addBrowInFrame(area, pts, MESH.rightBrow, frame, inner);
  addLoopInFrame(area, mouth, order, 1, frame, inner);
  return area.detach();
}

// Where the face's outline is at the height y, sideways (in the face's frame; `outline` holds the outline
// points there, x0, y0, x1, y1, …): its left and right edge. The left edge is more than the right one if the
// outline doesn't reach that height.
function outlineSpan(outline: number[], y: number): [number, number] {
  'worklet';
  let lo = 1e9;
  let hi = -1e9;
  const n = Math.floor(outline.length / 2);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const y0 = outline[i * 2 + 1];
    const y1 = outline[j * 2 + 1];
    if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
      const cross = outline[i * 2] + ((outline[j * 2] - outline[i * 2]) * (y - y0)) / (y1 - y0);
      lo = Math.min(lo, cross);
      hi = Math.max(hi, cross);
    }
  }
  return [lo, hi];
}

// How far a point (x, y) is inside the face's outline, sideways (in the face's frame). Below 0 means it is
// outside the face, or above or below it.
function insideFace(outline: number[], x: number, y: number) {
  'worklet';
  const [lo, hi] = outlineSpan(outline, y);
  if (!(hi > lo)) return -1e9;
  return Math.min(x - lo, hi - x);
}

// How much room a soft light at (x, y) has before it reaches an eye or a brow (in the face's frame; `avoid`
// holds the middle, half width and half height of each eye and brow there). 1 = well clear, 0 = on it.
// `rx` and `ry` are the light's own half sizes across and down the face.
function eyeRoom(avoid: number[], x: number, y: number, rx: number, ry: number) {
  'worklet';
  let room = 1;
  for (let i = 0; i + 3 < avoid.length; i += 4) {
    const d = Math.hypot((x - avoid[i]) / Math.max(1e-3, avoid[i + 2] + rx), (y - avoid[i + 1]) / Math.max(1e-3, avoid[i + 3] + ry));
    room = Math.min(room, ease((d - 0.95) / 0.55));
  }
  return room;
}

// How the gleam is doing right now: where it is across the face (1.25 = not yet on the sun's side, -1.25 =
// gone past the other side) and how bright it is (it fades in and out smoothly, never pops).
function shineNow(time: number): [number, number] {
  'worklet';
  const cycle = (((time / SHINE_EVERY) % 1) + 1) % 1 || 0;
  const crossing = Math.min(1, cycle / SHINE_TAKES);
  const glow = Math.sin(Math.PI * crossing);
  return [1.25 - 2.5 * ease(crossing), glow * glow];
}

function paintLiquidGold(canvas: SkCanvas, face: LensFace, sunX: number, sunY: number, viewWidth: number, time: number) {
  'worklet';
  const pts = face.pts;
  if (!pts || pts.length < 956) return;
  const w = distance(pts, MESH.leftFaceSide, MESH.rightFaceSide);
  if (!(w >= 4) || !(w < 1e6)) return;

  // The face's own frame: its middle, its tilt and how much taller than wide it is. In this frame the face is
  // a circle of radius `half`: the top of the forehead is at about -0.8 × half and the chin at 1.2 × half. It
  // is worked out from face points that stay put when you talk or laugh (not the chin or the jaw): the tilt
  // and the height from the top of the forehead (10) to the bottom of the nose (2), the middle between the
  // two sides of the face.
  const topX = pts[MESH.forehead * 2];
  const topY = pts[MESH.forehead * 2 + 1];
  const toBase = Math.hypot(pts[2 * 2] - topX, pts[2 * 2 + 1] - topY);
  if (!(toBase >= 1) || !(toBase < 1e6)) return;
  const ux = (pts[2 * 2] - topX) / toBase;
  const uy = (pts[2 * 2 + 1] - topY) / toBase;
  const half = w / 2;
  const tilt = Math.atan2(uy, ux) - Math.PI / 2;
  // About half the length from the forehead to the chin when the mouth is closed.
  const squash = Math.max(0.3, Math.min(4, (toBase * 0.9) / half)) || 1;
  const across = ((pts[MESH.leftFaceSide * 2] + pts[MESH.rightFaceSide * 2]) / 2 - topX) * uy - ((pts[MESH.leftFaceSide * 2 + 1] + pts[MESH.rightFaceSide * 2 + 1]) / 2 - topY) * ux;
  const frame = [topX + ux * toBase * 0.8 + uy * across, topY + uy * toBase * 0.8 - ux * across, Math.cos(tilt), Math.sin(tilt), squash];
  if (!(Math.abs(frame[0]) + Math.abs(frame[1]) < 1e7) || !(Math.abs(tilt) < 10)) return;
  // The face's own clock for the gleam: the further the face is from the sun's side of the view, the later
  // its gleam comes. It is worked out from where the face is (which changes smoothly), not from its place in
  // the camera's list of faces, so nothing jumps when that list changes. (The gold's slow breathing and the
  // highlights' shimmer follow the shared clock, so they never change pace when you move.)
  const t = time - SHINE_SPREAD * (Math.max(0, Math.min(1, frame[0] / viewWidth)) || 0);

  // Which way the sun is from this face, in the face's frame.
  const [toSunX, toSunY] = intoFrame(sunX, sunY, frame);
  const sunLength = Math.max(1e-3, Math.hypot(toSunX, toSunY));
  const sx = toSunX / sunLength;
  const sy = toSunY / sunLength;
  // Which side of the face is toward the sun (+1 or -1, smoothly in between if the head lies on its side).
  const sunSide = Math.max(-1, Math.min(1, sx * 4));
  // How far the face is turned: when it turns, the far side gets narrower and its highlights fade away.
  const [noseX] = intoFrame(pts[MESH.noseTip * 2], pts[MESH.noseTip * 2 + 1], frame);
  const turned = Math.max(-1, Math.min(1, (noseX / half) * 2.5));

  // The face's outline in its frame (to keep the gleam and the glints on the face).
  const outline: number[] = [];
  for (const i of MESH.faceOval) {
    const [ox, oy] = intoFrame(pts[i * 2], pts[i * 2 + 1], frame);
    outline.push(ox, oy);
  }
  // Both eyes and both brows in the face's frame (middle, half width, half height), and the strip across the
  // face from the top of the brows to the bottom of the eyes: the gleam stays out of that strip.
  const avoid: number[] = [];
  let stripTop = 1e9;
  let stripBottom = -1e9;
  for (const loop of [MESH.rightEye, MESH.leftEye, MESH.rightBrow, MESH.leftBrow]) {
    let x0 = 1e9;
    let x1 = -1e9;
    let y0 = 1e9;
    let y1 = -1e9;
    for (const i of loop) {
      const [fx, fy] = intoFrame(pts[i * 2], pts[i * 2 + 1], frame);
      x0 = Math.min(x0, fx);
      x1 = Math.max(x1, fx);
      y0 = Math.min(y0, fy);
      y1 = Math.max(y1, fy);
    }
    avoid.push((x0 + x1) / 2, (y0 + y1) / 2, Math.max(half * 0.03, (x1 - x0) / 2), Math.max(half * 0.03, (y1 - y0) / 2));
    stripTop = Math.min(stripTop, y0);
    stripBottom = Math.max(stripBottom, y1);
  }
  // How long the eyes are (corner to corner, which stays the same when you blink), for the softness of the
  // holes' edges.
  const eyeLong = (distance(pts, 33, 133) + distance(pts, 362, 263)) / 2;
  // The holes' soft edge: about a quarter of an open eye's height, so almost no gold reaches the iris and
  // there is still no cut-out edge. It doesn't change when you blink or squint, so the edges never flicker.
  const feather = Math.max(w * 0.006, Math.min(w * 0.022, eyeLong * 0.07)) || 1;
  const breathe = 0.93 + 0.07 * Math.sin(time * 0.9);
  // The hole for the nostrils, the moustache and the lips, made a little bigger around a point just under the
  // nose that stays put when you talk (so the hole's top doesn't move when your lips part): `hole` for the
  // upper gold and `holeLow`, a bit bigger, for the lower gold. `holeLow` is also kept inside the face's
  // outline: on a turned face its far side could reach past the outline, and that part would turn into a
  // patch of gold beside the face.
  const holeX = pts[2 * 2] + ux * toBase * 0.3;
  const holeY = pts[2 * 2 + 1] + uy * toBase * 0.3;
  const hole: number[] = [];
  const holeLow: number[] = [];
  const holeOrder: number[] = [];
  for (let k = 0; k < MOUTH_AREA.length; k++) {
    const i = MOUTH_AREA[k];
    hole.push(holeX + (pts[i * 2] - holeX) * 1.06, holeY + (pts[i * 2 + 1] - holeY) * 1.06);
    const [fx, fy] = intoFrame(holeX + (pts[i * 2] - holeX) * 1.15, holeY + (pts[i * 2 + 1] - holeY) * 1.15, frame);
    const [lo, hi] = outlineSpan(outline, fy);
    const margin = Math.min(half * 0.06, (hi - lo) / 2);
    const [lx, ly] = outOfFrame(hi > lo ? Math.max(lo + margin, Math.min(hi - margin, fx)) : fx, fy, frame);
    holeLow.push(lx, ly);
    holeOrder.push(k);
  }

  // 1. The gold, placed by face points that stay put when you talk or laugh: in the gold's frame the line
  //    between the eyes is at 0 and the bottom of the nose (point 2) is `half` straight down. Rich gold over
  //    the forehead, the eyes' level and the nose, and a lighter layer over both cheeks and the sides of the
  //    nose down to about the mouth corners, so the whole face is gold, not just the top half. Both fade out
  //    softly into the hair, the sides of the face and the jaw, warming to amber-brown as they fade. The
  //    nostrils, the moustache and the lips are left out with one soft hole, so they and a beard keep their
  //    natural colour. It is a tint, not paint: the face's own light and shade still show through it.
  const eyesX = (pts[133 * 2] + pts[362 * 2]) / 2;
  const eyesY = (pts[133 * 2 + 1] + pts[362 * 2 + 1]) / 2;
  const toNose = -(pts[2 * 2] - eyesX) * frame[3] + (pts[2 * 2 + 1] - eyesY) * frame[2];
  if (toNose >= 1 && toNose < 1e6) {
    const goldFrame = [eyesX, eyesY, frame[2], frame[3], Math.max(0.15, Math.min(4, toNose / half))];
    // How far up the gold goes (in steps): far enough to cover the whole forehead up to the hairline (point
    // 10 often sits below the real hairline), a little further for a tall forehead, but not up into the hair
    // (gold over dark hair turns it olive).
    const foreheadUp = ((pts[MESH.forehead * 2] - eyesX) * frame[3] - (pts[MESH.forehead * 2 + 1] - eyesY) * frame[2]) / toNose;
    const above = Math.max(2.2, Math.min(2.6, foreheadUp + GOLD_OVER)) || 2.2;
    // The gold is an egg shape: strongest across the lower forehead and the eyes' level, a little toward the
    // sun, fading out softly upward into the hair and a little faster downward, to the bottom of the nose.
    // `tall` is its middle size up and down and `egg` how far its widest part sits above where it is
    // strongest (below it when less than 0; both in steps); `step` is one step in the oval's own coordinates.
    // The gold reaches exactly `above` steps up and GOLD_DOWN steps down.
    const tall = (GOLD_DOWN + above) / 2;
    const egg = (above - GOLD_DOWN - 2 * GOLD_UP) / 2;
    canvas.save();
    enterFrame(canvas, goldFrame);
    // Its middle sits halfway between the two sides of the face (so on a turned face it moves with the
    // face and doesn't spill past the far side), a little toward the sun.
    const sidesX = ((pts[MESH.leftFaceSide * 2] + pts[MESH.rightFaceSide * 2]) / 2 - eyesX) * frame[2] + ((pts[MESH.leftFaceSide * 2 + 1] + pts[MESH.rightFaceSide * 2 + 1]) / 2 - eyesY) * frame[3];
    const oval = [sx * half * 0.05 + (Math.max(-0.4, Math.min(0.4, sidesX / half)) || 0) * half, 0, 1, 0, tall / GOLD_WIDE];
    enterFrame(canvas, oval);
    const step = half / oval[4];
    const reach = half * GOLD_WIDE;
    const gold = Skia.Paint();
    gold.setAntiAlias(true);
    gold.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, feather / Math.sqrt(goldFrame[4] * oval[4]), true));
    gold.setShader(
      Skia.Shader.MakeTwoPointConicalGradient(
        { x: 0, y: -GOLD_UP * step },
        0,
        { x: 0, y: -(GOLD_UP + egg) * step },
        reach,
        [
          goldColor('255,206,92', FACE_GOLD * breathe),
          goldColor('254,200,86', FACE_GOLD * breathe),
          goldColor('251,190,76', FACE_GOLD * 0.97),
          goldColor('246,178,66', FACE_GOLD * 0.84),
          goldColor('244,180,68', FACE_GOLD * 0.58),
          goldColor('232,160,52', FACE_GOLD * 0.3),
          goldColor('212,130,38', FACE_GOLD * 0.1),
          goldColor('186,100,28', 0),
        ],
        [0, 0.3, 0.42, 0.54, 0.66, 0.78, 0.9, 1],
        TileMode.Clamp,
      ),
    );
    canvas.drawPath(goldArea(pts, goldFrame, oval, 0, -(GOLD_UP + egg) * step, reach * 1.02, hole, holeOrder), gold);
    // The brows get a little deep warm brown in their holes, so they look like warm dark brown hair next to
    // the gold, not like cool grey painted-on lines.
    const brows = Skia.PathBuilder.Make();
    addBrowInFrame(brows, pts, MESH.leftBrow, goldFrame, oval);
    addBrowInFrame(brows, pts, MESH.rightBrow, goldFrame, oval);
    const warmBrows = Skia.Paint();
    warmBrows.setAntiAlias(true);
    warmBrows.setColor(goldColor('132,72,22', FACE_GOLD * 0.36));
    warmBrows.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, feather / Math.sqrt(goldFrame[4] * oval[4]), true));
    canvas.drawPath(brows.detach(), warmBrows);
    canvas.restore();
    // The lower gold: a lighter layer over the cheeks and the sides of the nose, right out to the sides of the
    // face and down to about the mouth corners, with a soft hole for the nostrils, the moustache and the lips.
    canvas.save();
    enterFrame(canvas, goldFrame);
    const lowArea = Skia.PathBuilder.Make();
    lowArea.setFillType(FillType.EvenOdd);
    // The face's outline, drawn in a little toward the face's middle (a point that stays put when you talk), so
    // the gold stays off the edge of the face, where sideburns and a beard grow.
    const edge: number[] = [];
    const round: number[] = [];
    for (let k = 0; k < MESH.faceOval.length; k++) {
      const i = MESH.faceOval[k];
      edge.push(frame[0] + (pts[i * 2] - frame[0]) * LOW_EDGE, frame[1] + (pts[i * 2 + 1] - frame[1]) * LOW_EDGE);
      round.push(k);
    }
    addLoopInFrame(lowArea, edge, round, 1, goldFrame);
    addLoopInFrame(lowArea, holeLow, holeOrder, 1, goldFrame);
    // Where it is full and where it starts to fade, as parts of the way from LOW_TOP to LOW_END; the fade is
    // spread evenly over the rest of the way, so it has no edge.
    const lowFull = (LOW_FULL - LOW_TOP) / (LOW_END - LOW_TOP);
    const lowFade = (LOW_FADE - LOW_TOP) / (LOW_END - LOW_TOP);
    const lower = Skia.Paint();
    lower.setAntiAlias(true);
    lower.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, (w * 0.03) / Math.sqrt(goldFrame[4]), true));
    lower.setShader(
      Skia.Shader.MakeLinearGradient(
        { x: 0, y: LOW_TOP * half },
        { x: 0, y: LOW_END * half },
        [
          goldColor('255,214,112', 0),
          goldColor('255,202,90', LOW_GOLD * breathe),
          goldColor('250,192,82', LOW_GOLD * breathe),
          goldColor('246,186,78', LOW_GOLD * 0.6),
          goldColor('232,160,56', LOW_GOLD * 0.25),
          goldColor('214,132,40', 0),
        ],
        [0, lowFull, lowFade, lowFade + (1 - lowFade) * 0.35, lowFade + (1 - lowFade) * 0.7, 1],
        TileMode.Clamp,
      ),
    );
    canvas.drawPath(lowArea.detach(), lower);
    canvas.restore();
  }

  // 2. The gleam: every few seconds a thin, bright line of light glides across the face from the sun's side
  //    to the other side, like light sliding over polished gold. It crosses the forehead, the bridge of the
  //    nose and the cheeks under the eyes, in three pieces with soft ends, and never goes into the strip of
  //    the eyes and brows (the piece on the bridge of the nose only shows while the gleam is well clear of
  //    both eyes and brows). On the cheeks the lowest piece reaches down to the bottom of the nose; over the
  //    nose it stops above the nostrils. It stays above the moustache.
  const [shineAt, shineGlow] = shineNow(t);
  const bandAngle = Math.PI / 2 + sunSide * 0.38;
  // How far the gleam leans sideways for each step down the face, and where it is at the strip's middle.
  const lean = Math.cos(bandAngle) / Math.max(1e-3, Math.sin(bandAngle));
  const bandY = (stripTop + stripBottom) / 2;
  const bandX = sunSide * shineAt * half;
  const gap = half * 0.05;
  const [, foreheadTop] = intoFrame(pts[MESH.forehead * 2], pts[MESH.forehead * 2 + 1], frame);
  const [, noseBase] = intoFrame(pts[2 * 2], pts[2 * 2 + 1], frame); // 2 = just under the nose
  // The tops of the nostrils, and where the nose is across the face and how wide (from its wings, 129 and 358).
  let nostrils = noseBase;
  for (const i of NOSTRIL_TOP) nostrils = Math.min(nostrils, intoFrame(pts[i * 2], pts[i * 2 + 1], frame)[1]);
  const [wingA] = intoFrame(pts[129 * 2], pts[129 * 2 + 1], frame);
  const [wingB] = intoFrame(pts[358 * 2], pts[358 * 2 + 1], frame);
  const coreThin = half * 0.065;
  const glowThin = half * 0.17;
  if (shineGlow > 0.005 && stripBottom > stripTop) {
    canvas.save();
    enterFrame(canvas, frame);
    for (let k = 0; k < 3; k++) {
      // k = 0: the forehead, 1: the bridge of the nose, 2: the cheeks under the eyes.
      const ya = k === 0 ? foreheadTop - half * 0.04 : k === 1 ? stripTop - gap : stripBottom + gap;
      // The piece under the eyes reaches down to the bottom of the nose on the cheeks, but over the nose (with
      // room for its glow) it stops above the nostrils, so it never lights them up.
      const overNose = 1 - ease((Math.abs(bandX + (nostrils - bandY) * lean - (wingA + wingB) / 2) - Math.abs(wingB - wingA) / 2 - glowThin * 0.5) / (half * 0.35));
      const yb = k === 0 ? stripTop - gap : k === 1 ? stripBottom + gap : noseBase - gap + (nostrils - gap * 1.5 - (noseBase - gap)) * overNose;
      // A piece with little room fades away smoothly instead of vanishing in one frame.
      const span = yb - ya;
      if (!(span > 0)) continue;
      const xa = bandX + (ya - bandY) * lean;
      const xb = bandX + (yb - bandY) * lean;
      const mx = (xa + xb) / 2;
      const my = (ya + yb) / 2;
      // Fade out near the face's edge (measured at the piece's middle and at its lower end).
      const room = Math.min(insideFace(outline, mx, my), insideFace(outline, xb, yb) + half * 0.1);
      let fade = ease((room - half * 0.08) / (half * 0.16)) * ease((span - half * 0.04) / (half * 0.3));
      if (k === 1) {
        // Only between the eyes and brows, with room to spare on both sides.
        let clear = 1e9;
        for (let i = 0; i + 3 < avoid.length; i += 4) clear = Math.min(clear, Math.abs(mx - avoid[i]) - avoid[i + 2]);
        fade *= ease((clear - glowThin * 0.7) / (half * 0.3));
      }
      const glow = SHINE * shineGlow * fade;
      if (glow < 0.01) continue;
      const long = Math.hypot(xb - xa, yb - ya) / 2;
      const angle = Math.atan2(yb - ya, xb - xa);
      // A short piece gets a narrower glow, so it stays a line and never turns into a blob.
      drawSoftOval(canvas, mx, my, long, Math.min(k === 1 ? glowThin * 0.7 : glowThin, long * 0.85), angle, [
        goldColor('255,226,140', glow * 0.32),
        goldColor('255,208,100', glow * 0.14),
        goldColor('255,200,90', 0),
      ], [0, 0.5, 1]);
      drawSoftOval(canvas, mx, my, long, Math.min(coreThin, long * 0.55), angle, [
        goldColor('255,250,224', glow),
        goldColor('255,238,176', glow * 0.7),
        goldColor('255,214,112', glow * 0.22),
        goldColor('255,200,90', 0),
      ], [0, 0.25, 0.6, 1]);
    }
    canvas.restore();
  }

  // 3. Polished highlights on the high points (forehead, nose, cheekbones, lower lip), like light on polished
  //    gold, with bright middles. A little stronger on the sun's side, each shimmering gently on its own, and
  //    they flare up as the gleam passes. Any that come near an eye or a brow fade out.
  const glints: number[] = [];
  for (let i = 0; i + 8 < GLOSS_SPOTS.length; i += 9) {
    const a = GLOSS_SPOTS[i];
    const b = GLOSS_SPOTS[i + 1];
    const along = GLOSS_SPOTS[i + 2];
    const x = pts[a * 2] + (pts[b * 2] - pts[a * 2]) * along;
    const y = pts[a * 2 + 1] + (pts[b * 2 + 1] - pts[a * 2 + 1]) * along;
    const c = GLOSS_SPOTS[i + 3];
    const d = GLOSS_SPOTS[i + 4];
    const angle = Math.atan2(pts[d * 2 + 1] - pts[c * 2 + 1], pts[d * 2] - pts[c * 2]);
    const long = w * GLOSS_SPOTS[i + 5];
    const thin = w * GLOSS_SPOTS[i + 6];
    const [fx, fy] = intoFrame(x, y, frame);
    // The oval's half sizes across and down the face, for keeping it off the eyes and brows.
    const across = Math.abs(Math.cos(angle - tilt));
    const down = Math.abs(Math.sin(angle - tilt));
    const clear = eyeRoom(avoid, fx, fy, across * long + down * thin, (down * long + across * thin) / squash);
    const toSun = (fx * sx + fy * sy) / half;
    const sunLit = 0.8 + 0.2 * Math.max(-1, Math.min(1, toSun * 1.6));
    const farSide = Math.max(0, Math.min(1, 1 - Math.max(0, (fx / half) * turned) * 1.6));
    // How close the gleam is to this spot (allowing for its lean); only on the upper face, so the lips don't
    // light up.
    const near = (fx - (bandX + (fy - bandY) * lean)) / half;
    const upper = 1 - ease((fy - noseBase + half * 0.05) / (half * 0.12));
    const passing = Math.exp(-(near * near) / 0.035) * upper * shineGlow * farSide;
    const shimmer = 0.88 + 0.12 * Math.sin(time * 1.3 + i * 0.7);
    // It fades out when it would reach past the face's edge (on the far cheek of a turned face), so it never
    // leaves a pale mark on the face's outline.
    const onFace = ease((insideFace(outline, fx, fy) - (across * long + down * thin) - half * 0.02) / (half * 0.1));
    const bright = (GLOSS * GLOSS_SPOTS[i + 7] * sunLit * shimmer * breathe + 0.5 * passing) * farSide * clear * onFace;
    if (bright < 0.01) continue;
    const grow = 1 + 0.2 * passing;
    drawSoftOval(canvas, x, y, long * grow, thin * grow, angle, [
      goldColor('255,254,244', bright),
      goldColor('255,244,200', bright * 0.8),
      goldColor('255,220,130', bright * 0.32),
      goldColor('255,204,100', 0),
    ], [0, 0.18, 0.5, 1]);
    // Remember the high points the gleam is lighting right now, for their glints. A glint fades out near
    // the face's edge and on the far side of a turned face.
    const edge = ease((insideFace(outline, fx, fy) - half * 0.12) / (half * 0.15));
    const flash = GLOSS_SPOTS[i + 8] === 1 ? passing * clear * edge * farSide : 0;
    if (flash > 0.08) glints.push(x, y, flash, fx, fy);
  }
  // At most two glints at a time: each one is only as bright as it is above the third brightest (and above
  // a small floor), so they never pop in or out when they swap places.
  let first = 0;
  let second = 0;
  let third = 0.08;
  for (let k = 2; k < glints.length; k += 5) {
    const f = glints[k];
    if (f > first) {
      third = Math.max(third, second);
      second = first;
      first = f;
    } else if (f > second) {
      third = Math.max(third, second);
      second = f;
    } else third = Math.max(third, f);
  }

  // 4. Glints: when the gleam passes a high point it flashes – a bright warm dot with one thin streak of
  //    light along the face, like the sun catching a lens. The streak follows a tilt, stays inside the face
  //    and is made shorter wherever it would reach an eye or a brow.
  for (let k = 0; k + 4 < glints.length; k += 5) {
    const strength = (glints[k + 2] - third) / Math.max(1e-3, 1 - third);
    if (strength < 0.01) continue;
    const x = glints[k];
    const y = glints[k + 1];
    const flash = GLINT * strength;
    const fx = glints[k + 3];
    const fy = glints[k + 4];
    const thick = Math.max(0.6, w * 0.007);
    // No longer than the room to the face's edge on either side.
    let streak = Math.min(w * 0.28 * (0.6 + 0.4 * strength), insideFace(outline, fx, fy) - half * 0.08);
    for (let i = 0; i + 3 < avoid.length; i += 4) {
      // How level the glint is with this eye or brow (1 = the streak would run into it), and how long the
      // streak may be before it gets there.
      const level = 1 - ease((Math.abs(fy - avoid[i + 1]) - avoid[i + 3] - (thick * 3) / squash - half * 0.06) / (half * 0.1));
      const room = Math.abs(fx - avoid[i]) - avoid[i + 2] - half * 0.08;
      streak = Math.min(streak, streak + (room - streak) * level);
    }
    // A streak with little room fades away instead of shrinking to a dot.
    const streakFade = ease((streak - w * 0.05) / (w * 0.06));
    if (streakFade > 0.01) {
      drawSoftOval(canvas, x, y, streak, thick, tilt, [
        goldColor('255,246,215', flash * 0.9 * streakFade),
        goldColor('255,214,124', flash * 0.45 * streakFade),
        goldColor('255,190,90', 0),
      ], [0, 0.25, 1]);
    }
    drawSoftOval(canvas, x, y, w * 0.045, w * 0.045, 0, [
      goldColor('255,255,246', flash),
      goldColor('255,232,160', flash * 0.45),
      goldColor('255,206,110', 0),
    ], [0, 0.3, 1]);
  }
}

// Where a face is and how big, for keeping the sun's glow and streak off it: its middle and a radius that
// takes in the hair. [0, 0, 0] if the face points are broken.
function faceCircle(face: LensFace): [number, number, number] {
  'worklet';
  const pts = face.pts;
  if (!pts || pts.length < 956) return [0, 0, 0];
  const x = (pts[MESH.forehead * 2] + pts[MESH.chin * 2]) / 2;
  const y = (pts[MESH.forehead * 2 + 1] + pts[MESH.chin * 2 + 1]) / 2;
  const r = Math.max(distance(pts, MESH.forehead, MESH.chin), distance(pts, MESH.leftFaceSide, MESH.rightFaceSide)) * 0.62;
  if (!(r >= 2) || !(Math.abs(x) + Math.abs(y) < 1e7)) return [0, 0, 0];
  return [x, y, r];
}

// How much of a golden orb to keep at (x, y): none over a face, its hair or its neck, all of it away from
// them. `r` is the orb's size.
function awayFromFaces(faces: LensFace[], x: number, y: number, r: number) {
  'worklet';
  let keep = 1;
  for (const face of faces) {
    const pts = face.pts;
    if (!pts || pts.length < 956) continue;
    // The face's own directions: across (to its side) and down (forehead to chin), from its middle.
    const ax = (pts[MESH.leftFaceSide * 2] - pts[MESH.rightFaceSide * 2]) / 2;
    const ay = (pts[MESH.leftFaceSide * 2 + 1] - pts[MESH.rightFaceSide * 2 + 1]) / 2;
    const bx = (pts[MESH.chin * 2] - pts[MESH.forehead * 2]) / 2;
    const by = (pts[MESH.chin * 2 + 1] - pts[MESH.forehead * 2 + 1]) / 2;
    const size = ax * by - ay * bx;
    const across = Math.hypot(ax, ay);
    if (!(Math.abs(size) >= 1) || !(across >= 2)) continue;
    const dx = x - (pts[MESH.forehead * 2] + pts[MESH.chin * 2]) / 2;
    const dy = y - (pts[MESH.forehead * 2 + 1] + pts[MESH.chin * 2 + 1]) / 2;
    const u = (dx * by - dy * bx) / size;
    const v = (ax * dy - ay * dx) / size;
    const d = Math.hypot(u / 1.3, (v - 0.3) / 1.75) - r / (across * 1.3);
    keep = Math.min(keep, ease((d - 1) / 0.45));
  }
  return keep;
}

function paintGoldenHour(canvas: SkCanvas, faces: LensFace[], width: number, height: number, time: number, fill: SkRect) {
  'worklet';
  // Everything for the whole picture is placed from `fill` (the view live, the whole photo when saving), so
  // the saved photo has the sun in the same place as the camera did: just past the left edge. If `fill`
  // can't be read, the camera view is used instead.
  const readable = fill.width >= 1 && fill.height >= 1 && Math.abs(fill.x) + Math.abs(fill.y) + fill.width + fill.height < 1e7;
  const picture = readable ? fill : Skia.XYWHRect(0, 0, width, height);
  const left = readable ? fill.x : 0;
  const top = readable ? fill.y : 0;
  const fw = readable ? fill.width : width;
  const fh = readable ? fill.height : height;
  if (!(fw >= 1) || !(fh >= 1) || !(fw + fh < 1e7)) return;
  const sunX = left + fw * SUN_AT[0];
  const sunY = top + fh * SUN_AT[1];
  const diag = Math.hypot(fw, fh);
  const shimmer = 0.94 + 0.06 * Math.sin(time * 0.6);

  // 1. The whole picture tinted a light, deep amber (a touch richer toward the sun). A deep colour at a low
  //    amount warms the picture without lifting the dark parts, so it doesn't look foggy.
  const honey = Skia.Paint();
  honey.setShader(
    Skia.Shader.MakeRadialGradient(
      { x: sunX, y: sunY },
      diag,
      [goldColor('218,128,20', HONEY * 1.1), goldColor('206,116,16', HONEY), goldColor('192,102,14', HONEY * 0.95)],
      [0, 0.45, 1],
      TileMode.Clamp,
    ),
  );
  canvas.drawRect(picture, honey);
  // Darker warm-brown corners, for the evening mood.
  const vignette = Skia.Paint();
  vignette.setShader(
    Skia.Shader.MakeRadialGradient(
      { x: left + fw * 0.52, y: top + fh * 0.46 },
      diag * 0.62,
      [goldColor('50,20,0', 0), goldColor('50,20,0', 0), goldColor('50,20,0', VIGNETTE)],
      [0, 0.5, 1],
      TileMode.Clamp,
    ),
  );
  canvas.drawRect(picture, vignette);

  // 2. The sun, mostly out of the picture: a warm glow with a bright middle at the left edge, soft sunbeams
  //    fanning out of it and a long thin streak of light across the picture, like a camera lens makes. All of
  //    it is drawn before the faces' gold, so the gold lies on top of the faint sunbeams. The brightest glow
  //    fades when a face comes near the sun, and the streak ends (softly) before it reaches a face, so a face
  //    is never crossed by it or fogged.
  const glowSize = fw * 0.5;
  let sunClear = 1;
  let streakLong = fw * 0.95;
  for (const face of faces) {
    const [fx, fy, fr] = faceCircle(face);
    if (fr <= 0) continue;
    sunClear = Math.min(sunClear, ease((Math.hypot(fx - sunX, fy - sunY) - fr) / (glowSize * 0.6)));
    // How much the streak's line runs through this face (1 = right through it), and how far it can go
    // before it reaches the face.
    const dy = Math.abs(fy - sunY);
    const onFace = 1 - ease((dy - fr) / (fr * 0.3));
    const faceLeft = fx - Math.sqrt(Math.max(0, fr * fr - Math.min(dy, fr) * Math.min(dy, fr)));
    const room = Math.max(0, faceLeft - sunX - fw * 0.03);
    streakLong = Math.min(streakLong, streakLong + (room - streakLong) * onFace);
  }
  const glowNow = SUN_GLOW * shimmer * (0.3 + 0.7 * sunClear);
  const sun = Skia.Paint();
  sun.setShader(
    Skia.Shader.MakeRadialGradient(
      { x: sunX, y: sunY },
      glowSize,
      [
        goldColor('255,250,232', glowNow),
        goldColor('255,236,180', glowNow * 0.75),
        goldColor('255,200,110', glowNow * 0.28),
        goldColor('250,170,70', glowNow * 0.07),
        goldColor('250,166,64', 0),
      ],
      [0, 0.1, 0.3, 0.6, 1],
      TileMode.Clamp,
    ),
  );
  // Only the round patch where the glow is (it is see-through beyond it), which saves drawing time.
  canvas.drawCircle(sunX, sunY, glowSize, sun);
  // The sunbeams: one gradient that goes round the sun, swaying very slowly, so it costs very little.
  const sway = 1.5 * Math.sin(time * 0.31);
  const rayColors = [goldColor('255,226,160', 0)];
  const rayStops = [0];
  for (let i = 0; i + 2 < SUN_RAYS.length; i += 3) {
    const middle = SUN_RAYS[i] + sway;
    const halfWidth = SUN_RAYS[i + 1];
    const glow = SUNBEAMS * SUN_RAYS[i + 2] * (0.8 + 0.2 * Math.sin(time * 0.7 + i)) * (0.5 + 0.5 * sunClear);
    rayStops.push((middle - halfWidth) / 360, middle / 360, (middle + halfWidth) / 360);
    rayColors.push(goldColor('255,226,160', 0), goldColor('255,230,170', glow), goldColor('255,226,160', 0));
  }
  rayStops.push(1);
  rayColors.push(goldColor('255,226,160', 0));
  const beams = Skia.Paint();
  beams.setShader(Skia.Shader.MakeSweepGradient(sunX, sunY, rayColors, rayStops, TileMode.Clamp));
  canvas.drawRect(picture, beams);
  // The streak: a faint soft haze with a thin bright line in it. A streak that has little room fades away.
  const streakFade = ease((streakLong - fw * 0.12) / (fw * 0.12));
  if (streakFade > 0.01) {
    drawSoftOval(canvas, sunX, sunY, streakLong * 1.05, fw * 0.022, 0, [
      goldColor('255,214,140', STREAK * 0.3 * shimmer * streakFade),
      goldColor('255,194,104', STREAK * 0.12 * shimmer * streakFade),
      goldColor('255,180,90', 0),
    ], [0, 0.4, 1]);
    drawSoftOval(canvas, sunX, sunY, streakLong, fw * 0.0045, 0, [
      goldColor('255,252,236', STREAK * shimmer * streakFade),
      goldColor('255,230,170', STREAK * 0.6 * shimmer * streakFade),
      goldColor('255,214,140', STREAK * 0.18 * streakFade),
      goldColor('255,210,130', 0),
    ], [0, 0.06, 0.5, 1]);
  }

  // 3. Each face: the gold, the gleam, polished highlights and glints (the gleam comes later the further
  //    right the face is, see paintLiquidGold).
  for (const face of faces) paintLiquidGold(canvas, face, sunX, sunY, width, time);

  // 4. Soft golden orbs, like sunlight out of focus in a lens: softly filled warm discs (no bright rim) that
  //    fade in, drift slowly away from the sun and fade out again before they start over, so none ever pops.
  //    They stay off faces. Like the sun, they are placed in the whole picture (`fill`).
  const awayX = left + fw * 0.5 - sunX;
  const awayY = top + fh * 0.5 - sunY;
  const away = Math.max(1e-3, Math.hypot(awayX, awayY));
  for (let i = 0; i + 4 < BOKEH_ORBS.length; i += 5) {
    const trip = time / BOKEH_ORBS[i + 3] + BOKEH_ORBS[i + 4];
    const life = trip - Math.floor(trip);
    const x = left + BOKEH_ORBS[i] * fw + (awayX / away) * life * fw * 0.24 + Math.sin(trip * 2.1) * fw * 0.01;
    const y = top + BOKEH_ORBS[i + 1] * fh + (awayY / away) * life * fw * 0.24;
    const r = fw * BOKEH_ORBS[i + 2];
    const fade = Math.sin(Math.PI * life);
    const alpha = BOKEH * fade * fade * awayFromFaces(faces, x, y, r);
    if (!(alpha >= 0.005) || !(r >= 1)) continue;
    const orb = Skia.Paint();
    orb.setAntiAlias(true);
    orb.setShader(
      Skia.Shader.MakeRadialGradient(
        { x, y },
        r,
        [goldColor('255,210,128', alpha), goldColor('255,206,122', alpha * 0.9), goldColor('255,200,116', alpha * 0.5), goldColor('255,196,110', 0)],
        [0, 0.5, 0.8, 1],
        TileMode.Clamp,
      ),
    );
    canvas.drawCircle(x, y, r, orb);
  }
}

// Draws `look` for these faces. `width`/`height` is the camera view. `fill` is the area the whole-picture
// parts (warm tint, corners, sun, sunbeams, streak and orbs, the aura's purple corners, the brain's green
// flash, the glitch line) must cover – the view itself live, the whole photo when saving. `time` is in
// seconds (for the twinkle, the gleam, a slow shimmer, the spinner, the heartbeat, and where each tear and
// heart is). `src` is only for the 4 stretchy filters: the camera picture (or the photo) they move around;
// without it they draw nothing. The other looks never use it.
// A look it doesn't know is an error (never a quiet stand-in): the live camera then switches only that look
// off, and the saved photo comes without it.
export function paintLook(
  canvas: SkCanvas,
  look: LensLook,
  faces: LensFace[],
  width: number,
  height: number,
  time: number,
  fill?: SkRect,
  src?: WarpSource | null,
) {
  'worklet';
  if (width <= 0 || height <= 0) return;
  const now = Number.isFinite(time) ? time : 0;
  const area = fill ?? Skia.XYWHRect(0, 0, width, height);
  switch (look) {
    case 'glow':
      for (const face of faces) paintSoftGlow(canvas, face, time);
      return;
    case 'golden':
      paintGoldenHour(canvas, faces, width, height, now, area);
      return;
    case 'peekabooEyes':
      paintPeekabooEyes(canvas, faces, now);
      return;
    case 'brainBuffering':
      paintBrainBuffering(canvas, faces, now, area);
      return;
    case 'crybaby':
      paintCrybaby(canvas, faces, now);
      return;
    case 'auraOverload':
      paintAuraOverload(canvas, faces, now, area, width, height);
      return;
    case 'heartEyes':
      paintHeartEyes(canvas, faces, now);
      return;
    case 'tinyFace':
    case 'gigachin':
    case 'bigMouth':
    case 'pixelPanic':
      paintWarpLook(canvas, look, faces, now, area, src);
      return;
    default: {
      const unknown: never = look;
      throw new Error(`Unknown face filter: ${String(unknown)}`);
    }
  }
}
