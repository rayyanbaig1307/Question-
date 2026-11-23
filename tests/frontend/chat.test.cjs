const test = require('node:test');
const assert = require('node:assert/strict');
const { React, loadScreen, renderScreen, act, unmount, host, outboxStore, textOf } = require('./harness.cjs');
// Values made inside the screen come from its own little world: compare them as plain data.
const plain = value => JSON.parse(JSON.stringify(value));
const message = changes => ({ id: 'message1', sender_id: 'bob', recipient_id: 'alice', kind: 'text', body: 'Hello 👋', opened_at: null, saved_at: null, media_path: null, created_at: '2026-11-04T12:00:00Z', ...changes });

// messages: what the chat loads (by default one text message from Bob, or from you with `mine`).
// Sends go through the outbox now (lib/outbox.ts): `calls.store` is a working stand-in, and `calls.sent` /
// `calls.stickers` list what was handed to it.
// cached: the chat's last list remembered from earlier (lib/chat.ts cachedConversation). load: what loading the chat
// returns (by default `messages`). calls.subscribed: what the screen listens to (subscribeToChat's arguments).
function fixture({ send, search, mine = false, plus = false, messages, react, cached = null, load } = {}) {
  const calls = { sent: [], hidden: [], deleted: [], reacted: [], options: [], stickers: [], pushed: [], toasts: [], loads: 0, subscribed: [], remembered: [] };
  const noop = () => {};
  const store = outboxStore();
  calls.store = store;
  const screen = loadScreen('src/app/(app)/chat/[id].tsx', {
    '@/lib/outbox': store,
    'expo-router': { router: { push: to => calls.pushed.push(to) }, useFocusEffect: callback => React.useEffect(callback, [callback]), useIsFocused: () => true, useLocalSearchParams: () => ({ id: 'bob' }) },
    'expo-image': { Image: host('ExpoImage') },
    'react-native-reanimated': { default: { View: host('AnimatedView') } },
    '@/components/ScreenHeader': { ScreenHeader: host('ScreenHeader'), RoundIconButton: host('RoundIconButton') },
    '@/components/IconButton': { IconButton: host('IconButton') },
    '@/components/DareComposer': { DareComposer: host('DareComposer') },
    '@/components/MessageActions': Object.fromEntries(['MessageActions', 'ReactionChips', 'ReplyQuote'].map(name => [name, host(name)])),
    '@/components/VoiceNote': { MicButton: host('MicButton'), VoiceBubble: host('VoiceBubble') },
    '@/components/Overlays': { useOverlays: () => ({ showToast: (...args) => calls.toasts.push(args), showOptions: value => calls.options.push(value) }) },
    '@/lib/chat': {
      fetchConversation: async () => { calls.loads++; return load ? load() : (messages ?? [message(mine ? { sender_id: 'alice', recipient_id: 'bob' } : {})]); }, fetchDareStreak: async () => 0, markChatRead: async () => {}, cleanUpOpenedSnaps() {}, subscribeToMyMessages: () => noop,
      cachedConversation: () => cached, rememberConversation: (...args) => calls.remembered.push(args),
      subscribeToChat: (...args) => { calls.subscribed.push(args); return noop; },
      sendText: async (...args) => { calls.sent.push(args); if (send) await send(...args); return message({ id: 'sent', sender_id: 'alice', body: args[2] }); },
      sendSticker: async (...args) => { calls.stickers.push(args); return message({ id: 'sticker1', sender_id: 'alice', kind: 'sticker', sticker: args[2], body: `Sticker: ${args[2]}` }); },
      hideMessage: async id => calls.hidden.push(id), deleteMessage: async value => calls.deleted.push(value.id),
      searchConversation: async (_me, _friend, query) => search ? search(query) : [],
      // 📷 A peek saved by its sender at the moment it was sent = a photo picked from Photos.
      isChatPhoto: m => m.kind === 'snap' && !!m.saved_at && m.saved_by === m.sender_id && m.saved_at === m.created_at,
      canReplay: () => false, canSave: () => false,
    },
    '@/lib/media': { useMediaUrl: () => null },
    '@/lib/friends': { fetchRelation: async () => ({ kind: 'friends' }) },
    '@/lib/profiles': { fetchProfile: async () => ({ id: 'bob', username: 'bob', display_name: 'Bob' }) },
    '@/lib/screenshots': { useScreenshotNotice() {} },
    '@/lib/reactions': { fetchReactions: async () => new Map(), subscribeToReactions: () => noop, toggleReaction: async (...args) => { calls.reacted.push(args); if (react) await react(...args); } },
    '@/lib/time': { timeAgo: () => 'now' },
    '@/lib/typing': { useTyping: () => ({ friendTyping: false, onTextChange: noop, clearFriendTyping: noop }) },
    '@/lib/voice': { Audio: null },
    '@/lib/useSafetyActions': { useSafetyActions: () => ({ report() {} }) },
    '@/lib/plus': { usePlus: () => plus },
  });
  // What the chat handed to the outbox, in the old shape: [me, friend, body, replyTo] and [me, friend, sticker].
  Object.defineProperty(calls, 'sent', { get: () => store.calls.sendLater.filter(([, , what]) => what.kind === 'text').map(([me, , what]) => [me, what.friendId, what.body, what.replyTo ?? undefined]) });
  Object.defineProperty(calls, 'stickers', { get: () => store.calls.sendLater.filter(([, , what]) => what.kind === 'sticker').map(([me, , what]) => [me, what.friendId, what.sticker]) });
  return { screen, calls };
}
const sendButton = tree => tree.root.findAllByType('IconButton').find(node => node.props.label === 'Send');
const openMenu = tree => tree.root.findAllByType('Pressable').find(node => node.props.onLongPress).props.onLongPress();

