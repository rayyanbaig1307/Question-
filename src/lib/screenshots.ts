import { requireOptionalNativeModule } from 'expo';
import { useEffect, useEffectEvent } from 'react';

import { sendScreenshotNotice } from './chat';

// The screenshot detector is a native part of the app. Expo Go has it, but an app built before it was added
// doesn't – so only load it when it's there (otherwise screenshot alerts are simply skipped).
const ScreenCapture: typeof import('expo-screen-capture') | null = requireOptionalNativeModule('ExpoScreenCapture')
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('expo-screen-capture')
  : null;

// While `enabled`, a screenshot tells the other person: "📸 … took a screenshot of the chat / your peek".
// (On Android 13 and older phones, screenshots can't be detected without an extra permission, so it's skipped there.)
export function useScreenshotNotice(
  me: string,
  other: string | null,
  what: 'chat' | 'peek',
  enabled: boolean,
  onScreenshot?: () => void,
) {
  const noticed = useEffectEvent(() => onScreenshot?.());

  useEffect(() => {
    if (!enabled || !other || !ScreenCapture) return;
    let last = 0;
    const subscription = ScreenCapture.addScreenshotListener(() => {
      // Several screenshots in a row only send one notice.
      const now = Date.now();
      if (now - last < 3000) return;
      last = now;
      sendScreenshotNotice(me, other, what).catch((error) => console.warn('Could not send screenshot notice', error));
      noticed();
    });
    return () => subscription.remove();
  }, [me, other, what, enabled]);
}
