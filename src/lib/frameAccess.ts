import AsyncStorage from '@react-native-async-storage/async-storage';
import { requireOptionalNativeModule } from 'expo';
import { useSyncExternalStore } from 'react';
import { Platform, TurboModuleRegistry } from 'react-native';

// ---------------------------------------------------------------------------
// The 4 stretchy filters (🫥 Tiny Face, 🗿 Gigachin, 😃 Big Mouth, 👾 Pixel Panic) change the camera picture
// itself, so they need the camera's own pixels. Only downloads built with react-native-vision-camera-worklets
// have them (App Store 1.1+, the new TestFlight build, Android APK v17+). Everywhere else this is false and
// their bubbles never show.
//
// Never import 'react-native-vision-camera-worklets' anywhere: on older downloads just loading it closes the
// app. The camera's own useFrameOutput loads it when it's needed, and that only happens in
// components/lens/warp/FrameFeed.tsx, which is only loaded when FRAME_ACCESS_AVAILABLE is true.
// See docs/FACE_MESH.md ("The stretchy filters").
// ---------------------------------------------------------------------------

// The off switch for all 4 (can be changed by an app update, no new download needed).
export const WARPS_ENABLED = true;
// Android has the code too, but it stays off until an Android phone passes the checks (docs/TESTING.md).
export const WARPS_ON_ANDROID = false;
// How a camera picture gets to the screen: 'share' hands over the camera's own picture with no copy (iPhone),
// 'copy' makes a copy first (Android, where the camera takes its picture back too soon).
export const FRAME_PATH: 'share' | 'copy' = Platform.OS === 'ios' ? 'share' : 'copy';
// How many camera pictures are held back, so the picture matches the face points (they come a moment later).
// 0–2. If the phone starts dropping camera pictures, set this to 0.
export const FRAME_DELAY = 1;
// A camera picture older than this (milliseconds) is not shown: the normal camera view shows instead.
export const STALE_MS = 300;
// A camera error this soon (milliseconds) after the stretchy filters' camera pictures were switched on counts
// as "switching them on broke the camera" (see markFramesBroken 'strike').
export const FRAME_SETUP_MS = 4000;
// Raise this by one to let every phone that turned the stretchy filters off (markFramesBroken) try again,
// after a fix that came by app update.
const RETRY_ROUND = 1;
// How many different app starts with a 'strike' it takes before the phone remembers it for good.
const STRIKES_TO_REMEMBER = 2;

function check(): boolean {
  try {
    if (!WARPS_ENABLED) return false;
    if (Platform.OS === 'ios') {
      // iOS 17 is needed for camera pictures the size of the screen (smaller and quicker).
      if (!(parseInt(String(Platform.Version), 10) >= 17)) return false;
    } else if (Platform.OS !== 'android' || !WARPS_ON_ANDROID || !(Number(Platform.Version) >= 28)) {
      return false;
    }
    // Asking first, because these libraries crash if they're loaded without their native parts.
    if (!TurboModuleRegistry.get('NitroModules')) return false;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NitroModules } = require('react-native-nitro-modules') as typeof import('react-native-nitro-modules');
    return NitroModules.hasHybridObject('WorkletQueueFactory') && NitroModules.hasHybridObject('CameraFactory');
  } catch {
    return false;
  }
}

export const FRAME_ACCESS_AVAILABLE = check();

// ---------------------------------------------------------------------------
// If the stretchy filters ever break on a phone, they switch themselves off: their 4 bubbles disappear and the
// camera goes back to normal. How long for depends on what went wrong (markFramesBroken below):
// - 'remember': something only the new code can cause (it couldn't load, its GPU programs couldn't be made, or
//   the camera pictures kept failing). The phone remembers it for this download (its build number), so it
//   doesn't keep failing.
// - 'thisRun': the camera reported an error while they were on. Lots of things the filters have nothing to do
//   with cause camera errors too (a zoom it can't do, the phone's media system restarting), so they only stay
//   off until the app is closed.
// - 'strike': the camera reported an error just after their camera pictures were switched on, which is what it
//   looks like when adding them breaks the camera on this phone. Off until the app is closed; if it happens in
//   STRIKES_TO_REMEMBER different app starts, the phone remembers it for this download.
// ---------------------------------------------------------------------------

export type FramesBrokenHow = 'remember' | 'thisRun' | 'strike';

let broken = false;
let remembered = false;
let warned = false;
const listeners = new Set<() => void>();
// This app start's own name, so several strikes in one app start count once.
const RUN = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;

function buildNumber(): string {
  try {
    const app = requireOptionalNativeModule<{ nativeBuildVersion?: string | null }>('ExpoApplication');
    if (app?.nativeBuildVersion) return String(app.nativeBuildVersion);
  } catch {
    // Use 'unknown'.
  }
  return 'unknown';
}

function storageKey(): string {
  return `peekaboo.framesBroken.${buildNumber()}.${RETRY_ROUND}`;
}

function strikesKey(): string {
  return `peekaboo.framesStrikes.${buildNumber()}.${RETRY_ROUND}`;
}

function remember() {
  if (remembered) return;
  remembered = true;
  try {
    AsyncStorage.setItem(storageKey(), '1').catch(() => {});
  } catch {
    // Remembered until the app closes, at least.
  }
}

// Notes a strike for this app start; the second app start with one makes the phone remember it.
async function addStrike() {
  try {
    let runs: string[] = [];
    try {
      const saved: unknown = JSON.parse((await AsyncStorage.getItem(strikesKey())) ?? '[]');
      if (Array.isArray(saved)) runs = saved.filter((run): run is string => typeof run === 'string');
    } catch {
      // Nothing readable saved: start again.
    }
    if (!runs.includes(RUN)) runs = [...runs, RUN].slice(-5);
    await AsyncStorage.setItem(strikesKey(), JSON.stringify(runs));
    if (runs.length >= STRIKES_TO_REMEMBER) remember();
  } catch {
    // No storage: off until the app closes, at least.
  }
}

function tell() {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // One listener failing must not stop the others.
    }
  }
}

// Load what this phone remembered, once when the app starts (only where the filters could show at all).
if (FRAME_ACCESS_AVAILABLE) {
  try {
    AsyncStorage.getItem(storageKey())
      .then((saved) => {
        if (saved === '1' && !broken) {
          broken = true;
          tell();
        }
      })
      .catch(() => {});
  } catch {
    // No storage: start with the filters on.
  }
}

// True once the stretchy filters switched themselves off on this phone.
export function framesBroken(): boolean {
  return broken;
}

// Switches the stretchy filters off on this phone, at once. `how` says for how long (see above): 'remember'
// (for this download), 'thisRun' (until the app is closed) or 'strike'. `why` goes to the log once.
export function markFramesBroken(why?: unknown, how: FramesBrokenHow = 'remember'): void {
  if (!warned) {
    warned = true;
    console.warn('Stretchy face filters switched off', why ?? '');
  }
  if (how === 'remember') remember();
  else if (how === 'strike') void addStrike();
  if (broken) return;
  broken = true;
  tell();
}

// Calls `listener` when the stretchy filters switch themselves off. Returns the "stop listening" function.
export function subscribeFramesBroken(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// For screens: true while the 4 stretchy filters can be shown on this phone (re-renders when that changes).
export function useWarpLooksOn(): boolean {
  const isBroken = useSyncExternalStore(subscribeFramesBroken, framesBroken, framesBroken);
  return FRAME_ACCESS_AVAILABLE && !isBroken;
}
