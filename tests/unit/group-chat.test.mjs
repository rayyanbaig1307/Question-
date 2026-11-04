import { expect, it, vi } from 'vitest';
import { query } from '../api/edgeHarness.mjs';
import { loadLibrary } from './libHarness.mjs';

it('a failed group-photo save removes its new public upload and preserves the real error', async () => {
  const failure = { message: 'Not a group member' };
  const remove = vi.fn(async () => {});
  const lib = loadLibrary('groupChat', {
    supabase: { rpc: async () => ({ data: null, error: failure }) },
    mocks: { './media': { uploadAvatar: async () => 'A/group-photo.jpg', deleteAvatar: remove } },
  });
  await expect(lib.setGroupPhoto('A', 'foreign-group', 'file:///photo.jpg')).rejects.toMatchObject(failure);
  expect(remove).toHaveBeenCalledExactlyOnceWith('A/group-photo.jpg');
});

it('a failed group capture never leaves successful uploads after a rejected message insert', async () => {
  const fields = { media_path: 'A/group/p.mp4', poster_path: 'A/group/p.jpg', overlay_path: 'A/group/p.png', media_type: 'video' };
  const remove = vi.fn(async () => {});
  const lib = loadLibrary('groupChat', {
    supabase: { from: () => query({ data: null, error: { message: 'Not a group member' } }) },
    mocks: { './media': { uploadCapture: async () => ({ fields }), deleteMedia: remove, mediaFiles: (f) => [f.media_path, f.poster_path, f.overlay_path] } },
  });
  await expect(lib.sendGroupCapture('A', 'foreign-group', { kind: 'video', uri: 'file:///video.mp4' })).rejects.toMatchObject({ message: 'Not a group member' });
  expect(remove).toHaveBeenCalledExactlyOnceWith(['A/group/p.mp4', 'A/group/p.jpg', 'A/group/p.png']);
});

it('group proof messages retain the target group and dare instead of trusting an invented sender', async () => {
  const insert = vi.fn();
  const chain = query({ error: null });
  chain.insert = (row) => { insert(row); return chain; };
  const lib = loadLibrary('groupChat', {
    supabase: { from: () => chain },
    mocks: { './media': { uploadCapture: async () => ({ fields: { media_path: 'A/group/a.jpg', media_type: 'photo', poster_path: null, overlay_path: null } }) } },
  });
  await lib.sendGroupCapture('A', 'test-group', { kind: 'photo', uri: 'file:///photo.jpg' }, 'test-dare');
  expect(insert.mock.calls[0][0]).toMatchObject({ group_id: 'test-group', dare_id: 'test-dare', kind: 'proof', media_path: 'A/group/a.jpg' });
  expect(insert.mock.calls[0][0]).not.toHaveProperty('sender_id');
});

function realtime() {
  const names = new Set();
  const removed = [];
  const supabase = { channel: (name) => {
    if (names.has(name)) return { on() { throw new Error('Tried to add a listener to an already subscribed channel'); } };
    const channel = { name, on() { return channel; }, subscribe() { names.add(name); return channel; } };
    return channel;
  }, removeChannel: (channel) => { removed.push(channel.name); } };
  return { supabase, names, removed };
}

it('two mounted copies of a one-to-one chat get different realtime listeners', () => {
  const r = realtime();
  const chat = loadLibrary('chat', { supabase: r.supabase, mocks: { './media': {} } });
  const first = chat.subscribeToMyMessages('chat-A-B', () => {});
  let second;
  expect(() => { second = chat.subscribeToMyMessages('chat-A-B', () => {}); }).not.toThrow();
  expect(r.names.size).toBe(2);
  first(); second();
  expect(r.removed).toHaveLength(2);
});

it('group and reaction subscriptions also use distinct listener names', () => {
  const r = realtime();
  const groups = loadLibrary('groupChat', { supabase: r.supabase, mocks: { './media': {} } });
  const reactions = loadLibrary('reactions', { supabase: r.supabase });
  const stops = [];
  for (let i = 0; i < 3; i++) {
    stops.push(groups.subscribeToGroup('test-group', () => {}));
    stops.push(groups.subscribeToGroupChat('test-group', () => {}));
    stops.push(reactions.subscribeToReactions(true, () => {}));
  }
  expect(r.names.size).toBe(9);
  stops.forEach((stop) => stop());
  expect(r.removed).toHaveLength(9);
});

it.each([false, true])('reaction upsert/deletion is limited to the chosen message and user; group=%s', async (group) => {
  const queries = [];
  const lib = loadLibrary('reactions', { supabase: { from: (table) => {
    const chain = query({ error: null });
    chain.upsert = (value) => { queries.push(['upsert', table, value]); return chain; };
    chain.eq = (column, value) => { queries.push(['filter', table, column, value]); return chain; };
    return chain;
  } } });
  await lib.toggleReaction('A', 'message-1', '❤️', null, group);
  await lib.toggleReaction('A', 'message-1', '❤️', '❤️', group);
  const table = group ? 'group_message_reactions' : 'message_reactions';
  expect(queries).toContainEqual(['upsert', table, { message_id: 'message-1', user_id: 'A', emoji: '❤️' }]);
  expect(queries).toContainEqual(['filter', table, 'user_id', 'A']);
  expect(queries).toContainEqual(['filter', table, 'message_id', 'message-1']);
});

it('a privacy-table outage cannot make cleared direct messages reappear', async () => {
  const chat = loadLibrary('chat', { supabase: { from: (name) => query(name === 'message_hides'
    ? { data: null, error: { message: 'privacy data unavailable' } }
    : { data: [{ id: 'cleared-message' }], error: null }) }, mocks: { './media': {} } });
  await expect(chat.fetchConversation('A', 'B')).rejects.toMatchObject({ message: 'privacy data unavailable' });
});

it('deleting one group message preserves a companion still used in another message', async () => {
  const remove = vi.fn();
  const rpc = vi.fn(async (_name, { object_name }) => ({ data: object_name !== 'A/group/shared-poster.jpg', error: null }));
  const lib = loadLibrary('groupChat', {
    supabase: { from: () => query({ error: null }), rpc },
    mocks: { './media': { deleteMedia: remove } },
  });
  await lib.deleteGroupMessage({ id: 'message-1', media_path: 'A/group/old-video.mp4', poster_path: 'A/group/shared-poster.jpg', overlay_path: null });
  expect(remove).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenCalledWith('can_cleanup_snap', { object_name: 'A/group/shared-poster.jpg' });
});

it('deleting a group message claims every distinct file before removing it', async () => {
  const calls = [];
  const lib = loadLibrary('groupChat', {
    supabase: { from: () => query({ error: null }), rpc: async (_name, { object_name }) => { calls.push(['claim', object_name]); return { data: true, error: null }; } },
    mocks: { './media': { deleteMedia: async (paths) => { calls.push(['remove', paths]); } } },
  });
  await lib.deleteGroupMessage({ id: 'message-1', media_path: 'A/group/a.jpg', poster_path: 'A/group/a.jpg', overlay_path: 'A/group/a.png' });
  expect(calls).toEqual([['claim', 'A/group/a.jpg'], ['claim', 'A/group/a.png'], ['remove', ['A/group/a.jpg', 'A/group/a.png']]]);
});
