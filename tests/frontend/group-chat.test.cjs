const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScreen, renderScreen, act, button, unmount, host } = require('./harness.cjs');

const message = (changes = {}) => ({ id: 'message1', group_id: 'squad', sender_id: 'bob', kind: 'text', body: 'Hello group 👋', media_path: null, poster_path: null, overlay_path: null, media_type: null, created_at: '2026-11-04T12:00:00Z', ...changes });
function fixture({ messages = [message()], send, search, missing = false } = {}) {
  const calls = { sent: [], reports: [], pinned: [], deleted: [], options: [], reacted: [], stopped: 0 };
  const group = { id: 'squad', name: 'Squad', pinned_message_id: null, members: ['alice', 'bob'].map(userId => ({ userId, profile: { id: userId, username: userId, display_name: userId } })) };
  const noop = () => {};
  const stop = () => { calls.stopped++; };
  const screen = loadScreen('src/app/(app)/groups/chat/[id].tsx', {
    'expo-router': { router: { push() {} }, useFocusEffect: callback => require('./harness.cjs').React.useEffect(callback, [callback]), useLocalSearchParams: () => ({ id: 'squad' }) },
    'expo-image-picker': { launchImageLibraryAsync: async () => ({ canceled: true }) },
    'expo-image': { Image: host('ExpoImage') },
    '@/components/ScreenHeader': { ScreenHeader: host('ScreenHeader'), RoundIconButton: host('RoundIconButton') },
    '@/components/IconButton': { IconButton: host('IconButton') },
    '@/components/GroupFaces': { GroupFaces: host('GroupFaces') },
    '@/components/DareComposer': { DareComposer: host('DareComposer') },
    '@/components/MessageActions': Object.fromEntries(['MessageActions', 'ReactionChips', 'ReplyQuote'].map(name => [name, host(name)])),
    '@/components/VoiceNote': { MicButton: host('MicButton'), VoiceBubble: host('VoiceBubble') },
    '@/components/SafeEdge': { SafeEdge: host('SafeEdge') },
    '@/components/ZoomableImage': { ZoomableImage: host('ZoomableImage') },
    '@/components/Overlays': { useOverlays: () => ({ showToast: noop, showOptions: value => calls.options.push(value) }) },
    '@/lib/groupChat': {
      fetchGroupMessages: async () => messages, fetchGroupReads: async () => new Map(), fetchGroupChats: async () => new Map(), markGroupChatRead: async () => {},
      subscribeToGroupChat: () => stop, subscribeToGroup: () => stop,
      sendGroupMessage: async (...args) => { calls.sent.push(args); if (send) await send(...args); return message({ id: 'sent', sender_id: 'alice', body: args[1] }); },
      deleteGroupMessage: async value => { calls.deleted.push(value.id); },
      pinGroupMessage: async (...args) => { calls.pinned.push(args); }, searchGroupMessages: async (_group, query) => search ? search(query) : [],
    },
    '@/lib/groups': { fetchGroup: async () => missing ? null : group },
    '@/lib/media': { useMediaUrls: paths => Object.fromEntries(paths.map(path => [path, `file:///qa/${path}`])) },
    '@/lib/reactions': { fetchReactions: async () => new Map(), subscribeToReactions: () => stop, toggleReaction: async (...args) => calls.reacted.push(args) },
    '@/lib/time': { timeAgo: () => 'now' },
    '@/lib/typing': { useGroupTyping: () => ({ typing: [], onTextChange: noop, clearTyping: noop }) },
    '@/lib/useSafetyActions': { useSafetyActions: () => ({ report: value => calls.reports.push(value) }) },
    '@/lib/voice': { Audio: null },
  });
  return { screen, calls };
}
function messageMenu(tree) { return tree.root.findAllByType('Pressable').find(node => node.props.onLongPress).props.onLongPress(); }
function sendButton(tree) { return tree.root.findAllByType('IconButton').find(node => node.props.label === 'Send'); }

test('a group video can be opened and played with its sound', async () => {
  const { screen } = fixture({ messages: [message({ kind: 'video', media_type: 'video', media_path: 'bob/group/video.mp4' })] });
  const tree = await renderScreen(screen);
  try {
    const media = tree.root.findAllByType('Pressable').find(node => node.props.onLongPress);
    assert.equal(typeof media.props.onPress, 'function', 'a paused video needs a playback action');
    await act(() => media.props.onPress());
    assert.ok(tree.root.findAllByType('VideoClip').some(node => node.props.playing && node.props.muted === false));
    await act(() => button(tree, 'Close media').props.onPress());
    assert.equal(tree.root.findAllByType('VideoClip').filter(node => node.props.playing).length, 0);
  } finally { await unmount(tree); }
});

