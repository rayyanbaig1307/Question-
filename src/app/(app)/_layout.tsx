import { Stack } from 'expo-router';
import { useEffect } from 'react';

import { ProfileSetup, useNeedsSetup } from '@/components/ProfileSetup';
import { HeardAbout } from '@/components/HeardAbout';
import { OutboxToasts, SendingPill } from '@/components/OutboxBanner';
import { PendingInvite } from '@/components/PendingInvite';
import { CouldNotCheck, TermsGate } from '@/components/TermsGate';
import { useAuth } from '@/lib/auth';
import { syncCommunityDares } from '@/lib/communityDares';
import { warmFriends } from '@/lib/friends';
import { useNeedsHeardAbout } from '@/lib/heardAbout';
import { useShareLocationWhileOpen } from '@/lib/location';
import { fetchNotificationPrefs } from '@/lib/notificationPrefs';
import { registerForPush, scheduleDropNotifications, useNotificationTaps } from '@/lib/notifications';
import { restoreOutbox } from '@/lib/outbox';
import { configurePurchases } from '@/lib/plus';
import { usePlusLapse } from '@/lib/plusLapse';
import { cleanLeftoverUploads } from '@/lib/preupload';
import { afterStartup, useStartupDone } from '@/lib/startup';
import { colors } from '@/theme';

// Every screen you can reach once you're logged in.
export default function AppLayout() {
  const { userId, profile } = useAuth();
  // ⚡ The things below that nobody is waiting for start about 2 seconds after Home is drawn (lib/startup.ts), so
  // Home's posts, the camera and your sends don't queue behind them when the app opens on a weak signal.
  const later = useStartupDone();
  // If you share your location, keep your spot on the friend map fresh while the app is open.
  useShareLocationWhileOpen(later ? userId : null, profile?.location_sharing ?? false);

  // Notifications: set this week's Peekaboo drop alerts (unless switched off), sign this phone up for
  // push notifications, and open the right screen when a notification is tapped (that one straight away).
  useEffect(() => {
    if (!userId || !later) return;
    fetchNotificationPrefs(userId)
      .then((prefs) => scheduleDropNotifications(prefs.drops))
      .catch((error) => console.warn('Could not schedule drop alerts', error))
      .finally(() => registerForPush());
  }, [userId, later]);
  useNotificationTaps(true);

  // Today's dare might be a community one: find out soon after you're in (and keep last month's for old posts).
  // And your friends list, so "Send to…" shows your friends the moment it opens.
  useEffect(() => {
    if (!userId || !later) return;
    syncCommunityDares().catch((error) => console.warn('Could not load community dares', error));
    warmFriends(userId);
  }, [userId, later]);

  // 📤 Sends from before the app was closed show as "Not sent – tap to try again" (never sent by themselves) – read
  // from the phone straight away. Early uploads nobody used are tidied away a little later (lib/outbox.ts,
  // lib/preupload.ts).
  useEffect(() => {
    if (!userId) return;
    restoreOutbox(userId)
      .then(() => afterStartup())
      .then(() => cleanLeftoverUploads(userId))
      .catch((error) => console.warn('Could not check unsent messages', error));
  }, [userId]);

  // Peekaboo+ ⭐: set up payments for this account and check whether you have Plus.
  useEffect(() => {
    if (userId && later) configurePurchases(userId);
  }, [userId, later]);
  // Peekaboo+ ended: put the free app theme and icon back (every Plus feature locks again by itself).
  usePlusLapse(later);

  // Just made your account with Apple or Google: pick a username first (shown instead of the app).
  // If we couldn't check (no internet?), or your profile isn't loaded yet, say so and offer "Try again" –
  // never the app, and never an empty setup form.
  const [needsSetup, setupDone, setupCheck] = useNeedsSetup();
  // A brand-new account: "How did you hear about Peekaboo?" once, after the name and username (never blocks:
  // a slow or failed check just skips it, and an account older than 3 days isn't checked at all).
  const [needsHeardAbout, heardAboutDone] = useNeedsHeardAbout(
    needsSetup === false ? userId : null,
    profile?.created_at,
  );
  if (needsSetup === null) return null;
  if (setupCheck.failed || (needsSetup && !profile)) {
    return <CouldNotCheck onRetry={setupCheck.retry} checking={setupCheck.checking} />;
  }
  if (needsSetup) return <ProfileSetup onDone={setupDone} />;
  if (needsHeardAbout === null) return null;
  if (needsHeardAbout && userId) return <HeardAbout userId={userId} onDone={heardAboutDone} />;

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
      <Stack.Screen name="plus" options={{ animation: 'slide_from_bottom' }} />
      {/* Lives 🔴: going live, and watching a friend's live. No swipe-back, so a swipe can't end a live by accident. */}
      <Stack.Screen
        name="go-live"
        options={{ animation: 'fade', gestureEnabled: false, contentStyle: { backgroundColor: colors.black } }}
      />
      <Stack.Screen
        name="live/[id]"
        options={{ animation: 'fade', gestureEnabled: false, contentStyle: { backgroundColor: colors.black } }}
      />
      {/* Main Character Mode 🌆: fades in, no swipe-back (a sideways swipe there picks the next character). */}
      <Stack.Screen
        name="main-character"
        options={{ animation: 'fade', gestureEnabled: false, contentStyle: { backgroundColor: colors.black } }}
      />
    </Stack>
    {/* 📤 "Sending…" / "Couldn't send · tap" at the top, and the toasts when a send is in. */}
    {userId ? <SendingPill userId={userId} /> : null}
    {userId ? <OutboxToasts userId={userId} /> : null}
    {/* Everyone must have agreed to the current Terms of Service. */}
    <TermsGate />
    {/* An invite link opened before you were in the app (e.g. before logging in) opens now. */}
    <PendingInvite />
    </>
  );
}
