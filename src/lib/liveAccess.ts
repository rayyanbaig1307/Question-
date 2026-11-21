import { requireOptionalNativeModule } from 'expo';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { useSyncExternalStore } from 'react';
import { NativeModules, Platform } from 'react-native';

import type * as LiveStageModuleNS from '@/components/live/LiveStage';

import { updateChannel } from './lensDiagnostics';

// ---------------------------------------------------------------------------
// Lives 🔴: can this phone go live or watch a live, and what is happening right now?
//
// Every app update reaches every download (App Store 1.0/1.1, old TestFlight builds, old Android APKs, Expo
// Go). Only downloads from version 1.2.0 on carry LiveKit's native parts, and on the others just LOADING
// LiveKit closes the app. So the check comes in two steps:
// 1) liveMaybeAvailable(): the cheap check. It creates nothing (the switches below, the update channel, the
//    platform, not Expo Go, and the download's own version number). Used for everything you can SEE: the 🔴
//    bubble, the live circles on Home, the settings switch and the "can get live notifications" flag.
// 2) isLiveAvailable(): the real check. It asks the phone for LiveKit's two native parts, and asking CREATES
//    them (that starts the phone's WebRTC sound engine). So it only runs right before a live is used (the Go
//    live button, or opening a live), never when the app starts.
//
// This file only uses LiveKit's TYPES. The one place that loads LiveKit for real is loadLiveStage() below.
// Nothing here runs at load time except plain constants. tests/unit/live-guard.test.mjs checks all of this.
// ---------------------------------------------------------------------------

// The off switch for all of lives (can be changed by an app update, no new download needed).
export const LIVE_ENABLED = true;
// 🔒 Lives are being tried out: they only show on the `testing` update channel – the owner's TestFlight build 13.
// One line switches them on for everyone later (set this to true).
export const LIVE_FOR_EVERYONE = false;
// Android has the code too, but it stays off until an Android phone with LiveKit passes the phone checks.
export const LIVE_ON_ANDROID = false;
// The off switch for hearts only (phone check G2: if hidden viewers can't send hearts, switch this off).
export const HEARTS_ENABLED = true;
// The first app download that carries LiveKit's native parts.
export const LIVE_MIN_APP_VERSION = '1.2.0';
// What the pinned LiveKit packages read from the phone the moment they load. If a native part is missing,
// loading them closes the app. tests/unit/live-guard.test.mjs keeps this list in sync with the packages.
export const LIVE_NATIVE_MODULES = ['WebRTCModule', 'LivekitReactNativeModule'] as const;

export type LiveStageModule = typeof LiveStageModuleNS;

// "1.10.0" is newer than "1.2.0"; "1.2" counts as "1.2.0". Anything missing or odd counts as "too old".
export function versionAtLeast(version: string | null | undefined, min: string): boolean {
  if (typeof version !== 'string' || !version.trim()) return false;
  const parts = (text: string) => text.trim().split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : NaN));
  const have = parts(version);
  const need = parts(min);
  if (have.some(Number.isNaN) || need.some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(have.length, need.length); i++) {
    const a = have[i] ?? 0;
    const b = need[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

// ---------------------------------------------------------------------------
// "Lives broke on this phone" (for this app start only): set when the real check or loading LiveKit fails.
// Then every live thing hides itself until the app is closed.
// ---------------------------------------------------------------------------

let broken = false;
let warned = false;
const brokenListeners = new Set<() => void>();

function tellAll(listeners: Set<() => void>) {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // One listener failing must not stop the others.
    }
  }
}

export function liveBroken(): boolean {
  return broken;
}

export function markLiveBroken(why?: unknown): void {
  if (!warned) {
    warned = true;
    console.warn('Lives switched off on this phone until the app is closed', why ?? '');
  }
  if (broken) return;
  broken = true;
  tellAll(brokenListeners);
}

// Calls `listener` when lives switch themselves off. Returns the "stop listening" function.
export function subscribeLiveBroken(listener: () => void): () => void {
  brokenListeners.add(listener);
  return () => {
    brokenListeners.delete(listener);
  };
}

