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
  // The editor now hands straight sends to the outbox (lib/outbox.ts) and leaves at once: [me, scope, what, extra].
  calls.sends = screen.calls.outbox.sendLater;
  return { screen, calls };
}
// Values made inside the screen come from its own little world: compare them as plain data.
const plain = value => JSON.parse(JSON.stringify(value));
const sendButton = tree => tree.root.findAllByType('Pressable').find(node => node.props.accessibilityRole === 'button' && /^Send/.test(textOf(node)));

// ---------------------------------------------------------------------------
// 📤 Straight sends (a chat's, a group's or the public chat's camera, and Guess Who) go to the outbox and the editor
// goes back at once: only the picture itself is waited for. Uploading, saving, trying again and the dare-claim
// alerts are the outbox's job now (tests/unit/outbox.test.mjs, toasts in src/components/OutboxBanner.tsx).
// ---------------------------------------------------------------------------

// F6: the owner's brother waited on "Sending…" forever.
test('chat camera Send goes straight back to the chat while the peek uploads', async () => {
  const { screen, calls } = fixture({ send: () => new Promise(() => {}) });
  const tree = await renderScreen(screen);
  try {
    assert.equal(textOf(sendButton(tree)), 'Send');
    await act(() => sendButton(tree).props.onPress());
    assert.deepEqual(calls.dismissedTo, ['/chat/bob']);
    assert.equal(calls.sends.length, 1);
    const [me, scope, what, extra] = calls.sends[0];
    assert.deepEqual([me, scope], ['alice', 'friend:bob']);
    assert.deepEqual(plain(what), { kind: 'peek', friendIds: ['bob'] });
    assert.deepEqual(plain(extra.capture), { kind: 'photo', uri: 'file:///qa-finished.jpg' });
    assert.equal(calls.snaps, 0, 'nothing is uploaded while you wait');
    assert.equal(screen.calls.alerts.length, 0);
    // Pressing again on the way out sends nothing more.
    await act(() => sendButton(tree).props.onPress());
    assert.equal(calls.sends.length, 1);
  } finally { await unmount(tree); }
});

// F7: the group camera, and a chat dare proof (the dare is marked as done by the outbox after the peek is in).
test('group camera Send goes straight back to the group while the snap uploads', async () => {
  const { screen, calls } = fixture({ group: true, params: { group: 'g1' }, send: () => new Promise(() => {}) });
  const tree = await renderScreen(screen);
  try {
    assert.equal(textOf(sendButton(tree)), 'Send snap');
    await act(() => sendButton(tree).props.onPress());
    assert.deepEqual(calls.dismissedTo, ['/groups/chat/g1']);
    const [, scope, what, extra] = calls.sends[0];
    assert.equal(scope, 'group:g1');
    assert.deepEqual(plain(what), { kind: 'groupMedia', groupId: 'g1', snap: true });
    assert.equal(extra.capture.kind, 'photo');
    assert.equal(calls.groupSnaps.length, 0);
  } finally { await unmount(tree); }
});

test('a chat dare proof goes back to the chat at once; the dare is marked by the outbox (no alert here)', async () => {
  const { screen, calls } = fixture({ chatDare: true, failClaim: true, claimError: 'This dare is gone' });
  const tree = await renderScreen(screen);
  try {
    await act(() => sendButton(tree).props.onPress());
    assert.deepEqual(plain(calls.sends[0][2]), { kind: 'peek', friendIds: ['bob'], chatDare: 'dare1' });
    assert.deepEqual(calls.dismissedTo, ['/chat/bob']);
    assert.equal(screen.calls.alerts.length, 0);
    assert.equal(calls.claimed, 0, 'the claim runs after the peek is saved, in the background');
  } finally { await unmount(tree); }
});

