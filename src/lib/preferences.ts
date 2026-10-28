import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

// Small settings that live on this phone only.

const SCRATCH_KEY = 'peekaboo.scratchToReveal';
let scratchToReveal = true;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

// Load the saved choice once when the app starts.
AsyncStorage.getItem(SCRATCH_KEY)
  .then((saved) => {
    if (saved !== null) {
      scratchToReveal = saved === 'true';
      notify();
    }
  })
  .catch(() => {});

// "Hold to reveal": drop photos in the feed start blurred and you scratch them clear. On by default.
export function useScratchToReveal(): [boolean, (on: boolean) => void] {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => scratchToReveal,
  );
  const set = (on: boolean) => {
    scratchToReveal = on;
    notify();
    AsyncStorage.setItem(SCRATCH_KEY, String(on)).catch(() => {});
  };
  return [value, set];
}
