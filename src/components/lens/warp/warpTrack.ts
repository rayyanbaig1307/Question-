import type { LensLook } from '@/lib/lensLooks';

import { eyesTrigger, levelOf } from '../filters/triggers';

// ---------------------------------------------------------------------------
// The stretchy filters' memory (🫥 Tiny Face, 🗿 Gigachin, 😃 Big Mouth, 👾 Pixel Panic), stepped once for
// every face-tracking frame on the app's main thread (faceTrack.ts calls stepWarp). Like the Peekaboo+
// filters, the memory lives on each face (LensFace), so the drawing only reads it and the saved photo gets the
// very same numbers as the screen. Real seconds everywhere, so it behaves the same at any camera speed.
// No Skia and no drawing here (tests/unit/warp-track.test.mjs runs it as it is).
// ---------------------------------------------------------------------------

// The memory each face carries for the stretchy filters (all at rest).
export type WarpMemory = {
  // 😃 How big the mouth is blown up (a bouncy spring; 1 = normal size) and how fast it is changing.
  mouth: number;
  mouthSpeed: number;
  // 🫥 How much you're talking (1 → 0 slowly after you stop): the face gets even tinier.
  tiny: number;
  // 🗿 The chin's power, 0–1 (the meter): it charges while you pout and drains when you stop.
  chin: number;
  // 👾 How glitched the face is, 0–1.
  glitch: number;
  // The expression level of the stretchy filter that is on, smoothed (0–1).
  warpLevel: number;
};

export const WARP_REST: WarpMemory = { mouth: 1, mouthSpeed: 0, tiny: 0, chin: 0, glitch: 0, warpLevel: 0 };

// The longest time step taken in one go (seconds). A longer gap counts as this long.
export const WARP_MAX_STEP = 0.05;
// The mouth spring is stepped in pieces of at most this long, so it stays smooth at any camera speed.
const SPRING_STEP = 1 / 60;

// 😃 The mouth spring (from the web version): how hard it pulls towards its size and how fast it calms down.
const MOUTH_PULL = 120;
const MOUTH_CALM = 10;
// 🗿 Pouting harder than this charges the chin; how fast it charges and drains (part of the meter a second).
const POUT_ON = 0.35;
const CHIN_UP = 0.9;
const CHIN_DOWN = 1.4;
// 👾 Above this the face glitches more; how fast it glitches and calms down (a second).
const PANIC_ON = 0.3;
const GLITCH_UP = 3;
const GLITCH_DOWN = 1.5;
// 🫥 How fast the talking fades after you stop (a second).
const TALK_FADE = 0.8;

function c01(x: number) {
  return Math.max(0, Math.min(1, x)) || 0;
}

function finite(x: number | undefined, fallback: number) {
  return typeof x === 'number' && Number.isFinite(x) ? x : fallback;
}

// Smooths `from` towards `to` like the web version did every frame with `alpha`, but in real seconds:
// alpha is for one step at 60 frames a second.
export function easeTowards(from: number, to: number, alpha: number, dt: number) {
  const k = 1 - Math.pow(1 - alpha, 60 * dt);
  return from + (to - from) * k;
}

// How strongly each stretchy filter reacts to the face right now (before smoothing), 0–1.
// 😃 An open mouth or a big smile (on as soon as it sees you, like the web version).
export function mouthTrigger(f: { jawOpen: number; smile: number }) {
  return levelOf(c01(1.3 * Math.max(finite(f.jawOpen, 0), finite(f.smile, 0))));
}
// 🫥 Talking (the jaw moving).
export function talkTrigger(f: { jawOpen: number }) {
  return levelOf(c01(2.2 * finite(f.jawOpen, 0)));
}
// 🗿 A pout (pursed or rounded lips). No rest level here: the chin meter must only fill when you pout.
export function poutTrigger(f: { pucker: number }) {
  return c01(1.3 * finite(f.pucker, 0));
}
// 👾 Raised brows.
export function panicTrigger(f: { browUp: number }) {
  return levelOf(eyesTrigger({ browUp: finite(f.browUp, 0) }));
}

// Moves one face's stretchy-filter memory on by `dt` seconds for the look that is on. The memory of the
// other looks goes back to rest, so switching looks always starts them fresh. `before` is the same face
// last time (if any). Gives back the face with its memory updated.
export function stepWarp<T extends WarpMemory & { jawOpen: number; smile: number; pucker: number; browUp: number }>(
  face: T,
  before: Partial<WarpMemory> | undefined,
  dt: number,
  look: LensLook,
): T {
  const out: T = { ...face, ...WARP_REST };
  const time = Math.max(0, Math.min(WARP_MAX_STEP, finite(dt, 0)));
  const level = finite(before?.warpLevel, 0);

  if (look === 'bigMouth') {
    // 😃 A bouncy spring towards its size: about 1.9× with a still face, about 2× with the mouth open.
    const open = easeTowards(level, mouthTrigger(face), 0.3, time);
    const target = 1.1 + 0.95 * open;
    let mouth = finite(before?.mouth, 1);
    let speed = finite(before?.mouthSpeed, 0);
    const steps = time > 0 ? Math.ceil(time / SPRING_STEP) : 0;
    const h = steps > 0 ? time / steps : 0;
    for (let i = 0; i < steps; i++) {
      speed += (target - mouth) * MOUTH_PULL * h - speed * MOUTH_CALM * h;
      mouth += speed * h;
    }
    // Never wildly out of shape, whatever happens.
    out.mouth = Math.max(0.5, Math.min(3, mouth));
    out.mouthSpeed = Math.max(-50, Math.min(50, speed));
    out.warpLevel = open;
  } else if (look === 'tinyFace') {
    // 🫥 Talking makes it tinier; it fades back slowly after you stop.
    const talk = easeTowards(level, talkTrigger(face), 0.4, time);
    out.tiny = c01(Math.max(talk, finite(before?.tiny, 0) - TALK_FADE * time));
    out.warpLevel = talk;
  } else if (look === 'gigachin') {
    // 🗿 Pout to charge the chin (full in about 1.1 s), relax to drain it.
    const pout = easeTowards(level, poutTrigger(face), 0.25, time);
    out.chin = c01(finite(before?.chin, 0) + (pout > POUT_ON ? CHIN_UP : -CHIN_DOWN) * time);
    out.warpLevel = pout;
  } else if (look === 'pixelPanic') {
    // 👾 Raised brows glitch it up; it calms down slowly.
    const panic = easeTowards(level, panicTrigger(face), 0.35, time);
    out.glitch = c01(finite(before?.glitch, 0) + (panic > PANIC_ON ? GLITCH_UP : -GLITCH_DOWN) * time);
    out.warpLevel = panic;
  }
  return out;
}
