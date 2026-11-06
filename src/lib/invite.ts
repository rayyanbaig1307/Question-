import * as Updates from 'expo-updates';
import { Platform, Share } from 'react-native';

// Where friends can get Peekaboo.
// Android: this download installs the app directly (and it keeps updating itself after that). When there's a
// newer Android download, change this one line. It's only added to invites sent from an Android phone.
// iPhone: the App Store app (it gets its updates on the "production" channel) sends the App Store link. Test
// copies (TestFlight, Expo Go) still send the TestFlight link: friends install the free TestFlight app, then
// Peekaboo from there.
export const ANDROID_LINK: string | null = 'https://expo.dev/artifacts/eas/7-FSOjuqu58hI0bg_-BNsih5vi4Sv6DIjqKIz9n8jvg.apk';
export const APP_STORE_LINK = 'https://apps.apple.com/app/id6829561855';
export const TESTFLIGHT_LINK = 'https://testflight.apple.com/join/3DWqzxhS';
const isStoreApp = Updates.channel === 'production';
export const IPHONE_LINK: string | null = isStoreApp ? APP_STORE_LINK : TESTFLIGHT_LINK;

// Adds the download links to a message.
export function withAppLink(message: string): string {
  const lines = [message, ''];
  if (ANDROID_LINK && Platform.OS === 'android') lines.push(`📱 Android: ${ANDROID_LINK}`);
  lines.push(IPHONE_LINK ? `🍎 iPhone: ${IPHONE_LINK}` : '🍎 iPhone: coming to the App Store soon 🔜');
  return lines.join('\n');
}

// Opens the phone's share sheet (Messages, WhatsApp, Instagram, copy…) with an invite to the app.
export async function inviteFriends(username?: string | null): Promise<void> {
  const me = username ? ` I'm @${username} – add me!` : '';
  const message = withAppLink(`Come hang out with me on Peekaboo 👀 Photos, stories and daily dares.${me}`);
  try {
    await Share.share({ message });
  } catch (error) {
    console.warn('Could not open the share sheet', error);
  }
}