test('rapid direct-chat Send presses create only one message', async () => {
  const { screen, calls } = fixture({ send: () => new Promise(() => {}) });
  const tree = await renderScreen(screen);
  try {
    await act(() => tree.root.findByType('TextInput').props.onChangeText('hello'));
    const press = sendButton(tree).props.onPress;
    await act(async () => { press(); press(); });
    assert.equal(calls.sent.length, 1);
  } finally { await unmount(tree); }
});

// F8: a text shows at once and the box empties before the server answers (it used to wait, with Send disabled).
test('a text shows at once and the box empties before the server answers', async () => {
  const { screen, calls } = fixture({ send: () => new Promise(() => {}) });
  const tree = await renderScreen(screen);
  try {
    await act(() => tree.root.findByType('TextInput').props.onChangeText('hi'));
    const press = sendButton(tree).props.onPress;
    await act(async () => { press(); press(); });
    assert.equal(tree.root.findByType('TextInput').props.value, '');
    assert.equal(sendButton(tree).props.disabled, undefined, 'Send is never greyed out while sending');
    const bubble = tree.root.findByType(screen.modules['@/components/chat/PendingBubble'].PendingBubble);
    const words = bubble.findAllByType('Text').map(textOf);
    assert.ok(words.includes('hi'), JSON.stringify(words));
    assert.ok(words.includes('Sending…'), JSON.stringify(words));
    // A double tap queued one job.
    assert.equal(calls.store.calls.sendLater.length, 1);
    assert.deepEqual(plain(calls.store.calls.sendLater[0].slice(0, 3)), ['alice', 'friend:bob', { kind: 'text', friendId: 'bob', body: 'hi', replyTo: null }]);
  } finally { await unmount(tree); }
});

