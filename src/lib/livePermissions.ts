import { Camera } from 'expo-camera';
import { Linking } from 'react-native';

// ---------------------------------------------------------------------------
// Lives 🔴: the camera AND the microphone, before you go live or come on someone's live.
// The normal camera only asks for the microphone when you record a video, so many people have never allowed it.
// 'ok' = both allowed · 'denied' = you said no just now (we can ask again next time) · 'settings' = you said no
// for good, so only the phone's Settings can change it (show the Open Settings button).
// ---------------------------------------------------------------------------

export type LivePermission = 'ok' | 'denied' | 'settings';

export const LIVE_PERMISSION_WORDS = 'Peekaboo needs your camera and microphone so friends can see and hear you';

type Answer = { granted: boolean; canAskAgain: boolean };

async function askFor(get: () => Promise<Answer>, request: () => Promise<Answer>): Promise<LivePermission> {
  let answer = await get();
  if (!answer.granted && answer.canAskAgain) answer = await request();
  if (answer.granted) return 'ok';
  return answer.canAskAgain ? 'denied' : 'settings';
}

export async function ensureLivePermissions(): Promise<LivePermission> {
  try {
    const camera = await askFor(Camera.getCameraPermissionsAsync, Camera.requestCameraPermissionsAsync);
    if (camera !== 'ok') return camera;
    return await askFor(Camera.getMicrophonePermissionsAsync, Camera.requestMicrophonePermissionsAsync);
  } catch (error) {
    // The phone couldn't tell us: treat it as "not allowed" (nothing starts).
    console.warn('Could not check the camera and microphone', error);
    return 'denied';
  }
}

// The phone's Settings page for Peekaboo (where the camera and microphone can be switched on).
export function openPhoneSettings(): void {
  Linking.openSettings().catch(() => {});
}
