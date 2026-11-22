const test = require('node:test');
const assert = require('node:assert/strict');
const { React, loadScreen, renderScreen, act, unmount, host, textOf } = require('./harness.cjs');

// The public chat screen (18+): who gets in, photos, messages and stickers, and the menus on each.
const bob = { id: 'bob', username: 'bob', display_name: 'Bob', avatar_path: null };
const alice = { id: 'alice', username: 'alice', display_name: 'Alice', avatar_path: null };
const photo = (changes = {}) => ({ kind: 'photo', id: 'p1', sender_id: 'bob', media_path: 'bob/public/a.jpg', created_at: '2026-11-18T12:00:00Z', hidden: false, author: bob, ...changes });
const message = (changes = {}) => ({ kind: 'text', id: 'm1', sender_id: 'bob', body: 'hey everyone', sticker: null, created_at: '2026-11-18T12:01:00Z', hidden: false, author: bob, ...changes });

// `fetchRoom` stands in for fetchPublicChat (default: the room with `items`); `sendText` for sendPublicText;
// `profile` is who is looking (the name they'd post with).
function fixture({ status = 'ok', items = [photo()], textOn = true, plus = false, sendError = null, fetchRoom = null, sendText = null,
  profile = { id: 'alice', username: 'alice', display_name: 'Alice' } } = {}) {
  const calls = { routes: [], options: [], reports: [], deleted: [], texts: [], stickers: [], subscribed: [], loads: 0 };
  const screen = loadScreen('src/app/(app)/public-chat.tsx', {
    'expo-router': { router: { push: to => calls.routes.push(to) }, useFocusEffect: callback => React.useEffect(callback, [callback]) },
    'expo-image': { Image: host('ExpoImage') },
    '@/components/IconButton': { IconButton: host('IconButton') },
    '@/components/ZoomableImage': { ZoomableImage: host('ZoomableImage') },
    '@/components/Overlays': { useOverlays: () => ({ showToast() {}, showOptions: value => calls.options.push(value) }) },
    '@/lib/media': { useMediaUrls: paths => Object.fromEntries(paths.map(p => [p, `https://files/${p}`])) },
    '@/lib/time': { timeAgo: () => 'now' },
    '@/lib/plus': { usePlus: () => plus },
    '@/lib/useSafetyActions': { useSafetyActions: () => ({ report: value => calls.reports.push(value) }) },
    '@/lib/auth': { useMe: () => ({ userId: 'alice', profile }) },
    '@/lib/publicChat': {
      PUBLIC_CHAT: 'public', PUBLIC_TEXT_MAX: 300, usePublicChatStatus: () => status,
      fetchPublicChat: async () => {
        calls.loads += 1;
        return fetchRoom ? fetchRoom(calls.loads) : { items, textOn };
      },
      // Like the real ones (src/lib/publicText.ts, tested in tests/unit): blank-looking characters don't count, and
      // a name with a link in it can't post and isn't shown.
      hasPublicText: text => text.replace(/[\s\u200B\u3164\u2800]/g, '') !== '',
      checkPublicName: person => (/t\.me|\.com/.test(`${person?.username} ${person?.display_name}`) ? 'Your name or username looks like a link or a phone number.' : null),
      publicChatName: author => author?.display_name || author?.username || 'Someone',
      deletePublicPhoto: async value => calls.deleted.push(value.id),
      deletePublicMessage: async id => calls.deleted.push(id),
      sendPublicText: async text => {
        calls.texts.push(text);
        if (sendText) return sendText(text);
        if (sendError) throw new Error(sendError);
        return message({ id: `sent-${calls.texts.length}`, sender_id: 'alice', author: alice, body: text });
      },
      sendPublicSticker: async sticker => {
        calls.stickers.push(sticker);
        return message({ id: `sticker-${calls.stickers.length}`, kind: 'sticker', body: null, sticker, sender_id: 'alice', author: alice });
      },
      subscribeToPublicChat: (onChange, options) => { calls.subscribed.push(options); return () => {}; },
    },
  });
  return { screen, calls };
}
const allText = tree => tree.root.findAll(node => typeof node.type === 'string').map(textOf).join(' ');
const iconButton = (tree, label) => tree.root.findAllByType('IconButton').find(node => node.props.label === label);
const held = tree => tree.root.findAllByType('Pressable').filter(node => node.props.accessibilityHint === 'Hold for options');

