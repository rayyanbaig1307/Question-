import Constants, { ExecutionEnvironment } from 'expo-constants';
import { requireOptionalNativeModule } from 'expo';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';

import { dropAt, localDay } from './drop';
import { supabase } from './supabase';

// Notifications are a native part of the app. Expo Go has them, but an app built before they were added
// doesn't – so only load them when they're there (otherwise notifications are simply skipped).
const Notifications: typeof import('expo-notifications') | null = requireOptionalNativeModule('ExpoNotificationScheduler')
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('expo-notifications')
  : null;

// Clears Peekaboo's notifications off the lock screen / notification list, and the red number on the app icon.
// Done whenever you open the app (like Instagram and Snapchat), so old ones never pile up.
export function clearDeliveredNotifications() {
  if (!Notifications) return;
  Notifications.dismissAllNotificationsAsync().catch(() => {});
  Notifications.setBadgeCountAsync(0).catch(() => {});
}

export function useClearNotificationsWhenOpen(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    clearDeliveredNotifications();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') clearDeliveredNotifications();
    });
    return () => subscription.remove();
  }, [enabled]);
}

const DROP_DAYS_AHEAD = 7;
const DROP_ID = 'peekaboo-drop-';

// Show notifications even while Peekaboo is open, set up Android's notification channels, and ask for
// permission once. Returns true if notifications are allowed.
async function getReady(): Promise<boolean> {
  if (!Notifications) return false;
  Notifications.setNotificationHandler({
    // While Peekaboo is open: a quick banner, but it isn't kept in the phone's notification list
    // (you're already in the app, so it would only pile up there).
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: false,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('drops', {
      name: 'Peekaboo drops',
      importance: Notifications.AndroidImportance.HIGH,
    });
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Messages, friends, likes and comments',
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status === 'undetermined') status = (await Notifications.requestPermissionsAsync()).status;
  return status === 'granted';
}

// ---------------------------------------------------------------------------
// Push notifications (messages, friend requests, likes, comments) are sent by the database through Expo's
// push service. For that, each phone tells the database its "push address".
// ---------------------------------------------------------------------------
let myPushToken: string | null = null;

export async function registerForPush(): Promise<void> {
  if (!(await getReady()) || !Notifications) return;
  try {
    const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
    const { data: token } = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    // Expo Go (the testing app) shows its own logo on notifications, not Peekaboo's. So pushes only go to the
    // real Peekaboo app – and if this Expo Go was signed up for pushes before, it's taken off the list.
    if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) {
      await supabase.rpc('unregister_push_token', { push_token: token });
      return;
    }
    const phone = Platform.OS === 'ios' ? 'ios' : 'android';
    // The phone's time zone, so the server can send the drop alert at your local drop time if you haven't
    // opened Peekaboo for a while (see supabase/migrations/20261208000000_drop_reminders.sql).
    let { error } = await supabase.rpc('register_push_token', {
      push_token: token,
      phone,
      utc_offset: -new Date().getTimezoneOffset(),
    });
    // A server without the time-zone part yet: sign up for pushes the old way.
    if (error) ({ error } = await supabase.rpc('register_push_token', { push_token: token, phone }));
    if (error) throw error;
    myPushToken = token;
  } catch (error) {
    // Expected in Expo Go on Android, and in Android builds until Firebase is set up – everything else still works.
    console.warn('Push notifications are not available on this phone yet', error);
  }
}

// Logging out: stop sending your notifications to this phone.
export async function unregisterPush(): Promise<void> {
  if (!myPushToken) return;
  await supabase.rpc('unregister_push_token', { push_token: myPushToken });
  myPushToken = null;
}

// ---------------------------------------------------------------------------
// The daily Peekaboo drop alert is set by the phone itself: every phone works out the same times, so everyone
// is pinged together. Runs each time the app opens, to keep the next week topped up.
// ---------------------------------------------------------------------------
export async function scheduleDropNotifications(enabled: boolean): Promise<void> {
  if (!(await getReady()) || !Notifications) return;

  // Start fresh, then schedule today's drop (if it's still to come) and the next few days.
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  await Promise.all(
    scheduled
      .filter((notification) => notification.identifier.startsWith(DROP_ID))
      .map((notification) => Notifications.cancelScheduledNotificationAsync(notification.identifier)),
  );
  if (!enabled) return; // switched off in Settings

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

// Tapping a notification opens the right screen (also when the tap is what started the app).
function openFor(data: Record<string, unknown> | undefined) {
  switch (data?.type) {
    case 'drop':
      router.push({ pathname: '/camera', params: { drop: '1' } });
      break;
    case 'message':
      if (typeof data.from === 'string') router.push(`/chat/${data.from}`);
      break;
    case 'friends':
      router.push('/friends');
      break;
    case 'post':
      if (typeof data.post === 'string') router.push(`/post/${data.post}`);
      break;
    case 'comments':
      if (typeof data.post === 'string') router.push(`/comments/${data.post}`);
      break;
    case 'group':
      if (typeof data.group === 'string') router.push(`/groups/${data.group}`);
      break;
    case 'group_chat':
      if (typeof data.group === 'string') router.push(`/groups/chat/${data.group}`);
      break;
    case 'dare':
      router.push('/dare');
      break;
    case 'hitups':
      // Hit ups are at the top of Chat.
      router.dismissTo({ pathname: '/', params: { page: 'chat' } });
      break;
  }
}

// Calls `onArrive` when a notification of this type comes in while Peekaboo is open.
export function onNotificationArrived(type: string, onArrive: () => void): () => void {
  if (!Notifications) return () => {};
  const subscription = Notifications.addNotificationReceivedListener((notification) => {
    if ((notification.request.content.data as Record<string, unknown> | undefined)?.type === type) onArrive();
  });
  return () => subscription.remove();
}

export function useNotificationTaps(enabled: boolean) {
  useEffect(() => {
    if (!enabled || !Notifications) return;
    const handled = new Set<string>();
    const open = (response: import('expo-notifications').NotificationResponse | null) => {
      if (!response) return;
      const id = response.notification.request.identifier;
      if (handled.has(id)) return;
      handled.add(id);
      openFor(response.notification.request.content.data as Record<string, unknown> | undefined);
    };
    Notifications.getLastNotificationResponseAsync().then((response) => {
      open(response);
      // Don't reopen the same screen next time the app starts.
      if (response) Notifications.clearLastNotificationResponse();
    });
    const subscription = Notifications.addNotificationResponseReceivedListener(open);
    return () => subscription.remove();
  }, [enabled]);
}
