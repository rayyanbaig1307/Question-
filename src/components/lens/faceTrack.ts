import { BLENDSHAPE, MESH } from '@/lib/faceMesh';
import type { LensLook } from '@/lib/lensLooks';

import { auraTrigger, eyesTrigger, levelOf } from './filters/triggers';
import type { LensFace } from './lensPaint';
import { stepWarp, WARP_REST } from './warp/warpTrack';

// ---------------------------------------------------------------------------
// Following faces from one camera frame to the next (this runs on the app's main thread, not the drawing
// thread, once for every face-tracking frame).
//
// For each face it: finds the same face in the frames before (by the nose), smooths the face points so they
// don't shiver, reads the expressions (raised brows, squint, open mouth, kiss), and steps the face filters'
// "memory": the bouncy googly eyes (👀), how far the brain has loaded (🧠) and the aura's charge (⚡). The
// stretchy filters' memory (😃 🫥 🗿 👾) is stepped in warp/warpTrack.ts, called from stepFace.
//
// That memory is kept ON each face (LensFace), so the drawing only reads it, and the saved photo gets the very
// same numbers as the screen. Everything uses real seconds, so it behaves the same whether the camera tracks
// faces 15 or 60 times a second. No Skia and no drawing here.
// ---------------------------------------------------------------------------

// One face as it comes from the camera: its points already on screen (toScreenPoints) and its 52 expression
// scores (may be empty).
export type RawFace = { pts: number[]; shapes: number[] };

// The faces seen lately, and the next number to give a new face (its "seed", which picks its tears and hearts).
export type TrackMemory = { recent: { face: LensFace; at: number }[]; nextSeed: number };

// A face that goes missing for up to this long (seconds) keeps its memory when it comes back (so a moment
// of lost tracking doesn't restart the brain or make the eyes pop in again).
export const MEMORY_SECONDS = 1;
// The longest time step we take in one go (seconds). A longer gap counts as this long.
const MAX_STEP = 0.1;
// Springs are stepped in small pieces of at most this long, so they stay smooth at any camera speed.
const SPRING_STEP = 1 / 60;

// The tracker's points shiver by a pixel or so even when you hold still. Small moves are smoothed a lot,
// big moves are followed straight away, so the filter stays calm but never lags behind.
const CALM = 0.35;

// 👀 The googly eyes' size spring (from the web version) and the wobble spring for the pupils.
const POP_STIFF = 140;
const POP_DAMP = 11;
const WOBBLE_STIFF = 60;
const WOBBLE_DAMP = 6;
const WOBBLE_PUSH = 0.8;

// 🧠 Brain Buffering: below STILL_BELOW (face widths a second) you hold still, above MOVING_ABOVE you move.
const STILL_BELOW = 0.12;
const MOVING_ABOVE = 0.2;
// Loading speed while still (it slows down near the end, like a real progress bar: 0 → 100 % in about 9 s).
const LOAD_RATE = 0.14;
// How fast moving drains it (part of the whole bar a second).
const DRAIN_RATE = 0.25;
// Once loaded, moving your head faster than this (face widths a second) – a shake – restarts it.
const SHAKE = 1.2;
// How fast the green flash fades (a second).
const FLASH_FADE = 1.2;

// ⚡ Aura Overload: the charge fills in under half a second with an open mouth and drains a bit slower.
const CHARGE_UP = 2.2;
const CHARGE_DOWN = 1.6;
const MOUTH_OPEN = 0.15;

export function newTrackMemory(): TrackMemory {
  return { recent: [], nextSeed: 1 };
}

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x)) || 0;
}

function finite(x: number) {
  return Number.isFinite(x) ? x : 0;
}

// The width of a face (side to side), at least 1.
function faceWidth(pts: number[]) {
  return (
    Math.hypot(
      pts[MESH.leftFaceSide * 2] - pts[MESH.rightFaceSide * 2],
      pts[MESH.leftFaceSide * 2 + 1] - pts[MESH.rightFaceSide * 2 + 1],
    ) || 1
  );
}