test('under 18: no photos, just "not available"', async () => {
  const { screen } = fixture({ status: 'under_18' });
  const tree = await renderScreen(screen);
  assert.equal(tree.root.findAllByType('ExpoImage').length, 0);
  assert.equal(tree.root.findByType('EmptyState').props.title, 'Not available');
  await unmount(tree);
});

test('no birthday yet: asks for it instead of showing the room', async () => {
  const { screen, calls } = fixture({ status: 'no_birthday' });
  const tree = await renderScreen(screen);
  assert.equal(tree.root.findAllByType('ExpoImage').length, 0);
  await act(async () => tree.root.findByType('Button').props.onPress());
  assert.deepEqual(calls.routes, ['/birthday']);
  await unmount(tree);
});

test('an adult sees the photos; the camera button opens the public chat camera', async () => {
  const { screen, calls } = fixture();
  const tree = await renderScreen(screen);
  assert.equal(tree.root.findAllByType('ExpoImage').length, 1);
  await act(async () => iconButton(tree, 'Post a photo').props.onPress());
  assert.equal(JSON.stringify(calls.routes), JSON.stringify([{ pathname: '/camera', params: { group: 'public' } }]));
  await unmount(tree);
});

test("someone else's photo can be reported (with its id); your own can be deleted", async () => {
  const { screen, calls } = fixture({ items: [photo(), photo({ id: 'p2', sender_id: 'alice', media_path: 'alice/public/b.jpg', author: alice })] });
  const tree = await renderScreen(screen);
  const menus = tree.root.findAllByType('Pressable').filter(node => node.props.accessibilityLabel === 'More');
  await act(async () => menus[0].props.onPress());
  await act(async () => calls.options[0].options.find(o => o.label === 'Report photo').onPress());
  assert.equal(calls.reports[0].contentType, 'public_photo');
  assert.equal(calls.reports[0].contentId, 'p1');
  assert.equal(calls.reports[0].user.id, 'bob');
  await act(async () => menus[1].props.onPress());
  assert.equal(calls.options[1].options.map(o => o.label).join(), 'Delete');
  await act(async () => calls.options[1].options[0].onPress());
  assert.deepEqual(calls.deleted, ['p2']);
  await unmount(tree);
});

test('a server without messages yet: photos only, the big camera button and no message box', async () => {
  const { screen, calls } = fixture({ textOn: false });
  const tree = await renderScreen(screen);
  assert.equal(tree.root.findAllByType('TextInput').length, 0);
  assert.equal(iconButton(tree, 'Post a photo').props.size, 64);
  assert.match(allText(tree), /Photos only/);
  assert.equal(calls.subscribed.at(-1).text, false);
  // The newest photo (at the bottom of the upside-down list) isn't hidden under the big camera button.
  const content = [tree.root.findByType('FlatList').props.contentContainerStyle].flat().filter(Boolean);
  assert.ok(content.some(style => style.paddingTop >= 96), JSON.stringify(content));
  await unmount(tree);
});

test('with the message box there is no big camera button, so no extra space at the bottom', async () => {
  const { screen } = fixture();
  const tree = await renderScreen(screen);
  const content = [tree.root.findByType('FlatList').props.contentContainerStyle].flat().filter(Boolean);
  assert.ok(!content.some(style => style.paddingTop >= 96));
  await unmount(tree);
});

test('no signal when the room opens: "Couldn\'t load the room" with Try again – not the photos-only room', async () => {
  const { screen, calls } = fixture({
    fetchRoom: n => { if (n === 1) throw new Error('Network request failed'); return { items: [message()], textOn: true }; },
  });
  const tree = await renderScreen(screen);
  assert.equal(tree.root.findByType('EmptyState').props.title, "Couldn't load the room");
  assert.equal(tree.root.findAllByType('TextInput').length, 0);
  assert.equal(iconButton(tree, 'Post a photo'), undefined, 'no big camera button');
  assert.doesNotMatch(allText(tree), /Photos only/);
  assert.equal(calls.subscribed.length, 0, 'no live updates until we know what the server has');
  await act(async () => tree.root.findByType('Button').props.onPress());
  assert.equal(calls.loads, 2);
  assert.match(allText(tree), /hey everyone/);
  assert.equal(tree.root.findAllByType('TextInput').length, 1);
  assert.equal(calls.subscribed.at(-1).text, true);
  await unmount(tree);
});

