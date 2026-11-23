import { expect, it } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

// A new version of the app restarts the app (src/lib/appUpdates.ts). Never while something is still sending, while
// the editor or "Send to…" is open, or while the drop is live: a restart then would lose the send or the moment.
function load({ busy = () => false, drop = () => ({ kind: 'waiting' }) } = {}) {
  const calls = { checks: 0, fetches: 0, reloads: 0 };
  const updates = {
    isEnabled: true,
    checkForUpdateAsync: async () => { calls.checks++; return { isAvailable: true }; },
    fetchUpdateAsync: async () => { calls.fetches++; return { isNew: true }; },
    reloadAsync: async () => { calls.reloads++; },
  };
  const library = loadLibrary('appUpdates', {
    mocks: {
      'expo-updates': updates,
      './outbox': { outboxBusy: busy },
      './liveAccess': { isLiveNow: () => false, runAfterLive() {} },
      './drop': { dropStatus: drop },
      'react-native': { AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } },
    },
    globals: { __DEV__: false },
  });
  return { library, calls };
}

it('a new version never restarts the app while a send is still going out; it waits for a quiet moment', async () => {
  let busy = true;
  const { library, calls } = load({ busy: () => busy });
  await library.updateNow();
  expect(calls.fetches).toBe(1);
  expect(calls.reloads).toBe(0);
  // Back from the background with nothing sending: the downloaded version is used (not downloaded again).
  busy = false;
  await library.updateNow();
  expect(calls.reloads).toBe(1);
  expect(calls.fetches).toBe(1);
});

it('never during the drop', async () => {
  const { library, calls } = load({ drop: () => ({ kind: 'live' }) });
  await library.updateNow();
  expect(calls.reloads).toBe(0);
});

it('with nothing going on it restarts straight away, as before', async () => {
  const { library, calls } = load();
  await library.updateNow();
  expect(calls.reloads).toBe(1);
});
