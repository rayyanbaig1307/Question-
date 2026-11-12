// ---------------------------------------------------------------------------
// Small sums for warp/FrameFeed.tsx, kept here with no imports so the tests can run them on their own
// (tests/unit/feed-logic.test.mjs). Every function is a 'worklet' (FrameFeed runs them on the drawing thread)
// and sits above the ones that use it.
// ---------------------------------------------------------------------------

// The camera connection's angle, voted on. Every picture brings its label (0, 90, 180 or 270); the one seen most
// is kept ("latched"). Without turning the camera's pictures the label never really changes, so this only stops
// one odd picture (the phone's turn sensor flipping at the wrong moment) from turning the picture for a frame.
export type TurnVotes = { counts: number[]; latched: number };

export function newTurnVotes(): TurnVotes {
  'worklet';
  return { counts: [0, 0, 0, 0], latched: -1 };
}

// Adds one picture's label. The latched angle only changes when another one has more votes than it.
export function voteTurn(votes: TurnVotes, angle: number): TurnVotes {
  'worklet';
  const slot = angle === 0 ? 0 : angle === 90 ? 1 : angle === 180 ? 2 : angle === 270 ? 3 : -1;
  if (slot < 0) return votes;
  const counts = [votes.counts[0], votes.counts[1], votes.counts[2], votes.counts[3]];
  counts[slot] += 1;
  let latched = votes.latched;
  const held = latched >= 0 ? counts[latched / 90] : -1;
  let best = 0;
  for (let i = 1; i < 4; i++) if (counts[i] > counts[best]) best = i;
  if (latched < 0 || counts[best] > held) latched = best * 90;
  return { counts, latched };
}

// How fast the pictures come. `gap` is a smoothed time between two pictures (milliseconds, 0 = none yet), `late`
// counts pictures that came more than LATE_MS after the one before.
export type FrameRate = { last: number; gap: number; late: number };
export const LATE_MS = 100;

export function newFrameRate(): FrameRate {
  'worklet';
  return { last: 0, gap: 0, late: 0 };
}

// One more picture, timed at `at` milliseconds (the camera's own clock). A jump back or a very long pause (the
// camera was stopped) starts the timing again without counting it.
export function nextFrameRate(rate: FrameRate, at: number): FrameRate {
  'worklet';
  if (!(at > 0)) return rate;
  const gap = at - rate.last;
  if (!(rate.last > 0) || !(gap > 0) || gap > 5000) return { last: at, gap: rate.gap, late: rate.late };
  const smooth = rate.gap > 0 ? rate.gap + 0.1 * (gap - rate.gap) : gap;
  return { last: at, gap: smooth, late: rate.late + (gap > LATE_MS ? 1 : 0) };
}

// Pictures per second, times 10 (so 29.7 is 297), from the smoothed gap. 0 before there is one.
export function framesPerSecondX10(rate: FrameRate) {
  'worklet';
  return rate.gap > 0 ? Math.round(10000 / rate.gap) : 0;
}

// Is the last picture too old to show (`now` and `lastAt` in milliseconds)? Never before the first picture.
export function isStale(now: number, lastAt: number, staleMs: number) {
  'worklet';
  return lastAt > 0 && now - lastAt > staleMs;
}

// Testing readout only: is a black-picture check due? The check makes the drawing thread wait for the graphics
// chip, so it runs rarely: soon after the pictures (re)start (`soon`: a stretchy filter was picked, the camera came
// back, or after a gap – when a black picture is most likely) but never twice within PROBE_MIN_MS, and otherwise
// once every PROBE_EVERY_MS. `now` and `last` (the last check, 0 = none yet) in milliseconds.
export const PROBE_MIN_MS = 2000;
export const PROBE_EVERY_MS = 10_000;

export function probeDue(now: number, last: number, soon: boolean) {
  'worklet';
  if (!(last > 0)) return true;
  return now - last >= (soon ? PROBE_MIN_MS : PROBE_EVERY_MS);
}

// Should the stretchy filters switch off? Only when, in one stretch of time, at least `min` pictures failed AND
// more than `rate` (a share, like 0.5) of the pictures tried failed. A few failures now and then are just
// skipped pictures (the last good one stays on screen).
export function errorVerdict(attempts: number, errors: number, min: number, rate: number) {
  'worklet';
  if (!(errors >= min)) return false;
  if (!(attempts > 0)) return true;
  return errors / attempts > rate;
}
