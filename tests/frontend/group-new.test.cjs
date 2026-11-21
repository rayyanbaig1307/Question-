const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScreen, renderScreen, act, button, unmount } = require('./harness.cjs');

// Making a group (src/app/(app)/groups/new.tsx): the new group's CHAT opens straight away (the owner, 21 Nov:
// it used to open the Group Peek drops screen, "a weird screen"). `replace` takes the form away, so Back goes to
// where you started. Editing a group still goes back to where you were.
function fixture({ params = {}, create } = {}) {
  const calls = { routes: [], created: [], renamed: [], added: [] };
  const screen = loadScreen('src/app/(app)/groups/new.tsx', {
    'expo-router': {
      router: Object.fromEntries(['back', 'push', 'replace', 'dismissTo'].map(name => [name, (...args) => calls.routes.push([name, ...args])])),
      useLocalSearchParams: () => params,
    },
    '@/lib/friends': { fetchFriends: async () => [{ id: 'bob', username: 'bob', display_name: 'Bob', avatar_path: null }] },
    '@/lib/invite': { inviteFriends() {} },
    '@/lib/groups': {
      createGroup: async (...args) => { calls.created.push(args); if (create) return create(...args); return 'g1'; },
      addToGroup: async (...args) => { calls.added.push(args); },
      renameGroup: async (...args) => { calls.renamed.push(args); },
      fetchGroup: async () => ({ id: 'squad', name: 'Squad', members: [{ userId: 'alice' }] }),
    },
  });
  return { screen, calls };
}
const pickBob = tree => tree.root.findAllByType('Pressable').find(node => node.props.accessibilityRole === 'checkbox').props.onPress();

test('making a group opens its group chat (never the drops screen), and the form is replaced', async () => {
  const { screen, calls } = fixture();
  const tree = await renderScreen(screen);
  try {
    await act(() => tree.root.findByType('TextField').props.onChangeText('Squad'));
    await act(() => pickBob(tree));
    await act(() => button(tree, /Make group with 1 friend/).props.onPress());
    assert.deepEqual(JSON.parse(JSON.stringify(calls.created)), [['Squad', ['bob']]]);
    assert.deepEqual(calls.routes, [['replace', '/groups/chat/g1']]);
  } finally { await unmount(tree); }
});

test('editing a group still goes back to where you were (no new chat opened)', async () => {
  const { screen, calls } = fixture({ params: { group: 'squad' } });
  const tree = await renderScreen(screen);
  try {
    await act(() => tree.root.findByType('TextField').props.onChangeText('Squad 2'));
    await act(() => button(tree, 'Save').props.onPress());
    assert.deepEqual(calls.renamed, [['squad', 'Squad 2']]);
    assert.deepEqual(calls.routes, [['back']]);
    assert.equal(calls.created.length, 0);
  } finally { await unmount(tree); }
});

test('a group that could not be made says why, goes nowhere, and Make group works again', async () => {
  let fail = true;
  const { screen, calls } = fixture({ create: async () => { if (fail) throw new Error('Simulated failure'); return 'g2'; } });
  const tree = await renderScreen(screen);
  try {
    await act(() => tree.root.findByType('TextField').props.onChangeText('Squad'));
    await act(() => pickBob(tree));
    await act(() => button(tree, /Make group with 1 friend/).props.onPress());
    assert.deepEqual(screen.calls.alerts.at(-1), ['Could not make the group', 'Simulated failure']);
    assert.deepEqual(calls.routes, []);
    fail = false;
    await act(() => button(tree, /Make group with 1 friend/).props.onPress());
    assert.deepEqual(calls.routes, [['replace', '/groups/chat/g2']]);
  } finally { await unmount(tree); }
});
