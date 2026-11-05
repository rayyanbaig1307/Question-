import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

// ---------------------------------------------------------------------------
// App icons 📱 (Peekaboo+): pick a different picture for Peekaboo on your home screen.
//
// The icons themselves are built into the app (scripts/make-plus-icons.py makes them, app.json lists them
// for plugins/with-ios-app-icons.js). Changing them needs a new app build, not just an update.
//
// iPhone only for now. Expo Go, older downloads and Android don't have the native part, so the App icon
// screen just says it isn't available there.
// ---------------------------------------------------------------------------

// Asking first, because the library crashes if it's loaded without its native part.
const AltIcons: typeof import('expo-alternate-app-icons') | null =
  Platform.OS === 'ios' && requireOptionalNativeModule('ExpoAlternateAppIcons')
    ? // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('expo-alternate-app-icons')
    : null;

// True when this phone can change Peekaboo's icon.
export const CAN_CHANGE_APP_ICON = (() => {
  try {
    return !!AltIcons?.supportsAlternateIcons;
  } catch {
    return false;
  }
})();

export type AppIconKey =
  | 'classic' | 'dark-gold' | 'midnight' | 'mint' | 'sunny' | 'clean-white' | 'all-black' | 'cherry'
  | 'fx-sunset' | 'fx-aurora' | 'fx-holo' | 'fx-neon' | 'fx-ocean' | 'fx-glitter-gold' | 'fx-candy' | 'fx-galaxy';

export type AppIcon = {
  key: AppIconKey;
  // The name the iPhone knows it by (the same names as in app.json). Classic is the normal icon: null.
  name: string | null;
  label: string;
  // Free for everyone (only Classic) or Peekaboo+.
  plus: boolean;
  // A small picture for the App icon screen.
  preview: number;
};

export const APP_ICONS: AppIcon[] = [
  { key: 'classic', name: null, label: 'Classic', plus: false, preview: require('../../assets/icons/preview/classic.png') },
  { key: 'dark-gold', name: 'DarkGold', label: 'Dark Gold', plus: true, preview: require('../../assets/icons/preview/dark-gold.png') },
  { key: 'midnight', name: 'Midnight', label: 'Midnight', plus: true, preview: require('../../assets/icons/preview/midnight.png') },
  { key: 'mint', name: 'Mint', label: 'Mint', plus: true, preview: require('../../assets/icons/preview/mint.png') },
  { key: 'sunny', name: 'Sunny', label: 'Sunny', plus: true, preview: require('../../assets/icons/preview/sunny.png') },
  { key: 'clean-white', name: 'CleanWhite', label: 'Clean White', plus: true, preview: require('../../assets/icons/preview/clean-white.png') },
  { key: 'all-black', name: 'AllBlack', label: 'All Black', plus: true, preview: require('../../assets/icons/preview/all-black.png') },
  { key: 'cherry', name: 'Cherry', label: 'Cherry', plus: true, preview: require('../../assets/icons/preview/cherry.png') },
  { key: 'fx-sunset', name: 'FxSunset', label: 'Sunset Fade', plus: true, preview: require('../../assets/icons/preview/fx-sunset.png') },
  { key: 'fx-aurora', name: 'FxAurora', label: 'Aurora', plus: true, preview: require('../../assets/icons/preview/fx-aurora.png') },
  { key: 'fx-holo', name: 'FxHolo', label: 'Holographic', plus: true, preview: require('../../assets/icons/preview/fx-holo.png') },
  { key: 'fx-neon', name: 'FxNeon', label: 'Neon', plus: true, preview: require('../../assets/icons/preview/fx-neon.png') },
  { key: 'fx-ocean', name: 'FxOcean', label: 'Ocean Fade', plus: true, preview: require('../../assets/icons/preview/fx-ocean.png') },
  { key: 'fx-glitter-gold', name: 'FxGlitterGold', label: 'Glitter Gold', plus: true, preview: require('../../assets/icons/preview/fx-glitter-gold.png') },
  { key: 'fx-candy', name: 'FxCandy', label: 'Candy Stripe', plus: true, preview: require('../../assets/icons/preview/fx-candy.png') },
  { key: 'fx-galaxy', name: 'FxGalaxy', label: 'Galaxy', plus: true, preview: require('../../assets/icons/preview/fx-galaxy.png') },
];

// The icon on the home screen right now (Classic when it can't be changed, or when the phone says an icon
// we don't know).
export function currentAppIcon(): AppIconKey {
  if (!AltIcons || !CAN_CHANGE_APP_ICON) return 'classic';
  try {
    const name = AltIcons.getAppIconName();
    return APP_ICONS.find((icon) => icon.name === name)?.key ?? 'classic';
  } catch {
    return 'classic';
  }
}

// Changes the home-screen icon. The iPhone shows its own little "You have changed the icon" message.
// Throws if it can't be done here, or if the phone said no.
export async function setAppIcon(key: AppIconKey): Promise<void> {
  const icon = APP_ICONS.find((item) => item.key === key);
  if (!icon) throw new Error("That icon doesn't exist.");
  if (!AltIcons || !CAN_CHANGE_APP_ICON) throw new Error('Changing the app icon needs the newest Peekaboo on an iPhone.');
  await AltIcons.setAlternateAppIcon(icon.name);
}