test('a sent text replaces its bubble with the real message', async () => {
  const { screen, calls } = fixture();
  const tree = await renderScreen(screen);
  try {
    await act(() => tree.root.findByType('TextInput').props.onChangeText('made it'));
    await act(() => sendButton(tree).props.onPress());
    const [job] = calls.store.jobs();
    await act(() => calls.store.finish(job.key, [message({ id: job.rowIds[0], sender_id: 'alice', recipient_id: 'bob', body: 'made it', created_at: '2026-11-04T12:01:00Z' })]));
    assert.equal(tree.root.findAllByType(screen.modules['@/components/chat/PendingBubble'].PendingBubble).length, 0);
    assert.equal(tree.root.findByType('FlatList').props.data[0].body, 'made it');
    assert.deepEqual(plain(calls.store.calls.ackSent), [job.key]);
  } finally { await unmount(tree); }
});

// F9: a peek that couldn't be sent says so in the chat, and a tap tries again.
test("a failed peek shows 'Couldn't send · tap to try again' and the tap retries", async () => {
  const { screen, calls } = fixture();
  calls.store.sendLater('alice', 'friend:bob', { kind: 'peek', friendIds: ['bob'] }, { capture: { kind: 'photo', uri: 'file:///p.jpg' } });
  const [job] = calls.store.jobs();
  calls.store.set(job.key, { state: 'failed', error: 'No connection – tap to try again', noAnswer: true });
  const tree = await renderScreen(screen);
  try {
    const failed = tree.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel === "Couldn't send · tap to try again");
    assert.ok(failed, 'the failed bubble says so');
    await act(() => failed.props.onPress());
    const menu = calls.options.at(-1);
    assert.deepEqual(plain(menu.options.map(choice => choice.label)), ['Try again', 'Delete']);
    await act(() => menu.options.find(choice => choice.label === 'Try again').onPress());
    assert.deepEqual(plain(calls.store.calls.retry), [job.key]);
  } finally { await unmount(tree); }
});

test('an empty chat with a send on its way shows the bubble, not "Say hi"', async () => {
  const { screen, calls } = fixture({ messages: [] });
  calls.store.sendLater('alice', 'friend:bob', { kind: 'text', friendId: 'bob', body: 'first ever' });
  const tree = await renderScreen(screen);
  try {
    assert.equal(tree.root.findAllByType('EmptyState').length, 0);
    assert.equal(tree.root.findAllByType(screen.modules['@/components/chat/PendingBubble'].PendingBubble).length, 1);
  } finally { await unmount(tree); }
});

// F10: a reaction shows before the server answers (it used to wait, then reload the whole chat).
test('a reaction shows before the server answers', async () => {
  const { screen, calls } = fixture({ react: () => new Promise(() => {}) });
  const tree = await renderScreen(screen);
  try {
    await act(() => openMenu(tree));
    // The server never answers here: don't wait for it.
    await act(() => { tree.root.findByType('MessageActions').props.onReact('🔥'); });
    const chips = tree.root.findAllByType('ReactionChips')[0].props.reactions;
    assert.deepEqual(plain(chips), [{ message_id: 'message1', user_id: 'alice', emoji: '🔥' }]);
    assert.equal(calls.reacted.length, 1);
  } finally { await unmount(tree); }
});

