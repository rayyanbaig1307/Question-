const test = require('node:test');
const assert = require('node:assert/strict');
const { React, loadScreen, renderScreen, act, textOf, unmount } = require('./harness.cjs');

const passThrough = props => React.createElement('SafeScreen', props, props.children);

// The peek viewer with everything it talks to faked. `message` and `sender` decide what the peek is.
// `bar.at` is how far the timer bar has run (0 = just started, 1 = time's up); a test can move it.
// group: a snap in a group chat (`/snap/<id>?group=1`): `message` is then the group_messages row, `opens` the
// group_snap_opens rows, and `open` / `replay` what the server says to opening / replaying it.
// screenshotTold: what the server answers to a group snap screenshot (true = its sender was told).
// params: more route params (the chat passes the peek's file names, so the viewer can start downloading at once).
// urlFor: the one-minute link given for a file. calls.signings counts link requests (one request can sign several files).
function loadViewer({ message, sender = null, prefetch = async () => true, extra = {}, group = false, opens = [], open = async () => true, replay = async () => true, save = async () => true, id = 'qa-peek', screenshotTold = async () => true, params = {}, fetchMessage = async () => message, urlFor = () => 'http://127.0.0.1/qa-photo.jpg' }) {
  const calls = { opened: 0, backs: 0, menus: [], reports: [], timings: [], cancels: 0, toasts: [], groupOpens: [], groupReplays: [], links: [], saves: [], order: [], screenshots: [], detector: null, signings: 0, profileAsks: 0, downloads: [] };
  // Snaps opened on this phone but not shown yet (src/lib/groupChat.ts keeps these while the app is open).
  const unshown = new Map();
  const bar = { at: 0 };
  const screen = loadScreen('src/app/(app)/snap/[id].tsx', {
    'expo-image': { Image: { prefetch: async (...args) => { calls.order.push('download'); calls.downloads.push(args[0]); return prefetch(...args); } } },
    'expo-router': { router: { canGoBack: () => true, back() { calls.backs++; } }, useLocalSearchParams: () => ({ id, ...(group ? { group: '1' } : {}), ...params }) },
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
    '@/components/Overlays': { useOverlays: () => ({ showToast: value => calls.toasts.push(value), showOptions: request => calls.menus.push(request) }) },
    '@/lib/useSafetyActions': { useSafetyActions: () => ({ report: params => calls.reports.push(params), confirmBlock() {} }) },
    '@/lib/chat': {
      fetchMessage: (...args) => fetchMessage(...args),
      canReplay: () => false,
      getSnapUrl: async path => { calls.signings++; calls.links.push(path); calls.order.push('link'); return urlFor(path); },
      getSnapUrls: async paths => { calls.signings++; calls.links.push(...paths); calls.order.push('link'); return Object.fromEntries(paths.map(path => [path, urlFor(path)])); },
      openSnap: async () => { calls.opened++; },
      replaySnap: async () => true,
      setSnapSaved: async () => true,
      // 📷 A peek saved by its sender at the moment it was sent = a photo picked from Photos.
      isChatPhoto: m => m.kind === 'snap' && !!m.saved_at && m.saved_by === m.sender_id && m.saved_at === m.created_at,
    },
    // 👀 Group snaps (only used with `group`).
    '@/lib/groupChat': {
      fetchGroupMessage: async () => message,
      fetchGroupSnapOpens: async () => new Map([[message?.id, opens]]),
      openGroupSnap: async (...args) => { calls.groupOpens.push(args); calls.order.push('open'); return open(...args); },
      replayGroupSnap: async (...args) => { calls.groupReplays.push(args); calls.order.push('replay'); return replay(...args); },
      setGroupSnapSaved: async (...args) => { calls.saves.push(args); return save(...args); },
      canUnsaveGroupSnap: (m, me) => !!m.saved_at && (m.saved_by === me || m.sender_id === me),
      groupSnapScreenshot: async (...args) => { calls.screenshots.push(args); return screenshotTold(...args); },
      noteGroupSnapUnshown: (me, snapId, mode) => { unshown.set(`${me}:${snapId}`, mode); },
      forgetGroupSnapUnshown: (me, snapId) => { unshown.delete(`${me}:${snapId}`); },
      groupSnapUnshown: (me, snapId) => unshown.get(`${me}:${snapId}`) ?? null,
    },
    '@/lib/profiles': { fetchProfile: async () => { calls.profileAsks++; return sender; } },
    // calls.detector: the screenshot detector for group snaps (whether it's on, and what a screenshot does).
    '@/lib/screenshots': { useScreenshotNotice() {}, useScreenshotDetector: (enabled, onScreenshot) => { calls.detector = { enabled, onScreenshot }; } },
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

// ---------------------------------------------------------------------------
// 📷 A photo picked from Photos in a one-on-one chat (a peek saved by its sender from the start): it opens like a
// normal photo – no timer, no Save/Unsave button – and still counts as opened.
// ---------------------------------------------------------------------------
test('a photo from Photos opens with no timer and no Unsave, and is marked opened', async () => {
  const photo = { ...fromBob, created_at: '2026-11-21T07:00:00.123456+00:00', saved_at: '2026-11-21T07:00:00.123456+00:00', saved_by: 'bob' };
  const { screen, calls } = loadViewer({ message: photo, sender: bob });
  const tree = await renderScreen(screen);
  try {
    assert.equal(calls.opened, 1, 'it no longer shows as new');
    assert.equal(calls.timings.length, 0, 'no timer: it does not disappear');
    assert.match(textOf(tree.toJSON()), /Photo 📷/);
    assert.equal(tree.root.findAll(node => typeof node.type === 'string' && /^(Unsave|Save in chat)$/.test(node.props.accessibilityLabel ?? '')).length, 0);
  } finally { await unmount(tree); }
});

test('a peek saved LATER still has its Saved button', async () => {
  const later = { ...fromBob, opened_at: '2026-11-21T07:05:00Z', created_at: '2026-11-21T07:00:00Z', saved_at: '2026-11-21T07:06:00Z', saved_by: 'alice' };
  const { screen } = loadViewer({ message: later, sender: bob });
  const tree = await renderScreen(screen);
  try {
    assert.match(textOf(tree.toJSON()), /Saved in chat/);
    assert.equal(tree.root.findAll(node => typeof node.type === 'string' && node.props.accessibilityLabel === 'Unsave').length, 1);
  } finally { await unmount(tree); }
});

// ---------------------------------------------------------------------------
// 👀 Group snaps (/snap/<id>?group=1). The server only lets you download one for 5 minutes after you open it, so
// the viewer opens FIRST, then gets a one-minute link, then shows it (10 s, or the video's length).
// ---------------------------------------------------------------------------
// The "gone" / "couldn't load" screen (an EmptyState stand-in: its words are in its props).
const emptyText = tree => tree.root.findAllByType('EmptyState').map(node => `${node.props.title} ${node.props.message}`).join(' ');
const groupSnap = { id: 'qa-snap', group_id: 'squad', sender_id: 'bob', kind: 'snap', media_type: 'photo', media_path: 'bob/snaps/test.jpg', poster_path: null, overlay_path: null, saved_at: null, saved_by: null, created_at: '2026-11-21T07:00:00Z' };

test('a new group snap is opened first, then downloaded with a one-minute link, then shown for 10 seconds', async () => {
  const { screen, calls } = loadViewer({ message: groupSnap, sender: bob, group: true, id: 'qa-snap' });
  const tree = await renderScreen(screen);
  try {
    assert.deepEqual(JSON.parse(JSON.stringify(calls.groupOpens)), [['qa-snap']]);
    assert.equal(calls.groupReplays.length, 0);
    assert.deepEqual(calls.order, ['open', 'link', 'download'], 'open first: the file is locked until then');
    assert.deepEqual(calls.links, ['bob/snaps/test.jpg']);
    assert.equal(calls.opened, 0, 'never the one-on-one open');
    assert.equal(calls.timings.join(), '10000');
    assert.ok(tree.root.findAll(node => node.props?.uri === 'http://127.0.0.1/qa-photo.jpg').length > 0, 'the snap is on screen');
    assert.equal(tree.root.findAll(node => typeof node.type === 'string' && node.props.accessibilityLabel === 'Save in chat').length, 1);
  } finally { await unmount(tree); }
});

test('an opened group snap uses your one replay; a replayed one is gone', async () => {
  const replay = loadViewer({ message: groupSnap, sender: bob, group: true, id: 'qa-snap', opens: [{ message_id: 'qa-snap', user_id: 'alice', opened_at: '2026-11-21T07:01:00Z', replayed_at: null }] });
  const tree = await renderScreen(replay.screen);
  try {
    assert.equal(replay.calls.groupOpens.length, 0);
    assert.equal(replay.calls.groupReplays.length, 1);
    assert.match(textOf(tree.toJSON()), /Replay 🔁/);
  } finally { await unmount(tree); }

  const used = loadViewer({ message: groupSnap, sender: bob, group: true, id: 'qa-snap-2', opens: [{ message_id: 'qa-snap', user_id: 'alice', opened_at: '2026-11-21T07:01:00Z', replayed_at: '2026-11-21T07:02:00Z' }] });
  const tree2 = await renderScreen(used.screen);
  try {
    assert.equal(used.calls.groupOpens.length + used.calls.groupReplays.length, 0);
    assert.equal(used.calls.links.length, 0, 'no link at all');
    assert.match(emptyText(tree2), /This snap is gone/);
  } finally { await unmount(tree2); }
});

test('when the server says no (over a day old, joined after it was sent…), nothing is downloaded and it says it is gone', async () => {
  const { screen, calls } = loadViewer({ message: groupSnap, sender: bob, group: true, id: 'qa-snap-3', open: async () => false });
  const tree = await renderScreen(screen);
  try {
    assert.equal(calls.groupOpens.length, 1);
    assert.equal(calls.links.length, 0);
    assert.match(emptyText(tree), /This snap is gone/);
  } finally { await unmount(tree); }
});

test('a group snap whose download fails can be tried again a moment later without using up the replay', async () => {
  let ok = false;
  const opens = [];
  const { screen, calls } = loadViewer({ message: groupSnap, sender: bob, group: true, id: 'qa-snap', opens, prefetch: async () => ok });
  const tree = await renderScreen(screen);
  try {
    assert.equal(calls.groupOpens.length, 1);
    assert.match(emptyText(tree), /Couldn't load the snap/);
    assert.match(emptyText(tree), /tap it again in the next few minutes – that still counts as your first look/);
    assert.match(emptyText(tree), /After that \(or if you close the app\) it counts as your replay/);
  } finally { await unmount(tree); }
  // Tapping it again: the server now has your open (a replay would be next) – but it was never shown on this phone,
  // and the server still lets you download it for a few minutes, so no replay is used.
  ok = true;
  opens.push({ message_id: 'qa-snap', user_id: 'alice', opened_at: '2026-11-21T07:01:00Z', replayed_at: null });
  const tree2 = await renderScreen(screen);
  try {
    assert.equal(calls.groupOpens.length, 1, 'no second open');
    assert.equal(calls.groupReplays.length, 0, 'no replay used');
    assert.equal(calls.links.length, 2);
    assert.equal(calls.timings.join(), '10000');
  } finally { await unmount(tree2); }
  // Shown now: the next tap is your replay.
  const tree3 = await renderScreen(screen);
  try {
    assert.equal(calls.groupReplays.length, 1);
  } finally { await unmount(tree3); }
});

test('your own group snap (not saved) does not open; a saved one opens for everyone with no timer', async () => {
  const mine = loadViewer({ message: { ...groupSnap, sender_id: 'alice' }, group: true, id: 'qa-snap-5' });
  const tree = await renderScreen(mine.screen);
  try {
    assert.equal(mine.calls.links.length, 0);
    assert.match(emptyText(tree), /This snap is gone/);
  } finally { await unmount(tree); }

  const saved = { ...groupSnap, saved_at: '2026-11-21T07:03:00Z', saved_by: 'cara' };
  const view = loadViewer({ message: saved, sender: bob, group: true, id: 'qa-snap-6' });
  const tree2 = await renderScreen(view.screen);
  try {
    assert.equal(view.calls.groupOpens.length, 1, 'opening a saved snap still notes that you saw it');
    assert.equal(view.calls.groupReplays.length, 0);
    assert.equal(view.calls.timings.length, 0, 'no timer on a saved snap');
    assert.match(textOf(tree2.toJSON()), /Saved in chat/);
    // Cara saved it: only Cara (or Bob, who sent it) can unsave it.
    assert.equal(tree2.root.findAll(node => typeof node.type === 'string' && node.props.accessibilityLabel === 'Unsave').length, 0);
  } finally { await unmount(tree2); }

  // Your own saved snap: no open (the server always says no to the sender), but it shows – and you can unsave it.
  const own = loadViewer({ message: { ...saved, sender_id: 'alice' }, group: true, id: 'qa-snap-9', open: async () => false });
  const tree3 = await renderScreen(own.screen);
  try {
    assert.equal(own.calls.groupOpens.length, 0);
    assert.equal(own.calls.links.length, 1);
    assert.equal(tree3.root.findAll(node => typeof node.type === 'string' && node.props.accessibilityLabel === 'Unsave').length, 1);
  } finally { await unmount(tree3); }
});

test('saving a group snap from the viewer stops the timer and says everyone can open it again', async () => {
  const { screen, calls } = loadViewer({ message: groupSnap, sender: bob, group: true, id: 'qa-snap-7' });
  const tree = await renderScreen(screen);
  try {
    const saveButton = tree.root.findAll(node => typeof node.type === 'string' && node.props.accessibilityLabel === 'Save in chat')[0];
    await act(async () => { await saveButton.props.onPress(); });
    assert.deepEqual(JSON.parse(JSON.stringify(calls.saves)), [['qa-snap-7', true]]);
    assert.match(calls.toasts.at(-1), /Saved in chat 📌 Everyone in the group can open it again/);
    assert.match(textOf(tree.toJSON()), /Saved in chat/);
  } finally { await unmount(tree); }
});

test('a group snap is reported as a group message, and the menu says snap', async () => {
  const { screen, calls } = loadViewer({ message: groupSnap, sender: bob, group: true, id: 'qa-snap-8' });
  const tree = await renderScreen(screen);
  try {
    await act(async () => { moreButton(tree).props.onPress(); });
    assert.equal(JSON.stringify(calls.menus[0].options.map(option => option.label)), JSON.stringify(['Report snap']));
    assert.match(textOf(tree.toJSON()), /Snap hidden while the menu is open/);
    await act(async () => { calls.menus[0].onClose(); });
    await act(async () => { moreButton(tree).props.onPress(); });
    await act(async () => { calls.menus[1].onClose(); });
    await act(async () => { calls.menus[1].options[0].onPress(); });
    assert.equal(JSON.stringify(calls.reports), JSON.stringify([{ user: bob, contentType: 'group_message', contentId: 'qa-snap-8' }]));
  } finally { await unmount(tree); }
});

test('a screenshot of a group snap tells its sender (once), and only while an unsaved snap is on screen', async () => {
  const { screen, calls } = loadViewer({ message: groupSnap, sender: bob, group: true, id: 'qa-snap-10' });
  const tree = await renderScreen(screen);
  try {
    assert.equal(calls.detector.enabled, true, 'watching for screenshots while the snap is shown');
    await act(async () => { calls.detector.onScreenshot(); await Promise.resolve(); });
    assert.deepEqual(JSON.parse(JSON.stringify(calls.screenshots)), [['qa-snap-10']]);
    assert.match(calls.toasts.at(-1), /They’ll see you took a screenshot/);
    // Saved in the chat while it's on screen: a normal photo now, so no more notices.
    const saveButton = tree.root.findAll(node => typeof node.type === 'string' && node.props.accessibilityLabel === 'Save in chat')[0];
    await act(async () => { await saveButton.props.onPress(); });
    assert.equal(calls.detector.enabled, false);
  } finally { await unmount(tree); }

  // The server says there was nothing to tell (e.g. you already took one): no toast.
  const again = loadViewer({ message: groupSnap, sender: bob, group: true, id: 'qa-snap-11', screenshotTold: async () => false });
  const tree2 = await renderScreen(again.screen);
  try {
    await act(async () => { again.calls.detector.onScreenshot(); await Promise.resolve(); });
    assert.equal(again.calls.screenshots.length, 1);
    assert.equal(again.calls.toasts.filter(t => /screenshot/.test(t)).length, 0);
  } finally { await unmount(tree2); }

  // A saved snap, and a one-on-one peek (that has its own notice): not watched here.
  const saved = loadViewer({ message: { ...groupSnap, saved_at: '2026-11-21T07:03:00Z', saved_by: 'cara' }, sender: bob, group: true, id: 'qa-snap-12' });
  const tree3 = await renderScreen(saved.screen);
  try { assert.equal(saved.calls.detector.enabled, false); } finally { await unmount(tree3); }
  const peek = loadViewer({ message: fromBob, sender: bob });
  const tree4 = await renderScreen(peek.screen);
  try { assert.equal(peek.calls.detector.enabled, false); } finally { await unmount(tree4); }
});

test('a photo picked from Photos in a one-on-one chat is called a photo everywhere in the viewer, never a peek', async () => {
  const sentAt = '2026-11-21T07:00:00.000Z';
  const photo = { ...fromBob, created_at: sentAt, saved_at: sentAt, saved_by: 'bob' };
  const { screen, calls } = loadViewer({ message: photo, sender: bob });
  const tree = await renderScreen(screen);
  try {
    assert.match(textOf(tree.toJSON()), /Photo 📷/);
    assert.equal(tree.root.findAll(node => typeof node.type === 'string' && node.props.accessibilityLabel === 'Close photo').length, 1);
    await act(async () => { moreButton(tree).props.onPress(); });
    assert.equal(JSON.stringify(calls.menus[0].options.map(option => option.label)), JSON.stringify(['Report photo']));
    assert.match(textOf(tree.toJSON()), /Photo hidden while the menu is open/);
    assert.doesNotMatch(textOf(tree.toJSON()), /Peek hidden/);
    await act(async () => { calls.menus[0].onClose(); });
    await act(async () => { moreButton(tree).props.onPress(); });
    await act(async () => { calls.menus[1].onClose(); });
    await act(async () => { calls.menus[1].options[0].onPress(); });
    assert.match(textOf(tree.toJSON()), /Photo hidden while you report it/);
  } finally { await unmount(tree); }
  // While it loads, a one-on-one chat doesn't know yet whether it's a peek or a photo.
  let release;
  const waiting = loadViewer({ message: photo, sender: bob, prefetch: () => new Promise(resolve => { release = resolve; }) });
  const tree2 = await renderScreen(waiting.screen);
  try {
    assert.match(textOf(tree2.toJSON()), /Opening…/);
    assert.doesNotMatch(textOf(tree2.toJSON()), /Opening peek/);
  } finally { release?.(true); await unmount(tree2); }
});

// ---------------------------------------------------------------------------
// Speed fix 5: opening a peek takes 1–2 round trips instead of 5–7 in a row. The chat passes the peek's file names,
// so its one-minute links (one request for all its files) and the download start while the peek itself is still
// being loaded, and the sender's name loads alongside. The view is still only used up after the download.
// ---------------------------------------------------------------------------
const later = () => { let settle; const promise = new Promise(resolve => { settle = resolve; }); return { promise, settle }; };
const shownUris = tree => tree.root.findAll(node => typeof node.props?.uri === 'string').map(node => node.props.uri);

test('with the file names from the chat, the link and the download start while the peek is still loading; the view is used only after', async () => {
  const loading = later();
  const { screen, calls } = loadViewer({ message: fromBob, sender: bob, params: { path: 'bob/test.jpg', type: 'photo', from: 'bob' }, fetchMessage: () => loading.promise });
  const tree = await renderScreen(screen);
  try {
    assert.deepEqual(calls.order, ['link', 'download'], 'started before the peek itself has loaded');
    assert.equal(calls.profileAsks, 1, 'the sender\'s name loads alongside');
    assert.equal(calls.opened, 0, 'nothing used up yet');
    await act(async () => { loading.settle(fromBob); });
    await act(async () => {});
    assert.equal(calls.opened, 1);
    assert.equal(calls.signings, 1, 'never signed twice');
    assert.equal(calls.profileAsks, 1);
    assert.ok(shownUris(tree).includes('http://127.0.0.1/qa-photo.jpg'));
  } finally { await unmount(tree); }
});

test('file names from the chat that don\'t match the peek are never shown', async () => {
  const urlFor = path => `http://127.0.0.1/${path}`;
  const { screen, calls } = loadViewer({ message: fromBob, sender: bob, params: { path: 'bob/old.jpg', type: 'photo', from: 'bob' }, urlFor });
  const tree = await renderScreen(screen);
  try {
    await act(async () => {});
    assert.equal(calls.opened, 1);
    assert.ok(calls.links.includes('bob/test.jpg'), 'the real file was signed');
    assert.ok(shownUris(tree).includes('http://127.0.0.1/bob/test.jpg'));
    assert.ok(!shownUris(tree).includes('http://127.0.0.1/bob/old.jpg'));
  } finally { await unmount(tree); }
});

test('a video peek gets the links for its video, still picture and text layer in ONE request', async () => {
  const video = { ...fromBob, media_type: 'video', media_path: 'bob/clip.mp4', poster_path: 'bob/clip.jpg', overlay_path: 'bob/clip.png' };
  const { screen, calls } = loadViewer({ message: video, sender: bob });
  const tree = await renderScreen(screen);
  try {
    await act(async () => {});
    assert.equal(calls.signings, 1);
    assert.deepEqual(calls.links, ['bob/clip.mp4', 'bob/clip.jpg', 'bob/clip.png']);
    assert.equal(calls.opened, 1);
  } finally { await unmount(tree); }
});

test('a group video snap: opened first, then one request for all its links', async () => {
  const video = { ...groupSnap, media_type: 'video', media_path: 'bob/snaps/clip.mp4', poster_path: 'bob/snaps/clip.jpg', overlay_path: null };
  const { screen, calls } = loadViewer({ message: video, sender: bob, group: true, id: 'qa-snap' });
  const tree = await renderScreen(screen);
  try {
    await act(async () => {});
    assert.deepEqual(calls.order, ['open', 'link', 'download']);
    assert.equal(calls.signings, 1);
    assert.deepEqual(calls.links, ['bob/snaps/clip.mp4', 'bob/snaps/clip.jpg']);
  } finally { await unmount(tree); }
});