// The download's own version (set when the app was built). Never Constants.expoConfig.version: an app update
// changes that one, but it can't add native parts.
function downloadVersion(): string | null {
  try {
    const app = requireOptionalNativeModule<{ nativeApplicationVersion?: string | null }>('ExpoApplication');
    return app?.nativeApplicationVersion ?? null;
  } catch {
    return null;
  }
}

function isExpoGo(): boolean {
  try {
    return Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
  } catch {
    return true;
  }
}

// Are lives switched on for this download's update channel (see LIVE_FOR_EVERYONE)? Like the public chat's
// switch. `channel` is for the tests; the app leaves it out.
export function liveSwitchedOn(channel?: string | null): boolean {
  return LIVE_FOR_EVERYONE || (channel === undefined ? updateChannel() : channel) === 'testing';
}

// 1) The cheap check (creates nothing; remembered for this app start).
let maybe: boolean | undefined;
export function liveMaybeAvailable(): boolean {
  if (maybe === undefined) {
    try {
      maybe =
        LIVE_ENABLED &&
        liveSwitchedOn() &&
        (Platform.OS === 'ios' || (Platform.OS === 'android' && LIVE_ON_ANDROID)) &&
        !isExpoGo() &&
        versionAtLeast(downloadVersion(), LIVE_MIN_APP_VERSION);
    } catch {
      maybe = false;
    }
  }
  return maybe === true && !broken;
}

// 2) The real check. Asking for the native parts CREATES them, so this only runs right before a live is used:
// in loadLiveStage() and on the Go live tap. Never at app start, never on Home or the camera.
let real: boolean | undefined;
export function isLiveAvailable(): boolean {
  if (real !== undefined) return real && !broken;
  try {
    const mods = NativeModules as Record<string, unknown> | undefined;
    real = liveMaybeAvailable() && LIVE_NATIVE_MODULES.every((name) => !!mods?.[name]);
  } catch {
    real = false;
  }
  // A 1.2+ download without the native parts: hide lives for this app start.
  if (!real && liveMaybeAvailable()) markLiveBroken('LiveKit native parts are missing');
  return real && !broken;
}

// Why lives can't run on this phone (for the "can't watch" card), or null when they can (as far as the cheap
// check knows). Words for each reason: LIVE_UNAVAILABLE_WORDS.
export type LiveUnavailableReason = 'off' | 'android' | 'update' | 'broken';
export function liveUnavailableReason(): LiveUnavailableReason | null {
  if (!LIVE_ENABLED) return 'off';
  // Not on this channel (the App Store app): "switched off for now", never "update" (no update has lives yet).
  if (!liveSwitchedOn()) return 'off';
  if (Platform.OS === 'android' && !LIVE_ON_ANDROID) return 'android';
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return 'broken';
  if (isExpoGo()) return 'broken';
  if (!versionAtLeast(downloadVersion(), LIVE_MIN_APP_VERSION)) return 'update';
  if (broken) return 'broken';
  return liveMaybeAvailable() ? null : 'broken';
}

export const LIVE_UNAVAILABLE_WORDS: Record<LiveUnavailableReason, string> = {
  update: 'Update Peekaboo to watch lives 🔴',
  android: "Lives aren't on Android yet – soon! 🔴",
  off: 'Lives are switched off for now.',
  broken: "Lives aren't working on this phone right now.",
};

// The ONLY place in the app that loads components/live/LiveStage (and with it LiveKit). It runs the real
// check first, and if loading fails, lives switch off for this app start instead of closing the app.
let stage: LiveStageModule | null | undefined;
export function loadLiveStage(): LiveStageModule | null {
  if (broken) return null;
  if (stage !== undefined) return stage;
  if (!isLiveAvailable()) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    stage = require('@/components/live/LiveStage') as LiveStageModule;
  } catch (error) {
    stage = null;
    markLiveBroken(error);
  }
  return broken ? null : stage;
}

// ---------------------------------------------------------------------------
// "Live now": are you hosting, on stage or watching a live right now? Set BEFORE any network call (the host's
// Go live tap; a viewer's live screen opening), cleared only when the summary or end card is closed (Done)
// or the live screen closes. While it is set, nothing restarts the app (updates, theme changes wait: see
// runAfterLive), and the screen stays awake.
// ---------------------------------------------------------------------------

export type LiveRole = 'host' | 'cohost' | 'viewer';