test('a reaction the server refuses is taken back with a toast', async () => {
  const { screen, calls } = fixture({ react: async () => { throw new Error('No internet'); } });
  const tree = await renderScreen(screen);
  try {
    await act(() => openMenu(tree));
    await act(() => tree.root.findByType('MessageActions').props.onReact('🔥'));
    assert.equal(tree.root.findAllByType('ReactionChips')[0].props.reactions?.length ?? 0, 0);
    assert.match(calls.toasts.at(-1)[0], /Couldn't react/);
  } finally { await unmount(tree); }
});

test('the next direct-chat draft survives a slow send', async () => {
  const { screen } = fixture({ send: () => new Promise(() => {}) });
  const tree = await renderScreen(screen);
  try {
    await act(() => tree.root.findByType('TextInput').props.onChangeText('first'));
    await act(() => sendButton(tree).props.onPress());
    await act(() => tree.root.findByType('TextInput').props.onChangeText('next draft'));
    assert.equal(tree.root.findByType('TextInput').props.value, 'next draft');
  } finally { await unmount(tree); }
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
    assert.deepEqual(plain(calls.sent[0]), ['alice', 'bob', 'reply 👋', 'message1']);
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
  assert.deepEqual(plain(calls.stickers.map(args => args.slice(1, 3))), [['bob', 'googly-eyes']]);
  assert.deepEqual(stickers, ['googly-eyes']);
  assert.deepEqual(calls.pushed, []);
});

test('word stickers are sent by their sticker name', async () => {
  const { calls } = await stickerFlow({ plus: false, pick: picker => picker.onPickWord('NO WAY') });
  assert.deepEqual(plain(calls.stickers.map(args => args[2])), ['word-no-way']);
});

test('without Peekaboo+ a Plus sticker is not sent; the Peekaboo+ screen opens instead', async () => {
  const { calls } = await stickerFlow({ plus: false, pick: picker => picker.onPickSpecial('plus-slay') });
  assert.deepEqual(calls.stickers, []);
  assert.deepEqual(calls.pushed, ['/plus']);
});

test('with Peekaboo+ a Plus sticker is sent', async () => {
  const { calls, stickers } = await stickerFlow({ plus: true, pick: picker => picker.onPickSpecial('plus-slay') });
  assert.deepEqual(plain(calls.stickers.map(args => args[2])), ['plus-slay']);
  assert.deepEqual(stickers, ['plus-slay']);
});

test('an emoji from the sticker picker goes as a normal message', async () => {
  const { calls } = await stickerFlow({ plus: false, pick: picker => picker.onPickEmoji('🔥') });
  assert.deepEqual(plain(calls.sent.map(args => args[2])), ['🔥']);
  assert.deepEqual(calls.stickers, []);
});

// ---------------------------------------------------------------------------
// 📷 A photo picked from Photos (a peek saved by its sender at the moment it was sent): it says photo, opens any
// time, and can't be unsaved (that would make it disappear). A normal peek and a peek saved later are unchanged.
// ---------------------------------------------------------------------------
const texts = tree => tree.root.findAllByType('Text').map(node => require('./harness.cjs').textOf(node));
const photo = changes => message({ kind: 'snap', body: null, media_type: 'photo', media_path: 'bob/snaps/p.jpg', saved_at: '2026-11-04T12:00:00Z', saved_by: 'bob', replayed_at: null, ...changes });

test('a new photo from Photos says "New photo · tap to view" and opens in the viewer; no Unsave', async () => {
  const { screen, calls } = fixture({ messages: [photo()] });
  const tree = await renderScreen(screen);
  try {
    assert.ok(texts(tree).includes('New photo · tap to view'), JSON.stringify(texts(tree)));
    const bubble = tree.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel === 'New photo · tap to view');
    await act(() => bubble.props.onPress());
    // (The viewer gets the photo's file name too, so it can start downloading at once – see the next test.)
    assert.deepEqual(plain(calls.pushed), [{ pathname: '/snap/[id]', params: { id: 'message1', path: 'bob/snaps/p.jpg', type: 'photo', from: 'bob' } }]);
    await act(() => openMenu(tree));
    const labels = [...tree.root.findByType('MessageActions').props.actions.map(action => action.label)];
    assert.ok(!labels.includes('Unsave'), JSON.stringify(labels));
  } finally { await unmount(tree); }
});

