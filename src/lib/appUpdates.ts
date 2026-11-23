import { useEffect } from 'react';
import { AppState } from 'react-native';
import * as Updates from 'expo-updates';

import { dropStatus } from './drop';
import { isLiveNow, runAfterLive } from './liveAccess';
import { outboxBusy } from './outbox';

// ---------------------------------------------------------------------------
// New versions of the app arrive over the air. On its own, the phone only downloads one when the app starts
// and uses it the *next* time the app starts – so people kept seeing the old version.
// Now: whenever the app opens or comes back from the background, it checks for a new version, downloads it
// and restarts into it straight away (a quick blink, only when there really is something new).
// Never in the middle of a live 🔴 (hosting, on stage or watching): no check starts then, and if a live started
// while an update was downloading (e.g. the app was opened from a "Sam is live" notification), the update is
// kept and the restart waits until you close the live (lib/liveAccess.ts runAfterLive).
// Never while something is still being sent (lib/outbox.ts), while the editor or "Send to…" is open, or during
// the 2 minutes of the drop either: the downloaded version is kept and used the next time you come back to the
// app with nothing sending (or the next time the app starts – expo-updates does that by itself).
// ---------------------------------------------------------------------------

let busy = false;
// A new version is downloaded and waiting for a quiet moment.
let waitingToRestart = false;
// How many editors and "Send to…" screens are open right now.
let composing = 0;

function quietMoment(): boolean {
  return !outboxBusy() && composing === 0 && dropStatus().kind !== 'live';
}

// The editor and "Send to…" call this: no restart for a new version while they're open.
export function useNoRestartWhileOpen() {
  useEffect(() => {
    composing += 1;
    return () => {
      composing -= 1;
    };
  }, []);
}

export async function updateNow() {
  if (busy || __DEV__ || !Updates.isEnabled || isLiveNow()) return;
  busy = true;
  try {
    if (waitingToRestart) {
      if (quietMoment()) await Updates.reloadAsync();
      return;
    }
    const check = await Updates.checkForUpdateAsync();
    if (!check.isAvailable) return;
    const fetched = await Updates.fetchUpdateAsync();
    if (!fetched.isNew) return;
    // Checked again right before the restart: a live may have started while the update was downloading.
    if (isLiveNow()) {
      runAfterLive('ota', () => Updates.reloadAsync());
      return;
    }
    if (!quietMoment()) {
      waitingToRestart = true;
      return;
    }
    await Updates.reloadAsync();
  } catch (error) {
    // No internet, or the update server is busy: try again next time.
    console.warn('Could not check for an update', error);
  } finally {
    busy = false;
  }
}

export function useStayUpToDate() {
  useEffect(() => {
    updateNow();
    // Only after the app really was in the background (not after a quick pop-up like the photo picker,
    // so nothing you're in the middle of gets interrupted).
    let last = AppState.currentState;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && last === 'background') updateNow();
      last = state;
    });
    return () => subscription.remove();
  }, []);
}
