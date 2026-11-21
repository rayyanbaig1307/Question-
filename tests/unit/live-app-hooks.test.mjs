import { afterEach, expect, it, vi } from 'vitest';

import { loadLibrary } from './libHarness.mjs';
import { loadTs } from './liveLoad.mjs';

// Lives 🔴 and the rest of the app (src/lib/notifications.ts, appUpdates.ts, notificationPrefs.ts and the root
// layout's theme restart), with the REAL live-now flag (src/lib/liveAccess.ts) and the real "End your live to
// open this?" step (src/lib/liveExit.ts):
// - nothing restarts the app during a live: an update that finishes downloading mid-live waits until Done;
// - while hosting or on stage, no banner pops up, and tapping a notification asks first (Stay = nothing happens);
// - "… is live" notifications open the live only on a phone that can show lives, and never mid-live;
// - after registering for pushes, the phone tells the server whether it can open a live;
// - a server without the new `lives` setting still answers "on".

afterEach(() => {
  vi.useRealTimers();
});

// The phone: an iPhone with the 1.2.0 download on the `testing` update channel (lives work: TestFlight build 13)
// unless `version` or `channel` says otherwise (the App Store app listens on `production`).
function phoneMocks({ version = '1.2.0', alerts = [], channel = 'testing' } = {}) {
  return {
    'expo-updates': { channel },
    expo: {
      requireOptionalNativeModule: (name) => {
        if (name === 'ExpoApplication') return { nativeApplicationVersion: version };
        if (name === 'ExpoNotificationScheduler') return {};
        return null;
      },
      reloadAppAsync: async () => {},
    },
    'expo-constants': {
      __esModule: true,
      default: { executionEnvironment: 'standalone', expoConfig: { extra: { eas: { projectId: 'project' } } } },
      ExecutionEnvironment: { StoreClient: 'storeClient' },
    },
    react: { useEffect() {}, useCallback: (fn) => fn, useSyncExternalStore: (_subscribe, get) => get() },
    'react-native': {
      NativeModules: {},
      Platform: { OS: 'ios' },
      AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
      Alert: { alert: (...args) => alerts.push(args) },
      Linking: { openSettings: async () => {} },
    },
  };
}

function loadAccess(options) {
  return loadLibrary('liveAccess', { mocks: phoneMocks(options) });
}

// ---------------------------------------------------------------------------
// App updates
// ---------------------------------------------------------------------------

