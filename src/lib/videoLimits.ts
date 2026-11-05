// ---------------------------------------------------------------------------
// How long and how big a video can be.
//
// Everyone can make videos up to 30 seconds. Peekaboo+ ⭐ members get up to 60 seconds.
// The players (peeks and stories) allow up to PLUS_VIDEO_SECONDS, so everyone can watch a long one.
// ---------------------------------------------------------------------------

export const FREE_VIDEO_SECONDS = 30;
export const PLUS_VIDEO_SECONDS = 60;

// The photo and video store takes files up to 30 MB (see the videos migration). A 60-second video from the
// Peekaboo camera (720p, 2.5 Mbps) is about 19 MB, so it fits.
export const MAX_VIDEO_BYTES = 30 * 1024 * 1024;

export const TOO_BIG_VIDEO = 'That video is too big to send (the most is 30 MB). Try a shorter one, or record one in Peekaboo.';

// The longest video you can make.
export function maxVideoSeconds(plus: boolean): number {
  return plus ? PLUS_VIDEO_SECONDS : FREE_VIDEO_SECONDS;
}

// What to do with a video picked from the camera roll (its length in milliseconds, as the picker gives it).
// A little extra (half a second) is allowed, because phones round video lengths.
export function checkPickedVideo(
  durationMs: number | null | undefined,
  fileSize: number | null | undefined,
  plus: boolean,
): 'ok' | 'too-long' | 'needs-plus' | 'too-big' {
  const seconds = (durationMs ?? 0) / 1000;
  if (seconds > PLUS_VIDEO_SECONDS + 0.5) return 'too-long';
  if (seconds > FREE_VIDEO_SECONDS + 0.5 && !plus) return 'needs-plus';
  if ((fileSize ?? 0) > MAX_VIDEO_BYTES) return 'too-big';
  return 'ok';
}
