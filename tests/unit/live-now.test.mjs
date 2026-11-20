import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { loadTs } from './liveLoad.mjs';

// "Live now" (lib/liveAccess.ts): while you host, co-host or watch a live, nothing restarts the app (updates,
// theme changes and Peekaboo+ ending wait for the end, then run once, the app update first), the screen stays
// awake, and the camera is handed over to the live and back one user at a time.

function load() {
  const awake = [];
  const subscribed = [];
  const access = loadTs('src/lib/liveAccess.ts', {
    expo: {
      requireOptionalNativeModule: (name) => (name === 'ExpoKeepAwake'
        ? { activate: async (tag) => { awake.push(['on', tag]); }, deactivate: async (tag) => { awake.push(['off', tag]); } }
        : name === 'ExpoApplication' ? { nativeApplicationVersion: '1.2.0' } : null),
    },
    'expo-constants': { __esModule: true, default: { executionEnvironment: 'standalone' }, ExecutionEnvironment: { StoreClient: 'storeClient' } },
    // Like React: a screen using the hook listens until it closes (`subscribed` holds the "stop listening").
    react: { useSyncExternalStore: (subscribe, get) => { subscribed.push(subscribe(() => {})); return get(); } },
    'react-native': { NativeModules: {}, Platform: { OS: 'ios' } },
  });
  return { access, awake, subscribed };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

it('the live-now flag: set, read, cleared (and the screen stays awake meanwhile)', () => {
  const { access, awake } = load();
  expect(access.isLiveNow()).toBe(false);
  expect(access.useLiveNow()).toBe(null);
  let ended = 0;
  const stop = access.onLiveEnded(() => { ended++; });
  access.setLiveNow('host');
  expect(access.isLiveNow()).toBe(true);
  expect(access.liveNowRole()).toBe('host');
  expect(access.useLiveNow()).toBe('host');
  // A co-host going back to watching is still live: the screen stays awake, nothing "ends".
  access.setLiveNow('viewer');
  expect(ended).toBe(0);
  access.setLiveNow(null);
  expect(ended).toBe(1);
  expect(access.isLiveNow()).toBe(false);
  expect(awake).toEqual([['on', 'peekaboo-live'], ['off', 'peekaboo-live']]);
  stop();
  access.setLiveNow('viewer');
  access.setLiveNow(null);
  expect(ended).toBe(1);
});

it('restarts wait for the live to end, then run once each – the app update first', async () => {
  const { access } = load();
  const ran = [];
  // Not live: runs at once.
  access.runAfterLive('theme', () => { ran.push('theme-now'); });
  expect(ran).toEqual(['theme-now']);

  access.setLiveNow('viewer');
  access.runAfterLive('theme', () => { ran.push('theme-old'); });
  access.runAfterLive('theme', () => { ran.push('theme'); }); // the newest wins
  access.runAfterLive('plusLapse', () => { ran.push('plusLapse'); });
  access.runAfterLive('ota', () => { ran.push('ota'); });
  await vi.runAllTimersAsync();
  expect(ran).toEqual(['theme-now']);

  access.setLiveNow(null);
  await vi.runAllTimersAsync();
  expect(ran).toEqual(['theme-now', 'ota', 'theme', 'plusLapse']);

  // Nothing is run twice.
  access.setLiveNow('host');
  access.setLiveNow(null);
  await vi.runAllTimersAsync();
  expect(ran).toHaveLength(4);
});

it('a restart that fails doesn\'t stop the others', async () => {
  const { access } = load();
  const ran = [];
  access.setLiveNow('host');
  access.runAfterLive('ota', async () => { throw new Error('no update'); });
  access.runAfterLive('theme', () => { ran.push('theme'); });
  access.setLiveNow(null);
  await vi.runAllTimersAsync();
  expect(ran).toEqual(['theme']);
});

it('if a new live starts before the waiting restarts run, they wait for that one too', async () => {
  const { access } = load();
  const ran = [];
  access.setLiveNow('viewer');
  access.runAfterLive('ota', () => { ran.push('ota'); });
  access.setLiveNow(null);
  access.setLiveNow('viewer'); // opened another live straight away (before the restart got its turn)
  await vi.runAllTimersAsync();
  expect(ran).toEqual([]);
  access.setLiveNow(null);
  await vi.runAllTimersAsync();
  expect(ran).toEqual(['ota']);
});

// The camera hand-off with `cameras` camera screens open: resolved = when waitForCameraRelease() finished (ms
// after the hold); `releases` = when each camera said it had gone.
async function handOff(cameras, releases) {
  const { access } = load();
  for (let i = 0; i < cameras; i++) access.useCameraHeldByLive();
  const start = Date.now();
  access.holdCameraForLive();
  let resolvedAt = null;
  access.waitForCameraRelease().then(() => { resolvedAt = Date.now() - start; });
  for (const at of releases) {
    await vi.advanceTimersByTimeAsync(at - (Date.now() - start));
    access.markCameraReleased();
  }
  await vi.advanceTimersByTimeAsync(3000);
  return resolvedAt;
}

it('the camera hand-off waits at least 500 ms after the camera went (or after the hold), at most 1,200 ms', async () => {
  // No camera screen open: 500 ms after the hold.
  expect(await handOff(0, [])).toBe(500);
  // The camera went 100 ms after the hold: 600 ms.
  expect(await handOff(1, [100])).toBe(600);
  expect(await handOff(1, [400])).toBe(900);
  // Two camera screens: 500 ms after the last one went.
  expect(await handOff(2, [50, 300])).toBe(800);
  // A slow camera is waited for (it isn't missed)…
  expect(await handOff(1, [700])).toBe(1200);
  // …but never more than 1,200 ms after the hold, even if one never says so.
  expect(await handOff(1, [])).toBe(1200);
  expect(await handOff(2, [100])).toBe(1200);
});

it('while the live holds the camera, camera screens show none; releasing gives it back', async () => {
  const { access } = load();
  expect(access.useCameraHeldByLive()).toBe(false);
  // No hold: nothing to wait for.
  let done = false;
  access.waitForCameraRelease().then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(done).toBe(true);
  access.holdCameraForLive();
  expect(access.useCameraHeldByLive()).toBe(true);
  expect(access.isCameraHeldByLive()).toBe(true);
  // Releasing while someone waits lets them go at once.
  let waited = false;
  access.waitForCameraRelease().then(() => { waited = true; });
  access.releaseCameraFromLive();
  await vi.advanceTimersByTimeAsync(0);
  expect(waited).toBe(true);
  expect(access.useCameraHeldByLive()).toBe(false);
  // A "released" with no hold on changes nothing.
  access.markCameraReleased();
  expect(access.useCameraHeldByLive()).toBe(false);
});