// Speed fix 5: opening a peek. The chat hands the viewer the peek's file names and who sent it, so the viewer can get
// the links and start the download while it loads the peek itself (1–2 round trips instead of 5–7 in a row).
test('tapping a new peek passes its file names and sender to the viewer', async () => {
  const peek = message({ id: 'peek1', kind: 'snap', body: null, media_type: 'video', media_path: 'bob/snaps/v.mp4', poster_path: 'bob/snaps/v.jpg', overlay_path: 'bob/snaps/v.png', saved_at: null, replayed_at: null });
  const { screen, calls } = fixture({ messages: [peek] });
  const tree = await renderScreen(screen);
  try {
    const bubble = tree.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel === 'New peek · tap to view');
    await act(() => bubble.props.onPress());
    assert.deepEqual(plain(calls.pushed), [{ pathname: '/snap/[id]', params: { id: 'peek1', path: 'bob/snaps/v.mp4', poster: 'bob/snaps/v.jpg', overlay: 'bob/snaps/v.png', type: 'video', from: 'bob' } }]);
  } finally { await unmount(tree); }
});

test('an opened photo, and one you sent, can still be opened any time', async () => {
  const seen = fixture({ messages: [photo({ opened_at: '2026-11-04T12:05:00Z' })] });
  const tree = await renderScreen(seen.screen);
  try {
    assert.ok(texts(tree).includes('Photo · tap to view'));
  } finally { await unmount(tree); }
  const sent = fixture({ messages: [photo({ sender_id: 'alice', recipient_id: 'bob', saved_by: 'alice' })] });
  const tree2 = await renderScreen(sent.screen);
  try {
    assert.ok(texts(tree2).includes('You sent a photo · tap to view'));
  } finally { await unmount(tree2); }
});

test('a peek and a peek saved later still look like peeks', async () => {
  const peek = fixture({ messages: [photo({ saved_at: null, saved_by: null })] });
  const tree = await renderScreen(peek.screen);
  try {
    assert.ok(texts(tree).includes('New peek · tap to view'));
  } finally { await unmount(tree); }
  const later = fixture({ messages: [photo({ opened_at: '2026-11-04T12:05:00Z', saved_at: '2026-11-04T12:06:00Z', saved_by: 'alice' })] });
  const tree2 = await renderScreen(later.screen);
  try {
    assert.ok(texts(tree2).includes('Saved peek · tap to view'));
    await act(() => openMenu(tree2));
    assert.ok(tree2.root.findByType('MessageActions').props.actions.some(action => action.label === 'Unsave'));
  } finally { await unmount(tree2); }
});

// ---------------------------------------------------------------------------
// Speed fix 6: chats open instantly and stop reloading for other chats' messages.
// ---------------------------------------------------------------------------
test('opening a chat again shows its last messages at once, before the server answers', async () => {
  const { screen, calls } = fixture({ cached: [message({ id: 'old1', body: 'Remembered 👋' })], load: () => new Promise(() => {}) });
  const tree = await renderScreen(screen);
  try {
    assert.equal(calls.loads, 1, 'it still checks for new messages');
    const words = tree.root.findAllByType('Text').map(textOf);
    assert.ok(words.includes('Remembered 👋'), JSON.stringify(words));
    assert.equal(tree.root.findAllByType('ActivityIndicator').length, 0, 'no spinner');
  } finally { await unmount(tree); }
});

test('the chat only listens for its own messages, and remembers what it shows for next time', async () => {
  const { screen, calls } = fixture({});
  const tree = await renderScreen(screen);
  try {
    assert.equal(calls.subscribed.length, 1);
    const [me, friend, shown, reload] = calls.subscribed[0];
    assert.deepEqual([me, friend], ['alice', 'bob']);
    // (An unsent message only says its id: the screen says whether it's one shown here.)
    assert.equal(shown('message1'), true);
    assert.equal(shown('somewhere-else'), false);
    const before = calls.loads;
    await act(async () => { reload(); });
    assert.equal(calls.loads, before + 1);
    assert.ok(calls.remembered.some(([who, chat, list]) => who === 'alice' && chat === 'bob' && list.some((m) => m.id === 'message1')));
  } finally { await unmount(tree); }
});