test('when the dare is gone the toast still says the peek was sent (it used to be an alert in the editor)', async () => {
  const banner = loadScreen('src/components/OutboxBanner.tsx').exports;
  const proof = { what: { kind: 'peek', friendIds: ['bob'], chatDare: 'dare1' } };
  assert.equal(banner.sentWords({ ...proof, result: { dareProblem: 'gone' } }), "Peek sent – that dare isn't there any more");
  assert.equal(banner.sentWords({ ...proof, result: { dareProblem: null } }), 'Proof sent 🎯 Now they confirm it');
  assert.match(banner.sentWords({ ...proof, result: { dareProblem: 'No internet' } }), /Peek sent – the dare wasn't updated: No internet/);
});

test('repeated editor presses send one group photo', async () => {
  const { screen, calls } = fixture({ group: true, params: { roll: '1' } });
  const tree = await renderScreen(screen);
  try {
    const press = sendButton(tree).props.onPress;
    let a, b;
    await act(async () => { a = press(); b = press(); await Promise.resolve(); });
    await act(() => Promise.all([a, b]));
    assert.equal(calls.sends.length, 1);
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
    assert.equal(calls.sends.length, 1);
    const [me, scope, what, extra] = calls.sends[0];
    assert.deepEqual([me, scope], ['alice', 'group:squad']);
    assert.deepEqual(plain(what), { kind: 'groupGuess', groupId: 'squad' });
    assert.deepEqual(plain(extra.capture), { kind: 'photo', uri: 'file:///qa-finished.jpg' });
    assert.deepEqual(calls.dismissedTo, ['/groups/chat/squad']);
    // Pressing again on the way out sends nothing more.
    await act(() => sendButton(tree).props.onPress());
    assert.equal(calls.sends.length, 1);
  } finally { await unmount(tree); }
});

test('a video in group Guess Who mode is refused at once (photos only) and nothing is sent', async () => {
  const { screen, calls } = fixture({ group: true, params: { groupGuess: '1', video: '1' }, overrides: { '@/lib/groupGuess': { GROUP_GUESS_PHOTOS_ONLY: 'Guess Who in groups is photos only for now' } } });
  const tree = await renderScreen(screen);
  try {
    await act(() => sendButton(tree).props.onPress());
    assert.equal(calls.sends.length, 0);
    assert.deepEqual(screen.calls.alerts.at(-1), ['Could not send', 'Guess Who in groups is photos only for now']);
    assert.deepEqual(calls.dismissedTo, []);
  } finally { await unmount(tree); }
});

test('a video that is too big is said at once, before leaving, and nothing is sent', async () => {
  const { screen, calls } = fixture({ params: { video: '1', uri: 'file:///huge.mov' }, overrides: { '@/lib/media': { resizePhoto: async uri => uri, videoTooBig: () => true } } });
  const tree = await renderScreen(screen);
  try {
    await act(() => sendButton(tree).props.onPress());
    assert.equal(calls.sends.length, 0);
    assert.match(screen.calls.alerts.at(-1)[1], /too big/);
    assert.deepEqual(calls.dismissedTo, []);
  } finally { await unmount(tree); }
});

test('a group camera can never post a friends-wide Guess Who (guess=1 with a group)', async () => {
  const { screen, calls } = fixture({ group: true, params: { guess: '1' } });
  const tree = await renderScreen(screen);
  try {
    assert.notEqual(textOf(sendButton(tree)), 'Post Guess Who');
    await act(() => sendButton(tree).props.onPress());
    assert.equal(calls.sends.length, 0);
  } finally { await unmount(tree); }
});

test('a group dare proof is never a Guess Who, even with groupGuess=1', async () => {
  const { screen, calls } = fixture({ group: true, params: { groupGuess: '1', groupDare: 'dare1' } });
  const tree = await renderScreen(screen);
  try {
    await act(() => sendButton(tree).props.onPress());
    assert.equal(calls.sends.filter(([, , what]) => what.kind === 'groupGuess').length, 0);
    assert.equal(calls.sends.filter(([, , what]) => what.kind === 'groupMedia').length, 0, 'nor a named proof the person thought was anonymous');
  } finally { await unmount(tree); }
});

test('a photo picked from Photos (roll=1) still goes to the group as a normal photo, as before', async () => {
  const { screen, calls } = fixture({ group: true, params: { roll: '1' } });
  const tree = await renderScreen(screen);
  try {
    assert.equal(textOf(sendButton(tree)), 'Send to group');
    await act(() => sendButton(tree).props.onPress());
    assert.deepEqual(plain(calls.sends.map(([, , what]) => what)), [{ kind: 'groupMedia', groupId: 'squad', snap: false }]);
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
    assert.equal(calls.sends.length, 1);
    const [me, scope, what, extra] = calls.sends[0];
    assert.deepEqual([me, scope], ['alice', 'group:squad']);
    assert.deepEqual(plain(what), { kind: 'groupMedia', groupId: 'squad', snap: true });
    assert.deepEqual(plain(extra.capture), { kind: 'photo', uri: 'file:///qa-finished.jpg' });
    assert.deepEqual(calls.dismissedTo, ['/groups/chat/squad']);
    // Pressing again on the way out sends nothing more.
    await act(() => sendButton(tree).props.onPress());
    assert.equal(calls.sends.length, 1);
  } finally { await unmount(tree); }
});

test('a video taken with the group chat camera goes as a snap too', async () => {
  const { screen, calls } = fixture({ group: true, params: { video: '1', uri: 'file:///qa-clip.mp4' } });
  const tree = await renderScreen(screen);
  try {
    await act(() => sendButton(tree).props.onPress());
    assert.equal(calls.sends.length, 1);
    assert.equal(calls.sends[0][2].snap, true);
    assert.equal(calls.sends[0][3].capture.kind, 'video');
  } finally { await unmount(tree); }
});

test('repeated presses send one group snap', async () => {
  const { screen, calls } = fixture({ group: true });
  const tree = await renderScreen(screen);
  try {
    const press = sendButton(tree).props.onPress;
    let a, b;
    await act(async () => { a = press(); b = press(); await Promise.resolve(); });
    await act(() => Promise.all([a, b]));
    assert.equal(calls.sends.length, 1);
  } finally { await unmount(tree); }
});

test('a group dare proof from the camera stays a normal proof (the group votes on it), never a snap', async () => {
  const { screen, calls } = fixture({ group: true, params: { groupDare: 'dare1' } });
  const tree = await renderScreen(screen);
  try {
    assert.equal(textOf(sendButton(tree)), 'Send to group');
    await act(() => sendButton(tree).props.onPress());
    assert.deepEqual(plain(calls.sends.map(([, , what]) => what)), [{ kind: 'groupMedia', groupId: 'squad', snap: false, dareId: 'dare1' }]);
  } finally { await unmount(tree); }
});

test('the public chat camera still posts a public photo, never a snap', async () => {
  const { screen, calls } = fixture({ group: true, params: { group: 'public' } });
  const tree = await renderScreen(screen);
  const postButton = () => tree.root.findAllByType('Pressable').find(node => node.props.accessibilityRole === 'button' && textOf(node) === 'Post in public chat');
  try {
    assert.ok(postButton(), 'the button says Post in public chat');
    await act(() => postButton().props.onPress());
    assert.deepEqual(plain(calls.sends.map(([, scope, what]) => [scope, what])), [['public', { kind: 'publicPhoto' }]]);
    assert.deepEqual(calls.dismissedTo, ['/public-chat']);
  } finally { await unmount(tree); }
});

test('a group Guess Who is never a snap', async () => {
  const { screen, calls } = fixture({ group: true, params: { groupGuess: '1' } });
  const tree = await renderScreen(screen);
  try {
    await act(() => sendButton(tree).props.onPress());
    assert.deepEqual(plain(calls.sends.map(([, , what]) => what.kind)), ['groupGuess']);
  } finally { await unmount(tree); }
});

test('Guess Who from Home posts straight to Guess Who and goes there', async () => {
  const { screen, calls } = fixture({ params: { to: undefined, guess: '1' } });
  const tree = await renderScreen(screen);
  try {
    await act(() => sendButton(tree)?.props.onPress() ?? tree.root.findAllByType('Pressable').find(node => textOf(node) === 'Post Guess Who').props.onPress());
    assert.deepEqual(plain(calls.sends.map(([, scope, what]) => [scope, what])), [['me', { kind: 'guess', caption: '' }]]);
    assert.deepEqual(calls.dismissedTo, ['/guess']);
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
    assert.deepEqual(plain(calls.sends.map(([, , what]) => what)), [{ kind: 'peek', friendIds: ['bob'] }]);
    assert.deepEqual(calls.dismissedTo, ['/chat/bob']);
  } finally { await unmount(tree); }
});

test('a photo picked from Photos in a one-on-one chat goes as a photo (never as a peek), once', async () => {
  const { screen, calls } = fixture({ params: { roll: '1' } });
  const tree = await renderScreen(screen);
  try {
    await act(() => sendButton(tree).props.onPress());
    assert.equal(calls.sends.length, 1);
    const [me, scope, what, extra] = calls.sends[0];
    assert.deepEqual(plain([me, scope, what, extra.capture.kind]), ['alice', 'friend:bob', { kind: 'chatPhoto', friendId: 'bob' }, 'photo']);
    assert.deepEqual(calls.dismissedTo, ['/chat/bob']);
    await act(() => sendButton(tree).props.onPress());
    assert.equal(calls.sends.length, 1);
  } finally { await unmount(tree); }
  const banner = loadScreen('src/components/OutboxBanner.tsx').exports;
  assert.equal(banner.sentWords({ what: { kind: 'chatPhoto', friendId: 'bob' }, capture: { kind: 'photo' } }), 'Photo sent 📷');
});

test('a dare proof picked from Photos is still a peek (your friend confirms it)', async () => {
  const { screen, calls } = fixture({ chatDare: true, params: { roll: '1' } });
  const tree = await renderScreen(screen);
  try {
    await act(() => sendButton(tree).props.onPress());
    assert.deepEqual(plain(calls.sends.map(([, , what]) => what)), [{ kind: 'peek', friendIds: ['bob'], chatDare: 'dare1' }]);
  } finally { await unmount(tree); }
});

// ---------------------------------------------------------------------------
// 📦 Save (Keep): your Keeps in Peekaboo get the clean picture; the copy in the phone's Photos leaves the app, so it
// goes through lib/shareOut.ts saveOut (which adds the small Peekaboo wordmark to photos). The toasts are the same
// as before.
// ---------------------------------------------------------------------------
function keepFixture({ saveOut, params = {} } = {}) {
  const log = [];
  const { screen, calls } = fixture({
    params,
    overrides: {
      '@/lib/keeps': { addKeep: async (...args) => { log.push(['addKeep', ...args]); } },
      '@/lib/shareOut': {
        CAN_SHARE_FILES: false,
        shareOut: async () => { throw new Error('the editor never opens the share sheet'); },
        saveOut: async (...args) => { log.push(['saveOut', ...args]); return saveOut ? saveOut(...args) : 'saved'; },
      },
    },
  });
  return { screen, calls, log };
}
const keepButton = tree => tree.root.findAllByType('Pressable').find(node => /^Save to Photos/.test(node.props.accessibilityLabel ?? ''));

test('Save: Keeps get the clean picture, and the Photos copy goes out through saveOut', async () => {
  const { screen, log } = keepFixture();
  const tree = await renderScreen(screen);
  try {
    await act(() => keepButton(tree).props.onPress());
    assert.deepEqual(JSON.parse(JSON.stringify(log)), [
      ['addKeep', 'alice', { kind: 'photo', uri: 'file:///qa-finished.jpg' }],
      ['saveOut', 'file:///qa-finished.jpg', 'photo'],
    ]);
    assert.deepEqual(screen.calls.toasts.at(-1), ['Saved to Photos and your Keeps 📦']);
    assert.equal(screen.calls.alerts.length, 0);
    // Saved once: the button says so, and pressing it again does nothing.
    const done = tree.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel === 'Saved');
    assert.equal(done.props.disabled, true);
    await act(() => done.props.onPress());
    assert.equal(log.length, 2);
  } finally { await unmount(tree); }
});

