import { useEffect } from 'react';
import { AppState } from 'react-native';
import * as Updates from 'expo-updates';

// ---------------------------------------------------------------------------
// New versions of the app arrive over the air. On its own, the phone only downloads one when the app starts
// and uses it the *next* time the app starts – so people kept seeing the old version.
// Now: whenever the app opens or comes back from the background, it checks for a new version, downloads it
// and restarts into it straight away (a quick blink, only when there really is something new).
// ---------------------------------------------------------------------------

let busy = false;

async function updateNow() {
  if (busy || __DEV__ || !Updates.isEnabled) return;
  busy = true;
  try {
    const check = await Updates.checkForUpdateAsync();
    if (!check.isAvailable) return;
    const fetched = await Updates.fetchUpdateAsync();
    if (fetched.isNew) await Updates.reloadAsync();
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
