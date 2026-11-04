import { Share } from 'react-native';

// Where friends can get Peekaboo.
// Android: this download installs the app directly (and it keeps updating itself after that). When there's a
// newer Android download, change this one line. iPhone: the TestFlight link (friends install the free TestFlight
// app, then Peekaboo from there); swap it for the App Store link once Peekaboo is on the store.
export const ANDROID_LINK: string | null = 'https://expo.dev/artifacts/eas/ppdhlnUFQfDTdK6MUZTA8Z00n9OjA-Y8VNH1AnCc-RA.apk';
export const IPHONE_LINK: string | null = 'https://testflight.apple.com/join/3DWqzxhS';

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
