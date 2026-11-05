const test = require('node:test');
const assert = require('node:assert/strict');
const { React, loadScreen, renderScreen, act, unmount, host, textOf } = require('./harness.cjs');

function fixture({ group = false, chatDare = false, failClaim = false, claimError = 'Simulated dare update failure', send } = {}) {
  const calls = { snaps: 0, groups: 0, claimed: 0, dismissedTo: [] };
  const passthrough = Object.fromEntries(['CropTool', 'DraggableItem', 'StickerPicker', 'TextComposer'].map(name => [`@/components/editor/${name}`, { [name]: host(name) }]));
  const shared = initial => React.useRef({ value: initial, get() { return this.value; }, set(value) { this.value = value; } }).current;
  const screen = loadScreen('src/app/(app)/editor.tsx', {
    ...passthrough,
    'expo-crypto': { randomUUID: () => 'qa-id' },
    'expo-router': { router: { dismissTo(path) { calls.dismissedTo.push(path); }, push() {}, back() {} }, useLocalSearchParams: () => ({ uri: 'file:///qa-photo.jpg', ...(group ? { group: 'squad' } : { to: 'bob' }), ...(chatDare ? { chatDare: 'dare1' } : {}) }) },
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
    '@/lib/eyeTrack': { CAN_TRACK_EYES: false },
    '@/lib/keeps': { CAN_SAVE_TO_PHOTOS: false, addKeep: async () => {} },
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
