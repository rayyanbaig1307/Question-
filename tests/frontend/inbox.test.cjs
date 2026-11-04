const test = require('node:test');
const assert = require('node:assert/strict');
const { React, loadScreen, renderScreen, act, button, unmount, host, textOf } = require('./harness.cjs');

function fixture({ respond } = {}) {
  const calls = { routes: [], clear: 0, seen: 0, reload: 0, replies: [], channels: [], removed: 0 };
  const noop = () => {};
  const reload = () => { calls.reload++; };
  const activity = { items: [{ kind: 'like', actor_id: 'bob', actor_name: 'Bob', post_id: 'post1', at: '2026-11-04T12:00:00Z' }], seenAt: '1970-01-01', markSeen: () => { calls.seen++; }, clear: () => { calls.clear++; }, reload };
  const screen = loadScreen('src/app/(app)/inbox.tsx', {
    'expo-router': { router: { push: route => calls.routes.push(route) }, useFocusEffect: callback => React.useEffect(callback, [callback]) },
    '@/components/FriendButton': { FriendButton: host('FriendButton') }, '@/components/PersonRow': { PersonRow: host('PersonRow') },
    '@/components/Overlays': { useOverlays: () => ({ showToast: noop, showOptions: noop }) },
    '@/lib/activity': { useActivity: () => activity, describeActivity: () => 'liked your post ❤️' },
    '@/lib/friends': { fetchIncomingRequests: async () => [], relationFrom: () => ({ kind: 'received' }) },
    '@/lib/hitups': { useHitUps: () => ({ hitUps: [], reload }), respondToHitUp: async (...args) => { calls.replies.push(args); if (respond) await respond(...args); } },
    '@/lib/notifications': { clearDeliveredNotifications: noop },
    '@/lib/supabase': { supabase: { channel: name => { const channel = { name, callbacks: [], on(_kind, _filter, callback) { this.callbacks.push(callback); return this; }, subscribe() { return this; } }; calls.channels.push(channel); return channel; }, removeChannel: () => { calls.removed++; } } },
    '@/lib/time': { timeAgo: () => 'now' },
    '@/lib/useSafetyActions': { useSafetyActions: () => ({ report: noop, confirmBlock: noop }) },
  });
  return { screen, calls };
}

test('Inbox opens activity posts, clears activity, and marks it seen on leaving', async () => {
  const { screen, calls } = fixture();
  const tree = await renderScreen(screen);
  await act(() => tree.root.findAllByType('Pressable').find(node => node.props.accessibilityRole === 'button' && textOf(node).includes('Bob')).props.onPress());
  assert.deepEqual(calls.routes, ['/post/post1']);
  await act(() => tree.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel === 'Clear activity').props.onPress());
  assert.equal(calls.clear, 1);
  await unmount(tree);
  assert.equal(calls.seen, 1);
  assert.equal(calls.removed, 1);
});

test('two Inbox listeners use different realtime channel names', async () => {
  const { screen, calls } = fixture();
  const first = await renderScreen(screen);
  const second = await renderScreen(screen);
  try {
    assert.equal(calls.channels.length, 2);
    assert.notEqual(calls.channels[0].name, calls.channels[1].name);
  } finally { await unmount(first); await unmount(second); }
});

test('a live Inbox event refreshes activity, hit ups, and requests', async () => {
  const { screen, calls } = fixture();
  const tree = await renderScreen(screen);
  try {
    await act(() => calls.channels[0].callbacks[0]());
    await act(() => screen.calls.timers.shift()());
    assert.equal(calls.reload, 2);
  } finally { await unmount(tree); }
});

test('rapid Hit back and Ignore presses cannot submit contradictory responses', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { screen, calls } = fixture({ respond: () => pending });
  const Row = screen.getBinding('HitUpRow');
  screen.Component = () => React.createElement(Row, { hitUp: { id: 'hit1', sender: { id: 'bob', username: 'bob', display_name: 'Bob' }, created_at: '2026-11-04' }, onDone() {} });
  const tree = await renderScreen(screen);
  try {
    const accept = button(tree, 'Hit back').props.onPress;
    const ignore = button(tree, 'Ignore').props.onPress;
    let a, b;
    await act(async () => { a = accept(); b = ignore(); await Promise.resolve(); });
    release(); await act(() => Promise.all([a, b]));
    assert.equal(calls.replies.length, 1);
    assert.deepEqual(calls.replies[0], ['hit1', true]);
  } finally { release(); await unmount(tree); }
});