test('Save: when Photos says no (or can\'t), it is still in your Keeps, with the same words as before', async () => {
  for (const answer of ['no-permission', 'not-possible', 'throws']) {
    const { screen, log } = keepFixture({ saveOut: async () => { if (answer === 'throws') throw new Error('Photos fell over'); return answer; } });
    const tree = await renderScreen(screen);
    try {
      await act(() => keepButton(tree).props.onPress());
      assert.deepEqual(log.map(([what]) => what), ['addKeep', 'saveOut'], answer);
      assert.deepEqual(screen.calls.toasts.at(-1), ['Saved to your Keeps 📦'], answer);
      assert.equal(screen.calls.alerts.length, 0, answer);
    } finally { await unmount(tree); }
  }
});

test('Save of a video: Keeps get the video and its layer, and Photos gets the video as it is (no wordmark yet)', async () => {
  const { screen, log } = keepFixture({ params: { video: '1' } });
  const tree = await renderScreen(screen);
  try {
    await act(() => keepButton(tree).props.onPress());
    assert.deepEqual(JSON.parse(JSON.stringify(log)), [
      ['addKeep', 'alice', { kind: 'video', uri: 'file:///qa-photo.jpg', overlayUri: null }],
      ['saveOut', 'file:///qa-photo.jpg', 'video'],
    ]);
    assert.deepEqual(screen.calls.toasts.at(-1), ['Saved to Photos and your Keeps 📦']);
  } finally { await unmount(tree); }
});

