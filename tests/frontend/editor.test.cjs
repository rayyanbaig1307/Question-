const test = require('node:test');
const assert = require('node:assert/strict');
const { React, loadScreen, renderScreen, act, unmount, host, textOf } = require('./harness.cjs');

// params: more route params (e.g. groupGuess). groupGuess: what postGroupGuess does (by default it works).
// overrides: other stand-ins (e.g. gestures that remember their settings).
function fixture({ group = false, chatDare = false, failClaim = false, claimError = 'Simulated dare update failure', send, params = {}, groupGuess, overrides = {} } = {}) {
  const calls = { snaps: 0, chatPhotos: [], groups: 0, groupSnaps: [], publicPhotos: 0, claimed: 0, dismissedTo: [], groupGuesses: [], mysteries: [], pushed: [] };
  const passthrough = Object.fromEntries(['CropTool', 'DraggableItem', 'StickerPicker', 'TextComposer'].map(name => [`@/components/editor/${name}`, { [name]: host(name) }]));
  const shared = initial => React.useRef({ value: initial, get() { return this.value; }, set(value) { this.value = value; } }).current;
  const screen = loadScreen('src/app/(app)/editor.tsx', {
    ...passthrough,
    'expo-crypto': { randomUUID: () => 'qa-id' },
    'expo-router': { router: { dismissTo(path) { calls.dismissedTo.push(path); }, push(to) { calls.pushed.push(to); }, back() {} }, useLocalSearchParams: () => ({ uri: 'file:///qa-photo.jpg', ...(group ? { group: 'squad' } : { to: 'bob' }), ...(chatDare ? { chatDare: 'dare1' } : {}), ...params }) },
    'expo-status-bar': { StatusBar: host('StatusBar') },
    'react-native-gesture-handler': { GestureDetector: host('GestureDetector'), usePanGesture: () => ({}), usePinchGesture: () => ({}), useTapGesture: () => ({}), useSimultaneousGestures: () => ({}) },
    'react-native-reanimated': { __esModule: true, default: { View: host('AnimatedView') }, useSharedValue: shared, useAnimatedStyle: callback => callback(), withTiming: value => value },
    'react-native-view-shot': { captureRef: async () => 'file:///qa-finished.jpg' },
    'react-native-worklets': { scheduleOnRN() {} },
    '@/components/editor/filters': { FILTERS: [{ name: 'No filter' }], FilterLayers: host('FilterLayers') },
    '@/components/editor/stickers': { TEXT_COLORS: ['white'], randomOffset: () => 0 },
    '@/components/IconButton': { IconButton: host('IconButton') },
    '@/components/SafeEdge': { SafeEdge: host('SafeEdge') },
    '@/lib/chat': {
      sendSnap: async () => { calls.snaps++; if (send) await send(); },
      sendChatPhoto: async (...args) => { calls.chatPhotos.push(args); if (send) await send(); },
      claimChatDare: async () => { if (++calls.claimed === 1 && failClaim) throw new Error(claimError); },
    },
    '@/lib/groupChat': {
      sendGroupCapture: async () => { calls.groups++; if (send) await send(); },
      sendGroupSnap: async (...args) => { calls.groupSnaps.push(args); if (send) await send(); },
    },
    '@/lib/publicChat': { PUBLIC_CHAT: 'public', sendPublicPhoto: async () => { calls.publicPhotos++; } },
    '@/lib/groupGuess': { postGroupGuess: async (...args) => { calls.groupGuesses.push(args); if (groupGuess) await groupGuess(...args); } },
    '@/lib/guess': { postMystery: async (...args) => { calls.mysteries.push(args); } },
    '@/lib/eyeTrack': { CAN_TRACK_EYES: false },
    '@/lib/keeps': { CAN_SAVE_TO_PHOTOS: false, addKeep: async () => {} },
    ...overrides,
  }, { timers: 'real' }); // the editor waits a moment for moving text to stop before it takes the picture
  return { screen, calls };
}
const sendButton = tree => tree.root.findAllByType('Pressable').find(node => node.props.accessibilityRole === 'button' && /^Send/.test(textOf(node)));

test('repeated editor presses send one group photo', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { screen, calls } = fixture({ group: true, send: () => pending, params: { roll: '1' } });
  const tree = await renderScreen(screen);
  try {
    const press = sendButton(tree).props.onPress;
    let a, b;
    await act(async () => { a = press(); b = press(); await Promise.resolve(); });
    release(); await act(() => Promise.all([a, b]));
    assert.equal(calls.groups, 1);
  } finally { release(); await unmount(tree); }
});

