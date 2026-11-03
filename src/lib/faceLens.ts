import { TurboModuleRegistry } from 'react-native';

// ---------------------------------------------------------------------------
// The live googly-eyes lens: eyes stick to the faces the camera sees, like a Snapchat lens.
// It needs native face tracking (VisionCamera + Google's ML Kit face detection). The Peekaboo app download has
// it; Expo Go and older downloads don't – there the lens just says it needs the newest download.
// ---------------------------------------------------------------------------

function lensAvailable(): boolean {
  try {
    // Asking first, because these libraries crash if they're loaded without their native parts.
    if (!TurboModuleRegistry.get('NitroModules')) return false;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NitroModules } = require('react-native-nitro-modules') as typeof import('react-native-nitro-modules');
    return NitroModules.hasHybridObject('CameraFactory') && NitroModules.hasHybridObject('FaceDetectorFactory');
  } catch {
    return false;
  }
}

export const FACE_LENS_AVAILABLE = lensAvailable();

// Where a pair of googly eyes goes on the screen: the point between the eyes, how big (1 = the sticker's own
// size) and how tilted (radians).
export type EyePair = { x: number; y: number; scale: number; rotation: number };

// The face lenses. Each puts one drawing on every face, centred between the eyes:
// 'googly' = googly eyes, 'makeup' = Glam (blush, lips, eyeliner), 'pup' = Peekaboo Pup (ears, nose, freckles).
// 'glow' = soft, smooth, glowing skin (no drawing – it changes the photo itself, like 'makeup' does).
export type FaceLook = 'googly' | 'makeup' | 'glow' | 'pup';
// The drawing each lens puts on faces as a movable sticker (Glam and Glow are painted onto the photo instead).
export const LOOK_STICKER: Record<FaceLook, string | null> = {
  googly: 'googly-eyes',
  makeup: null,
  glow: null,
  pup: 'lens-pup',
};

// Skia (the drawing engine the realistic makeup and glow use) is only in the app download, not Expo Go.
export const SKIA_AVAILABLE = (() => {
  try {
    return TurboModuleRegistry.get('RNSkiaModule') != null;
  } catch {
    return false;
  }
})();

// The real shape of one face on screen (from the face tracker's outlines), for makeup and glow:
// the face outline, the lips, the eyes and eyebrows, and the cheeks. Points are screen points.
export type Pt = { x: number; y: number };
export type FaceShape = {
  key: string;
  face: Pt[];
  upperLip: Pt[];
  lowerLip: Pt[];
  leftEye: Pt[];
  rightEye: Pt[];
  leftBrow: Pt[];
  rightBrow: Pt[];
  leftCheek: Pt | null;
  rightCheek: Pt | null;
  // How wide the face is (screen points) – sizes everything else.
  width: number;
};

// One drawing on one face: where, how big, how tilted, and which drawing.
export type LensItem = EyePair & { sticker: string };

// A photo taken with a lens, and where the drawings were when it was taken (so the editor can put them there,
// as stickers you can still move, resize or delete).
export type LensShot = { uri: string; items: LensItem[]; shapes: FaceShape[] };
