const test = require('node:test');
const assert = require('node:assert/strict');
const { React, loadScreen, renderScreen, act, unmount, host, textOf } = require('./harness.cjs');

// The photo editor turns the photo and its text and stickers into one picture before it is sent or saved
// (react-native-view-shot). In a web browser that needs an extra package the app doesn't have, so the
// editor must say so in a message people can see – not fail quietly and leave them stuck on the editor.

function loadEditor(os) {
  const captures = [];
  const routes = [];
  const passthrough = Object.fromEntries(['CropTool', 'DraggableItem', 'StickerPicker', 'TextComposer'].map(name => [`@/components/editor/${name}`, { [name]: host(name) }]));
  const shared = initial => React.useRef({ value: initial, get() { return this.value; }, set(value) { this.value = value; } }).current;
  const mocks = {
    ...passthrough,
    'expo-crypto': { randomUUID: () => 'qa-id' },
    // Opened from the camera with no chat, dare or group: the editor shows "Send to" and "Save".
    'expo-router': { router: { dismissTo() {}, push: (...args) => routes.push(args), back() {} }, useLocalSearchParams: () => ({ uri: 'file:///qa-photo.jpg' }) },
    'expo-status-bar': { StatusBar: host('StatusBar') },
    'react-native-gesture-handler': { GestureDetector: host('GestureDetector'), usePanGesture: () => ({}), usePinchGesture: () => ({}), useTapGesture: () => ({}), useSimultaneousGestures: () => ({}) },
    'react-native-reanimated': { __esModule: true, default: { View: host('AnimatedView') }, useSharedValue: shared, useAnimatedStyle: callback => callback(), withTiming: value => value },
    'react-native-view-shot': { captureRef: async (...args) => { captures.push(args); return 'file:///qa-finished.jpg'; } },
    'react-native-worklets': { scheduleOnRN() {} },
    '@/components/editor/filters': { FILTERS: [{ name: 'No filter' }], FilterLayers: host('FilterLayers') },
    '@/components/editor/stickers': { TEXT_COLORS: ['white'], randomOffset: () => 0 },
    '@/components/IconButton': { IconButton: host('IconButton') },
    '@/components/SafeEdge': { SafeEdge: host('SafeEdge') },
    '@/lib/chat': { sendSnap: async () => {}, claimChatDare: async () => {} },
    '@/lib/groupChat': { sendGroupCapture: async () => {} },
    '@/lib/eyeTrack': { CAN_TRACK_EYES: false },
    '@/lib/keeps': { CAN_SAVE_TO_PHOTOS: false, addKeep: async () => {} },
  };
  // The shared test mock of react-native, with only the platform changed.
  const reactNative = loadScreen('src/app/(app)/editor.tsx', mocks).modules['react-native'];
  // Real timers: the editor waits a moment for moving text to stop before it takes the picture.
  const screen = loadScreen('src/app/(app)/editor.tsx', { ...mocks, 'react-native': { ...reactNative, Platform: { OS: os } } }, { timers: 'real' });
  return { screen, captures, routes };
}

const sendTo = tree => tree.root.findAllByType('Pressable').find(node => textOf(node) === 'Send to');
const save = tree => tree.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel === 'Save to Photos and Keeps');

test('in a web browser, Send to and Save explain they need the phone app instead of failing quietly', async () => {
  const { screen, captures, routes } = loadEditor('web');
  const tree = await renderScreen(screen);
  try {
    await act(() => sendTo(tree).props.onPress());
    await act(() => save(tree).props.onPress());
    // Two visible messages (a toast shows on the web; Alert.alert does nothing there).
    assert.equal(screen.calls.toasts.length, 2);
    for (const [message] of screen.calls.toasts) assert.match(message, /phone app/);
    assert.equal(screen.calls.alerts.length, 0);
    // Nothing tried to make the picture, and the editor didn't move on with a broken one.
    assert.equal(captures.length, 0);
    assert.equal(routes.length, 0);
  } finally { await unmount(tree); }
});

test('on phones, Send to still makes the picture and opens the Send to list as before', async () => {
  const { screen, captures, routes } = loadEditor('ios');
  const tree = await renderScreen(screen);
  try {
    await act(() => sendTo(tree).props.onPress());
    assert.equal(captures.length, 1);
    assert.equal(JSON.stringify(routes), JSON.stringify([[{ pathname: '/share', params: { uri: 'file:///qa-finished.jpg' } }]]));
    assert.equal(screen.calls.toasts.length, 0);
  } finally { await unmount(tree); }
});
