import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';

// The small sums FrameFeed (src/components/lens/warp/FrameFeed.tsx) uses on the drawing thread, in
// src/components/lens/warp/feedLogic.ts: the camera's label voted on (so one odd picture never turns the picture),
// how fast pictures come, when the last picture is too old, when failed pictures switch the filters off, and
// when the testing readout's black-picture check may run.

function load() {
  const code = ts.transpileModule(readFileSync(resolve(import.meta.dirname, '../../src/components/lens/warp/feedLogic.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, Math, require: (id) => { throw new Error(`feedLogic.ts must not import ${id}`); } });
  return module.exports;
}

const { errorVerdict, framesPerSecondX10, isStale, LATE_MS, newFrameRate, newTurnVotes, nextFrameRate, PROBE_EVERY_MS, PROBE_MIN_MS, probeDue, voteTurn } = load();

it('the camera\'s label is voted on: the first one is kept, and one odd picture never changes it', () => {
  let votes = newTurnVotes();
  expect(votes.latched).toBe(-1);
  votes = voteTurn(votes, 90);
  expect(votes.latched).toBe(90);
  for (let i = 0; i < 5; i++) votes = voteTurn(votes, 90);
  // The phone's turn sensor flips at the wrong moment: one picture says 270.
  votes = voteTurn(votes, 270);
  expect(votes.latched).toBe(90);
  // Even a tie keeps the one already held (the first odd picture of a fresh feed can't win).
  let fresh = voteTurn(newTurnVotes(), 270);
  fresh = voteTurn(fresh, 90);
  expect(fresh.latched).toBe(270);
  // Only when another label really is seen more does it change.
  for (let i = 0; i < 7; i++) votes = voteTurn(votes, 270);
  expect(votes.latched).toBe(270);
  // Labels that aren't a quarter turn are ignored, and the old votes are never changed in place.
  const before = voteTurn(newTurnVotes(), 180);
  expect(voteTurn(before, 45)).toBe(before);
  voteTurn(before, 0);
  expect(before.counts).toEqual([0, 0, 1, 0]);
});

it('pictures 33 ms apart settle at 30 per second; a picture over 0.1 s late is counted', () => {
  let rate = newFrameRate();
  let at = 10_000;
  rate = nextFrameRate(rate, at);
  expect(framesPerSecondX10(rate)).toBe(0);
  for (let i = 0; i < 200; i++) {
    at += 1000 / 30;
    rate = nextFrameRate(rate, at);
  }
  expect(framesPerSecondX10(rate)).toBe(300);
  expect(rate.late).toBe(0);
  expect(LATE_MS).toBe(100);
  rate = nextFrameRate(rate, at + 99);
  expect(rate.late).toBe(0);
  rate = nextFrameRate(rate, at + 99 + 101);
  expect(rate.late).toBe(1);
  // A long pause (the camera stopped) or a jump back starts the timing again without counting.
  const paused = nextFrameRate(rate, at + 99 + 101 + 9000);
  expect(paused.late).toBe(1);
  expect(nextFrameRate(paused, 5).late).toBe(1);
  expect(nextFrameRate(rate, 0)).toBe(rate);
});

it('the last picture stays until it is more than STALE_MS (1 s) old, never before the first one', () => {
  expect(isStale(5000, 0, 1000)).toBe(false);
  expect(isStale(5000, 4001, 1000)).toBe(false);
  expect(isStale(5000, 4000, 1000)).toBe(false);
  expect(isStale(5001, 4000, 1000)).toBe(true);
});

it('failed pictures only switch the filters off when at least 10 fail and over half of those tried fail', () => {
  const verdict = (attempts, errors) => errorVerdict(attempts, errors, 10, 0.5);
  expect(verdict(9, 9)).toBe(false);
  expect(verdict(12, 10)).toBe(true);
  expect(verdict(40, 10)).toBe(false);
  expect(verdict(20, 10)).toBe(false); // exactly half is not over half
  expect(verdict(19, 10)).toBe(true);
  expect(verdict(0, 0)).toBe(false);
  // Failures with no tries at all (letting go of a picture failed) still count.
  expect(verdict(0, 12)).toBe(true);
});

it('the black-picture check (it makes the drawing thread wait) runs rarely: soon after a (re)start, otherwise every 10 s', () => {
  expect(PROBE_MIN_MS).toBe(2000);
  expect(PROBE_EVERY_MS).toBe(10_000);
  // Never checked yet: due.
  expect(probeDue(500, 0, false)).toBe(true);
  expect(probeDue(500, 0, true)).toBe(true);
  // Normally every 10 s, never sooner.
  expect(probeDue(10_999, 1000, false)).toBe(false);
  expect(probeDue(11_000, 1000, false)).toBe(true);
  // Soon after the pictures (re)started (a filter picked, the camera back, after a gap), but never within 2 s.
  expect(probeDue(2999, 1000, true)).toBe(false);
  expect(probeDue(3000, 1000, true)).toBe(true);
});
