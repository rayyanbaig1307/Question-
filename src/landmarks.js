// MediaPipe Face Landmarker: 478 landmarks (468 mesh + 10 iris points).
// Indices below are the canonical face-mesh indices.
export const LM = {
  foreheadTop: 10,
  chin: 152,
  noseTip: 1,
  noseBridge: 6,
  noseBottom: 2,
  leftCheek: 234,  // viewer's left when NOT mirrored; subject's right
  rightCheek: 454,
  leftEyeOuter: 33,
  leftEyeInner: 133,
  leftEyeTop: 159,
  leftEyeBottom: 145,
  rightEyeInner: 362,
  rightEyeOuter: 263,
  rightEyeTop: 386,
  rightEyeBottom: 374,
  leftIris: 468,
  rightIris: 473,
  leftBrowInner: 107,
  leftBrowOuter: 70,
  leftBrowMid: 105,
  rightBrowInner: 336,
  rightBrowOuter: 300,
  rightBrowMid: 334,
  mouthLeft: 61,
  mouthRight: 291,
  upperLipTop: 0,
  upperLipBottom: 13,
  lowerLipTop: 14,
  lowerLipBottom: 17,
  chinTop: 18,
  leftCheekBlush: 50,
  rightCheekBlush: 280,
};

// Face oval contour, ordered clockwise around the face.
export const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378,
  400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21,
  54, 103, 67, 109,
];

export const LEFT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
export const RIGHT_EYE = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398];
export const LIPS_OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** Convert normalized landmarks to pixel space for a W×H canvas. */
export function toPixels(landmarks, W, H) {
  const out = new Array(landmarks.length);
  for (let i = 0; i < landmarks.length; i++) {
    const l = landmarks[i];
    out[i] = { x: l.x * W, y: l.y * H, z: l.z * W };
  }
  return out;
}

/** Bounding box of a set of landmark indices, optionally padded (fraction of size). */
export function bbox(pts, indices, pad = 0) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of indices) {
    const p = pts[i];
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  const w = x1 - x0, h = y1 - y0;
  return { x: x0 - w * pad, y: y0 - h * pad, w: w * (1 + 2 * pad), h: h * (1 + 2 * pad), cx: x0 + w / 2, cy: y0 + h / 2 };
}

/** Derived face measurements every filter can use. */
export function faceMetrics(pts) {
  const lEye = mid(pts[LM.leftEyeOuter], pts[LM.leftEyeInner]);
  const rEye = mid(pts[LM.rightEyeOuter], pts[LM.rightEyeInner]);
  const eyeDist = dist(lEye, rEye);
  const width = dist(pts[LM.leftCheek], pts[LM.rightCheek]);
  const height = dist(pts[LM.foreheadTop], pts[LM.chin]);
  const roll = Math.atan2(rEye.y - lEye.y, rEye.x - lEye.x);
  const center = mid(pts[LM.foreheadTop], pts[LM.chin]);
  const mouth = mid(pts[LM.upperLipBottom], pts[LM.lowerLipTop]);
  return {
    lEye, rEye, eyeDist, width, height, roll, center, mouth,
    lEyeW: dist(pts[LM.leftEyeOuter], pts[LM.leftEyeInner]),
    rEyeW: dist(pts[LM.rightEyeOuter], pts[LM.rightEyeInner]),
    mouthW: dist(pts[LM.mouthLeft], pts[LM.mouthRight]),
    mouthOpen: dist(pts[LM.upperLipBottom], pts[LM.lowerLipTop]),
    forehead: pts[LM.foreheadTop],
    chin: pts[LM.chin],
    nose: pts[LM.noseTip],
  };
}

/** Blendshape category list -> {name: score} map. */
export function blendMap(categories) {
  const m = Object.create(null);
  if (!categories) return m;
  for (const c of categories) m[c.categoryName] = c.score;
  return m;
}

/** Exponential smoother for noisy per-frame signals. */
export class Smoother {
  constructor(alpha = 0.35) {
    this.alpha = alpha;
    this.values = Object.create(null);
  }
  get(key, raw, alpha = this.alpha) {
    const prev = this.values[key];
    const v = prev === undefined ? raw : prev + (raw - prev) * alpha;
    this.values[key] = v;
    return v;
  }
}
