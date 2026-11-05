const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScreen, renderScreen, act, unmount } = require('./harness.cjs');

test('a close-friend privacy change cannot be overtaken by a second rapid change', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const updates = [];
  let stored = false;
  const screen = loadScreen('src/app/(app)/close-friends.tsx', {
    '@/lib/friends': { fetchFriends: async () => [{ id: 'bob', username: 'bob', display_name: 'Bob' }] },
    '@/lib/closeFriends': { fetchCloseFriendIds: async () => new Set(), setCloseFriend: async (...args) => { updates.push(args); if (updates.length === 1) await pending; stored = args[2]; } },
    '@/lib/invite': { inviteFriends() {} },
  });
  const tree = await renderScreen(screen);
  try {
    let first;
    await act(async () => { first = tree.root.findByType('Pressable').props.onPress(); await Promise.resolve(); });
    const row = tree.root.findByType('Pressable');
    let second;
    await act(async () => { second = row.props.onPress(); await Promise.resolve(); });
    release();
    await act(() => Promise.all([first, second]));
    assert.equal(stored, tree.root.findByType('Pressable').props.accessibilityState.checked,
      'the screen must never say a person is excluded when the server still lets them see close-friend photos');
  } finally { release(); await unmount(tree); }
});

test('a rejected close-friend change restores the previous private list', async () => {
  const screen = loadScreen('src/app/(app)/close-friends.tsx', {
    '@/lib/friends': { fetchFriends: async () => [{ id: 'bob', username: 'bob', display_name: 'Bob' }] },
    '@/lib/closeFriends': { fetchCloseFriendIds: async () => new Set(['bob']), setCloseFriend: async () => { throw new Error('Simulated database outage'); } },
    '@/lib/invite': { inviteFriends() {} },
  });
  const tree = await renderScreen(screen);
  try {
    await act(() => tree.root.findByType('Pressable').props.onPress());
    assert.equal(tree.root.findByType('Pressable').props.accessibilityState.checked, true);
    assert.equal(screen.calls.alerts[0][0], 'Could not update');
  } finally { await unmount(tree); }
});