test('a half-saved chat proof explains the failure and retries the dare update without resending its photo', async () => {
  const { screen, calls } = fixture({ chatDare: true, failClaim: true });
  const tree = await renderScreen(screen);
  try {
    await act(() => sendButton(tree).props.onPress());
    assert.equal(screen.calls.alerts.length, 1, 'a failed dare update must not be reported as a complete success');
    assert.equal(screen.calls.toasts.length, 0);
    await act(() => sendButton(tree).props.onPress());
    assert.equal(calls.snaps, 1);
    assert.equal(calls.claimed, 2);
  } finally { await unmount(tree); }
});

test('a chat proof whose dare is gone says so once and goes back to the chat instead of asking to try again', async () => {
  const { screen, calls } = fixture({ chatDare: true, failClaim: true, claimError: 'This dare is gone' });
  const tree = await renderScreen(screen);
  try {
    await act(() => sendButton(tree).props.onPress());
    assert.equal(screen.calls.alerts.length, 1);
    assert.equal(screen.calls.alerts[0][0], 'Photo sent');
    assert.doesNotMatch(screen.calls.alerts[0][1], /Tap Send again/, 'trying again can never work when the dare is gone');
    assert.deepEqual(calls.dismissedTo, ['/chat/bob'], 'back to the chat');
    // The photo is not sent twice if Send is pressed again on the way out.
    await act(() => sendButton(tree).props.onPress());
    assert.equal(calls.snaps, 1);
    assert.equal(calls.claimed, 1);
  } finally { await unmount(tree); }
});

// ---------------------------------------------------------------------------
// 🕵️ Guess Who in a group chat. It must NEVER go out as a normal group photo (that shows your name) or as a
// friends-wide Guess Who.
// ---------------------------------------------------------------------------
test('a group Guess Who goes to that group with no name: never as a group photo, never to friends', async () => {
  const { screen, calls } = fixture({ group: true, params: { groupGuess: '1' } });
  const tree = await renderScreen(screen);
  try {
    assert.equal(textOf(sendButton(tree)), 'Send Guess Who');
    await act(() => sendButton(tree).props.onPress());
    assert.equal(calls.groups, 0, 'not sent as a normal (named) group photo');
    assert.equal(calls.mysteries.length, 0, 'not posted to friends');
    assert.equal(calls.groupGuesses.length, 1);
    const [me, group, capture] = calls.groupGuesses[0];
    assert.deepEqual([me, group, capture.kind, capture.uri], ['alice', 'squad', 'photo', 'file:///qa-finished.jpg']);
    assert.deepEqual(calls.dismissedTo, ['/groups/chat/squad']);
    assert.deepEqual(screen.calls.toasts.at(-1), ['Guess Who sent 🕵️ No name on it – let the group guess!']);
    // Pressing again on the way out sends nothing more.
    await act(() => sendButton(tree).props.onPress());
    assert.equal(calls.groupGuesses.length, 1);
  } finally { await unmount(tree); }
});

test('a refused group Guess Who says why, and Send can be tried again', async () => {
  const { screen, calls } = fixture({ group: true, params: { groupGuess: '1' }, groupGuess: async () => { throw new Error('You can post 3 Guess Whos in this group a day'); } });
  const tree = await renderScreen(screen);
  try {
    await act(() => sendButton(tree).props.onPress());
    assert.deepEqual(screen.calls.alerts.at(-1), ['Could not send', 'You can post 3 Guess Whos in this group a day']);
    assert.deepEqual(calls.dismissedTo, []);
    assert.equal(calls.groups, 0);
    await act(() => sendButton(tree).props.onPress());
    assert.equal(calls.groupGuesses.length, 2);
  } finally { await unmount(tree); }
});

test('a group camera can never post a friends-wide Guess Who (guess=1 with a group)', async () => {
  const { screen, calls } = fixture({ group: true, params: { guess: '1' } });
  const tree = await renderScreen(screen);
  try {
    assert.notEqual(textOf(sendButton(tree)), 'Post Guess Who');
    await act(() => sendButton(tree).props.onPress());
    assert.equal(calls.mysteries.length, 0);
    assert.equal(calls.groupGuesses.length, 0);
    assert.equal(calls.groups, 0);
  } finally { await unmount(tree); }
});

