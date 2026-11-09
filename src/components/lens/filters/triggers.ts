// ---------------------------------------------------------------------------
// How much each Peekaboo+ face filter reacts to your face. Used in two places: faceTrack.ts (on the app's
// main thread, for the bouncy eyes and the aura's charge) and the filter drawing (on the drawing thread), so
// both always use the very same numbers.
//
// Every filter is already on and easy to see while your face is still (REST_LEVEL, like the web version's
// always-on level). Your expression then turns it up to full: raised brows, a squint, an open mouth, a kiss.
//
// No imports here on purpose, and every function is a 'worklet' so the drawing thread can use it too.
// ---------------------------------------------------------------------------

// How strong every filter is with a still face (0–1).
export const REST_LEVEL = 0.8;

// Keeps a number between 0 and 1. Anything broken (not a number) becomes 0.
function c01(x: number) {
  'worklet';
  return Math.max(0, Math.min(1, x)) || 0;
}

// How strong a filter is right now: REST_LEVEL with no expression, 1 at the full expression.
export function levelOf(trigger: number) {
  'worklet';
  return REST_LEVEL + (1 - REST_LEVEL) * c01(trigger);
}

// 👀 Raised eyebrows.
export function eyesTrigger(f: { browUp: number }) {
  'worklet';
  return c01(1.6 * f.browUp);
}

// 😭 Squinting, or scrunching your eyes shut (a quick blink is smoothed away).
export function cryTrigger(f: { squint: number; blinkLeft: number; blinkRight: number }) {
  'worklet';
  return c01(Math.max(1.4 * f.squint, (0.9 * (f.blinkLeft + f.blinkRight)) / 2 - 0.1));
}

// ⚡ An open mouth.
export function auraTrigger(f: { jawOpen: number }) {
  'worklet';
  return c01(1.5 * f.jawOpen);
}

// 😘 A kiss (pursed or rounded lips).
export function kissTrigger(f: { pucker: number }) {
  'worklet';
  return c01(1.3 * f.pucker);
}
