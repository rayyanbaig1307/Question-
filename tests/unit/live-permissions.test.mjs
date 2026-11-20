import { expect, it } from 'vitest';

import { loadTs } from './liveLoad.mjs';

// Lives 🔴: the camera AND the microphone before going live or coming on someone's live
// (src/lib/livePermissions.ts). Many people never allowed the microphone (the camera only asks for it when you
// record a video). Asked when it can still be asked; "for good" means only the phone's Settings can change it.

function load({ camera, mic, failing = false }) {
  const asked = [];
  const opened = [];
  const answer = (state, name) => async () => {
    asked.push(name);
    if (failing) throw new Error('no camera module');
    return { ...state.now };
  };
  const ask = (state, name) => async () => {
    asked.push(name);
    state.now = { ...state.afterAsk };
    return { ...state.now };
  };
  const lib = loadTs('src/lib/livePermissions.ts', {
    'expo-camera': {
      Camera: {
        getCameraPermissionsAsync: answer(camera, 'get camera'),
        requestCameraPermissionsAsync: ask(camera, 'ask camera'),
        getMicrophonePermissionsAsync: answer(mic, 'get mic'),
        requestMicrophonePermissionsAsync: ask(mic, 'ask mic'),
      },
    },
    'react-native': { Linking: { openSettings: async () => { opened.push('settings'); } } },
  });
  return { lib, asked, opened };
}

const allowed = { granted: true, canAskAgain: true };
const notYet = { granted: false, canAskAgain: true };
const never = { granted: false, canAskAgain: false };

it('both already allowed: ok, and nothing is asked', async () => {
  const { lib, asked } = load({ camera: { now: allowed }, mic: { now: allowed } });
  expect(await lib.ensureLivePermissions()).toBe('ok');
  expect(asked).toEqual(['get camera', 'get mic']);
});

it('the microphone never asked before: it is asked now; yes → ok, no → "denied" (ask again next time)', async () => {
  let phone = load({ camera: { now: allowed }, mic: { now: notYet, afterAsk: allowed } });
  expect(await phone.lib.ensureLivePermissions()).toBe('ok');
  expect(phone.asked).toEqual(['get camera', 'get mic', 'ask mic']);

  phone = load({ camera: { now: allowed }, mic: { now: notYet, afterAsk: notYet } });
  expect(await phone.lib.ensureLivePermissions()).toBe('denied');
});

it('refused for good: "settings" (the Open Settings button), and the phone isn\'t asked again', async () => {
  let phone = load({ camera: { now: allowed }, mic: { now: never } });
  expect(await phone.lib.ensureLivePermissions()).toBe('settings');
  expect(phone.asked).toEqual(['get camera', 'get mic']);
  // The camera refused for good: the microphone isn't even looked at.
  phone = load({ camera: { now: never }, mic: { now: allowed } });
  expect(await phone.lib.ensureLivePermissions()).toBe('settings');
  expect(phone.asked).toEqual(['get camera']);
  phone.lib.openPhoneSettings();
  await Promise.resolve();
  expect(phone.opened).toEqual(['settings']);
});

it('the phone can\'t tell: counts as "not allowed" (nothing starts)', async () => {
  const { lib } = load({ camera: { now: allowed }, mic: { now: allowed }, failing: true });
  expect(await lib.ensureLivePermissions()).toBe('denied');
});

it('the words for the Open Settings line', () => {
  const { lib } = load({ camera: { now: allowed }, mic: { now: allowed } });
  expect(lib.LIVE_PERMISSION_WORDS).toBe('Peekaboo needs your camera and microphone so friends can see and hear you');
});