test('a group dare proof is never a Guess Who, even with groupGuess=1', async () => {
  const { screen, calls } = fixture({ group: true, params: { groupGuess: '1', groupDare: 'dare1' } });
  const tree = await renderScreen(screen);
  try {
    await act(() => sendButton(tree).props.onPress());
    assert.equal(calls.groupGuesses.length, 0);
    assert.equal(calls.groups, 0, 'nor a named proof the person thought was anonymous');
    assert.equal(calls.mysteries.length, 0);
  } finally { await unmount(tree); }
});

test('a photo picked from Photos (roll=1) still goes to the group as a normal photo, as before', async () => {
  const { screen, calls } = fixture({ group: true, params: { roll: '1' } });
  const tree = await renderScreen(screen);
  try {
    assert.equal(textOf(sendButton(tree)), 'Send to group');
    await act(() => sendButton(tree).props.onPress());
    assert.equal(calls.groups, 1);
    assert.equal(calls.groupSnaps.length, 0, 'never a snap');
    assert.equal(calls.groupGuesses.length, 0);
    assert.deepEqual(calls.dismissedTo, ['/groups/chat/squad']);
  } finally { await unmount(tree); }
});

// ---------------------------------------------------------------------------
// 👀 Group snaps (the owner, 21 Nov): a picture taken with a group chat's CAMERA goes as a snap (view once, then
// gone, unless someone saves it in the chat). Only pictures picked from Photos go as normal photos. Group dare
// proofs, group Guess Who and the public chat stay exactly as they were.
// ---------------------------------------------------------------------------
test('a picture taken with the group chat camera goes as a snap (never as a normal photo)', async () => {
  const { screen, calls } = fixture({ group: true });
  const tree = await renderScreen(screen);
  try {
    assert.equal(textOf(sendButton(tree)), 'Send snap');
    await act(() => sendButton(tree).props.onPress());
    assert.equal(calls.groups, 0, 'not a normal (permanent) group photo');
    assert.equal(calls.groupSnaps.length, 1);
    const [me, group, capture] = calls.groupSnaps[0];
    assert.deepEqual([me, group, capture.kind, capture.uri], ['alice', 'squad', 'photo', 'file:///qa-finished.jpg']);
    assert.deepEqual(screen.calls.toasts.at(-1), ['Snap sent 👀']);
    assert.deepEqual(calls.dismissedTo, ['/groups/chat/squad']);
    // Pressing again on the way out sends nothing more.
    await act(() => sendButton(tree).props.onPress());
    assert.equal(calls.groupSnaps.length, 1);
  } finally { await unmount(tree); }
});

test('a video taken with the group chat camera goes as a snap too', async () => {
  const { screen, calls } = fixture({ group: true, params: { video: '1', uri: 'file:///qa-clip.mp4' } });
  const tree = await renderScreen(screen);
  try {
    await act(() => sendButton(tree).props.onPress());
    assert.equal(calls.groupSnaps.length, 1);
    assert.equal(calls.groupSnaps[0][2].kind, 'video');
    assert.equal(calls.groups, 0);
  } finally { await unmount(tree); }
});

test('repeated presses send one group snap', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { screen, calls } = fixture({ group: true, send: () => pending });
  const tree = await renderScreen(screen);
  try {
    const press = sendButton(tree).props.onPress;
    let a, b;
    await act(async () => { a = press(); b = press(); await Promise.resolve(); });
    release(); await act(() => Promise.all([a, b]));
    assert.equal(calls.groupSnaps.length, 1);
  } finally { release(); await unmount(tree); }
});

test('a group snap that could not be sent says why, and Send can be tried again', async () => {
  let fail = true;
  const { screen, calls } = fixture({ group: true, send: async () => { if (fail) throw new Error('Simulated upload failure'); } });
  const tree = await renderScreen(screen);
  try {
    await act(() => sendButton(tree).props.onPress());
    assert.deepEqual(screen.calls.alerts.at(-1), ['Could not send', 'Simulated upload failure']);
    assert.deepEqual(calls.dismissedTo, []);
    fail = false;
    await act(() => sendButton(tree).props.onPress());
    assert.equal(calls.groupSnaps.length, 2);
    assert.deepEqual(calls.dismissedTo, ['/groups/chat/squad']);
  } finally { await unmount(tree); }
});

