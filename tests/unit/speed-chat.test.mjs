import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

// Speed fixes 5 and 6 in src/lib/chat.ts:
// - a peek's one-minute links come from ONE request for all its files (getSnapUrls);
// - chats open instantly: each chat's last list is remembered while the app is open, and the messages you hid
//   ("Delete for me", "Clear chat") are no longer downloaded again with every chat load;
// - an open chat only reloads for ITS messages (the logs showed 8 reloads in 25 seconds in the owner's chat, for
//   messages in other chats).

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

// A pretend Supabase that writes down every request.
function fakeServer({ hidden = [], messages = [] } = {}) {
  const requests = [];
  const channels = [];
  const signings = [];
  const supabase = {
    from(table) {
      const request = { table, calls: [] };
      requests.push(request);
      const chain = {};
      for (const method of ['select', 'or', 'order', 'eq', 'in', 'limit', 'ilike']) {
        chain[method] = (...args) => { request.calls.push([method, ...args]); return chain; };
      }
      chain.then = (resolve, reject) => Promise.resolve(
        table === 'message_hides'
          ? { data: hidden.map((id) => ({ message_id: id })), error: null }
          : { data: messages, error: null },
      ).then(resolve, reject);
      return chain;
    },
    rpc: async (name, args) => { requests.push({ table: `rpc:${name}`, args }); return { data: null, error: null }; },
    channel(name) {
      const channel = { name, listeners: [] };
      channels.push(channel);
      const api = {
        on: (_type, _filter, callback) => { channel.listeners.push(callback); return api; },
        subscribe: () => api,
      };
      return api;
    },
    removeChannel(channel) { channels.splice(channels.indexOf(channel), 1); },
    storage: {
      from: (bucket) => ({
        createSignedUrls: async (paths, seconds) => {
          signings.push({ bucket, paths, seconds });
          return { data: paths.map((path) => (path.includes('gone') ? { path, signedUrl: '', error: 'Object not found' } : { path, signedUrl: `https://signed/${path}`, error: null })), error: null };
        },
      }),
    },
  };
  return { supabase, requests, channels, signings };
}

const load = (server) => loadLibrary('chat', { supabase: server.supabase, mocks: { './media': {} } });
const msg = (id, sender, recipient) => ({ id, sender_id: sender, recipient_id: recipient, kind: 'text', body: id, created_at: '2026-11-22T10:00:00Z' });
const hideRequests = (server) => server.requests.filter((r) => r.table === 'message_hides').length;

it('a peek\'s links for all its files come from one request; a file that can\'t be signed is left out', async () => {
  const server = fakeServer();
  const chat = load(server);
  const links = await chat.getSnapUrls(['A/clip.mp4', 'A/clip.jpg', 'A/gone.png', 'A/clip.mp4']);
  expect(server.signings).toEqual([{ bucket: 'media', paths: ['A/clip.mp4', 'A/clip.jpg', 'A/gone.png'], seconds: 60 }]);
  expect(links).toEqual({ 'A/clip.mp4': 'https://signed/A/clip.mp4', 'A/clip.jpg': 'https://signed/A/clip.jpg' });
  expect(await chat.getSnapUrls([])).toEqual({});
  expect(server.signings).toHaveLength(1);
});

it('the messages you hid are asked for once every few minutes, not with every chat load – and still hidden', async () => {
  const server = fakeServer({ hidden: ['m2'], messages: [msg('m1', 'me', 'ray'), msg('m2', 'ray', 'me')] });
  const chat = load(server);
  expect((await chat.fetchConversation('me', 'ray')).map((m) => m.id)).toEqual(['m1']);
  await chat.fetchConversation('me', 'sam');
  await chat.fetchRecentMessages('me');
  expect(hideRequests(server)).toBe(1);
  vi.advanceTimersByTime(3 * 60 * 1000 + 1);
  await chat.fetchConversation('me', 'ray');
  expect(hideRequests(server)).toBe(2);
});

it('after "Delete for me" or "Clear chat" the hidden list is asked for again (never an old one)', async () => {
  const server = fakeServer({ hidden: [], messages: [msg('m1', 'me', 'ray')] });
  const chat = load(server);
  await chat.fetchConversation('me', 'ray');
  await chat.hideMessage('m1');
  await chat.fetchConversation('me', 'ray');
  expect(hideRequests(server)).toBe(2);
  await chat.clearChat('ray');
  await chat.fetchConversation('me', 'ray');
  expect(hideRequests(server)).toBe(3);
});

it('another person never gets the hidden list or the remembered chats of the one before', async () => {
  const server = fakeServer({ hidden: [], messages: [msg('m1', 'me', 'ray')] });
  const chat = load(server);
  await chat.fetchConversation('me', 'ray');
  expect(chat.cachedConversation('me', 'ray').map((m) => m.id)).toEqual(['m1']);
  expect(chat.cachedConversation('me', 'sam')).toBe(null);
  await chat.fetchConversation('other', 'ray');
  expect(hideRequests(server)).toBe(2);
  expect(chat.cachedConversation('me', 'ray')).toBe(null);
  // What the chat screen shows is remembered too (a message you just sent or deleted).
  chat.rememberConversation('other', 'ray', [msg('m9', 'other', 'ray')]);
  expect(chat.cachedConversation('other', 'ray').map((m) => m.id)).toEqual(['m9']);
});

it('an open chat only reloads for its own messages', () => {
  const server = fakeServer();
  const chat = load(server);
  const reloads = vi.fn();
  const shown = new Set(['m1']);
  const stop = chat.subscribeToChat('me', 'ray', (id) => shown.has(id), reloads);
  const send = (payload) => server.channels[0].listeners.forEach((listener) => listener(payload));
  // A message in another chat: nothing.
  send({ eventType: 'INSERT', new: msg('x1', 'sam', 'me'), old: {} });
  send({ eventType: 'UPDATE', new: msg('x2', 'me', 'sam'), old: { id: 'x2' } });
  expect(reloads).not.toHaveBeenCalled();
  // Ray's new message, and your own to Ray (opened, saved…): reload.
  send({ eventType: 'INSERT', new: msg('m3', 'ray', 'me'), old: {} });
  send({ eventType: 'UPDATE', new: msg('m1', 'me', 'ray'), old: { id: 'm1' } });
  expect(reloads).toHaveBeenCalledTimes(2);
  // An unsent message only says its id: reload only if it's one on screen here.
  send({ eventType: 'DELETE', new: {}, old: { id: 'zzz' } });
  expect(reloads).toHaveBeenCalledTimes(2);
  send({ eventType: 'DELETE', new: {}, old: { id: 'm1' } });
  expect(reloads).toHaveBeenCalledTimes(3);
  // Something we can't tell: better one load too many than a missed message.
  send(undefined);
  expect(reloads).toHaveBeenCalledTimes(4);
  stop();
  expect(server.channels).toHaveLength(0);
});
