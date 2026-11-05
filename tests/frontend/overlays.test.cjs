const test = require('node:test');
const assert = require('node:assert/strict');
const { React, loadScreen, renderScreen, act, unmount, host, textOf } = require('./harness.cjs');

test('a delayed menu action cannot run after its account overlay is unmounted', async () => {
  let actions = 0;
  const screen = loadScreen('src/components/Overlays.tsx', {
    'react-native-reanimated': { __esModule: true, default: { View: host('AnimatedView') }, FadeInUp: {}, FadeOutUp: {} },
    '@/components/SafeEdge': { SafeEdge: host('SafeEdge') },
  });
  function Trigger() { const { showOptions } = screen.exports.useOverlays(); return React.createElement('Trigger', { onPress: () => showOptions({ options: [{ label: 'Run action', onPress: () => { actions++; } }] }) }); }
  screen.Component = () => React.createElement(screen.exports.OverlayProvider, null, React.createElement(Trigger));
  const tree = await renderScreen(screen);
  await act(() => tree.root.findByType('Trigger').props.onPress());
  await act(() => tree.root.findAllByType('Pressable').find(node => textOf(node) === 'Run action').props.onPress());
  assert.equal(actions, 0);
  await unmount(tree);
  for (const timer of screen.calls.timers) await act(() => timer());
  assert.equal(actions, 0, 'queued actions must be discarded when their account is left');
});
