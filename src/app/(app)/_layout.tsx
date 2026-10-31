import { Stack } from 'expo-router';
import { useEffect } from 'react';

import { TermsGate } from '@/components/TermsGate';
import { useAuth } from '@/lib/auth';
import { syncCommunityDares } from '@/lib/communityDares';
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

  // Today's dare might be a community one: find out as soon as you're in (and keep last month's for old posts).
  useEffect(() => {
    if (!userId) return;
    syncCommunityDares().catch((error) => console.warn('Could not load community dares', error));
  }, [userId]);

  return (
    <>
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
      {/* Comments slide up as a sheet over the post (the screen draws its own sheet and animation). */}
      <Stack.Screen
        name="comments/[postId]"
        options={{ presentation: 'transparentModal', animation: 'none', contentStyle: { backgroundColor: 'transparent' } }}
      />
      <Stack.Screen name="camera" options={{ animation: 'slide_from_bottom' }} />
      <Stack.Screen name="map" options={{ animation: 'slide_from_bottom' }} />
    </Stack>
    {/* Everyone must have agreed to the current Terms of Service. */}
    <TermsGate />
    </>
  );
}
