import { Stack } from 'expo-router';
import { useEffect } from 'react';

import { useAuth } from '@/lib/auth';
import { useShareLocationWhileOpen } from '@/lib/location';
import { fetchNotificationPrefs } from '@/lib/notificationPrefs';
import { registerForPush, scheduleDropNotifications, useNotificationTaps } from '@/lib/notifications';
import { colors } from '@/theme';

// Every screen you can reach once you're logged in.
export default function AppLayout() {
  const { userId, profile } = useAuth();
  // If you share your location, keep your spot on the friend map fresh while the app is open.
  useShareLocationWhileOpen(userId, profile?.location_sharing ?? false);

  // Notifications: set this week's Peekaboo drop alerts (unless switched off), sign this phone up for
  // push notifications, and open the right screen when a notification is tapped.
  useEffect(() => {
    if (!userId) return;
    fetchNotificationPrefs(userId)
      .then((prefs) => scheduleDropNotifications(prefs.drops))
      .catch((error) => console.warn('Could not schedule drop alerts', error))
      .finally(() => registerForPush());
  }, [userId]);
  useNotificationTaps(true);

  return (
    <Stack
      screenOptions={{
        // Every screen draws its own top bar (ScreenHeader), so they all match the app's style.
        headerShown: false,
        contentStyle: { backgroundColor: colors.bg },
      }}>
      <Stack.Screen name="editor" options={{ animation: 'fade', gestureEnabled: false }} />
      <Stack.Screen name="post/[id]" options={{ animation: 'fade', contentStyle: { backgroundColor: colors.black } }} />
      <Stack.Screen name="snap/[id]" options={{ animation: 'fade', contentStyle: { backgroundColor: colors.black } }} />
      <Stack.Screen
        name="stories/[user]"
        options={{ animation: 'fade', contentStyle: { backgroundColor: colors.black } }}
      />
      <Stack.Screen name="camera" options={{ animation: 'slide_from_bottom' }} />
      <Stack.Screen name="map" options={{ animation: 'slide_from_bottom' }} />
    </Stack>
  );
}
