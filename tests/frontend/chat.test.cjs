const test = require('node:test');
const assert = require('node:assert/strict');
const { React, loadScreen, renderScreen, act, unmount, host } = require('./harness.cjs');
const message = changes => ({ id: 'message1', sender_id: 'bob', recipient_id: 'alice', kind: 'text', body: 'Hello 👋', opened_at: null, saved_at: null, media_path: null, created_at: '2026-11-04T12:00:00Z', ...changes });

function fixture({ send, search, mine = false, plus = false } = {}) {
  const calls = { sent: [], hidden: [], deleted: [], reacted: [], options: [], stickers: [], pushed: [] };
  const noop = () => {};
  const screen = loadScreen('src/app/(app)/chat/[id].tsx', {
    'expo-router': { router: { push: to => calls.pushed.push(to) }, useFocusEffect: callback => React.useEffect(callback, [callback]), useIsFocused: () => true, useLocalSearchParams: () => ({ id: 'bob' }) },
    'expo-image': { Image: host('ExpoImage') },
    'react-native-reanimated': { default: { View: host('AnimatedView') } },
    '@/components/ScreenHeader': { ScreenHeader: host('ScreenHeader'), RoundIconButton: host('RoundIconButton') },
    '@/components/IconButton': { IconButton: host('IconButton') },
    '@/components/DareComposer': { DareComposer: host('DareComposer') },
    '@/components/MessageActions': Object.fromEntries(['MessageActions', 'ReactionChips', 'ReplyQuote'].map(name => [name, host(name)])),
    '@/components/VoiceNote': { MicButton: host('MicButton'), VoiceBubble: host('VoiceBubble') },
    '@/components/Overlays': { useOverlays: () => ({ showToast: noop, showOptions: value => calls.options.push(value) }) },
    '@/lib/chat': {
      fetchConversation: async () => [message(mine ? { sender_id: 'alice', recipient_id: 'bob' } : {})], fetchDareStreak: async () => 0, markChatRead: async () => {}, cleanUpOpenedSnaps() {}, subscribeToMyMessages: () => noop,
      sendText: async (...args) => { calls.sent.push(args); if (send) await send(...args); return message({ id: 'sent', sender_id: 'alice', body: args[2] }); },
      sendSticker: async (...args) => { calls.stickers.push(args); return message({ id: 'sticker1', sender_id: 'alice', kind: 'sticker', sticker: args[2], body: `Sticker: ${args[2]}` }); },
      hideMessage: async id => calls.hidden.push(id), deleteMessage: async value => calls.deleted.push(value.id),
      searchConversation: async (_me, _friend, query) => search ? search(query) : [],
    },
    '@/lib/media': { useMediaUrl: () => null },
    '@/lib/friends': { fetchRelation: async () => ({ kind: 'friends' }) },
    '@/lib/profiles': { fetchProfile: async () => ({ id: 'bob', username: 'bob', display_name: 'Bob' }) },
    '@/lib/screenshots': { useScreenshotNotice() {} },
    '@/lib/reactions': { fetchReactions: async () => new Map(), subscribeToReactions: () => noop, toggleReaction: async (...args) => calls.reacted.push(args) },
    '@/lib/time': { timeAgo: () => 'now' },
    '@/lib/typing': { useTyping: () => ({ friendTyping: false, onTextChange: noop, clearFriendTyping: noop }) },
    '@/lib/voice': { Audio: null },
    '@/lib/useSafetyActions': { useSafetyActions: () => ({ report() {} }) },
    '@/lib/plus': { usePlus: () => plus },
  });
  return { screen, calls };
}
const sendButton = tree => tree.root.findAllByType('IconButton').find(node => node.props.label === 'Send');
const openMenu = tree => tree.root.findAllByType('Pressable').find(node => node.props.onLongPress).props.onLongPress();

test('rapid direct-chat Send presses create only one message', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { screen, calls } = fixture({ send: () => pending });
  const tree = await renderScreen(screen);
  try {
    await act(() => tree.root.findByType('TextInput').props.onChangeText('hello'));
    const press = sendButton(tree).props.onPress;
    let a, b;
    await act(async () => { a = press(); b = press(); await Promise.resolve(); });
    release(); await act(() => Promise.all([a, b]));
    assert.equal(calls.sent.length, 1);
  } finally { release(); await unmount(tree); }
});

test('the next direct-chat draft survives a slow send', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { screen } = fixture({ send: () => pending });
  const tree = await renderScreen(screen);
  try {
    await act(() => tree.root.findByType('TextInput').props.onChangeText('first'));
    let sent;
    await act(async () => { sent = sendButton(tree).props.onPress(); await Promise.resolve(); });
    await act(() => tree.root.findByType('TextInput').props.onChangeText('next draft'));
    release(); await act(() => sent);
    assert.equal(tree.root.findByType('TextInput').props.value, 'next draft');
  } finally { release(); await unmount(tree); }
});

