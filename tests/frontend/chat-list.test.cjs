const test = require('node:test');
const assert = require('node:assert/strict');
const { React, loadScreen, renderScreen, act, unmount, host } = require('./harness.cjs');

test('an old native Clear chat confirmation cannot clear the next account’s chat', async () => {
  let cleared = 0;
  const menus = [], noop = () => {};
  const screen = loadScreen('src/components/home/ChatPage.tsx', {
    '@/components/FriendButton': { FriendButton: host('FriendButton') }, '@/components/GroupFaces': { GroupFaces: host('GroupFaces') }, '@/components/PersonRow': { PersonRow: host('PersonRow') },
    '@/components/Overlays': { useOverlays: () => ({ showOptions: menu => menus.push(menu), showToast: noop }) },
    '@/lib/chat': { fetchRecentMessages: async () => [], subscribeToMyMessages: () => noop, clearChat: async () => { cleared++; } },
    '@/lib/friends': { fetchFriends: async () => [{ id: 'bob', username: 'bob', display_name: 'Bob' }] },
    '@/lib/closeFriends': { fetchCloseFriendIds: async () => new Set() },
    '@/lib/friendSettings': { fetchFriendSettings: async () => new Map() },
    '@/lib/groupChat': { fetchGroupChats: async () => new Map(), subscribeToGroupChat: () => noop },
    '@/lib/groups': { fetchGroups: async () => [] },
    '@/lib/invite': { inviteFriends: noop }, '@/lib/time': { timeAgo: () => 'now' },
    '@/lib/useSafetyActions': { useSafetyActions: () => ({ confirmBlock: noop }) },
    './HomeTabBar': { useTabBarSpace: () => 60 }, './PageHeader': { PageHeader: host('PageHeader') },
  });
  screen.Component = () => React.createElement(screen.exports.ChatPage, { visible: true, inboxCount: 0, onRefreshInbox: noop });
  const tree = await renderScreen(screen);
  await act(() => tree.root.findAllByType('Pressable').find(node => node.props.onLongPress).props.onLongPress());
  await act(() => menus[0].options.find(item => item.label.includes('Clear chat')).onPress());
  const confirmed = screen.calls.alerts[0][2].find(item => item.text === 'Clear').onPress;
  await unmount(tree); await act(() => confirmed());
  assert.equal(cleared, 0);
});

// ---------------------------------------------------------------------------
// Pinned chats (Peekaboo+): the real src/lib/chatPins.ts, with a pretend file on the phone.
// ---------------------------------------------------------------------------
const { textOf } = require('./harness.cjs');

function pinsSetup({ plus, file = null }) {
  const disk = { text: file };
  class FakeFile {
    get exists() { return disk.text !== null; }
    textSync() { return disk.text; }
    create() { disk.text = ''; }
    async write(text) { disk.text = text; }
  }
  const pinsModule = loadScreen('src/lib/chatPins.ts', {
    'expo-file-system': { File: FakeFile, Paths: { document: 'documents' } },
    './auth': { useMe: () => ({ userId: 'alice' }) },
    './plus': { usePlus: () => plus },
  });
  const menus = [], noop = () => {};
  const screen = loadScreen('src/components/home/ChatPage.tsx', {
    '@/components/FriendButton': { FriendButton: host('FriendButton') }, '@/components/GroupFaces': { GroupFaces: host('GroupFaces') }, '@/components/PersonRow': { PersonRow: host('PersonRow') },
    '@/components/Overlays': { useOverlays: () => ({ showOptions: menu => menus.push(menu), showToast: (...args) => screen.calls.toasts.push(args) }) },
    '@/lib/chat': { fetchRecentMessages: async () => [], subscribeToMyMessages: () => noop, clearChat: async () => {} },
    '@/lib/friends': { fetchFriends: async () => ['bob', 'carol', 'dave', 'erin'].map(id => ({ id, username: id, display_name: id.toUpperCase() })) },
    '@/lib/closeFriends': { fetchCloseFriendIds: async () => new Set() },
    '@/lib/friendSettings': { fetchFriendSettings: async () => new Map() },
    '@/lib/groupChat': { fetchGroupChats: async () => new Map(), subscribeToGroupChat: () => noop },
    '@/lib/groups': { fetchGroups: async () => [{ id: 'g1', name: 'Gang', members: [] }, { id: 'g2', name: 'Crew', members: [] }], counting: g => g.members, stillToPost: () => [] },
    '@/lib/chatPins': pinsModule.exports,
    '@/lib/invite': { inviteFriends: noop }, '@/lib/time': { timeAgo: () => 'now' },
    '@/lib/useSafetyActions': { useSafetyActions: () => ({ confirmBlock: noop }) },
    './HomeTabBar': { useTabBarSpace: () => 60 }, './PageHeader': { PageHeader: host('PageHeader') },
  });
  screen.Component = () => React.createElement(screen.exports.ChatPage, { visible: true, inboxCount: 0, onRefreshInbox: noop });
  return { screen, menus, disk };
}
// The rows you can hold down, top to bottom, by name (groups first, then friends).
const holdable = tree => tree.root.findAllByType('Pressable').filter(node => node.props.onLongPress);
// A pinned row has a small 📌 by its name; it's written here as "NAME 📌".
const rowNames = tree => holdable(tree).map(node => {
  const name = textOf(node.findAllByType('Text')[0]).replace(' 📌', '');
  const pinned = node.findAllByType('Text').some(text => textOf(text).trim() === '📌');
  return pinned ? `${name} 📌` : name;
});
async function choose(tree, menus, rowName, label) {
  const row = holdable(tree).find(node => textOf(node.findAllByType('Text')[0]).startsWith(rowName));
  await act(() => row.props.onLongPress());
  const item = menus.at(-1).options.find(option => option.label === label);
  assert.ok(item, `${rowName} menu has ${label}`);
  await act(() => item.onPress());
}

