import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

// Speed fix 3 (src/lib/startup.ts): a lighter app open. What you look at first (Home's posts and stories, the camera,
// your sends) goes first; the things nobody is waiting for start about 2 seconds after Home is drawn. The logs of the
// owner's drop showed ~25 requests leaving at once when the app opened, so on 1 bar the first ones waited 15 s.

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const load = () => loadLibrary('startup', { globals: { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout } });

it('the extras start 2 seconds after Home is drawn, and everyone waiting is told', async () => {
  const startup = load();
  const told = vi.fn();
  startup.subscribeStartup(told);
  expect(startup.startupDone()).toBe(false);
  const waited = vi.fn();
  void startup.afterStartup().then(waited);
  startup.noteHomeDrawn();
  await vi.advanceTimersByTimeAsync(1999);
  expect(startup.startupDone()).toBe(false);
  expect(waited).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(startup.startupDone()).toBe(true);
  expect(told).toHaveBeenCalledTimes(1);
  expect(waited).toHaveBeenCalledTimes(1);
  // Drawing Home again (coming back to it) changes nothing.
  startup.noteHomeDrawn();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(told).toHaveBeenCalledTimes(1);
});

it('if Home never shows (the app opened straight into a chat), they start after 6 seconds anyway', async () => {
  const startup = load();
  const told = vi.fn();
  startup.subscribeStartup(told);
  await vi.advanceTimersByTimeAsync(5999);
  expect(startup.startupDone()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(startup.startupDone()).toBe(true);
  expect(told).toHaveBeenCalledTimes(1);
});

it('once started, a screen asking later is answered at once', async () => {
  const startup = load();
  startup.noteHomeDrawn();
  await vi.advanceTimersByTimeAsync(2000);
  const waited = vi.fn();
  await startup.afterStartup().then(waited);
  expect(waited).toHaveBeenCalledTimes(1);
});
