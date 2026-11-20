import type * as Native from './liveAccess';

// ---------------------------------------------------------------------------
// The website version of liveAccess.ts: lives never run on the web, so everything here says "no" and loads
// nothing (LiveKit must never get into the website bundle). Same names as liveAccess.ts.
// ---------------------------------------------------------------------------

export const LIVE_ENABLED = true;
export const LIVE_ON_ANDROID = false;
export const HEARTS_ENABLED = true;
export const LIVE_MIN_APP_VERSION = '1.2.0';
export const LIVE_NATIVE_MODULES = ['WebRTCModule', 'LivekitReactNativeModule'] as const;
export const CAMERA_RELEASE_MIN_MS = 500;
export const CAMERA_RELEASE_MAX_MS = 1200;
export const LEAVE_WAIT_MS = 8000;

export type LiveStageModule = Native.LiveStageModule;
export type LiveRole = Native.LiveRole;
export type LiveUnavailableReason = Native.LiveUnavailableReason;

export const LIVE_UNAVAILABLE_WORDS: Record<LiveUnavailableReason, string> = {
  update: 'Update Peekaboo to watch lives 🔴',
  android: "Lives aren't on Android yet – soon! 🔴",
  off: 'Lives are switched off for now.',
  broken: "Lives aren't working on this phone right now.",
};

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

export function liveBroken(): boolean {
  return false;
}
export function markLiveBroken(_why?: unknown): void {}
export function subscribeLiveBroken(_listener: () => void): () => void {
  return () => {};
}
export function liveMaybeAvailable(): boolean {
  return false;
}
export function isLiveAvailable(): boolean {
  return false;
}
export function liveUnavailableReason(): LiveUnavailableReason | null {
  return LIVE_ENABLED ? 'broken' : 'off';
}
export function loadLiveStage(): LiveStageModule | null {
  return null;
}

export function setLiveNow(_role: LiveRole | null): void {}
export function liveNowRole(): LiveRole | null {
  return null;
}
export function isLiveNow(): boolean {
  return false;
}
export function useLiveNow(): LiveRole | null {
  return null;
}
export function onLiveEnded(_listener: () => void): () => void {
  return () => {};
}
// Nothing is ever live on the web, so the work runs at once.
export function runAfterLive(_key: string, work: () => unknown): void {
  try {
    Promise.resolve(work()).catch((error) => console.warn('Could not finish what waited for the live to end', error));
  } catch (error) {
    console.warn('Could not finish what waited for the live to end', error);
  }
}

export function whileLeaving(_work: Promise<unknown>): void {}

export function holdCameraForLive(): number {
  return 0;
}
export function useCameraHeldByLive(): boolean {
  return false;
}
export function isCameraHeldByLive(): boolean {
  return false;
}
export function markCameraReleased(): void {}
export function waitForCameraRelease(): Promise<void> {
  return Promise.resolve();
}
export function releaseCameraFromLive(_hold?: number | null): void {}

// Type check only: the web version must have every name the phone version has, with the same shapes.
type Same = { [K in keyof typeof Native]: (typeof Native)[K] };
const _same: Same = {
  LIVE_ENABLED, LIVE_ON_ANDROID, HEARTS_ENABLED, LIVE_MIN_APP_VERSION, LIVE_NATIVE_MODULES, CAMERA_RELEASE_MIN_MS,
  CAMERA_RELEASE_MAX_MS, LEAVE_WAIT_MS, LIVE_UNAVAILABLE_WORDS, versionAtLeast, liveBroken, markLiveBroken,
  subscribeLiveBroken, liveMaybeAvailable, isLiveAvailable, liveUnavailableReason, loadLiveStage, setLiveNow,
  liveNowRole, isLiveNow, useLiveNow, onLiveEnded, runAfterLive, whileLeaving, holdCameraForLive,
  useCameraHeldByLive, isCameraHeldByLive, markCameraReleased, waitForCameraRelease, releaseCameraFromLive,
};
void _same;