test('without Peekaboo+, Pin to top opens the Peekaboo+ page and pins nothing', async () => {
  const { screen, menus, disk } = pinsSetup({ plus: false });
  const tree = await renderScreen(screen);
  await choose(tree, menus, 'CAROL', '📌 Pin to top');
  await choose(tree, menus, 'Gang', '📌 Pin to top');
  assert.deepEqual(screen.calls.routes, [['push', '/plus'], ['push', '/plus']]);
  assert.equal(disk.text, null);
  assert.deepEqual(rowNames(tree), ['Gang', 'Crew', 'BOB', 'CAROL', 'DAVE', 'ERIN']);
  await unmount(tree);
});

test('Peekaboo+ pins up to 3 chats, shown first in pin order with a 📌, and saved for this account only', async () => {
  const { screen, menus, disk } = pinsSetup({ plus: true, file: JSON.stringify({ someone: ['friend:erin'] }) });
  const tree = await renderScreen(screen);
  assert.deepEqual(rowNames(tree), ['Gang', 'Crew', 'BOB', 'CAROL', 'DAVE', 'ERIN']);
  await choose(tree, menus, 'DAVE', '📌 Pin to top');
  await choose(tree, menus, 'Crew', '📌 Pin to top');
  await choose(tree, menus, 'CAROL', '📌 Pin to top');
  assert.deepEqual(rowNames(tree), ['Crew 📌', 'Gang', 'DAVE 📌', 'CAROL 📌', 'BOB', 'ERIN']);
  // A 4th pin is refused kindly.
  await choose(tree, menus, 'BOB', '📌 Pin to top');
  assert.match(screen.calls.toasts.at(-1)[0], /up to 3 chats/);
  assert.deepEqual(JSON.parse(disk.text), { someone: ['friend:erin'], alice: ['friend:dave', 'group:g2', 'friend:carol'] });
  // Unpinning frees a place.
  await choose(tree, menus, 'DAVE', '📌 Unpin');
  await choose(tree, menus, 'BOB', '📌 Pin to top');
  assert.deepEqual(rowNames(tree), ['Crew 📌', 'Gang', 'CAROL 📌', 'BOB 📌', 'DAVE', 'ERIN']);
  assert.deepEqual(JSON.parse(disk.text).alice, ['group:g2', 'friend:carol', 'friend:bob']);
  assert.deepEqual(screen.calls.routes, []);
  await unmount(tree);
});

test('a pinned chat that is gone does not use up a place', async () => {
  const { screen, menus, disk } = pinsSetup({ plus: true, file: JSON.stringify({ alice: ['friend:gone', 'group:old', 'friend:bob'] }) });
  const tree = await renderScreen(screen);
  await choose(tree, menus, 'DAVE', '📌 Pin to top');
  assert.deepEqual(JSON.parse(disk.text).alice, ['friend:bob', 'friend:dave']);
  assert.deepEqual(rowNames(tree), ['Gang', 'Crew', 'BOB 📌', 'DAVE 📌', 'CAROL', 'ERIN']);
  await unmount(tree);
});

test('a vote on a group dare proof (a message UPDATE) does not reload the Chat list; a new message does', async () => {
  let loads = 0, onChange = null;
  const noop = () => {};
  const screen = loadScreen('src/components/home/ChatPage.tsx', {
    '@/components/FriendButton': { FriendButton: host('FriendButton') }, '@/components/GroupFaces': { GroupFaces: host('GroupFaces') }, '@/components/PersonRow': { PersonRow: host('PersonRow') },
    '@/components/Overlays': { useOverlays: () => ({ showOptions: noop, showToast: noop }) },
    '@/lib/chat': { fetchRecentMessages: async () => [], subscribeToMyMessages: () => noop, clearChat: async () => {} },
    '@/lib/friends': { fetchFriends: async () => [] },
    '@/lib/closeFriends': { fetchCloseFriendIds: async () => new Set() },
    '@/lib/friendSettings': { fetchFriendSettings: async () => new Map() },
    '@/lib/groupChat': { fetchGroupChats: async () => { loads++; return new Map(); }, subscribeToGroupChat: (_group, listener) => { onChange = listener; return noop; } },
    '@/lib/groups': { fetchGroups: async () => [] },
    '@/lib/invite': { inviteFriends: noop }, '@/lib/time': { timeAgo: () => 'now' },
    '@/lib/useSafetyActions': { useSafetyActions: () => ({ confirmBlock: noop }) },
    './HomeTabBar': { useTabBarSpace: () => 60 }, './PageHeader': { PageHeader: host('PageHeader') },
  });
  screen.Component = () => React.createElement(screen.exports.ChatPage, { visible: true, inboxCount: 0, onRefreshInbox: noop });
  const tree = await renderScreen(screen);
  try {
    const before = loads;
    await act(() => onChange({ event: 'UPDATE', message: { id: 'p1', proof_legit: 1, proof_cap: 0 } }));
    assert.equal(loads, before);
    await act(() => onChange({ event: 'INSERT', message: { id: 'm2' } }));
    assert.equal(loads, before + 1);
  } finally { await unmount(tree); }
});