test('a later load that fails keeps the room as it is; coming back to the app loads it again', async () => {
  let fail = false;
  const { screen, calls } = fixture({
    fetchRoom: () => { if (fail) throw new Error('Network request failed'); return { items: [message()], textOn: true }; },
  });
  const tree = await renderScreen(screen);
  fail = true;
  // Back in the app: a reload (at most twice a second, so after the timer).
  await act(async () => { for (const listener of screen.calls.appState) listener('active'); });
  await act(async () => screen.calls.timers.at(-1)());
  assert.equal(calls.loads, 2);
  assert.match(allText(tree), /hey everyone/);
  assert.equal(tree.root.findAllByType('TextInput').length, 1, 'still the message box, not photos only');
  assert.equal(calls.subscribed.at(-1).text, true);
  await unmount(tree);
  assert.equal(screen.calls.appState.size, 0, 'leaving stops listening');
});

test('messages and stickers show in the room; stickers this app doesn\'t know are left out', async () => {
  const { screen, calls } = fixture({ items: [
    message(), message({ id: 'm2', kind: 'sticker', body: null, sticker: 'googly-eyes' }),
    message({ id: 'm3', kind: 'sticker', body: null, sticker: 'from-the-future' }), photo(),
  ] });
  const tree = await renderScreen(screen);
  assert.match(allText(tree), /hey everyone/);
  assert.deepEqual(tree.root.findAllByType('ChatSticker').map(node => node.props.id), ['googly-eyes']);
  assert.equal(held(tree).length, 2);
  assert.match(allText(tree), /no links or phone numbers/);
  assert.equal(calls.subscribed.at(-1).text, true);
  await unmount(tree);
});

test('typing and sending a message: it shows straight away and the box is cleared', async () => {
  const { screen, calls } = fixture({ items: [] });
  const tree = await renderScreen(screen);
  assert.equal(tree.root.findByType('EmptyState').props.title, 'Nobody has said anything yet');
  const input = tree.root.findByType('TextInput');
  assert.equal(input.props.maxLength, 300);
  assert.equal(iconButton(tree, 'Send').props.disabled, true);
  await act(async () => input.props.onChangeText('hello room'));
  assert.equal(iconButton(tree, 'Send a sticker'), undefined, 'the sticker button steps aside while you type');
  await act(async () => iconButton(tree, 'Send').props.onPress());
  assert.deepEqual(calls.texts, ['hello room']);
  assert.match(allText(tree), /hello room/);
  assert.equal(tree.root.findByType('TextInput').props.value, '');
  await unmount(tree);
});

test('words typed while a message is still sending are kept', async () => {
  let finish;
  const { screen, calls } = fixture({ items: [], sendText: text => new Promise(resolve => { finish = () => resolve(message({ id: 'sent', sender_id: 'alice', author: alice, body: text })); }) });
  const tree = await renderScreen(screen);
  await act(async () => tree.root.findByType('TextInput').props.onChangeText('first'));
  let sending;
  await act(async () => { sending = iconButton(tree, 'Send').props.onPress(); });
  await act(async () => tree.root.findByType('TextInput').props.onChangeText('second message I am typing'));
  await act(async () => { finish(); await sending; });
  assert.deepEqual(calls.texts, ['first']);
  assert.match(allText(tree), /first/);
  assert.equal(tree.root.findByType('TextInput').props.value, 'second message I am typing');
  await unmount(tree);
});

