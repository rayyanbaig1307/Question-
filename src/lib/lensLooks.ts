// ---------------------------------------------------------------------------
// The face filters that use MediaPipe face tracking (lensPaint.ts draws them). Only plain words and
// numbers here – nothing that needs Skia or the camera – so the mode row and the camera screen can use
// this list on every download, even ones without face tracking.
// ---------------------------------------------------------------------------

export type LensLook = 'glow' | 'golden' | 'peekabooEyes' | 'brainBuffering' | 'crybaby' | 'auraOverload' | 'heartEyes';

export type LensLookInfo = {
  key: LensLook;
  emoji: string;
  // Shown nowhere on the camera (no words there) – only read out by VoiceOver.
  label: string;
  hint: string;
  // Peekaboo+ only.
  plus: boolean;
};

// In the order they sit on the mode row, after Dare, Guess Who and Googly. The new ones follow the
// owner's concept sheet.
export const LENS_LOOKS: readonly LensLookInfo[] = [
  { key: 'glow', emoji: '✨', label: 'Soft Glow', hint: 'Golden light on your face', plus: true },
  { key: 'golden', emoji: '🌅', label: 'Golden Hour', hint: 'Your face shines like gold in the evening sun', plus: true },
  { key: 'peekabooEyes', emoji: '👀', label: 'Peekaboo Eyes', hint: 'Raise your brows to make them pop', plus: true },
  { key: 'brainBuffering', emoji: '🧠', label: 'Brain Buffering', hint: 'Hold still to load your brain, shake your head to restart', plus: true },
  { key: 'crybaby', emoji: '😭', label: 'Crybaby', hint: 'Squint for more tears', plus: true },
  { key: 'auraOverload', emoji: '⚡', label: 'Aura Overload', hint: 'Open your mouth to power up', plus: true },
  { key: 'heartEyes', emoji: '😘', label: 'Heart Eyes', hint: 'Blow a kiss for more hearts', plus: true },
];

export function isLensLook(mode: string): mode is LensLook {
  return LENS_LOOKS.some((look) => look.key === mode);
}

// The modes only Peekaboo+ can use (CameraPage asks before switching to one).
export function isPlusMode(mode: string): boolean {
  return LENS_LOOKS.some((look) => look.key === mode && look.plus);
}
