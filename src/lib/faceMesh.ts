import { useEffect, useMemo, useRef } from 'react';
import { TurboModuleRegistry } from 'react-native';
import type { HybridObject } from 'react-native-nitro-modules';
import type { CameraOutput, CameraRef } from 'react-native-vision-camera';

// ---------------------------------------------------------------------------
// Face mesh: Google's MediaPipe Face Landmarker on the live camera. It finds 478 points on each face (eyes,
// lips, the face outline, the irises…) plus 52 expression scores (smile, blink, jaw open…). Much more detail
// than the ML Kit tracking the googly lens uses, so lenses can follow the real shape of a face.
//
// The native part lives in modules/face-mesh (see docs/FACE_MESH.md). Only app downloads built with it have
// it. Expo Go and older downloads don't, so FACE_MESH_AVAILABLE is false there and the app keeps using the
// googly lens (lib/faceLens.ts). Nothing here loads a native module unless it's really there.
// ---------------------------------------------------------------------------

// One face, as the native part sends it (same shape as modules/face-mesh/src/specs/FaceMeshFactory.nitro.ts).
export type FaceMeshFace = {
  // 478 points packed as x0, y0, z0, x1, … in VisionCamera camera coordinates.
  points: number[];
  // 52 expression scores, 0–1, in MediaPipe's order (see BLENDSHAPE below). Empty when turned off.
  blendshapes: number[];
};

export type FaceMeshOutputOptions = {
  maxFaces?: number;
  blendshapes?: boolean;
  onFaces: (faces: FaceMeshFace[]) => void;
  onError: (error: Error) => void;
};

interface FaceMeshFactory extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
  isModelReady(): boolean;
  createFaceMeshOutput(options: FaceMeshOutputOptions): CameraOutput;
}

function loadFactory(): FaceMeshFactory | null {
  try {
    // Asking first, because these libraries crash if they're loaded without their native parts.
    if (!TurboModuleRegistry.get('NitroModules')) return null;
    // The Soft Glow drawing needs Skia too.
    if (!TurboModuleRegistry.get('RNSkiaModule')) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NitroModules } = require('react-native-nitro-modules') as typeof import('react-native-nitro-modules');
    if (!NitroModules.hasHybridObject('CameraFactory') || !NitroModules.hasHybridObject('FaceMeshFactory')) return null;
    const factory = NitroModules.createHybridObject<FaceMeshFactory>('FaceMeshFactory');
    // The model file has to be inside the app as well.
    return factory.isModelReady() ? factory : null;
  } catch {
    return null;
  }
}

const factory = loadFactory();

export const FACE_MESH_AVAILABLE = factory !== null;

// A camera output for VisionCamera's `outputs` that calls `onFaces` for every frame it looks at.
// The callbacks may change between renders; the output itself is only made again when the settings change.
export function useFaceMeshOutput({ maxFaces = 2, blendshapes = true, onFaces, onError }: FaceMeshOutputOptions): CameraOutput | null {
  // The newest callbacks, kept in one box that never changes, so the camera output doesn't have to be remade.
  const listeners = useRef({ onFaces, onError });
  useEffect(() => {
    listeners.current = { onFaces, onError };
  });
  return useMemo(() => {
    if (!factory) return null;
    try {
      // The ref is only read later, when a frame comes in – never while drawing the screen.
      // eslint-disable-next-line react-hooks/refs
      return factory.createFaceMeshOutput({
        maxFaces,
        blendshapes,
        onFaces: (faces) => listeners.current.onFaces(faces),
        onError: (error) => listeners.current.onError(error),
      });
    } catch (error) {
      console.warn('Face mesh', error);
      return null;
    }
  }, [maxFaces, blendshapes]);
}

// ---------------------------------------------------------------------------
// Turning camera coordinates into screen points.
// The camera → screen mapping is "flat" (it only scales, turns, mirrors and moves), so we ask the camera
// about three points and work out every other point from them – 3 native calls instead of 478.
// ---------------------------------------------------------------------------

type Converter = Pick<CameraRef, 'convertCameraPointToViewPoint'>;

// The camera → screen mapping from three points: where the camera's point (0,0) lands on the screen (ox, oy), and
// how far the screen point moves for the camera's x going 0 → 1 (ax, ay) and its y going 0 → 1 (bx, by).
export type CameraAxes = { ox: number; oy: number; ax: number; ay: number; bx: number; by: number };