test('only spaces or invisible characters in the box: nothing to send', async () => {
  const { screen, calls } = fixture({ items: [] });
  const tree = await renderScreen(screen);
  await act(async () => tree.root.findByType('TextInput').props.onChangeText('\u200B\u200B \u3164'));
  assert.equal(iconButton(tree, 'Send').props.disabled, true);
  assert.ok(iconButton(tree, 'Send a sticker'), 'the sticker button stays');
  await act(async () => iconButton(tree, 'Send').props.onPress());
  assert.deepEqual(calls.texts, []);
  await unmount(tree);
});

test('a link in your name: you\'re told to change it, and nothing is sent', async () => {
  const { screen, calls } = fixture({ profile: { id: 'alice', username: 'alice', display_name: 'add me t.me/promo' } });
  const tree = await renderScreen(screen);
  await act(async () => tree.root.findByType('TextInput').props.onChangeText('hi 👋'));
  await act(async () => iconButton(tree, 'Send').props.onPress());
  await act(async () => iconButton(tree, 'Post a photo').props.onPress());
  await act(async () => tree.root.findByType('StickerPicker').props.onPickSpecial('googly-eyes'));
  assert.deepEqual(calls.texts, []);
  assert.deepEqual(calls.stickers, []);
  assert.deepEqual(calls.routes, []);
  assert.equal(screen.calls.alerts.length, 3);
  assert.equal(screen.calls.alerts[0][0], 'Change your name first');
  await unmount(tree);
});

test('a message the server (or the app) says no to: a friendly reason, and the words stay in the box', async () => {
  const { screen, calls } = fixture({ sendError: "Links aren't allowed in the public chat." });
  const tree = await renderScreen(screen);
  await act(async () => tree.root.findByType('TextInput').props.onChangeText('see example.com'));
  await act(async () => iconButton(tree, 'Send').props.onPress());
  assert.deepEqual(screen.calls.alerts, [['Message not sent', "Links aren't allowed in the public chat."]]);
  assert.equal(tree.root.findByType('TextInput').props.value, 'see example.com');
  assert.equal(calls.texts.length, 1);
  await unmount(tree);
});

test('stickers: a free one is sent by name; a Peekaboo+ one without Peekaboo+ opens the Peekaboo+ screen', async () => {
  const { screen, calls } = fixture();
  const tree = await renderScreen(screen);
  await act(async () => iconButton(tree, 'Send a sticker').props.onPress());
  const picker = () => tree.root.findByType('StickerPicker');
  assert.equal(picker().props.visible, true);
  await act(async () => picker().props.onPickSpecial('googly-eyes'));
  await act(async () => picker().props.onPickWord('NO WAY'));
  await act(async () => picker().props.onPickSpecial('plus-slay'));
  await act(async () => picker().props.onPickEmoji('😂'));
  assert.deepEqual(calls.stickers, ['googly-eyes', 'word-no-way']);
  assert.deepEqual(calls.routes, ['/plus']);
  assert.deepEqual(calls.texts, ['😂'], 'an emoji goes as a normal message');
  assert.equal(picker().props.visible, false);
  await unmount(tree);
});

test('hold a message: report someone else\'s (with its id), delete your own; your hidden message says why', async () => {
  const { screen, calls } = fixture({ items: [
    message(), message({ id: 'm2', sender_id: 'alice', author: alice, body: 'mine', hidden: true }),
  ] });
  const tree = await renderScreen(screen);
  assert.match(allText(tree), /Hidden: several people reported this message/);
  const [theirs, mine] = held(tree);
  await act(async () => theirs.props.onLongPress());
  assert.equal(calls.options[0].title, '@bob');
  assert.equal(calls.options[0].options.map(o => o.label).join(), 'Report message,See profile');
  await act(async () => calls.options[0].options[0].onPress());
  assert.equal(calls.reports[0].contentType, 'public_message');
  assert.equal(calls.reports[0].contentId, 'm1');
  // Blocking them takes their messages out of the room.
  await act(async () => calls.reports[0].onBlocked());
  assert.doesNotMatch(allText(tree), /hey everyone/);
  await act(async () => mine.props.onLongPress());
  assert.equal(calls.options[1].title, 'Your message');
  await act(async () => calls.options[1].options[0].onPress());
  assert.deepEqual(calls.deleted, ['m2']);
  assert.equal(held(tree).length, 0);
  await unmount(tree);
});