test('Delete for me hides exactly the chosen direct message', async () => {
  const { screen, calls } = fixture();
  const tree = await renderScreen(screen);
  try {
    await act(() => openMenu(tree));
    const actions = tree.root.findByType('MessageActions').props.actions;
    assert.equal(actions.some(action => action.label === 'Delete for everyone'), false);
    await act(() => actions.find(action => action.label === 'Delete for me').onPress());
    assert.deepEqual(calls.hidden, ['message1']);
  } finally { await unmount(tree); }
});

test('direct replies carry the selected parent message', async () => {
  const { screen, calls } = fixture();
  const tree = await renderScreen(screen);
  try {
    await act(() => openMenu(tree));
    await act(() => tree.root.findByType('MessageActions').props.actions.find(action => action.label === '↩ Reply').onPress());
    await act(() => tree.root.findByType('TextInput').props.onChangeText('reply 👋'));
    await act(() => sendButton(tree).props.onPress());
    assert.deepEqual(calls.sent[0], ['alice', 'bob', 'reply 👋', 'message1']);
  } finally { await unmount(tree); }
});

test('an older direct search cannot replace the newest results', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { screen, calls } = fixture({ search: query => query === 'old' ? pending : [message({ id: 'fresh', body: 'fresh match' })] });
  const tree = await renderScreen(screen);
  try {
    // Search lives in the ••• menu at the top.
    await act(() => tree.root.findByType('ScreenHeader').props.right.props.onPress());
    const searchOption = calls.options.at(-1).options.find(choice => /Search this chat/.test(choice.label));
    await act(() => searchOption.onPress());
    const input = () => tree.root.findAllByType('TextInput').find(node => node.props.placeholder === 'Search this chat');
    let old;
    await act(async () => { old = input().props.onChangeText('old'); await Promise.resolve(); });
    await act(() => input().props.onChangeText('fresh'));
    release([message({ id: 'old', body: 'old match' })]); await act(() => old);
    assert.equal(tree.root.findByType('FlatList').props.data[0]?.body, 'fresh match');
  } finally { release([]); await unmount(tree); }
});

test('a disabled icon button cannot run its action', async () => {
  let actions = 0;
  const screen = loadScreen('src/components/IconButton.tsx', { '@/components/Bouncy': { Bouncy: host('Bouncy') } });
  screen.Component = () => React.createElement(screen.exports.IconButton, { icon: 'send', label: 'Send', disabled: true, onPress: () => { actions++; } });
  const tree = await renderScreen(screen);
  try {
    await act(() => tree.root.findByType('Bouncy').props.onPress());
    assert.equal(actions, 0);
    assert.equal(tree.root.findByType('Bouncy').props.disabled, true);
  } finally { await unmount(tree); }
});

// 🏷️ Stickers in chat: free ones send, Peekaboo+ ones only with Peekaboo+ (otherwise the Peekaboo+ screen opens).
const stickerFlow = async ({ plus, pick }) => {
  const { screen, calls } = fixture({ plus });
  const tree = await renderScreen(screen);
  await act(async () => tree.root.findAllByType('IconButton').find(node => node.props.label === 'Send a sticker').props.onPress());
  const picker = tree.root.findByType('StickerPicker');
  assert.equal(picker.props.visible, true);
  await act(async () => pick(picker.props));
  const stickers = tree.root.findAllByType('ChatSticker').map(node => node.props.id);
  await unmount(tree);
  return { calls, stickers };
};

test('a free sticker is sent and shows up in the chat', async () => {
  const { calls, stickers } = await stickerFlow({ plus: false, pick: picker => picker.onPickSpecial('googly-eyes') });
  assert.deepEqual(calls.stickers.map(args => args.slice(1, 3)), [['bob', 'googly-eyes']]);
  assert.deepEqual(stickers, ['googly-eyes']);
  assert.deepEqual(calls.pushed, []);
});

test('word stickers are sent by their sticker name', async () => {
  const { calls } = await stickerFlow({ plus: false, pick: picker => picker.onPickWord('NO WAY') });
  assert.deepEqual(calls.stickers.map(args => args[2]), ['word-no-way']);
});

test('without Peekaboo+ a Plus sticker is not sent; the Peekaboo+ screen opens instead', async () => {
  const { calls } = await stickerFlow({ plus: false, pick: picker => picker.onPickSpecial('plus-slay') });
  assert.deepEqual(calls.stickers, []);
  assert.deepEqual(calls.pushed, ['/plus']);
});

test('with Peekaboo+ a Plus sticker is sent', async () => {
  const { calls, stickers } = await stickerFlow({ plus: true, pick: picker => picker.onPickSpecial('plus-slay') });
  assert.deepEqual(calls.stickers.map(args => args[2]), ['plus-slay']);
  assert.deepEqual(stickers, ['plus-slay']);
});

test('an emoji from the sticker picker goes as a normal message', async () => {
  const { calls } = await stickerFlow({ plus: false, pick: picker => picker.onPickEmoji('🔥') });
  assert.deepEqual(calls.sent.map(args => args[2]), ['🔥']);
  assert.deepEqual(calls.stickers, []);
});
