const test = require('node:test');
const assert = require('node:assert/strict');
const { React, loadScreen, renderScreen, act, unmount } = require('./harness.cjs');

test('leaving a peek while its photo is downloading does not use up the view', async () => {
  let release;
  const downloading = new Promise(resolve => { release = resolve; });
  let opened = 0;
  const passThrough = props => React.createElement('SafeScreen', props, props.children);
  const screen = loadScreen('src/app/(app)/snap/[id].tsx', {
    'expo-image': { Image: { prefetch: async () => downloading } },
    'expo-router': { router: { canGoBack: () => true, back() {} }, useLocalSearchParams: () => ({ id: 'qa-peek' }) },
    'expo-status-bar': { StatusBar: () => null },
    'react-native-reanimated': {
      default: { View: passThrough },
      useSharedValue: initial => React.useRef({ get: () => initial, set() {} }).current,
      useAnimatedStyle: callback => callback(), cancelAnimation() {}, Easing: { linear: x => x }, withTiming: x => x,
    },
    'react-native-worklets': { scheduleOnRN: callback => callback() },
    '@/components/Bouncy': { Bouncy: passThrough },
    '@/components/SafeEdge': { SafeScreen: passThrough, SafeEdge: passThrough },
    '@/components/ZoomableImage': { ZoomableImage: passThrough },
    '@/lib/chat': {
      fetchMessage: async () => ({ id: 'qa-peek', sender_id: 'bob', recipient_id: 'alice', kind: 'snap', media_type: 'photo', media_path: 'bob/test.jpg', opened_at: null }),
      canReplay: () => false, getSnapUrl: async () => 'http://127.0.0.1/qa-photo.jpg', openSnap: async () => { opened++; },
    },
    '@/lib/profiles': { fetchProfile: async () => null },
    '@/lib/screenshots': { useScreenshotNotice() {} },
  });
  const tree = await renderScreen(screen);
  await unmount(tree);
  await act(async () => { release(true); await downloading; await Promise.resolve(); });
  assert.equal(opened, 0, 'a cancelled download must leave the disappearing photo unopened');
});