function loadUpdates({ live }) {
  const steps = [];
  let finishFetch;
  const updates = {
    isEnabled: true,
    checkForUpdateAsync: async () => { steps.push('check'); return { isAvailable: true }; },
    fetchUpdateAsync: () => { steps.push('fetch'); return new Promise((resolve) => { finishFetch = () => resolve({ isNew: true }); }); },
    reloadAsync: async () => { steps.push('reload'); },
  };
  const lib = loadLibrary('appUpdates', {
    mocks: { ...phoneMocks(), 'expo-updates': updates, './liveAccess': live },
    globals: { __DEV__: false },
  });
  return { lib, steps, finishFetch: () => finishFetch() };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

it('no update check starts during a live', async () => {
  const live = loadAccess();
  const { lib, steps } = loadUpdates({ live });
  live.setLiveNow('host');
  await lib.updateNow();
  expect(steps).toEqual([]);
  live.setLiveNow(null);
});

it('an update that finishes downloading after a live started waits for Done, then restarts exactly once', async () => {
  const live = loadAccess();
  const { lib, steps, finishFetch } = loadUpdates({ live });
  // The app opened from a "Sam is live" notification: the update check and the live screen start together.
  const running = lib.updateNow();
  await tick();
  expect(steps).toEqual(['check', 'fetch']);
  live.setLiveNow('viewer');
  finishFetch();
  await running;
  await tick();
  expect(steps).toEqual(['check', 'fetch'], 'no restart while the live is on');
  // A co-host going back to watching is still in the live.
  live.setLiveNow('cohost');
  live.setLiveNow('viewer');
  await tick();
  expect(steps.filter((step) => step === 'reload')).toEqual([]);
  // Done on the end card: the waiting update restarts the app, once.
  live.setLiveNow(null);
  await tick();
  expect(steps.filter((step) => step === 'reload')).toEqual(['reload']);
  await tick();
  expect(steps.filter((step) => step === 'reload')).toEqual(['reload']);
});

it('without a live, a new update restarts straight away (as before)', async () => {
  const live = loadAccess();
  const { lib, steps, finishFetch } = loadUpdates({ live });
  const running = lib.updateNow();
  await tick();
  finishFetch();
  await running;
  expect(steps).toEqual(['check', 'fetch', 'reload']);
});

// ---------------------------------------------------------------------------
// The "Match phone" theme restart (src/app/_layout.tsx)
// ---------------------------------------------------------------------------

it('the "Match phone" theme restart waits for the live to end, then runs once', async () => {
  const live = loadAccess();
  let reloads = 0;
  let onAppearance = null;
  const nothing = () => null;
  const layout = loadTs('src/app/_layout.tsx', {
    expo: { reloadAppAsync: async () => { reloads++; } },
    'expo-router': { Stack: Object.assign(nothing, { Screen: nothing, Protected: nothing }), ThemeProvider: nothing },
    'expo-splash-screen': { preventAutoHideAsync() {}, hideAsync() {} },
    'expo-status-bar': { StatusBar: nothing },
    react: { useEffect: (effect) => effect() },
    'react/jsx-runtime': { jsx: nothing, jsxs: nothing, Fragment: nothing },
    'react-native': { Appearance: { addChangeListener: (listener) => { onAppearance = listener; return { remove() {} }; } } },
    'react-native-gesture-handler': { GestureHandlerRootView: nothing },
    '@/components/Overlays': { OverlayProvider: nothing },
    '@/components/SetupNeeded': { SetupNeeded: nothing },
    '@/lib/appUpdates': { useStayUpToDate() {} },
    '@/lib/auth': { AuthProvider: nothing, useAuth: () => ({}) },
    '@/lib/liveAccess': live,
    '@/lib/supabase': { isSupabaseConfigured: true },
    '@/theme': { colors: {}, isDark: true, navigationTheme: {}, phoneScheme: 'dark', themeChoice: 'system' },
  });
  layout.default();
  expect(typeof onAppearance).toBe('function');
  live.setLiveNow('host');
  onAppearance({ colorScheme: 'light' });
  onAppearance({ colorScheme: 'light' });
  await tick();
  expect(reloads).toBe(0);
  live.setLiveNow(null);
  await tick();
  expect(reloads).toBe(1);
  // Not in a live: straight away, as before.
  onAppearance({ colorScheme: 'light' });
  await tick();
  expect(reloads).toBe(2);
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

function loadNotifications({ version = '1.2.0', channel = 'testing' } = {}) {
  const alerts = [];
  const routes = [];
  const rpcs = [];
  const handlers = {};
  const mocks = phoneMocks({ version, alerts, channel });
  const live = loadLibrary('liveAccess', { mocks });
  const exit = loadLibrary('liveExit', { mocks: { ...mocks, './liveAccess': live } });
  const notifications = {
    setNotificationHandler: (handler) => { handlers.foreground = handler; },
    getPermissionsAsync: async () => ({ status: 'granted' }),
    getExpoPushTokenAsync: async () => ({ data: 'ExponentPushToken[phone]' }),
    setNotificationChannelAsync: async () => {},
    AndroidImportance: { HIGH: 4 },
  };
  const lib = loadLibrary('notifications', {
    supabase: { rpc: async (name, args) => { rpcs.push([name, args]); return { error: null }; } },
    mocks: {
      ...mocks,
      'expo-notifications': notifications,
      'expo-router': {
        router: {
          push: (to) => routes.push(['push', to]),
          dismissTo: (to) => routes.push(['dismissTo', to]),
        },
        useFocusEffect() {},
      },
      './drop': { dropAt: () => 0, localDay: () => '2026-11-20' },
      './liveAccess': live,
      './liveExit': exit,
    },
  });
  return { lib, live, exit, alerts, routes, rpcs, handlers };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

it('"… is live" opens the live – only on a phone that can show lives, and never while you\'re in one', async () => {
  const LIVE = '11111111-2222-4333-8444-555555555555';
  let phone = loadNotifications();
  phone.lib.openFor({ type: 'live', live: LIVE, host: 'sam' });
  expect(phone.routes).toEqual([['push', { pathname: '/live/[id]', params: { id: LIVE } }]]);
  // Already watching (or hosting) a live: the tap does nothing (no "end your live" question for this one).
  phone.live.setLiveNow('viewer');
  phone.lib.openFor({ type: 'live', live: LIVE });
  expect(phone.routes.length).toBe(1);
  expect(phone.alerts).toEqual([]);
  phone.live.setLiveNow(null);
  // Something odd in the notification: nothing opens.
  phone.lib.openFor({ type: 'live', live: 42 });
  expect(phone.routes.length).toBe(1);

  // An older download (App Store 1.1): never opens a live.
  phone = loadNotifications({ version: '1.1.0' });
  phone.lib.openFor({ type: 'live', live: LIVE });
  expect(phone.routes).toEqual([]);

  // The App Store app (channel production), even a 1.2 one: lives stay on the TestFlight build only.
  phone = loadNotifications({ channel: 'production' });
  phone.lib.openFor({ type: 'live', live: LIVE });
  expect(phone.routes).toEqual([]);
});

it('while hosting, tapping a notification (hit ups, the drop alert) asks first – and Stay keeps you live', async () => {
  for (const tap of [{ type: 'hitups' }, { type: 'drop' }]) {
    const phone = loadNotifications();
    const ended = [];
    phone.live.setLiveNow('host');
    phone.exit.setLiveExit(async () => { ended.push('end'); phone.live.setLiveNow(null); });
    phone.lib.openFor(tap);
    expect(phone.routes).toEqual([]);
    const [title, , buttons] = phone.alerts.at(-1);
    expect(title).toBe('End your live to open this?');
    expect(buttons.map((b) => b.text)).toEqual(['Stay', 'End and open']);
    // Stay: nothing happens.
    buttons.find((b) => b.text === 'Stay').onPress?.();
    await flush();
    expect(phone.routes).toEqual([]);
    expect(ended).toEqual([]);
    expect(phone.live.liveNowRole()).toBe('host');
    // Tapped again → End and open: the live is ended properly FIRST, then the screen opens.
    phone.lib.openFor(tap);
    phone.alerts.at(-1)[2].find((b) => b.text === 'End and open').onPress();
    await flush();
    expect(ended).toEqual(['end']);
    expect(phone.routes.length).toBe(1);
    expect(phone.routes[0][1]).toEqual(tap.type === 'drop' ? { pathname: '/camera', params: { drop: '1' } } : { pathname: '/', params: { page: 'chat' } });
  }
});

it('on stage the question is "Leave the stage…"; just watching, the tap opens straight away', async () => {
  let phone = loadNotifications();
  phone.live.setLiveNow('cohost');
  phone.lib.openFor({ type: 'message', from: 'bob' });
  expect(phone.alerts.at(-1)[0]).toBe('Leave the stage to open this?');
  expect(phone.routes).toEqual([]);

  phone = loadNotifications();
  phone.live.setLiveNow('viewer');
  phone.lib.openFor({ type: 'message', from: 'bob' });
  expect(phone.alerts).toEqual([]);
  expect(phone.routes).toEqual([['push', '/chat/bob']]);
});

it('no banners or sounds while hosting or on stage; a "… is live" banner never shows during any live', async () => {
  const phone = loadNotifications();
  const { quietDuringLive } = phone.lib;
  expect(quietDuringLive({ type: 'message' }, 'host')).toBe(true);
  expect(quietDuringLive({ type: 'like' }, 'cohost')).toBe(true);
  expect(quietDuringLive({ type: 'message' }, 'viewer')).toBe(false);
  expect(quietDuringLive({ type: 'live' }, 'viewer')).toBe(true);
  expect(quietDuringLive({ type: 'live' }, null)).toBe(false);
  expect(quietDuringLive({ type: 'message' }, null)).toBe(false);

  // The real foreground handler, after registering.
  await phone.lib.registerForPush();
  const show = (data) => phone.handlers.foreground.handleNotification({ request: { content: { data } } });
  expect((await show({ type: 'message', from: 'bob' })).shouldShowBanner).toBe(true);
  phone.live.setLiveNow('host');
  const quiet = await show({ type: 'message', from: 'bob' });
  expect(quiet.shouldShowBanner).toBe(false);
  expect(quiet.shouldPlaySound).toBe(false);
  phone.live.setLiveNow('viewer');
  expect((await show({ type: 'message', from: 'bob' })).shouldShowBanner).toBe(true);
  expect((await show({ type: 'live', live: 'x' })).shouldShowBanner).toBe(false);
  phone.live.setLiveNow(null);
});

it('after registering for pushes, the phone tells the server whether it can open a live', async () => {
  let phone = loadNotifications();
  await phone.lib.registerForPush();
  await flush();
  expect(phone.rpcs.map(([name]) => name)).toEqual(['register_push_token', 'set_push_capability']);
  expect(phone.rpcs[1][1]).toEqual({ push_token: 'ExponentPushToken[phone]', live_ok: true });

  // An older download says "no", so the server never sends it "… is live".
  phone = loadNotifications({ version: '1.1.0' });
  await phone.lib.registerForPush();
  await flush();
  expect(phone.rpcs.find(([name]) => name === 'set_push_capability')[1]).toEqual({ push_token: 'ExponentPushToken[phone]', live_ok: false });

  // The App Store app (channel production) says "no" too: lives are only on the TestFlight build for now.
  phone = loadNotifications({ channel: 'production' });
  await phone.lib.registerForPush();
  await flush();
  expect(phone.rpcs.find(([name]) => name === 'set_push_capability')[1]).toEqual({ push_token: 'ExponentPushToken[phone]', live_ok: false });
});

// ---------------------------------------------------------------------------
// The "Friends going live" setting
// ---------------------------------------------------------------------------

function loadPrefs(row) {
  const asked = [];
  const saved = [];
  const lib = loadLibrary('notificationPrefs', {
    supabase: {
      from: () => ({
        select: (columns) => {
          asked.push(columns);
          return { eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) };
        },
        upsert: async (value) => { saved.push(value); return { error: null }; },
      }),
    },
  });
  return { lib, asked, saved };
}

it('"Friends going live" is on unless you turned it off – also on a server from before lives', async () => {
  // A server without the `lives` setting yet: every column is asked for, and a missing one counts as on.
  let prefs = loadPrefs({ user_id: 'me', messages: true, friend_requests: false, likes: true, comments: true, drops: true });
  expect(await prefs.lib.fetchNotificationPrefs('me')).toEqual({ messages: true, friend_requests: false, likes: true, comments: true, drops: true, lives: true });
  expect(prefs.asked).toEqual(['*']);
  prefs = loadPrefs({ user_id: 'me', messages: true, friend_requests: true, likes: true, comments: true, drops: true, lives: false });
  expect((await prefs.lib.fetchNotificationPrefs('me')).lives).toBe(false);
  // Nothing saved yet: everything on.
  prefs = loadPrefs(null);
  expect((await prefs.lib.fetchNotificationPrefs('me')).lives).toBe(true);
});
