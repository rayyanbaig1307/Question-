import { Alert } from 'react-native';

import { liveNowRole } from './liveAccess';

// ---------------------------------------------------------------------------
// Lives 🔴: "End your live to open this?"
// While you're hosting (or on stage in someone's live), tapping a notification would pull you out of the live.
// So we ask first. The live screen that's open says how to leave it properly (stop the camera, tell the
// server) with setLiveExit(); "End and open" runs that, then opens what you tapped. "Stay" does nothing.
// Watching someone else's live doesn't ask: the screen behind closes the connection by itself.
// ---------------------------------------------------------------------------

type Exit = () => Promise<void> | void;

let exit: Exit | null = null;

// The live screen that's open registers how to leave it. Returns the "forget it" function.
export function setLiveExit(handler: Exit): () => void {
  exit = handler;
  return () => {
    if (exit === handler) exit = null;
  };
}

// Leave the live you're in (if a screen said how). Never throws.
export async function leaveLiveNow(): Promise<void> {
  const handler = exit;
  if (!handler) return;
  try {
    await handler();
  } catch (error) {
    console.warn('Could not leave the live', error);
  }
}

// `open` runs straight away, unless you're hosting or on stage: then you're asked first.
export function openUnlessLive(open: () => void): void {
  const role = liveNowRole();
  if (role !== 'host' && role !== 'cohost') {
    open();
    return;
  }
  const host = role === 'host';
  Alert.alert(
    host ? 'End your live to open this?' : 'Leave the stage to open this?',
    host ? 'Your friends will see that your live has ended.' : 'You can keep watching after.',
    [
      { text: 'Stay', style: 'cancel' },
      {
        text: host ? 'End and open' : 'Leave and open',
        style: 'destructive',
        onPress: () => {
          leaveLiveNow().then(open, open);
        },
      },
    ],
  );
}