// Asks the camera view (3 native calls). Throws if the view isn't ready yet.
function readAxes(camera: Converter): CameraAxes {
  const origin = camera.convertCameraPointToViewPoint({ x: 0, y: 0 });
  const xAxis = camera.convertCameraPointToViewPoint({ x: 1, y: 0 });
  const yAxis = camera.convertCameraPointToViewPoint({ x: 0, y: 1 });
  return { ox: origin.x, oy: origin.y, ax: xAxis.x - origin.x, ay: xAxis.y - origin.y, bx: yAxis.x - origin.x, by: yAxis.y - origin.y };
}

// The camera → screen mapping, or null while the camera view isn't ready (or the numbers make no sense).
// The stretchy filters also use it as a second opinion on which way up the camera picture goes
// (components/lens/warp/frameMatrix.ts placeShot).
export function cameraAxes(camera: Converter): CameraAxes | null {
  try {
    const axes = readAxes(camera);
    return Object.values(axes).every(Number.isFinite) ? axes : null;
  } catch {
    return null;
  }
}

// Screen points of one face, packed as x0, y0, x1, y1, … (478 points → 956 numbers), from cameraAxes.
export function toScreenPointsFrom(face: FaceMeshFace, axes: CameraAxes): number[] {
  const { ox, oy, ax, ay, bx, by } = axes;
  const count = Math.floor(face.points.length / 3);
  const out = new Array<number>(count * 2);
  for (let i = 0; i < count; i++) {
    const x = face.points[i * 3];
    const y = face.points[i * 3 + 1];
    out[i * 2] = ox + ax * x + bx * y;
    out[i * 2 + 1] = oy + ay * x + by * y;
  }
  return out;
}

// The same, asking the camera view itself (throws if it isn't ready yet).
export function toScreenPoints(face: FaceMeshFace, camera: Converter): number[] {
  return toScreenPointsFrom(face, readAxes(camera));
}

// ---------------------------------------------------------------------------
// Which of the 478 points is which (MediaPipe's standard face mesh numbering).
// "Left" and "right" are the person's own left and right.
// ---------------------------------------------------------------------------

export const MESH = {
  // The outline of the face, going round from the top of the forehead.
  faceOval: [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109],
  leftEye: [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398],
  rightEye: [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
  leftBrow: [336, 296, 334, 293, 300, 276, 283, 282, 295, 285],
  rightBrow: [70, 63, 105, 66, 107, 55, 65, 52, 53, 46],
  // The outer edge of the lips.
  lips: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185],
  // Iris middles and one point on each iris edge.
  leftIris: 473,
  leftIrisEdge: 474,
  rightIris: 468,
  rightIrisEdge: 469,
  // Middle of each cheek (the apple of the cheek), the sides of the face, nose tip, chin, forehead.
  leftCheek: 425,
  rightCheek: 205,
  leftFaceSide: 454,
  rightFaceSide: 234,
  leftTemple: 356,
  rightTemple: 127,
  leftCheekbone: 345,
  rightCheekbone: 116,
  noseTip: 1,
  chin: 152,
  forehead: 10,
  // For the Peekaboo+ face filters (components/lens/filters): eye corners and the bottom of each eye, the
  // bottom of the nose, the inner lips, the mouth corners and a spot on each cheek for blush.
  rightEyeOuter: 33,
  rightEyeInner: 133,
  rightEyeBottom: 145,
  leftEyeOuter: 263,
  leftEyeInner: 362,
  leftEyeBottom: 374,
  noseBottom: 2,
  upperLipInner: 13,
  lowerLipInner: 14,
  mouthRightCorner: 61,
  mouthLeftCorner: 291,
  rightBlush: 50,
  leftBlush: 280,
} as const;

// A few of the 52 expression scores (their place in `blendshapes`). This is MediaPipe's standard order: the
// native part puts each score at its category's index, and tests/unit/face-track.test.mjs checks these numbers
// against the full list of 52 names.
export const BLENDSHAPE = {
  browInnerUp: 3,
  browOuterUpLeft: 4,
  browOuterUpRight: 5,
  eyeBlinkLeft: 9,
  eyeBlinkRight: 10,
  eyeSquintLeft: 19,
  eyeSquintRight: 20,
  jawOpen: 25,
  mouthFunnel: 32,
  mouthPucker: 38,
  mouthSmileLeft: 44,
  mouthSmileRight: 45,
} as const;
