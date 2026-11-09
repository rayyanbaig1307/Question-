const test = require('node:test');
const assert = require('node:assert/strict');
const { React, loadScreen, renderScreen, act, unmount, host, textOf } = require('./harness.cjs');

// params: more route params (e.g. groupGuess). groupGuess: what postGroupGuess does (by default it works).
// overrides: other stand-ins (e.g. gestures that remember their settings).
function fixture({ group = false, chatDare = false, failClaim = false, claimError = 'Simulated dare update failure', send, params = {}, groupGuess, overrides = {} } = {}) {
  const calls = { snaps: 0, groups: 0, claimed: 0, dismissedTo: [], groupGuesses: [], mysteries: [], pushed: [] };
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
    '@/lib/chat': { sendSnap: async () => { calls.snaps++; if (send) await send(); }, claimChatDare: async () => { if (++calls.claimed === 1 && failClaim) throw new Error(claimError); } },
    '@/lib/groupChat': { sendGroupCapture: async () => { calls.groups++; if (send) await send(); } },
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
  const { screen, calls } = fixture({ group: true, send: () => pending });
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

test('a normal group photo still goes to the group as before', async () => {
  const { screen, calls } = fixture({ group: true });
  const tree = await renderScreen(screen);
  try {
    assert.equal(textOf(sendButton(tree)), 'Send to group');
    await act(() => sendButton(tree).props.onPress());
    assert.equal(calls.groups, 1);
    assert.equal(calls.groupGuesses.length, 0);
    assert.deepEqual(calls.dismissedTo, ['/groups/chat/squad']);
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
