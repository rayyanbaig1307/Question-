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

// The face lens: googly eyes on every face. (Glam, Glow and Pup were tried and removed.)
export type FaceLook = 'googly';
// The drawing the lens puts on faces as a movable sticker.
export const LOOK_STICKER: Record<FaceLook, string> = {
  googly: 'googly-eyes',
};

// One drawing on one face: where, how big, how tilted, and which drawing.
export type LensItem = EyePair & { sticker: string };

// A photo taken with a lens, and where the drawings were when it was taken (so the editor can put them there,
// as stickers you can still move, resize or delete).
export type LensShot = { uri: string; items: LensItem[] };
