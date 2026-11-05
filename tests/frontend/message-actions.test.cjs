const test = require('node:test');
const assert = require('node:assert/strict');
const { React, loadScreen, renderScreen, act, textOf, unmount, host } = require('./harness.cjs');

test('message actions wait for the native menu to close before opening another sheet', async () => {
  const events = [];
  const screen = loadScreen('src/components/MessageActions.tsx', {
    '@/components/SafeEdge': { SafeEdge: host('SafeEdge') }, '@/lib/reactions': { REACTIONS: ['❤️', '😂'] },
  });
  screen.Component = () => React.createElement(screen.exports.MessageActions, { visible: true, myReaction: null, onClose: () => events.push('closed'), onReact: () => {}, actions: [{ label: 'Report', onPress: () => events.push('report') }] });
  const tree = await renderScreen(screen);
  try {
    await act(() => tree.root.findAllByType('Pressable').find(node => node.props.accessibilityRole === 'button' && textOf(node) === 'Report').props.onPress());
    assert.deepEqual(events, ['closed'], 'iOS cannot open the report sheet while the old native modal is closing');
    await act(() => tree.root.findByType('Modal').props.onDismiss());
    assert.deepEqual(events, ['closed', 'report']);
    for (const timer of screen.calls.timers) await act(() => timer());
    assert.deepEqual(events, ['closed', 'report'], 'native dismissal and the fallback timer must not run the action twice');
  } finally { await unmount(tree); }
});

test('reaction chips combine equal emoji and pass the tapped emoji back', async () => {
  const chosen = [];
  const screen = loadScreen('src/components/MessageActions.tsx', { '@/components/SafeEdge': { SafeEdge: host('SafeEdge') }, '@/lib/reactions': { REACTIONS: ['❤️', '😂'] } });
  screen.Component = () => React.createElement(screen.exports.ReactionChips, { reactions: [{ user_id: 'alice', emoji: '😂' }, { user_id: 'bob', emoji: '😂' }, { user_id: 'carol', emoji: '❤️' }], me: 'alice', onToggle: emoji => chosen.push(emoji) });
  const tree = await renderScreen(screen);
  try {
    const chips = tree.root.findAllByType('Pressable');
    assert.equal(chips.length, 2);
    assert.equal(chips[0].props.accessibilityLabel, '😂 2');
    await act(() => chips[0].props.onPress());
    assert.deepEqual(chosen, ['😂']);
  } finally { await unmount(tree); }
});
