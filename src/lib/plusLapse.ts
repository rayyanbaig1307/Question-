import { reloadAppAsync } from 'expo';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { APP_ICONS, CAN_CHANGE_APP_ICON, currentAppIcon, setAppIcon } from '@/lib/appIcons';
import { plusSurelyOff, refreshServerPlus, watchMyPlus } from '@/lib/plus';
import { PLUS_THEMES, saveThemeChoice, themeChoice, type PlusTheme } from '@/theme';

// ---------------------------------------------------------------------------
// When Peekaboo+ ends (cancelled, or a payment didn't go through), everything goes back to free:
// - Every Plus feature locks again by itself (they all check usePlus() or the server), and the Peekaboo+
//   screen shows "Subscribe" again.
// - The two things that stay on the phone are put back here: a Plus app theme goes back to Dark (the app
//   restarts once in the new colours), and a Plus app icon goes back to the normal one.
// - Coming back to the app asks the server again, so Plus that ran out while the app was in the background
//   locks straight away.
// It only acts when we're SURE there's no Plus (plusSurelyOff): never on "not sure yet" or "no internet".
// ---------------------------------------------------------------------------

export function usePlusLapse(): void {
  useEffect(() => {
    let done = false;
    const check = () => {
      if (done || !plusSurelyOff()) return;
      done = true;
      endPlusExtras().catch((error) => console.warn('Could not put the free look back', error));
    };
    check();
    const stop = watchMyPlus(check);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshServerPlus().catch(() => {});
    });
    return () => {
      stop();
      subscription.remove();
    };
  }, []);
}

// Puts the free app icon and theme back. Exported for the tests.
export async function endPlusExtras(): Promise<void> {
  const icon = currentAppIcon();
  if (CAN_CHANGE_APP_ICON && APP_ICONS.find((item) => item.key === icon)?.plus) {
    try {
      await setAppIcon('classic');
    } catch (error) {
      console.warn('Could not put the normal app icon back', error);
    }
  }
  if ((PLUS_THEMES as readonly string[]).includes(themeChoice as PlusTheme)) {
    await saveThemeChoice('dark');
    // The colours are chosen when the app starts, so start again in Dark.
    await reloadAppAsync();
  }
}
