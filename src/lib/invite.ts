import { Share } from 'react-native';

// The link friends get when you invite them.
// For now it opens the test version in the Expo Go app. Once Peekaboo is in the App Store / Google Play,
// change this one line to the store link.
export const APP_LINK = 'exp://u.expo.dev/3c421eae-c4ec-47ea-92da-4b2d07b7d13e?channel-name=preview';

// Opens the phone's share sheet (Messages, WhatsApp, Instagram, copy…) with an invite to the app.
export async function inviteFriends(username?: string | null): Promise<void> {
  const me = username ? ` I'm @${username} – add me!` : '';
  const message = `Come hang out with me on Peekaboo 👀 Photos, stories and daily dares.${me}\n\n${APP_LINK}`;
  try {
    await Share.share({ message });
  } catch (error) {
    console.warn('Could not open the share sheet', error);
  }
}