test('reporting a group message preserves the offending message ID', async () => {
  const { screen, calls } = fixture();
  const tree = await renderScreen(screen);
  try {
    await act(() => messageMenu(tree));
    await act(() => tree.root.findByType('MessageActions').props.actions.find(action => action.label === 'Report').onPress());
    assert.equal(calls.reports[0].contentType, 'group_message');
    assert.equal(calls.reports[0].contentId, 'message1');
    assert.equal(calls.reports[0].user.id, 'bob');
  } finally { await unmount(tree); }
});

test('rapid group Send presses create only one message', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { screen, calls } = fixture({ send: () => pending });
  const tree = await renderScreen(screen);
  try {
    await act(() => tree.root.findByType('TextInput').props.onChangeText('hello'));
    const press = sendButton(tree).props.onPress;
    let a, b;
    await act(async () => { a = press(); b = press(); await Promise.resolve(); });
    release();
    await act(() => Promise.all([a, b]));
    assert.equal(calls.sent.length, 1);
  } finally { release(); await unmount(tree); }
});

test('the next draft survives while a group message is being sent', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { screen } = fixture({ send: () => pending });
  const tree = await renderScreen(screen);
  try {
    await act(() => tree.root.findByType('TextInput').props.onChangeText('first message'));
    let sending;
    await act(async () => { sending = sendButton(tree).props.onPress(); await Promise.resolve(); });
    await act(() => tree.root.findByType('TextInput').props.onChangeText('my next message'));
    release();
    await act(() => sending);
    assert.equal(tree.root.findByType('TextInput').props.value, 'my next message');
  } finally { release(); await unmount(tree); }
});

test('group reply attaches the selected message ID', async () => {
  const { screen, calls } = fixture();
  const tree = await renderScreen(screen);
  try {
    await act(() => messageMenu(tree));
    await act(() => tree.root.findByType('MessageActions').props.actions.find(action => action.label === '↩ Reply').onPress());
    await act(() => tree.root.findByType('TextInput').props.onChangeText('reply 👋'));
    await act(() => sendButton(tree).props.onPress());
    assert.deepEqual(calls.sent[0], ['squad', 'reply 👋', 'message1']);
  } finally { await unmount(tree); }
});

test('group pin and own-message delete point to the selected message', async () => {
  const { screen, calls } = fixture({ messages: [message({ sender_id: 'alice' })] });
  const tree = await renderScreen(screen);
  try {
    await act(() => messageMenu(tree));
    await act(() => tree.root.findByType('MessageActions').props.actions.find(action => action.label === '📌 Pin to the top').onPress());
    assert.deepEqual(calls.pinned[0], ['squad', 'message1']);
    await act(() => tree.root.findByType('MessageActions').props.actions.find(action => action.label === 'Delete for everyone').onPress());
    assert.deepEqual(calls.deleted, ['message1']);
  } finally { await unmount(tree); }
});

test('a removed group hides the composer and every message', async () => {
  const { screen } = fixture({ missing: true });
  const tree = await renderScreen(screen);
  try {
    assert.equal(tree.root.findAllByType('TextInput').length, 0);
    assert.equal(tree.root.findByType('EmptyState').props.title, 'This group is gone');
  } finally { await unmount(tree); }
});

test('leaving a group chat removes every subscription and polling timer', async () => {
  const { screen, calls } = fixture();
  const tree = await renderScreen(screen);
  assert.equal(screen.calls.intervals.size, 1);
  await unmount(tree);
  assert.equal(screen.calls.intervals.size, 0);
  assert.equal(calls.stopped, 3);
});

test('an older group search response cannot erase newer matching results', async () => {
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const { screen, calls } = fixture({ search: query => query === 'old' ? delayed : [message({ id: 'fresh', body: 'fresh match' })] });
  const tree = await renderScreen(screen);
  try {
    await act(() => tree.root.findByType('ScreenHeader').props.right.props.onPress());
    await act(() => calls.options[0].options.find(item => item.label.includes('Search')).onPress());
    const input = () => tree.root.findAllByType('TextInput').find(node => node.props.placeholder === 'Search this chat');
    let old;
    await act(async () => { old = input().props.onChangeText('old'); await Promise.resolve(); });
    await act(() => input().props.onChangeText('fresh'));
    release([message({ id: 'old', body: 'old match' })]);
    await act(() => old);
    assert.equal(tree.root.findByType('FlatList').props.data[0]?.body, 'fresh match');
  } finally { release([]); await unmount(tree); }
});
