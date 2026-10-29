import { Share } from 'react-native';

// Where friends can get Peekaboo.
// Android: this download installs the app directly (and it keeps updating itself after that). When there's a
// newer Android download, change this one line. iPhone: no link until Peekaboo is on TestFlight / the App Store.
export const ANDROID_LINK: string | null = 'https://expo.dev/artifacts/eas/e_fJ6C5N4BTeg9Ng3zOVgmHINujyj9zX0B5UXDf3m9w.apk';
export const IPHONE_LINK: string | null = null;

// Adds the download links to a message.
export function withAppLink(message: string): string {
  const lines = [message, ''];
  if (ANDROID_LINK) lines.push(`📱 Android: ${ANDROID_LINK}`);
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