let liveRole: LiveRole | null = null;
const liveListeners = new Set<() => void>();
const endedListeners = new Set<() => void>();
// Work that waits for the live to end (one job per key, the newest wins). Keys: 'ota', 'theme', 'plusLapse'.
const waiting = new Map<string, () => unknown>();
const KEEP_AWAKE_TAG = 'peekaboo-live';

// The screen stays on while you're in a live. Uses the phone's own part directly (it's in every download as
// part of Expo): never import 'expo-keep-awake'.
function keepScreenOn(on: boolean) {
  try {
    const keepAwake = requireOptionalNativeModule<{
      activate?: (tag: string) => Promise<void>;
      deactivate?: (tag: string) => Promise<void>;
    }>('ExpoKeepAwake');
    const done = on ? keepAwake?.activate?.(KEEP_AWAKE_TAG) : keepAwake?.deactivate?.(KEEP_AWAKE_TAG);
    done?.catch?.(() => {});
  } catch {
    // The screen may dim – nothing else breaks.
  }
}

export function setLiveNow(role: LiveRole | null): void {
  const before = liveRole;
  if (before === role) return;
  liveRole = role;
  if (before === null && role !== null) keepScreenOn(true);
  tellAll(liveListeners);
  if (before !== null && role === null) {
    keepScreenOn(false);
    tellAll(endedListeners);
    runWaitingWork();
  }
}

export function liveNowRole(): LiveRole | null {
  return liveRole;
}

export function isLiveNow(): boolean {
  return liveRole !== null;
}

function subscribeLiveNow(listener: () => void): () => void {
  liveListeners.add(listener);
  return () => {
    liveListeners.delete(listener);
  };
}

// For screens: your role in a live right now, or null (re-renders when it changes).
export function useLiveNow(): LiveRole | null {
  return useSyncExternalStore(subscribeLiveNow, liveNowRole, liveNowRole);
}

// Calls `listener` each time a live ends for you (the flag clears). Returns the "stop listening" function.
export function onLiveEnded(listener: () => void): () => void {
  endedListeners.add(listener);
  return () => {
    endedListeners.delete(listener);
  };
}

// Runs `work` now, or – while you're in a live – once the live is over. One job per key is kept.
export function runAfterLive(key: string, work: () => unknown): void {
  if (!isLiveNow()) {
    runSafely(work);
    return;
  }
  waiting.set(key, work);
}

function runSafely(work: () => unknown): Promise<void> {
  try {
    return Promise.resolve(work()).then(
      () => {},
      (error) => console.warn('Could not finish what waited for the live to end', error),
    );
  } catch (error) {
    console.warn('Could not finish what waited for the live to end', error);
    return Promise.resolve();
  }
}

// Leaving work that is still running (telling the server you ended or left the live). A waiting restart waits
// for it first – at most LEAVE_WAIT_MS – so a restart never cancels the "I've left" message on its way out.
export const LEAVE_WAIT_MS = 8000;
const leaving = new Set<Promise<unknown>>();

export function whileLeaving(work: Promise<unknown>): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Each one counts for at most LEAVE_WAIT_MS (a request that never answers mustn't hold every later restart).
  const tracked: Promise<unknown> = Promise.race([
    work.catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, LEAVE_WAIT_MS);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
    leaving.delete(tracked);
  });
  leaving.add(tracked);
}

// Each waiting job is a restart (app update, theme, Peekaboo+ ending). The app update goes first: it
// restarts into the new version, which also picks up a new theme. The rest only run if it didn't restart.
function runWaitingWork() {
  if (!waiting.size) return;
  const jobs = [...waiting.entries()].sort(([a], [b]) => (a === 'ota' ? -1 : b === 'ota' ? 1 : 0));
  waiting.clear();
  setTimeout(() => {
    void (async () => {
      if (leaving.size) {
        let timer: ReturnType<typeof setTimeout> | null = null;
        await Promise.race([
          Promise.allSettled([...leaving]),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, LEAVE_WAIT_MS);
          }),
        ]);
        if (timer) clearTimeout(timer);
      }
      for (let i = 0; i < jobs.length; i++) {
        if (isLiveNow()) {
          // A new live started meanwhile: the rest wait again.
          for (const [key, job] of jobs.slice(i)) if (!waiting.has(key)) waiting.set(key, job);
          return;
        }
        await runSafely(jobs[i][1]);
      }
    })();
  }, 0);
}