test('a group dare proof from the camera stays a normal proof (the group votes on it), never a snap', async () => {
  const { screen, calls } = fixture({ group: true, params: { groupDare: 'dare1' } });
  const tree = await renderScreen(screen);
  try {
    assert.equal(textOf(sendButton(tree)), 'Send to group');
    await act(() => sendButton(tree).props.onPress());
    assert.equal(calls.groups, 1);
    assert.equal(calls.groupSnaps.length, 0);
    assert.deepEqual(screen.calls.toasts.at(-1), ['Proof posted in the group 🎯']);
  } finally { await unmount(tree); }
});

test('the public chat camera still posts a public photo, never a snap', async () => {
  const { screen, calls } = fixture({ group: true, params: { group: 'public' } });
  const tree = await renderScreen(screen);
  const postButton = () => tree.root.findAllByType('Pressable').find(node => node.props.accessibilityRole === 'button' && textOf(node) === 'Post in public chat');
  try {
    assert.ok(postButton(), 'the button says Post in public chat');
    await act(() => postButton().props.onPress());
    assert.equal(calls.publicPhotos, 1);
    assert.equal(calls.groupSnaps.length, 0);
    assert.equal(calls.groups, 0);
  } finally { await unmount(tree); }
});

test('a group Guess Who is never a snap', async () => {
  const { screen, calls } = fixture({ group: true, params: { groupGuess: '1' } });
  const tree = await renderScreen(screen);
  try {
    await act(() => sendButton(tree).props.onPress());
    assert.equal(calls.groupGuesses.length, 1);
    assert.equal(calls.groupSnaps.length, 0);
  } finally { await unmount(tree); }
});

// ---------------------------------------------------------------------------
// 🕵️ What you see is what's posted: a group Guess Who is saved as a 3:4 photo, so in that mode the picture the
// editor sends is a 3:4 box in the middle of the screen (the test screen is 320 × 568). Anywhere else it is the
// whole screen, as before.
// ---------------------------------------------------------------------------
const flat = style => (Array.isArray(style) ? Object.assign({}, ...style.map(flat)) : style || {});
const captureView = tree => tree.root.findAll(node => node.type === 'View' && node.props.collapsable === false);

test('in group Guess Who mode the picture that is sent is a 3:4 box in the middle; otherwise it is the whole screen', async () => {
  const { screen } = fixture({ group: true, params: { groupGuess: '1' } });
  const tree = await renderScreen(screen);
  try {
    const views = captureView(tree);
    assert.equal(views.length, 1, 'one picture is taken');
    const box = flat(views[0].props.style);
    assert.equal(box.position, 'absolute');
    assert.equal(box.width, 320, 'as wide as the screen');
    assert.ok(Math.abs(box.height - (320 * 4) / 3) < 1e-9, `3:4 (height ${box.height})`);
    assert.equal(box.left, 0);
    assert.ok(Math.abs(box.top - (568 - (320 * 4) / 3) / 2) < 1e-9, 'in the middle, black above and below');
    assert.equal(box.overflow, 'hidden', 'text and stickers dragged outside the box are not shown (and not sent)');
  } finally { await unmount(tree); }

  for (const params of [{}, { groupDare: 'dare1', groupGuess: '1' }]) {
    const normal = fixture({ group: true, params });
    const tree2 = await renderScreen(normal.screen);
    try {
      const [view] = captureView(tree2);
      const style = flat(view.props.style);
      assert.equal(style.width, undefined, 'no fixed size: it fills the screen');
      assert.equal(style.height, undefined);
      assert.ok([view.props.style].flat(Infinity).includes(normal.screen.getBinding('styles').canvas), 'the full-screen canvas');
    } finally { await unmount(tree2); }
  }
});

test('in group Guess Who mode, zooming and moving the photo stay inside the 3:4 box', async () => {
  let pinch;
  const { screen } = fixture({ group: true, params: { groupGuess: '1' }, overrides: {
    'react-native-gesture-handler': { GestureDetector: host('GestureDetector'), usePanGesture: () => ({}), usePinchGesture: config => { pinch = config; return {}; }, useTapGesture: () => ({}), useSimultaneousGestures: () => ({}) },
  } });
  const tree = await renderScreen(screen);
  try {
    // Pinch all the way in (5×) with your fingers far above the middle: the photo can move at most
    // (box height × 4) / 2 down – measured with the box, not the whole screen.
    await act(() => pinch.onUpdate({ scaleChange: 5, focalX: 160, focalY: -100 }));
    await act(() => tree.update(React.createElement(screen.Component)));
    const moved = tree.root.findAllByType('AnimatedView').map(node => flat(node.props.style).transform).find(Boolean);
    const translate = Object.assign({}, ...moved);
    assert.equal(translate.scale, 5);
    assert.equal(translate.translateX, 0);
    assert.ok(Math.abs(translate.translateY - ((320 * 4) / 3) * 2) < 1e-9, `moved ${translate.translateY}`);
  } finally { await unmount(tree); }
});

