import { Stack } from 'expo-router';
import { useEffect } from 'react';

import { useAuth } from '@/lib/auth';
import { useShareLocationWhileOpen } from '@/lib/location';
import { scheduleDropNotifications, useDropNotificationTaps } from '@/lib/notifications';
import { colors } from '@/theme';

// Every screen you can reach once you're logged in.
export default function AppLayout() {
  const { userId, profile } = useAuth();
  // If you share your location, keep your spot on the friend map fresh while the app is open.
  useShareLocationWhileOpen(userId, profile?.location_sharing ?? false);

  // Peekaboo drops: set this week's drop alerts, and open the drop camera when one is tapped.
  useEffect(() => {
    scheduleDropNotifications().catch((error) => console.warn('Could not schedule drop alerts', error));
  }, []);
  useDropNotificationTaps(true);

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