// ---------------------------------------------------------------------------
// One camera user at a time. The Peekaboo camera (and its face filters) and LiveKit each open the phone's
// camera, and two at once fails. So before a live sends your camera:
//   holdCameraForLive() → await waitForCameraRelease() → publish.  When leaving: releaseCameraFromLive().
// holdCameraForLive() returns a number for this hold. A screen that passes it to releaseCameraFromLive(hold)
// can only end its own hold: a late "release" from a screen that is closing never gives the camera back while
// a newer live is using it.
// While the hold is on, every camera screen shows no camera at all (useCameraHeldByLive()), and calls
// markCameraReleased() when its camera has gone. The camera parts stop a moment after their view goes, so the
// wait lasts at least CAMERA_RELEASE_MIN_MS after the last "released" (or after the hold, when no camera screen
// was open) and at most CAMERA_RELEASE_MAX_MS after the hold. Each camera screen that was open when the hold
// started (each one using useCameraHeldByLive) is waited for, so a slow one isn't missed.
// ---------------------------------------------------------------------------

export const CAMERA_RELEASE_MIN_MS = 500;
export const CAMERA_RELEASE_MAX_MS = 1200;

let cameraHeld = false;
let holdId = 0;
let heldAt = 0;
let lastRelease = 0;
let releasesExpected = 0;
let releasesSeen = 0;
const cameraListeners = new Set<() => void>();
const releaseWaiters = new Set<() => void>();

function cameraHeldNow(): boolean {
  return cameraHeld;
}

function subscribeCamera(listener: () => void): () => void {
  cameraListeners.add(listener);
  return () => {
    cameraListeners.delete(listener);
  };
}

export function holdCameraForLive(): number {
  holdId += 1;
  if (cameraHeld) return holdId; // already held: the newest holder owns it now
  cameraHeld = true;
  heldAt = Date.now();
  lastRelease = 0;
  releasesSeen = 0;
  // The camera screens open right now (each one listens through useCameraHeldByLive).
  releasesExpected = cameraListeners.size;
  tellAll(cameraListeners);
  return holdId;
}

// For camera screens: true while a live is using the camera (show no camera then).
export function useCameraHeldByLive(): boolean {
  return useSyncExternalStore(subscribeCamera, cameraHeldNow, cameraHeldNow);
}

export function isCameraHeldByLive(): boolean {
  return cameraHeld;
}

// Called by a camera screen when its camera view has gone.
export function markCameraReleased(): void {
  if (!cameraHeld) return;
  lastRelease = Date.now();
  releasesSeen += 1;
  tellAll(releaseWaiters);
}

// When the camera is free for the live (see above). Resolves at once when no hold is on.
export function waitForCameraRelease(): Promise<void> {
  if (!cameraHeld) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = () => {
      if (timer) clearTimeout(timer);
      releaseWaiters.delete(check);
      resolve();
    };
    const check = () => {
      if (timer) clearTimeout(timer);
      if (!cameraHeld) {
        done();
        return;
      }
      const now = Date.now();
      const latest = heldAt + CAMERA_RELEASE_MAX_MS;
      // Still waiting for a camera screen to say its camera has gone: wait (at most until `latest`).
      const allGone = releasesSeen >= releasesExpected;
      const readyAt = allGone ? Math.min(Math.max(heldAt, lastRelease) + CAMERA_RELEASE_MIN_MS, latest) : latest;
      if (now >= readyAt) {
        done();
        return;
      }
      timer = setTimeout(check, readyAt - now);
    };
    releaseWaiters.add(check);
    check();
  });
}

// The live is done with the camera: the camera screens show their camera again. With `hold`: only if that is
// still the newest hold.
export function releaseCameraFromLive(hold?: number | null): void {
  if (!cameraHeld) return;
  if (typeof hold === 'number' && hold !== holdId) return;
  cameraHeld = false;
  lastRelease = 0;
  releasesSeen = 0;
  releasesExpected = 0;
  tellAll(cameraListeners);
  tellAll(releaseWaiters);
}