test('Save: if Keeps fails, nothing goes to Photos and it says why', async () => {
  const { screen, log } = keepFixture();
  screen.modules['@/lib/keeps'].addKeep = async () => { log.push(['addKeep']); throw new Error('No internet'); };
  const tree = await renderScreen(screen);
  try {
    await act(() => keepButton(tree).props.onPress());
    assert.deepEqual(log.map(([what]) => what), ['addKeep']);
    assert.deepEqual(screen.calls.alerts.at(-1), ['Could not save', 'No internet']);
  } finally { await unmount(tree); }
});

// ---------------------------------------------------------------------------
// 📦 The other Save to Photos: a keep opened from your Keeps (src/app/(app)/keeps/[id].tsx). The file comes back
// from Peekaboo and goes to Photos through saveOut too (photos get the wordmark there; videos go as they are).
// ---------------------------------------------------------------------------
const { button } = require('./harness.cjs');

function keepViewer({ mediaType = 'photo', answer = 'saved' } = {}) {
  const log = [];
  const keep = { id: 'k1', user_id: 'alice', media_path: 'alice/keeps/k1', media_type: mediaType, poster_path: null, overlay_path: null, created_at: '2026-11-22T10:00:00Z' };
  const screen = loadScreen('src/app/(app)/keeps/[id].tsx', {
    'expo-image': { Image: host('Image') },
    'expo-router': { router: { back: () => log.push(['back']), push: to => log.push(['push', to]) }, useLocalSearchParams: () => ({ id: 'k1' }) },
    '@/components/IconButton': { IconButton: host('IconButton') },
    '@/components/SafeEdge': { SafeEdge: host('SafeEdge') },
    '@/lib/keeps': {
      CAN_SAVE_TO_PHOTOS: true,
      fetchKeeps: async () => [keep],
      deleteKeep: async () => {},
      downloadKeepFile: async (url, name) => { log.push(['download', url, name]); return `file:///cache/${name}`; },
    },
    '@/lib/media': { useMediaUrls: () => ({ 'alice/keeps/k1': 'https://example.invalid/k1' }) },
    '@/lib/shareOut': {
      CAN_SHARE_FILES: false,
      shareOut: async () => 'not-possible',
      saveOut: async (...args) => { log.push(['saveOut', ...args]); return answer; },
    },
  });
  return { screen, log };
}

