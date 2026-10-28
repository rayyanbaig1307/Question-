import { requireOptionalNativeModule } from 'expo';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { Platform } from 'react-native';

import { dropAt, localDay } from './drop';

// Notifications are a native part of the app. Expo Go has them, but an app built before they were added
// doesn't – so only load them when they're there (otherwise drop alerts are simply skipped).
const Notifications: typeof import('expo-notifications') | null = requireOptionalNativeModule('ExpoNotificationScheduler')
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('expo-notifications')
  : null;

const DROP_DAYS_AHEAD = 7;
const DROP_ID = 'peekaboo-drop-';

// Sets the phone's own "alarm" for the next week of Peekaboo drops. Every phone works out the same times,
// so everyone is pinged together (no server needed). Runs each time the app opens, to keep the week topped up.
export async function scheduleDropNotifications(): Promise<void> {
  if (!Notifications) return;

  Notifications.setNotificationHandler({
    // Show the drop even if Peekaboo is open at that moment.
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('drops', {
      name: 'Peekaboo drops',
      importance: Notifications.AndroidImportance.HIGH,
    });
  }

  let { status } = await Notifications.getPermissionsAsync();
  if (status === 'undetermined') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return;

  // Start fresh, then schedule today's drop (if it's still to come) and the next few days.
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  await Promise.all(
    scheduled
      .filter((notification) => notification.identifier.startsWith(DROP_ID))
      .map((notification) => Notifications.cancelScheduledNotificationAsync(notification.identifier)),
  );
  const now = Date.now();
  for (let i = 0; i < DROP_DAYS_AHEAD; i++) {
    const day = localDay(new Date(now + i * 24 * 60 * 60 * 1000));
    const at = dropAt(day);
    if (at.getTime() <= now) continue;
    await Notifications.scheduleNotificationAsync({
      identifier: DROP_ID + day,
      content: {
        title: 'Peekaboo! 👀',
        body: "You have 2 minutes to show what you're doing.",
        data: { type: 'drop', day },
        sound: true,
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: at, channelId: 'drops' },
    });
  }
}

// Tapping a drop notification opens the drop camera (also when the tap is what started the app).
export function useDropNotificationTaps(enabled: boolean) {
  useEffect(() => {
    if (!enabled || !Notifications) return;
    const handled = new Set<string>();
    const open = (response: import('expo-notifications').NotificationResponse | null) => {
      if (!response || response.notification.request.content.data?.type !== 'drop') return;
      const id = response.notification.request.identifier;
      if (handled.has(id)) return;
      handled.add(id);
      router.push({ pathname: '/camera', params: { drop: '1' } });
    };
    Notifications.getLastNotificationResponseAsync().then((response) => {
      open(response);
      // Don't reopen the same drop next time the app starts.
      if (response) Notifications.clearLastNotificationResponse();
    });
    const subscription = Notifications.addNotificationResponseReceivedListener(open);
    return () => subscription.remove();
  }, [enabled]);
}
