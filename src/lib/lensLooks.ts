// ---------------------------------------------------------------------------
// The face filters that use MediaPipe face tracking (lensPaint.ts draws them). Only plain words and
// numbers here – nothing that needs Skia or the camera – so the mode row and the camera screen can use
// this list on every download, even ones without face tracking.
// ---------------------------------------------------------------------------

export type LensLook =
  | 'glow'
  | 'golden'
  | 'peekabooEyes'
  | 'tinyFace'
  | 'gigachin'
  | 'brainBuffering'
  | 'crybaby'
  | 'bigMouth'
  | 'auraOverload'
  | 'heartEyes'
  | 'pixelPanic';

// The 4 stretchy filters: they change the camera picture itself (they stretch and squash your face), so they
// need the camera's own pixels. Only downloads built for them have those (see lib/frameAccess.ts).
export type WarpLook = 'tinyFace' | 'gigachin' | 'bigMouth' | 'pixelPanic';

export type LensLookInfo = {
  key: LensLook;
  emoji: string;
  // Shown nowhere on the camera (no words there) – only read out by VoiceOver.
  label: string;
  hint: string;
  // Peekaboo+ only.
  plus: boolean;
  // Needs the camera's own pixels (lib/frameAccess.ts). Only shown on downloads that have them.
  needsFrames?: true;
};

// In the order they sit on the mode row, after Dare, Guess Who and Googly. The new ones follow the
// owner's concept sheet.
export const LENS_LOOKS: readonly LensLookInfo[] = [
  { key: 'glow', emoji: '✨', label: 'Soft Glow', hint: 'Golden light on your face', plus: false },
  { key: 'golden', emoji: '🌅', label: 'Golden Hour', hint: 'Your face shines like gold in the evening sun', plus: false },
  { key: 'peekabooEyes', emoji: '👀', label: 'Peekaboo Eyes', hint: 'Raise your brows to make them pop', plus: true },
  { key: 'tinyFace', emoji: '🫥', label: 'Tiny Face', hint: 'Just talk to shrink it more', plus: true, needsFrames: true },
  { key: 'gigachin', emoji: '🗿', label: 'Gigachin', hint: 'Pout to power up your chin', plus: true, needsFrames: true },
  { key: 'brainBuffering', emoji: '🧠', label: 'Brain Buffering', hint: 'Hold still to load your brain, shake your head to restart', plus: true },
  { key: 'crybaby', emoji: '😭', label: 'Crybaby', hint: 'Squint for more tears', plus: true },
  { key: 'bigMouth', emoji: '😃', label: 'Big Mouth', hint: 'Open wide', plus: true, needsFrames: true },
  { key: 'auraOverload', emoji: '⚡', label: 'Aura Overload', hint: 'Open your mouth to power up', plus: true },
  { key: 'heartEyes', emoji: '😘', label: 'Heart Eyes', hint: 'Blow a kiss for more hearts', plus: true },
  { key: 'pixelPanic', emoji: '👾', label: 'Pixel Panic', hint: 'Raise your brows to glitch', plus: true, needsFrames: true },
];

export function isLensLook(mode: string): mode is LensLook {
  return LENS_LOOKS.some((look) => look.key === mode);
}

// The modes only Peekaboo+ can use (CameraPage asks before switching to one).
export function isPlusMode(mode: string): boolean {
  return LENS_LOOKS.some((look) => look.key === mode && look.plus);
}

// One of the 4 stretchy filters (they need the camera's own pixels, see lib/frameAccess.ts).
export function isWarpLook(mode: string): mode is WarpLook {
  return LENS_LOOKS.some((look) => look.key === mode && look.needsFrames === true);
}