test('Keeps viewer: Save to Photos sends the photo through saveOut, with the same words as before', async () => {
  for (const [answer, toast] of [['saved', 'Saved to Photos ✅'], ['no-permission', 'Peekaboo needs permission to save to Photos']]) {
    const { screen, log } = keepViewer({ answer });
    const tree = await renderScreen(screen);
    try {
      await act(() => button(tree, 'Save to Photos').props.onPress());
      assert.deepEqual(log, [['download', 'https://example.invalid/k1', 'keep-k1.jpg'], ['saveOut', 'file:///cache/keep-k1.jpg', 'photo']]);
      assert.deepEqual(screen.calls.toasts.at(-1), [toast]);
      assert.equal(screen.calls.alerts.length, 0);
    } finally { await unmount(tree); }
  }
});

test('Keeps viewer: a video goes to Photos as a video; Photos failing says so', async () => {
  const video = keepViewer({ mediaType: 'video' });
  let tree = await renderScreen(video.screen);
  try {
    await act(() => button(tree, 'Save to Photos').props.onPress());
    assert.deepEqual(video.log.at(-1), ['saveOut', 'file:///cache/keep-k1.mp4', 'video']);
  } finally { await unmount(tree); }
  const broken = keepViewer({ answer: 'not-possible' });
  tree = await renderScreen(broken.screen);
  try {
    await act(() => button(tree, 'Save to Photos').props.onPress());
    assert.equal(broken.screen.calls.toasts.length, 0);
    assert.equal(broken.screen.calls.alerts.at(-1)[0], 'Could not save');
  } finally { await unmount(tree); }
});
