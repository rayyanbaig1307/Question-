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

test('each friend\'s picture in the Chat list is a story picture: tap = their story (or the chat), hold = the menu; rings are checked when Chat opens', async () => {
  const menus = [], refreshed = [], noop = () => {};
  const screen = loadScreen('src/components/home/ChatPage.tsx', {
    '@/components/FriendButton': { FriendButton: host('FriendButton') }, '@/components/GroupFaces': { GroupFaces: host('GroupFaces') }, '@/components/PersonRow': { PersonRow: host('PersonRow') },
    '@/components/Overlays': { useOverlays: () => ({ showOptions: menu => menus.push(menu), showToast: noop }) },
    '@/lib/chat': { fetchRecentMessages: async () => [], subscribeToMyMessages: () => noop, clearChat: async () => {} },
    '@/lib/friends': { fetchFriends: async () => [{ id: 'bob', username: 'bob', display_name: 'Bob', avatar_path: 'bob/a.jpg' }] },
    '@/lib/closeFriends': { fetchCloseFriendIds: async () => new Set() },
    '@/lib/friendSettings': { fetchFriendSettings: async () => new Map() },
    '@/lib/groupChat': { fetchGroupChats: async () => new Map(), subscribeToGroupChat: () => noop },
    '@/lib/groups': { fetchGroups: async () => [] },
    '@/lib/invite': { inviteFriends: noop }, '@/lib/time': { timeAgo: () => 'now' },
    '@/lib/useSafetyActions': { useSafetyActions: () => ({ confirmBlock: noop }) },
    '@/lib/storyRings': { refreshStoryBadges: async (...args) => { refreshed.push(args); } },
    './HomeTabBar': { useTabBarSpace: () => 60 }, './PageHeader': { PageHeader: host('PageHeader') },
  });
  screen.Component = () => React.createElement(screen.exports.ChatPage, { visible: true, inboxCount: 0, onRefreshInbox: noop });
  const tree = await renderScreen(screen);
  try {
    assert.deepEqual(refreshed, [['alice']]);
    const [picture] = tree.root.findAllByType('StoryAvatar');
    assert.equal(picture.props.person.id, 'bob');
    assert.equal(picture.props.size, 52);
    // No story: tapping the picture opens the chat, like the rest of the row (StoryAvatar opens the story itself).
    await act(() => picture.props.onPress());
    assert.deepEqual(screen.calls.routes.at(-1), ['push', '/chat/bob']);
    await act(() => picture.props.onLongPress());
    assert.equal(menus.length, 1, 'holding the picture opens the same menu as holding the row');
  } finally { await unmount(tree); }
});
