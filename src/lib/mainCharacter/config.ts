// ---------------------------------------------------------------------------
// Main Character Mode 🌆: the switches and numbers (docs/MAIN_CHARACTER.md).
//
// Everything here can be changed by an app update (no new download needed). No imports on purpose: the route
// file loads this on every download (Android, Expo Go and web too), so it must never be able to crash, and the
// tests run it on its own. Nothing runs when this file loads except plain constants.
// ---------------------------------------------------------------------------

// The off switch for the whole mode.
export const MAIN_CHARACTER_ENABLED = true;
// true = on for everyone with the face mesh (App Store app and TestFlight). The owner switched it on for
// everyone on 22 Nov ("make sure public chats, main character mode and invite fix all go up today").
// false = only on the `testing` update channel (the owner's TestFlight builds).
export const MAIN_CHARACTER_FOR_EVERYONE = true;
// Android stays off, even once an Android download has the face mesh, until an Android phone passes the checks.
export const MAIN_CHARACTER_ON_ANDROID = false;
// true = Peekaboo+ only (planned: free).
export const MAIN_CHARACTER_PLUS = false;

// Can this phone use Main Character Mode? `os` is Platform.OS, `faceMesh` is FACE_MESH_AVAILABLE and `channel`
// is updateChannel() from lib/lensDiagnostics.ts (null in Expo Go or while developing). Plain checks only, so it
// never throws.
export function mainCharacterHere(os: string, faceMesh: boolean, channel: string | null): boolean {
  if (!MAIN_CHARACTER_ENABLED || faceMesh !== true) return false;
  if (!MAIN_CHARACTER_FOR_EVERYONE && channel !== 'testing') return false;
  return os === 'ios' || (os === 'android' && MAIN_CHARACTER_ON_ANDROID);
}

// The 🌆 bubble on the home camera's mode row.
export const MAIN_CHARACTER_BUBBLE = { key: 'mainCharacter', emoji: '🌆', label: 'Main Character',
  hint: 'Put your face in a comic poster' } as const;

// The poster: 1080 × 1920 pixels, scene behind, character in front.
export const POSTER_W = 1080;
export const POSTER_H = 1920;
export const CHARACTER_SCALE = 0.92;               // character box: 92 % of the poster, standing on the bottom edge

export const LIVE_FACE_FROM_CAMERA = true;         // full live path where camera pictures exist
export const LITE_CAMERA_MOVE: 'follow' | 'off' = 'follow';   // 'off' = fixed hole, line your face up yourself
export const FRAME_WAIT_MS = 1000;                 // camera starts without camera pictures if FrameFeed's output isn't there by then
export const SNAP_FROM_SCREEN = true;              // full path: save what was shown (false = always the photo path)
export const SNAP_TIMEOUT_MS = 1500;               // no snapshot by then → the photo path
export const PHOTO_MAX_SIDE = 1600;                // photo path: the photo is made this small first
export const LIVE_WORDMARK = true;                 // small wordmark on the live and result screens
export const LIVE_COMIC_GENTLE = true;             // live only: softer banding and ink (less shimmer on camera noise)

// The banner words: the owner's own words (they chose to keep them when the mode went to everyone, 22 Nov).
export const MISSION_TITLE = 'MISSION PASSED';
export const MISSION_REWARD = '+RESPECT';
export const MISSION_INTRO_MS = 1100;              // result may show after this
export const MISSION_SHOW_MS = 1700;               // banner fades out after this

// The error message for "there is no face to put in the poster". The camera and the photo bake both use it, and
// the screen looks for it to say "look at the camera" (instead of "couldn't make your poster").
export const NO_FACE = 'no-face';

// Online art (new characters and scenes that show up by themselves).
export const ART_BUCKET = 'main-character';
export const CHARACTER_FOLDER = 'characters';
export const SCENE_FOLDER = 'backgrounds';
export const LIST_REFRESH_MS = 30 * 60_000;
export const LIST_TIMEOUT_MS = 8000;
export const MAX_ART_BYTES = 1_572_864;            // 1.5 MB, the same as the bucket's own limit
export const MAX_ART_SIDE = 4096;                  // read from the file's header, before any decoding
export const MIN_ART_SIDE = 512;
export const ART_TALL = { min: 1.5, max: 2.1 };     // a picture must stand up: height 1.5–2.1 × its width (the poster is 1.78)
export const ONLINE_PER_VISIT = 3;                 // new online pictures prepared per visit (newest first, one at a time)
export const ART_CACHE_SIZE = 5;                   // decoded 1080 × 1920 pictures kept (≈ 8 MB each)

// The face-hole guess for online art without a sidecar (worked out on the 6 bundled characters; the art script
// prints new numbers and tests/unit/main-character-parity.test.mjs keeps them honest).
export const HOLE = { eyeY: 0.283, eyeHalf: 0.207, noseY: 0.499, chinY: 1.019, foreheadY: -0.056, faceWidth: 1.034 };
// Strict shape checks: a hole outside these is not guessed at – the picture is skipped.
export const HOLE_CHECK = { minWidth: 0.18, maxWidth: 0.30, minAspect: 0.8, maxAspect: 1.05,
  minFill: 0.70, maxFill: 0.90, minX: 0.3, maxX: 0.7, maxY: 0.5 };
// How your face is fitted into the hole.
export const FIT = { useForehead: true, maxStretch: 1.15, minScale: 0.2, maxScale: 8, minEyeGap: 4 };
// The skin-coloured plate behind the face and the soft edge round it.
export const SKIN = { plateGrow: 1.04, faceGrow: 1.03, liteFaceShrink: 0.97, edgeBlur: 4, liteTint: 0.12 };
