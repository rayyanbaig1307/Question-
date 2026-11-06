const test = require('node:test');
const assert = require('node:assert/strict');
const { React, loadScreen, act, textOf, host, unmount, renderer } = require('./harness.cjs');

// The editor's full-screen text tool, with its looks, gestures and animations faked.
function loadComposer() {
  return loadScreen('src/components/editor/TextComposer.tsx', {
    '@expo/vector-icons/MaterialCommunityIcons': host('MaterialCommunityIcons'),
    'expo-linear-gradient': { LinearGradient: host('LinearGradient') },
    'react-native-gesture-handler': { GestureDetector: host('GestureDetector'), usePanGesture: () => ({}) },
    'react-native-reanimated': {
      __esModule: true,
      default: { View: host('AnimatedView') },
      useSharedValue: initial => React.useRef({ get: () => initial, set() {} }).current,
      useAnimatedStyle: callback => callback(),
    },
    'react-native-worklets': { scheduleOnRN: callback => callback() },
    '@/components/SafeEdge': { SafeScreen: host('SafeScreen') },
    '@/theme': { colors: {}, keyboardAppearance: 'dark' },
    './stickers': { TEXT_COLORS: ['#FFFFFF'], BRAND_TEXT_COLORS: ['#FFD6EA'], textOn: () => '#000000' },
    './TextLook': {
      MIN_TEXT_SIZE: 16,
      MAX_TEXT_SIZE: 80,
      TEXT_FONTS: [{ id: 'bubbly', label: 'Bubbly', family: 'Bubbly', scale: 1, plus: false }],
      TEXT_EFFECTS: [{ id: 'none', label: 'None', plus: false }],
      TEXT_ANIMATIONS: [{ id: 'none', label: 'None', plus: false }],
      TEXT_BACKGROUNDS: ['none', 'pill'],
      resolveText: item => ({ font: null, effect: 'none', animation: 'none', align: 'center', background: 'none', size: 34, googly: false, ...item }),
      TextLook: host('TextLook'),
      useTextFonts: () => true,
    },
  });
}

test('the text tool has no "Coming soon" buttons, and "@ Tag a friend" still adds an @', async () => {
  const composer = loadComposer();
  let tree;
  await act(async () => {
    tree = renderer.create(React.createElement(composer.exports.TextComposer, {
      initial: { content: 'hi ', color: '#FFFFFF', look: 'shadow' },
      onDone() {},
      onCancel() {},
    }));
  });
  const text = textOf(tree.toJSON());
  for (const gone of ['Dare', 'Spot', 'Song', 'soon']) assert.doesNotMatch(text, new RegExp(gone), `no "${gone}" button`);

  const tag = tree.root.findAll(node => node.type === 'Pressable' && textOf(node) === '@ Tag a friend');
  assert.equal(tag.length, 1, 'the tag button is still there');
  await act(async () => { tag[0].props.onPress(); });
  assert.equal(tree.root.findByType('TextInput').props.value, 'hi @');
  assert.equal(composer.calls.toasts.length, 0, 'no "Coming soon" toast');
  await unmount(tree);
});
