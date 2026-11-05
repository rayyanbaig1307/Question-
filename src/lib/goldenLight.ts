// ---------------------------------------------------------------------------
// The light for the "Golden Hour" face filter 🌅: works out how much low sunset light falls on each part of
// a face, using the face's 3D points (MediaPipe gives each point a depth, `z`).
//
// How it works, in plain words:
//  1. From the 3D points we find which way the head is turned and tilted (its "left", "down" and "forward").
//  2. Each lit spot (a cheekbone, the jaw, the temple…) has a direction its skin faces, measured on a face
//     looking straight at you. We turn those directions with the head.
//  3. A spot is lit as much as its skin faces the sun (the sun is low, to the top-left of the screen, a
//     little in front of you). Turn your face toward the sun and that cheek lights up; turn away and the
//     light slides off.
//
// No drawing here, only numbers – the drawing is in components/lens/lensPaint.ts. Kept free of app imports
// so it can be tested on a computer (tests/unit/golden-light.test.mjs).
// ---------------------------------------------------------------------------

type Vec = [number, number, number];

function norm(v: Vec): Vec {
  'worklet';
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function dot(a: Vec, b: Vec) {
  'worklet';
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// Where the sun is, seen from the face, on screen: x to the right, y down, z away from the camera.
// So this is "left, up, and toward the camera" – low evening sun from the top-left corner, like the flare.
export const SUN: Vec = norm([-0.8, -0.38, -0.55]);

// The same direction flat on the screen (for the rim light and the flare).
export const SUN_ON_SCREEN = (() => {
  const length = Math.hypot(SUN[0], SUN[1]) || 1;
  return { x: SUN[0] / length, y: SUN[1] / length };
})();

// The lit spots. `point` is a face-mesh point (see MESH in lib/faceMesh.ts). `faces` is which way the skin
// there faces on a face looking straight at the camera: [toward the person's left, down, forward].
// `size` is the spot's size compared with the face width.
export type LightSpot = { point: number; faces: Vec; size: number };

const RIGHT_SIDE: LightSpot[] = [
  { point: 116, faces: [-0.55, -0.15, 0.82], size: 0.17 }, // cheekbone
  { point: 205, faces: [-0.42, 0.08, 0.9], size: 0.15 }, // cheek
  { point: 234, faces: [-0.92, 0.0, 0.38], size: 0.12 }, // side of the face
  { point: 127, faces: [-0.8, -0.3, 0.52], size: 0.12 }, // temple
  { point: 54, faces: [-0.5, -0.55, 0.68], size: 0.14 }, // forehead, side
  { point: 172, faces: [-0.75, 0.35, 0.56], size: 0.12 }, // jaw
  { point: 136, faces: [-0.55, 0.62, 0.56], size: 0.1 }, // lower jaw
];
// The person's left side: the same spots on the other half of the mesh, facing the other way.
const MIRROR: Record<number, number> = { 116: 345, 205: 425, 234: 454, 127: 356, 54: 284, 172: 397, 136: 365 };
const LEFT_SIDE: LightSpot[] = RIGHT_SIDE.map((spot) => ({
  point: MIRROR[spot.point],
  faces: [-spot.faces[0], spot.faces[1], spot.faces[2]],
  size: spot.size,
}));
const MIDDLE: LightSpot[] = [
  { point: 10, faces: [0, -0.5, 0.86], size: 0.18 }, // forehead
  { point: 6, faces: [0, -0.25, 0.97], size: 0.07 }, // top of the nose
  { point: 152, faces: [0, 0.62, 0.78], size: 0.1 }, // chin
];

export const LIGHT_SPOTS: LightSpot[] = [...RIGHT_SIDE, ...LEFT_SIDE, ...MIDDLE];

// For the rim light: the very sides of the face.
const SIDE_LEFT: Vec = [0.95, 0, 0.3];
const SIDE_RIGHT: Vec = [-0.95, 0, 0.3];

// Mesh points used to find the head's turn.
const LEFT = 454;
const RIGHT = 234;
const TOP = 10;
const CHIN = 152;
const NOSE = 1;

// How deep a face is compared with its height (nose tip to the sides of the face, about 9 cm on a 19 cm
// face). Used to turn MediaPipe's depth numbers into the same units as the screen points.
const DEPTH_TO_HEIGHT = 0.45;

export type FaceLight = {
  // How much each spot in LIGHT_SPOTS faces the sun: 1 = straight at it, 0 = side-on, below 0 = away.
  light: number[];
  // How strongly the edge of the face catches the light (0–1), for the golden rim.
  rim: number;
};

// `screen`: the face's screen points (x0, y0, x1, y1, …). `depth`: MediaPipe's z for each point (in the
// order of the points; smaller = closer to the camera).
export function faceLight(screen: number[], depth: number[]): FaceLight {
  'worklet';
  const sx = (i: number) => screen[i * 2];
  const sy = (i: number) => screen[i * 2 + 1];
  const height = Math.hypot(sx(CHIN) - sx(TOP), sy(CHIN) - sy(TOP));
  // How far the sides of the face are behind the nose, in MediaPipe's units → screen units.
  const rawDepth = (depth[LEFT] + depth[RIGHT]) / 2 - depth[NOSE];
  const zScale = Number.isFinite(rawDepth) && Math.abs(rawDepth) > 1e-6 ? (DEPTH_TO_HEIGHT * height) / Math.abs(rawDepth) : 0;
  const p = (i: number): Vec => [sx(i), sy(i), (depth[i] ?? 0) * zScale];

  // The head's own directions: toward the person's left, down (forehead → chin), and forward (out of the face).
  const l = p(LEFT);
  const r = p(RIGHT);
  const toLeft = norm([l[0] - r[0], l[1] - r[1], l[2] - r[2]]);
  const top = p(TOP);
  const chin = p(CHIN);
  const rawDown: Vec = [chin[0] - top[0], chin[1] - top[1], chin[2] - top[2]];
  const along = dot(rawDown, toLeft);
  const down = norm([rawDown[0] - along * toLeft[0], rawDown[1] - along * toLeft[1], rawDown[2] - along * toLeft[2]]);
  let forward: Vec = [
    toLeft[1] * down[2] - toLeft[2] * down[1],
    toLeft[2] * down[0] - toLeft[0] * down[2],
    toLeft[0] * down[1] - toLeft[1] * down[0],
  ];
  // Forward must point at the camera (z goes away from it). This also takes care of selfie mirroring.
  if (forward[2] > 0) forward = [-forward[0], -forward[1], -forward[2]];

  const turn = (v: Vec): Vec =>
    norm([
      v[0] * toLeft[0] + v[1] * down[0] + v[2] * forward[0],
      v[0] * toLeft[1] + v[1] * down[1] + v[2] * forward[1],
      v[0] * toLeft[2] + v[1] * down[2] + v[2] * forward[2],
    ]);

  const light = LIGHT_SPOTS.map((spot) => dot(turn(spot.faces), SUN));
  const rim = Math.max(0, Math.min(1, Math.max(dot(turn(SIDE_LEFT), SUN), dot(turn(SIDE_RIGHT), SUN))));
  return { light, rim };
}

// Turns "how much it faces the sun" into how bright the spot is drawn (0–1): only spots that really face
// the sun get light, with a soft start so it never looks like a hard-edged sticker.
export function spotBrightness(facing: number) {
  'worklet';
  const t = Math.max(0, Math.min(1, (facing - 0.35) / 0.6));
  return t * t * (3 - 2 * t);
}

// And how much shade a spot facing away gets (kept very faint).
export function spotShade(facing: number) {
  'worklet';
  const t = Math.max(0, Math.min(1, (-facing - 0.05) / 0.55));
  return t * t * (3 - 2 * t);
}
