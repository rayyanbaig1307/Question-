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

// ---------------------------------------------------------------------------
// Cleared and hidden messages never come back from the remembered chats
// ---------------------------------------------------------------------------

// A pretend Supabase that keeps a real list of hidden messages: "Clear chat" hides every message in the chat with
// that friend, "Delete for me" hides one. A messages load can be held (`holdMessages`) until the test lets it answer.
function hidingServer(messages) {
  const state = { hidden: new Set(), held: [], holdMessages: false, rpcError: null, hideRequests: 0 };
  const supabase = {
    from(table) {
      const chain = {};
      for (const method of ['select', 'or', 'order', 'eq', 'in', 'limit', 'ilike']) chain[method] = () => chain;
      chain.then = (resolve, reject) => {
        if (table === 'message_hides') {
          state.hideRequests += 1;
          // The server's answer at the moment it was asked.
          return Promise.resolve({ data: [...state.hidden].map((id) => ({ message_id: id })), error: null }).then(resolve, reject);
        }
        const answer = { data: messages.map((m) => ({ ...m })), error: null };
        if (!state.holdMessages) return Promise.resolve(answer).then(resolve, reject);
        return new Promise((release) => state.held.push(() => release(answer))).then(resolve, reject);
      };
      return chain;
    },
    rpc: async (name, args) => {
      if (state.rpcError) return { data: null, error: state.rpcError };
      if (name === 'clear_chat') messages.filter((m) => m.sender_id === args.friend || m.recipient_id === args.friend).forEach((m) => state.hidden.add(m.id));
      if (name === 'hide_message') state.hidden.add(args.message);
      return { data: null, error: null };
    },
  };
  return { supabase, state };
}

const ids = (list) => (list ? list.map((m) => m.id) : list);

it('"Clear chat" forgets the remembered chat: opening it again never shows the cleared messages, even if loading fails', async () => {
  const server = hidingServer([msg('m1', 'me', 'ray'), msg('m2', 'ray', 'me')]);
  const chat = loadLibrary('chat', { supabase: server.supabase, mocks: { './media': {} } });
  await chat.fetchConversation('me', 'ray');
  chat.rememberConversation('me', 'sam', [msg('s1', 'sam', 'me')]);
  expect(ids(chat.cachedConversation('me', 'ray'))).toEqual(['m1', 'm2']);
  await chat.clearChat('ray');
  // The chat screen starts from this: nothing remembered means it waits for a fresh load (an empty chat if that
  // fails), instead of drawing the cleared messages straight away.
  expect(chat.cachedConversation('me', 'ray')).toBe(null);
  expect(ids(chat.cachedConversation('me', 'sam'))).toEqual(['s1']);
  // The next load leaves them out too.
  expect(ids(await chat.fetchConversation('me', 'ray'))).toEqual([]);
});

it('"Clear chat" that fails (or can\'t tell if it worked) still forgets the remembered chat', async () => {
  const server = hidingServer([msg('m1', 'me', 'ray')]);
  const chat = loadLibrary('chat', { supabase: server.supabase, mocks: { './media': {} } });
  await chat.fetchConversation('me', 'ray');
  server.state.rpcError = { message: 'Network request failed' };
  await expect(chat.clearChat('ray')).rejects.toMatchObject({ message: 'Network request failed' });
  expect(chat.cachedConversation('me', 'ray')).toBe(null);
});

it('a chat load that was on its way when you cleared the chat can\'t bring the cleared messages back', async () => {
  const server = hidingServer([msg('m1', 'me', 'ray'), msg('m2', 'ray', 'me')]);
  const chat = loadLibrary('chat', { supabase: server.supabase, mocks: { './media': {} } });
  // You open Ray's chat on a weak signal and go back before it loads; the hidden list (empty) is already in.
  server.state.holdMessages = true;
  const loading = chat.fetchConversation('me', 'ray');
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(server.state.held).toHaveLength(1);
  // On the Chat list you clear the chat with Ray...
  await chat.clearChat('ray');
  // ...then the old load comes in, with messages from before the clear.
  server.state.held.shift()();
  expect(ids(await loading)).toEqual([]);
  expect(ids(chat.cachedConversation('me', 'ray'))).toEqual([]);
});

it('"Delete for me" takes the message out of every remembered chat', async () => {
  const server = hidingServer([msg('m1', 'me', 'ray'), msg('m2', 'ray', 'me')]);
  const chat = loadLibrary('chat', { supabase: server.supabase, mocks: { './media': {} } });
  await chat.fetchConversation('me', 'ray');
  chat.rememberConversation('me', 'sam', [msg('s1', 'sam', 'me')]);
  await chat.hideMessage('m2');
  expect(ids(chat.cachedConversation('me', 'ray'))).toEqual(['m1']);
  expect(ids(chat.cachedConversation('me', 'sam'))).toEqual(['s1']);
  // Even when we can't tell if it worked, it's not drawn again from the remembered chat.
  server.state.rpcError = { message: 'Network request failed' };
  await expect(chat.hideMessage('m1')).rejects.toMatchObject({ message: 'Network request failed' });
  expect(ids(chat.cachedConversation('me', 'ray'))).toEqual([]);
});
