const test = require('node:test');
const assert = require('node:assert/strict');
const { React, loadScreen, renderScreen, act, unmount, host } = require('./harness.cjs');

// Speed fix 3: the home screen (src/app/(app)/index.tsx) tells lib/startup.ts when it's drawn, and its badge numbers
// (unread chats, hit ups, friend requests, activity) and the birthday question wait until the extras start, about
// 2 seconds later. Home's posts and stories go first.

function loadHome() {
  let done = false;
  const listeners = new Set();
  const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
  const seen = { drawn: 0, unread: [], hitUps: [], requests: [], activity: [], birthday: 0 };
  class Value { constructor(value) { this.value = value; } interpolate() { return 0; } }
  const screen = loadScreen('src/app/(app)/index.tsx', {
    'expo-router': { router: { push() {}, setParams() {} }, useIsFocused: () => true, useLocalSearchParams: () => ({}) },
    'expo-status-bar': { StatusBar: host('StatusBar') },
    'react-native': {
      Animated: { Value, add: () => ({ interpolate: () => 0 }), event: () => () => {}, View: host('AnimatedView') },
      StyleSheet: { create: (value) => value, absoluteFill: {} },
      View: host('View'),
    },
    '@/components/home/CameraPage': { CameraPage: host('CameraPage') },
    '@/components/home/ChatPage': { ChatPage: host('ChatPage') },
    '@/components/home/HomePage': { HomePage: host('HomePage') },
    '@/components/home/HomePager': { HomePager: host('HomePager') },
    '@/components/home/HomeTabBar': { HomeTabBar: host('HomeTabBar') },
    '@/components/ThemeScene': { ThemeScene: host('ThemeScene') },
    '@/lib/activity': { useActivity: (_me, active) => { seen.activity.push(active); return { unseen: 0, reload() {} }; } },
    '@/lib/birthday': { wasAskedForBirthday: async () => { seen.birthday++; return true; }, fetchMyBirthday: async () => null, markAskedForBirthday() {} },
    '@/lib/chat': { useUnreadCount: (_me, active) => { seen.unread.push(active); return 0; } },
    '@/lib/friends': { useIncomingRequestCount: (_me, active) => { seen.requests.push(active); return 0; } },
    '@/lib/hitups': { useHitUps: (_me, active) => { seen.hitUps.push(active); return { hitUps: [], reload() {} }; } },
    '@/lib/notifications': { useClearNotificationsWhenOpen() {} },
    '@/lib/startup': {
      noteHomeDrawn() { seen.drawn++; },
      useStartupDone: () => React.useSyncExternalStore(subscribe, () => done),
    },
    '@/theme': { colors: {}, isDark: false, themeScene: null },
  });
  return { screen, seen, start() { done = true; listeners.forEach((listener) => listener()); } };
}

test('Home says it is drawn; its badges and the birthday question wait for the extras to start', async () => {
  const setup = loadHome();
  const tree = await renderScreen(setup.screen);
  try {
    await act(async () => {});
    assert.equal(setup.seen.drawn, 1);
    for (const name of ['unread', 'hitUps', 'requests', 'activity']) {
      assert.ok(setup.seen[name].length > 0, name);
      assert.ok(setup.seen[name].every((active) => active === false), `${name} waits`);
    }
    assert.equal(setup.seen.birthday, 0);
    await act(async () => { setup.start(); });
    await act(async () => {});
    for (const name of ['unread', 'hitUps', 'requests', 'activity']) assert.equal(setup.seen[name].at(-1), true, `${name} starts`);
    assert.equal(setup.seen.birthday, 1);
  } finally { await unmount(tree); }
});
