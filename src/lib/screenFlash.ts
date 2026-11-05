import { requireOptionalNativeModule } from 'expo';

// ---------------------------------------------------------------------------
// The selfie flash 💡 (like the iPhone camera's own front flash): selfie cameras have no light, so for a
// moment the whole screen turns a warm, bright white and goes to full brightness, then back to how it was.
//
// Full brightness needs expo-brightness, which only app downloads built with it have. Without it (Expo Go,
// older downloads) the flash still happens, just at the brightness the phone was already at.
// ---------------------------------------------------------------------------

const Brightness: typeof import('expo-brightness') | null = requireOptionalNativeModule('ExpoBrightness')
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('expo-brightness')
  : null;

// The flash colour: a soft warm white, kinder to skin than pure white (the iPhone's is warm too).
export const SCREEN_FLASH_COLOR = '#FFF6E6';

// How long the screen stays bright before the photo is taken, so the camera has time to adjust to the light.
export const SCREEN_FLASH_WARMUP_MS = 450;

// Turns the screen to full brightness. Returns a function that puts it back. Never throws.
export async function brightenScreen(): Promise<() => Promise<void>> {
  if (!Brightness) return async () => {};
  try {
    const before = await Brightness.getBrightnessAsync();
    await Brightness.setBrightnessAsync(1);
    return async () => {
      try {
        await Brightness.setBrightnessAsync(before);
      } catch {
        // the phone puts it back itself when you leave the app
      }
    };
  } catch {
    return async () => {};
  }
}
