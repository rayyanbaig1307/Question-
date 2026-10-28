import { Share } from 'react-native';

// The link friends get to download Peekaboo.
// Empty for now: the test version only opens in Expo Go for the app's owner, so a link would be dead for friends.
// When there's a real download link (TestFlight, App Store or Google Play), put it here and every invite uses it.
export const APP_LINK: string | null = null;

// Adds the download link to a message – or a "coming soon" note while there isn't one yet.
export function withAppLink(message: string): string {
  return APP_LINK ? `${message}\n\n${APP_LINK}` : `${message}\n\nIt's not in the App Store yet – I'll send you the link as soon as it's out 🔜`;
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
