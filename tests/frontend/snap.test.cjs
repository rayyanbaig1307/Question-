const test = require('node:test');
const assert = require('node:assert/strict');
const { React, loadScreen, renderScreen, act, textOf, unmount } = require('./harness.cjs');

const passThrough = props => React.createElement('SafeScreen', props, props.children);

// The peek viewer with everything it talks to faked. `message` and `sender` decide what the peek is.
// `bar.at` is how far the timer bar has run (0 = just started, 1 = time's up); a test can move it.
function loadViewer({ message, sender = null, prefetch = async () => true, extra = {} }) {
  const calls = { opened: 0, backs: 0, menus: [], reports: [], timings: [], cancels: 0 };
  const bar = { at: 0 };
  const screen = loadScreen('src/app/(app)/snap/[id].tsx', {
    'expo-image': { Image: { prefetch } },
    'expo-router': { router: { canGoBack: () => true, back() { calls.backs++; } }, useLocalSearchParams: () => ({ id: 'qa-peek' }) },
    'expo-status-bar': { StatusBar: () => null },
    'react-native-reanimated': {
      __esModule: true,
      default: { View: passThrough },
      useSharedValue: () => React.useRef({ get: () => bar.at, set() {} }).current,
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
  return { screen, calls, bar };
}

const fromBob = { id: 'qa-peek', sender_id: 'bob', recipient_id: 'alice', kind: 'snap', media_type: 'photo', media_path: 'bob/test.jpg', opened_at: null };
const bob = { id: 'bob', username: 'bob', display_name: 'Bob', avatar_path: null };
const moreButton = tree => tree.root.findAll(node => typeof node.type === 'string' && node.props.accessibilityLabel === 'More options')[0];
const closeArea = tree => tree.root.findAll(node => typeof node.type === 'string' && node.props.accessibilityLabel === 'Close peek')[0];
const MENU_COVER = /Peek hidden while the menu is open/;
// Everything on screen in drawing order: a later one is drawn on top of an earlier one.
function drawOrder(tree) {
  const nodes = [];
  (function walk(node) {
    if (!node || typeof node === 'string') return;
    nodes.push(node);
    (node.children ?? []).forEach(walk);
  })(tree.toJSON());
  return nodes;
}
// Is the "Peek hidden" cover drawn on top of the photo or video?
function coverIsOnTop(tree, isPeek) {
  const nodes = drawOrder(tree);
  const peek = nodes.findIndex(isPeek);
  const cover = nodes.findIndex(node => node.type === 'Text' && MENU_COVER.test(textOf(node)));
  return peek >= 0 && cover > peek;
}

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

  assert.doesNotMatch(textOf(tree.toJSON()), MENU_COVER, 'nothing covers the photo before the menu opens');

  // Opening the menu stops the timer (it shouldn't close the peek while you choose).
  await act(async () => { moreButton(tree).props.onPress(); });
  assert.equal(calls.menus.length, 1);
  // (Objects made inside the screen come from another JavaScript realm, so compare them as JSON.)
  assert.equal(JSON.stringify(calls.menus[0].options.map(option => option.label)), JSON.stringify(['Report peek']));
  assert.ok(calls.cancels >= 1, 'the timer stops while the menu is open');
  assert.equal(calls.timings.length, 1, 'the timer does not run while the menu is open');
  // ...and the peek is covered, so the menu can't be used to keep a disappearing photo on screen.
  const isPhoto = node => node.props?.uri === 'http://127.0.0.1/qa-photo.jpg';
  assert.match(textOf(tree.toJSON()), MENU_COVER);
  assert.ok(coverIsOnTop(tree, isPhoto), 'the cover is drawn on top of the photo');

  // Closing the menu without picking anything starts the timer again and shows the photo again.
  await act(async () => { calls.menus[0].onClose(); });
  assert.equal(calls.timings.length, 2, 'the timer carries on after the menu closes');
  assert.doesNotMatch(textOf(tree.toJSON()), MENU_COVER, 'the cover goes once the menu closes');
  assert.equal(photos().length, 1, 'the photo is on screen again');

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

test('the 1-second top-up after the ⋯ menu is given only once per peek', async () => {
  const { screen, calls, bar } = loadViewer({ message: fromBob, sender: bob });
  const tree = await renderScreen(screen);
  assert.equal(calls.timings.join(), '10000');
  // Each menu below is opened, then closed without picking anything.
  let menus = 0;
  async function pauseAt(at) {
    bar.at = at;
    await act(async () => { moreButton(tree).props.onPress(); });
    await act(async () => { calls.menus[menus++].onClose(); });
    return calls.timings.at(-1);
  }
  // Plenty of time left: it just carries on (5 of the 10 seconds left), and the top-up isn't used up.
  assert.equal(await pauseAt(0.5), 5000);
  // Only 0.625 seconds left: you get a full second, so a report picked from the menu isn't cut off.
  assert.equal(await pauseAt(0.9375), 1000);
  // Again with 0.3125 seconds left: no second top-up, so opening the menu again and again can't keep it on screen.
  assert.equal(await pauseAt(0.96875), 312.5);
  // Time's up: it closes straight away.
  assert.equal(await pauseAt(1), 0);
  await unmount(tree);
});

test('a video peek is covered and paused while the ⋯ menu is open, then carries on (not from the start)', async () => {
  let mounts = 0;
  const VideoClip = props => {
    React.useEffect(() => { mounts++; }, []);
    return React.createElement('VideoClip', props);
  };
  const video = { ...fromBob, media_type: 'video', poster_path: null, overlay_path: null };
  const { screen, calls } = loadViewer({ message: video, sender: bob, extra: { '@/components/VideoClipSafe': { VideoClip } } });
  const tree = await renderScreen(screen);
  const clip = () => tree.root.findAll(node => node.type === 'VideoClip')[0];
  assert.equal(calls.timings.length, 0, 'the timer waits for the video to load');
  await act(async () => { clip().props.onDuration(8); });
  assert.equal(calls.timings.join(), '8000', 'an 8-second video gets 8 seconds');
  assert.equal(clip().props.playing, true);

  await act(async () => { moreButton(tree).props.onPress(); });
  assert.match(textOf(tree.toJSON()), MENU_COVER);
  assert.ok(coverIsOnTop(tree, node => node.type === 'VideoClip'), 'the cover is drawn on top of the video');
  assert.equal(clip().props.playing, false, 'the video waits while the menu is open');

  await act(async () => { calls.menus[0].onClose(); });
  assert.doesNotMatch(textOf(tree.toJSON()), MENU_COVER);
  assert.equal(clip().props.playing, true, 'the video plays on after the menu closes');
  assert.equal(mounts, 1, 'the video kept its place (it was not started again)');
  assert.equal(calls.timings.length, 2);
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
