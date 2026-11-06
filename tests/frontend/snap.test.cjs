const test = require('node:test');
const assert = require('node:assert/strict');
const { React, loadScreen, renderScreen, act, textOf, unmount } = require('./harness.cjs');

const passThrough = props => React.createElement('SafeScreen', props, props.children);

// The peek viewer with everything it talks to faked. `message` and `sender` decide what the peek is.
function loadViewer({ message, sender = null, prefetch = async () => true, extra = {} }) {
  const calls = { opened: 0, backs: 0, menus: [], reports: [], timings: [], cancels: 0 };
  const screen = loadScreen('src/app/(app)/snap/[id].tsx', {
    'expo-image': { Image: { prefetch } },
    'expo-router': { router: { canGoBack: () => true, back() { calls.backs++; } }, useLocalSearchParams: () => ({ id: 'qa-peek' }) },
    'expo-status-bar': { StatusBar: () => null },
    'react-native-reanimated': {
      __esModule: true,
      default: { View: passThrough },
      useSharedValue: initial => React.useRef({ get: () => initial, set() {} }).current,
      useAnimatedStyle: callback => callback(),
      cancelAnimation() { calls.cancels++; },
      Easing: { linear: x => x },
      withTiming: (to, config) => { calls.timings.push(config.duration); return to; },
    },
    'react-native-worklets': { scheduleOnRN: callback => callback() },
    '@/components/Bouncy': { Bouncy: passThrough },
    '@/components/SafeEdge': { SafeScreen: passThrough, SafeEdge: passThrough },
    '@/components/ZoomableImage': { ZoomableImage: passThrough },
    '@/components/Overlays': { useOverlays: () => ({ showToast() {}, showOptions: request => calls.menus.push(request) }) },
    '@/lib/useSafetyActions': { useSafetyActions: () => ({ report: params => calls.reports.push(params), confirmBlock() {} }) },
    '@/lib/chat': {
      fetchMessage: async () => message,
      canReplay: () => false,
      getSnapUrl: async () => 'http://127.0.0.1/qa-photo.jpg',
      openSnap: async () => { calls.opened++; },
      replaySnap: async () => true,
      setSnapSaved: async () => true,
    },
    '@/lib/profiles': { fetchProfile: async () => sender },
    '@/lib/screenshots': { useScreenshotNotice() {} },
    ...extra,
  });
  return { screen, calls };
}

const fromBob = { id: 'qa-peek', sender_id: 'bob', recipient_id: 'alice', kind: 'snap', media_type: 'photo', media_path: 'bob/test.jpg', opened_at: null };
const bob = { id: 'bob', username: 'bob', display_name: 'Bob', avatar_path: null };
const moreButton = tree => tree.root.findAll(node => typeof node.type === 'string' && node.props.accessibilityLabel === 'More options')[0];
const closeArea = tree => tree.root.findAll(node => typeof node.type === 'string' && node.props.accessibilityLabel === 'Close peek')[0];

test('leaving a peek while its photo is downloading does not use up the view', async () => {
  let release;
  const downloading = new Promise(resolve => { release = resolve; });
  const { screen, calls } = loadViewer({ message: fromBob, prefetch: async () => downloading });
  const tree = await renderScreen(screen);
  await unmount(tree);
  await act(async () => { release(true); await downloading; await Promise.resolve(); });
  assert.equal(calls.opened, 0, 'a cancelled download must leave the disappearing photo unopened');
});

test('a peek from a friend has ⋯ → Report: the timer waits, then the report goes to the shared Report/Block flow', async () => {
  const { screen, calls } = loadViewer({ message: fromBob, sender: bob });
  const tree = await renderScreen(screen);
  assert.equal(calls.opened, 1, 'opening the peek uses up the view');
  assert.equal(calls.timings.join(), '10000', 'a photo peek gets 10 seconds');
  assert.ok(moreButton(tree), 'the ⋯ button is shown on a peek from someone else');
  const photos = () => tree.root.findAll(node => node.type === 'SafeScreen' && node.props.uri === 'http://127.0.0.1/qa-photo.jpg');
  assert.equal(photos().length, 1, 'the photo is on screen');

  // Opening the menu stops the timer (it shouldn't close the peek while you choose).
  await act(async () => { moreButton(tree).props.onPress(); });
  assert.equal(calls.menus.length, 1);
  // (Objects made inside the screen come from another JavaScript realm, so compare them as JSON.)
  assert.equal(JSON.stringify(calls.menus[0].options.map(option => option.label)), JSON.stringify(['Report peek']));
  assert.ok(calls.cancels >= 1, 'the timer stops while the menu is open');
  assert.equal(calls.timings.length, 1, 'the timer does not run while the menu is open');

  // Closing the menu without picking anything starts the timer again.
  await act(async () => { calls.menus[0].onClose(); });
  assert.equal(calls.timings.length, 2, 'the timer carries on after the menu closes');

  // Picking "Report peek" reports this message as from Bob (the shared flow then offers Block).
  // (The menu closes first, then runs the picked option a moment later.)
  await act(async () => { moreButton(tree).props.onPress(); });
  await act(async () => { calls.menus[1].onClose(); });
  const cancelsBefore = calls.cancels;
  await act(async () => { calls.menus[1].options[0].onPress(); });
  assert.equal(JSON.stringify(calls.reports), JSON.stringify([{ user: bob, contentType: 'message', contentId: 'qa-peek' }]));
  assert.ok(calls.cancels > cancelsBefore, 'the timer stops for good once you report');

  // While reporting, the photo is covered and the ⋯ button is gone; a tap closes the viewer.
  assert.equal(photos().length, 0, 'the photo is hidden while you report');
  assert.match(textOf(tree.toJSON()), /hidden while you report/);
  assert.equal(moreButton(tree), undefined);
  await act(async () => { closeArea(tree).props.onPress(); });
  assert.equal(calls.backs, 1, 'a tap closes the covered peek');
  await unmount(tree);
});

test('your own saved peek has no Report button', async () => {
  const mine = { ...fromBob, sender_id: 'alice', recipient_id: 'bob', saved_at: '2026-11-06T10:00:00Z', opened_at: '2026-11-06T09:00:00Z' };
  const { screen, calls } = loadViewer({ message: mine, sender: { id: 'alice', username: 'alice', display_name: 'Alice', avatar_path: null } });
  const tree = await renderScreen(screen);
  assert.equal(calls.opened, 0, 'your own peek is not marked opened');
  assert.match(textOf(tree.toJSON()), /Saved in chat/);
  assert.equal(moreButton(tree), undefined, 'nothing to report on your own peek');
  await unmount(tree);
});
