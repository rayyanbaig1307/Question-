import { expect, it } from 'vitest';

import { faceLight, LIGHT_SPOTS, spotBrightness, spotShade } from '../../src/lib/goldenLight.ts';

// A made-up head (centimetres): the five points faceLight uses to find how the head is turned.
// x = toward the person's left, y = down, z = away from the camera (the nose is closest).
const HEAD = { 454: [7, 0, 4], 234: [-7, 0, 4], 10: [0, -10, 2], 152: [0, 9, 2], 1: [0, 1, -3] };

// The head turned by `yaw` (positive = toward the screen's left, where the sun is), drawn on a 400-wide
// screen. `mirror` = a selfie (left and right swapped on screen). `depthUnits` = how MediaPipe scales z.
function face({ yaw = 0, mirror = false, depthUnits = 0.01 } = {}) {
  const screen = new Array(478 * 2).fill(200);
  const depth = new Array(478).fill(0);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  for (const [index, [x, y, z]] of Object.entries(HEAD)) {
    // Person facing the camera: their left is on the screen's right. Turning: x' = x cos − z sin…
    const rx = x * c + z * s;
    const rz = -x * s + z * c;
    screen[index * 2] = 200 + (mirror ? -rx : rx) * 10;
    screen[index * 2 + 1] = 300 + y * 10;
    depth[index] = rz * depthUnits;
  }
  return faceLight(screen, depth);
}

const spot = point => LIGHT_SPOTS.findIndex(item => item.point === point);
const RIGHT_CHEEKBONE = spot(116);
const LEFT_CHEEKBONE = spot(345);

it('the side of the face toward the sun (top-left of the screen) gets the light', () => {
  const { light } = face();
  // Not mirrored: the person's right cheek is on the screen's left, nearer the sun.
  expect(light[RIGHT_CHEEKBONE]).toBeGreaterThan(light[LEFT_CHEEKBONE]);
  expect(spotBrightness(light[RIGHT_CHEEKBONE])).toBeGreaterThan(spotBrightness(light[LEFT_CHEEKBONE]));
});

it('a selfie (mirrored) lights whichever cheek is on the sun side of the screen', () => {
  const { light } = face({ mirror: true });
  expect(light[LEFT_CHEEKBONE]).toBeGreaterThan(light[RIGHT_CHEEKBONE]);
});

it('turning toward the sun brings light onto the far cheek; turning away takes it off', () => {
  const away = face({ yaw: -0.5 }).light[LEFT_CHEEKBONE];
  const straight = face({ yaw: 0 }).light[LEFT_CHEEKBONE];
  const toward = face({ yaw: 0.5 }).light[LEFT_CHEEKBONE];
  expect(away).toBeLessThan(straight);
  expect(straight).toBeLessThan(toward);
});

it("doesn't depend on MediaPipe's depth units", () => {
  const a = face({ yaw: 0.3, depthUnits: 0.01 });
  const b = face({ yaw: 0.3, depthUnits: 0.37 });
  a.light.forEach((value, i) => expect(b.light[i]).toBeCloseTo(value, 6));
  expect(b.rim).toBeCloseTo(a.rim, 6);
});

it('gives one value per spot, all sensible, even for a flat face with no depth', () => {
  for (const result of [face(), face({ depthUnits: 0 })]) {
    expect(result.light).toHaveLength(LIGHT_SPOTS.length);
    for (const value of result.light) {
      expect(Number.isFinite(value)).toBe(true);
      expect(Math.abs(value)).toBeLessThanOrEqual(1 + 1e-9);
    }
    expect(result.rim).toBeGreaterThanOrEqual(0);
    expect(result.rim).toBeLessThanOrEqual(1);
  }
});

it('brightness and shade fade in softly and stay between 0 and 1', () => {
  expect(spotBrightness(0)).toBe(0);
  expect(spotBrightness(1)).toBe(1);
  expect(spotBrightness(0.6)).toBeGreaterThan(0);
  expect(spotBrightness(0.6)).toBeLessThan(1);
  expect(spotShade(0.5)).toBe(0);
  expect(spotShade(-1)).toBe(1);
});
