import { useSyncExternalStore } from 'react';

// ---------------------------------------------------------------------------
// A lighter app open: what you look at first goes first.
//
// When the app opens, Home's posts and stories, the camera and your sends are what you wait for. Other things
// nobody is waiting for – drop alerts, signing this phone up for notifications, payments, community dares, your spot
// on the friend map, the numbers on the Chat tab – start about 2 seconds after Home is first drawn. Before, all of it
// left at the same moment (the logs showed about 25 requests at once), and on a weak signal the first things you
// wanted queued behind the rest for up to 15 seconds.
// ---------------------------------------------------------------------------

// How long after Home is drawn the extras start.
export const AFTER_HOME_MS = 2000;
// If Home never shows (the app opened straight into a chat from a notification), they start after this anyway.
export const AT_THE_LATEST_MS = 6000;

let started = false;
let homeTimer: ReturnType<typeof setTimeout> | null = null;
let latestTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function start() {
  if (started) return;
  started = true;
  if (homeTimer) clearTimeout(homeTimer);
  if (latestTimer) clearTimeout(latestTimer);
  homeTimer = null;
  latestTimer = null;
  listeners.forEach((listener) => listener());
}

// The "at the latest" clock starts the first time anything waits for the extras.
function startLatestClock() {
  if (!started && !latestTimer) latestTimer = setTimeout(start, AT_THE_LATEST_MS);
}

// Home (src/app/(app)/index.tsx) calls this once it's drawn.
export function noteHomeDrawn(): void {
  if (started || homeTimer) return;
  homeTimer = setTimeout(start, AFTER_HOME_MS);
}

// Have the extras started?
export function startupDone(): boolean {
  return started;
}

// Tells `listener` once the extras start. Returns the way to stop listening.
export function subscribeStartup(listener: () => void): () => void {
  listeners.add(listener);
  startLatestClock();
  return () => {
    listeners.delete(listener);
  };
}

// Waits until the extras may start (straight away once they have).
export function afterStartup(): Promise<void> {
  if (started) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = subscribeStartup(() => {
      stop();
      resolve();
    });
  });
}

// For screens: false until the extras may start, then true.
export function useStartupDone(): boolean {
  return useSyncExternalStore(subscribeStartup, startupDone, startupDone);
}