test('in group Guess Who mode the bin sits at the bottom of the 3:4 box (a sticker never vanishes off the box on its way there); elsewhere it stays at the bottom of the screen', async () => {
  const binOf = async params => {
    const { screen } = fixture({ group: true, params });
    const tree = await renderScreen(screen);
    try {
      // Add a sticker, then start dragging it so the bin shows.
      await act(() => tree.root.findByType('StickerPicker').props.onPickEmoji('🔥'));
      const sticker = tree.root.findAllByType('DraggableItem')[0];
      await act(() => sticker.props.onDragChange(true));
      const icon = tree.root.findAll(node => node.type === 'View' && node.props.pointerEvents === 'none' && flat(node.props.style).top !== undefined && tree.root.findAllByType('Ionicons').some(i => i.props.name === 'trash'));
      return { zone: sticker.props.trash, iconTop: flat(icon[icon.length - 1].props.style).top };
    } finally { await unmount(tree); }
  };
  // The test screen is 320 × 568: the 3:4 box is 320 × 426.67, from y = 70.67 to y = 497.33.
  const boxTop = (568 - (320 * 4) / 3) / 2;
  const boxBottom = boxTop + (320 * 4) / 3;
  const guess = await binOf({ groupGuess: '1' });
  assert.ok(Math.abs(guess.zone.top - (boxBottom - 150)) < 1e-9, `bin starts 150 above the box's bottom (got ${guess.zone.top})`);
  assert.equal(guess.zone.left, 160 - 70);
  assert.equal(guess.zone.right, 160 + 70);
  assert.ok(Math.abs(guess.iconTop - (boxBottom - 130)) < 1e-9, 'the bin icon is drawn inside the box');
  // Any other mode: the whole screen, exactly as before.
  const normal = await binOf({});
  assert.deepEqual({ ...normal.zone }, { top: 568 - 150, left: 160 - 70, right: 160 + 70 });
});

// ---------------------------------------------------------------------------
// 📷 One-on-one chats: a picture from the chat's camera is a peek (as before); one picked from Photos (roll=1) goes
// as a photo that never disappears (a peek saved from the start, see sendChatPhoto). A dare proof is always a peek.
// ---------------------------------------------------------------------------
test('a one-on-one chat camera picture is still a peek', async () => {
  const { screen, calls } = fixture();
  const tree = await renderScreen(screen);
  try {
    assert.equal(textOf(sendButton(tree)), 'Send');
    await act(() => sendButton(tree).props.onPress());
    assert.equal(calls.snaps, 1);
    assert.equal(calls.chatPhotos.length, 0);
    assert.deepEqual(screen.calls.toasts.at(-1), ['Peek sent 👀']);
    assert.deepEqual(calls.dismissedTo, ['/chat/bob']);
  } finally { await unmount(tree); }
});

test('a photo picked from Photos in a one-on-one chat goes as a photo (never as a peek), once', async () => {
  const { screen, calls } = fixture({ params: { roll: '1' } });
  const tree = await renderScreen(screen);
  try {
    await act(() => sendButton(tree).props.onPress());
    assert.equal(calls.snaps, 0, 'not a disappearing peek');
    assert.equal(calls.chatPhotos.length, 1);
    const [me, friend, capture] = calls.chatPhotos[0];
    assert.deepEqual([me, friend, capture.kind], ['alice', 'bob', 'photo']);
    assert.deepEqual(screen.calls.toasts.at(-1), ['Photo sent 📷']);
    assert.deepEqual(calls.dismissedTo, ['/chat/bob']);
    await act(() => sendButton(tree).props.onPress());
    assert.equal(calls.chatPhotos.length, 1);
  } finally { await unmount(tree); }
});

test('a dare proof picked from Photos is still a peek (your friend confirms it)', async () => {
  const { screen, calls } = fixture({ chatDare: true, params: { roll: '1' } });
  const tree = await renderScreen(screen);
  try {
    await act(() => sendButton(tree).props.onPress());
    assert.equal(calls.snaps, 1);
    assert.equal(calls.chatPhotos.length, 0);
    assert.equal(calls.claimed, 1);
  } finally { await unmount(tree); }
});
