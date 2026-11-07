import { expect, it } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

// While a chat is open, its own new messages don't pop up as a banner on top of it. Other chats still do.
function load() {
  let focus = null;
  const lib = loadLibrary('notifications', {
    mocks: {
      expo: { requireOptionalNativeModule: () => null },
      'expo-router': { router: {}, useFocusEffect: (effect) => { focus = effect; } },
      react: { useCallback: (fn) => fn, useEffect() {} },
      'react-native': { AppState: { addEventListener: () => ({ remove() {} }) }, Platform: { OS: 'ios' } },
      './drop': { dropAt: () => 0, localDay: () => '2026-11-07' },
    },
  });
  // Open a chat screen: runs its focus effect, returns the "leave the screen" step.
  const open = (chat) => { lib.useOpenChat(chat); return focus(); };
  return { lib, open };
}

it('works out which chat a notification is about', () => {
  const { lib } = load();
  expect(lib.chatOfNotification({ type: 'message', from: 'bob' })).toBe('friend:bob');
  // Group chat messages are 'group_chat' (what the server sends: send_push(..., jsonb_build_object('type', 'group_chat', 'group', …))).
  expect(lib.chatOfNotification({ type: 'group_chat', group: 'g1' })).toBe('group:g1');
  // 'group' is a group peek or "added you to a group": not a chat message, so it never counts as the open chat.
  expect(lib.chatOfNotification({ type: 'group', group: 'g1' })).toBe(null);
  expect(lib.chatOfNotification({ type: 'like', post: 'p1' })).toBe(null);
  expect(lib.chatOfNotification(undefined)).toBe(null);
});

it('a message from the open chat stays quiet; other chats and other kinds still show', () => {
  const { lib, open } = load();
  const leave = open('friend:bob');
  expect(lib.isForOpenChat({ type: 'message', from: 'bob' })).toBe(true);
  expect(lib.isForOpenChat({ type: 'message', from: 'carol' })).toBe(false);
  expect(lib.isForOpenChat({ type: 'group_chat', group: 'g1' })).toBe(false);
  expect(lib.isForOpenChat({ type: 'like', post: 'p1' })).toBe(false);
  // Leaving the chat: Bob's messages pop up again.
  leave();
  expect(lib.isForOpenChat({ type: 'message', from: 'bob' })).toBe(false);
});

it('a group chat works the same way', () => {
  const { lib, open } = load();
  const leave = open('group:g1');
  expect(lib.isForOpenChat({ type: 'group_chat', group: 'g1' })).toBe(true);
  expect(lib.isForOpenChat({ type: 'group_chat', group: 'g2' })).toBe(false);
  // A group peek in the same group still shows (it isn't a chat message).
  expect(lib.isForOpenChat({ type: 'group', group: 'g1' })).toBe(false);
  expect(lib.isForOpenChat({ type: 'message', from: 'bob' })).toBe(false);
  leave();
  expect(lib.isForOpenChat({ type: 'group_chat', group: 'g1' })).toBe(false);
});