// A new face from the camera: its expressions read (0–1; missing or broken scores are 0) and all its filter
// memory at rest.
export function readFace(raw: RawFace): LensFace {
  const shapes = Array.isArray(raw.shapes) ? raw.shapes : [];
  const score = (index: number) => clamp01(shapes[index]);
  return {
    pts: raw.pts,
    blinkLeft: score(BLENDSHAPE.eyeBlinkLeft),
    blinkRight: score(BLENDSHAPE.eyeBlinkRight),
    smile: (score(BLENDSHAPE.mouthSmileLeft) + score(BLENDSHAPE.mouthSmileRight)) / 2,
    light: [],
    rim: 0,
    browUp: Math.max(score(BLENDSHAPE.browInnerUp), (score(BLENDSHAPE.browOuterUpLeft) + score(BLENDSHAPE.browOuterUpRight)) / 2),
    squint: (score(BLENDSHAPE.eyeSquintLeft) + score(BLENDSHAPE.eyeSquintRight)) / 2,
    jawOpen: score(BLENDSHAPE.jawOpen),
    pucker: Math.max(score(BLENDSHAPE.mouthPucker), score(BLENDSHAPE.mouthFunnel)),
    seed: 0,
    pop: 0,
    popSpeed: 0,
    wobbleX: 0,
    wobbleY: 0,
    wobbleSpeedX: 0,
    wobbleSpeedY: 0,
    motion: 0,
    still: 1,
    progress: 0,
    flash: 0,
    charge: 0,
    ...WARP_REST,
  };
}

// The face from the frames before that is nearest to this one (by the nose tip), so each face is smoothed
// with its own history even when two people are in the picture.
export function closest(face: LensFace, before: LensFace[]): LensFace | undefined {
  const nx = face.pts[MESH.noseTip * 2];
  const ny = face.pts[MESH.noseTip * 2 + 1];
  let best: LensFace | undefined;
  let bestDistance = Infinity;
  for (const old of before) {
    const d = Math.hypot(old.pts[MESH.noseTip * 2] - nx, old.pts[MESH.noseTip * 2 + 1] - ny);
    if (d < bestDistance) {
      best = old;
      bestDistance = d;
    }
  }
  const width = Math.hypot(
    face.pts[MESH.leftFaceSide * 2] - face.pts[MESH.rightFaceSide * 2],
    face.pts[MESH.leftFaceSide * 2 + 1] - face.pts[MESH.rightFaceSide * 2 + 1],
  );
  // Too far away to be the same face.
  return bestDistance < width * 0.5 ? best : undefined;
}

// Smooths a face with the same face from before: the points (calm when still, straight away when moving) and
// the expressions. Everything else on the new face is kept as it is (the new face is copied first, so a field
// added later can never get lost here).
export function smooth(face: LensFace, before: LensFace | undefined): LensFace {
  if (!before || before.pts.length !== face.pts.length) return face;
  const width = faceWidth(face.pts);
  // How far the face moved, compared with its size. Still → heavy smoothing; moving → none.
  const moved =
    Math.hypot(face.pts[MESH.noseTip * 2] - before.pts[MESH.noseTip * 2], face.pts[MESH.noseTip * 2 + 1] - before.pts[MESH.noseTip * 2 + 1]) / width;
  const follow = Math.min(1, CALM + moved * 10);
  const pts = new Array<number>(face.pts.length);
  for (let i = 0; i < pts.length; i++) pts[i] = before.pts[i] + (face.pts[i] - before.pts[i]) * follow;
  const ease = (a: number, b: number) => finite(a) + (finite(b) - finite(a)) * 0.5;
  return {
    ...face,
    pts,
    blinkLeft: ease(before.blinkLeft, face.blinkLeft),
    blinkRight: ease(before.blinkRight, face.blinkRight),
    smile: ease(before.smile, face.smile),
    browUp: ease(before.browUp, face.browUp),
    squint: ease(before.squint, face.squint),
    jawOpen: ease(before.jawOpen, face.jawOpen),
    pucker: ease(before.pucker, face.pucker),
    light: face.light,
    rim: face.rim,
  };
}

// Moves one face's filter memory on by `dt` seconds, for the look that is on. The other looks' memory goes
// back to rest, so switching looks always starts them fresh. `before` is the same face last time (if any).
export function stepFace(face: LensFace, before: LensFace | undefined, dt: number, look: LensLook): LensFace {
  const time = Math.max(0, Math.min(MAX_STEP, finite(dt)));
  const out: LensFace = {
    ...face,
    seed: before ? finite(before.seed) : finite(face.seed),
    pop: 0,
    popSpeed: 0,
    wobbleX: 0,
    wobbleY: 0,
    wobbleSpeedX: 0,
    wobbleSpeedY: 0,
    motion: 0,
    still: 1,
    progress: 0,
    flash: 0,
    charge: 0,
  };
  const width = faceWidth(face.pts);
  // How fast the head moves (face widths a second), from the nose.
  let headX = 0;
  let headY = 0;
  if (before && time > 0 && before.pts.length === face.pts.length) {
    headX = finite((face.pts[MESH.noseTip * 2] - before.pts[MESH.noseTip * 2]) / time / width);
    headY = finite((face.pts[MESH.noseTip * 2 + 1] - before.pts[MESH.noseTip * 2 + 1]) / time / width);
  }
  const steps = time > 0 ? Math.ceil(time / SPRING_STEP) : 0;
  const h = steps > 0 ? time / steps : 0;

  if (look === 'peekabooEyes') {
    // 👀 The eyes spring towards their size (bigger with raised brows); a new face starts at 0, so they pop in.
    const target = 0.55 + 1.15 * levelOf(eyesTrigger(face));
    let pop = before ? finite(before.pop) : 0;
    let popSpeed = before ? finite(before.popSpeed) : 0;
    let wx = before ? finite(before.wobbleX) : 0;
    let wy = before ? finite(before.wobbleY) : 0;
    let wvx = before ? finite(before.wobbleSpeedX) : 0;
    let wvy = before ? finite(before.wobbleSpeedY) : 0;
    for (let i = 0; i < steps; i++) {
      popSpeed += ((target - pop) * POP_STIFF - popSpeed * POP_DAMP) * h;
      pop += popSpeed * h;
      // The pupils swing the other way when the head moves, then settle (like real googly eyes).
      wvx += (-WOBBLE_STIFF * wx - WOBBLE_DAMP * wvx - WOBBLE_PUSH * headX) * h;
      wvy += (-WOBBLE_STIFF * wy - WOBBLE_DAMP * wvy - WOBBLE_PUSH * headY) * h;
      wx += wvx * h;
      wy += wvy * h;
    }
    out.pop = pop;
    out.popSpeed = popSpeed;
    out.wobbleX = wx;
    out.wobbleY = wy;
    out.wobbleSpeedX = wvx;
    out.wobbleSpeedY = wvy;
  } else if (look === 'brainBuffering') {
    // 🧠 Hold still to load, move to drain, shake to restart once loaded.
    const speed = Math.hypot(headX, headY);
    let motion = before ? finite(before.motion) : 0;
    let still = before ? clamp01(before.still) : 1;
    let progress = before ? clamp01(before.progress) : 0;
    let flash = before ? clamp01(before.flash) : 0;
    for (let i = 0; i < steps; i++) {
      motion += (speed - motion) * (1 - Math.exp(-h / 0.15));
      // Between the two limits it keeps doing what it did (so it doesn't flicker between still and moving).
      const target = motion < STILL_BELOW ? 1 : motion > MOVING_ABOVE ? 0 : still >= 0.5 ? 1 : 0;
      still += (target - still) * (1 - Math.exp(-h / 0.2));
      if (progress >= 1) {
        if (motion > SHAKE) {
          progress = 0;
          flash = 0;
        }
      } else if (still > 0.5) {
        progress = Math.min(1, progress + LOAD_RATE * (1.4 - progress) * h);
        if (progress >= 1) flash = 1;
      } else {
        progress = Math.max(0, progress - DRAIN_RATE * h);
      }
      flash = Math.max(0, flash - FLASH_FADE * h);
    }
    out.motion = motion;
    out.still = still;
    out.progress = progress;
    out.flash = flash;
  } else if (look === 'auraOverload') {
    // ⚡ Charges up while the mouth is open.
    const charge = before ? clamp01(before.charge) : 0;
    out.charge = clamp01(charge + (auraTrigger(face) > MOUTH_OPEN ? CHARGE_UP : -CHARGE_DOWN) * time);
  }
  // 😃 🫥 🗿 👾 The stretchy filters' memory (at rest for every other look).
  return stepWarp(out, before, time, look);
}

// One camera frame: finds each face's earlier self, smooths it and steps its filter memory. `now` is in
// seconds (performance.now() / 1000). `memory` is updated for the next frame.
export function trackFaces(raw: RawFace[], memory: TrackMemory, look: LensLook, now: number): LensFace[] {
  const at = finite(now);
  // The faces seen lately (not too long ago), each one usable once.
  const pool = memory.recent.filter((entry) => at - entry.at < MEMORY_SECONDS && at - entry.at >= 0);
  const used = new Set<LensFace>();
  const out: LensFace[] = [];
  for (const one of raw) {
    if (!one || !Array.isArray(one.pts) || one.pts.length < 478 * 2) continue;
    const fresh = readFace(one);
    const free = pool.filter((entry) => !used.has(entry.face));
    const old = closest(fresh, free.map((entry) => entry.face));
    const oldAt = old ? (free.find((entry) => entry.face === old)?.at ?? at) : at;
    if (old) used.add(old);
    const smoothed = smooth(fresh, old);
    const face = old ? smoothed : { ...smoothed, seed: memory.nextSeed++ };
    out.push(stepFace(face, old, old ? at - oldAt : 0, look));
  }
  memory.recent = [...out.map((face) => ({ face, at })), ...pool.filter((entry) => !used.has(entry.face))];
  return out;
}
