import { expect, it, vi } from 'vitest';
import { query } from '../api/edgeHarness.mjs';
import { loadLibrary } from './libHarness.mjs';

// setGroupPhoto uploads the new picture first, then asks the server to use it. If that request fails, the new
// file is removed only when the server clearly said no. When the answer is lost on the way (bad signal), the
// server may still have saved the picture (even a moment after we look), so the file is kept.
function groupPhotoLibrary(rpcResult, { remove = vi.fn(async () => {}), groupRead = vi.fn(() => query({ data: { photo_path: 'B/older.jpg' }, error: null })) } = {}) {
  const lib = loadLibrary('groupChat', {
    supabase: { rpc: async () => { if (rpcResult instanceof Error) throw rpcResult; return rpcResult; }, from: groupRead },
    mocks: { './media': { uploadAvatar: async () => 'A/group-photo.jpg', deleteAvatar: remove } },
  });
  return { lib, remove, groupRead };
}

it('a group-photo save the server refuses (an error with a code) removes the new upload and keeps the real error', async () => {
  // What the real server sends when set_group_photo says no, e.g. "Not a group member" (HTTP 400, code P0001).
  const failure = { message: 'Not a group member', code: 'P0001', details: null, hint: null };
  const { lib, remove, groupRead } = groupPhotoLibrary({ data: null, error: failure, status: 400 });
  await expect(lib.setGroupPhoto('A', 'foreign-group', 'file:///photo.jpg')).rejects.toMatchObject(failure);
  expect(remove).toHaveBeenCalledExactlyOnceWith('A/group-photo.jpg');
  expect(groupRead).not.toHaveBeenCalled();
});

it('a group-photo save refused with an HTTP error status (no code) also removes the new upload', async () => {
  const failure = { message: 'permission denied' };
  const { lib, remove } = groupPhotoLibrary({ data: null, error: failure, status: 403 });
  await expect(lib.setGroupPhoto('A', 'my-group', 'file:///photo.jpg')).rejects.toMatchObject(failure);
  expect(remove).toHaveBeenCalledExactlyOnceWith('A/group-photo.jpg');
});

it('a lost answer (network error, no code) keeps the new upload and still reports the error', async () => {
  // This is how supabase-js reports a request that never got an answer: no code, status 0.
  const failure = { message: 'TypeError: fetch failed', details: '', hint: '', code: '' };
  // Even if the group shows an older picture right now, the server may still save the new one a moment later.
  const { lib, remove, groupRead } = groupPhotoLibrary({ data: null, error: failure, status: 0 });
  await expect(lib.setGroupPhoto('A', 'my-group', 'file:///photo.jpg')).rejects.toMatchObject(failure);
  expect(remove).not.toHaveBeenCalled();
  expect(groupRead).not.toHaveBeenCalled();
});

it('a request that fails before any answer (thrown error) keeps the new upload and still reports the error', async () => {
  const failure = new Error('Network request failed');
  const { lib, remove } = groupPhotoLibrary(failure);
  await expect(lib.setGroupPhoto('A', 'my-group', 'file:///photo.jpg')).rejects.toBe(failure);
  expect(remove).not.toHaveBeenCalled();
});

it('a gateway timeout without a code keeps the new upload (the server may still have saved it)', async () => {
  const failure = { message: 'upstream request timeout' };
  const { lib, remove } = groupPhotoLibrary({ data: null, error: failure, status: 504 });
  await expect(lib.setGroupPhoto('A', 'my-group', 'file:///photo.jpg')).rejects.toMatchObject(failure);
  expect(remove).not.toHaveBeenCalled();
});

it('if removing a refused group photo fails too, the real reason is still reported', async () => {
  const failure = { message: 'Not a group member', code: 'P0001' };
  const remove = vi.fn(async () => { throw new Error('Synthetic cleanup failure'); });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const { lib } = groupPhotoLibrary({ data: null, error: failure, status: 400 }, { remove });
    await expect(lib.setGroupPhoto('A', 'my-group', 'file:///photo.jpg')).rejects.toMatchObject(failure);
    expect(remove).toHaveBeenCalledExactlyOnceWith('A/group-photo.jpg');
    expect(warning).toHaveBeenCalled();
  } finally { warning.mockRestore(); }
});

it('a saved group photo is not removed', async () => {
  const { lib, remove } = groupPhotoLibrary({ data: null, error: null, status: 204 });
  await expect(lib.setGroupPhoto('A', 'my-group', 'file:///photo.jpg')).resolves.toBeUndefined();
  expect(remove).not.toHaveBeenCalled();
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

// Group dares: the group votes Legit 🔥 or Cap 🧢 on each proof (supabase/migrations/20261216000000_group_dare_votes.sql).
it('a vote on a proof sends the account on screen, the proof and the choice (null takes it back)', async () => {
  const sent = [];
  const lib = loadLibrary('groupChat', {
    supabase: { rpc: async (name, args) => { sent.push([name, args]); return { data: { legit: 2, cap: 1, mine: args.legit }, error: null }; } },
    mocks: { './media': {} },
  });
  expect(await lib.voteGroupProof('A', 'proof-1', false)).toEqual({ legit: 2, cap: 1, mine: false });
  expect(await lib.voteGroupProof('A', 'proof-1', null)).toEqual({ legit: 2, cap: 1, mine: null });
  expect(sent).toEqual([
    ['vote_group_proof', { proof: 'proof-1', legit: false, expected_user_id: 'A' }],
    ['vote_group_proof', { proof: 'proof-1', legit: null, expected_user_id: 'A' }],
  ]);
});

it('a vote also says whether the proof still counts as one from before voting (the server sends it)', async () => {
  const lib = loadLibrary('groupChat', {
    supabase: { rpc: async () => ({ data: { legit: 0, cap: 1, mine: false, legacy: false }, error: null }) },
    mocks: { './media': {} },
  });
  expect(await lib.voteGroupProof('A', 'proof-1', false)).toEqual({ legit: 0, cap: 1, mine: false, legacy: false });
});

it('a vote the server refuses keeps the real reason', async () => {
  const failure = { message: "You can't vote on your own proof", code: 'P0001' };
  const lib = loadLibrary('groupChat', { supabase: { rpc: async () => ({ data: null, error: failure }) }, mocks: { './media': {} } });
  await expect(lib.voteGroupProof('A', 'proof-1', true)).rejects.toMatchObject(failure);
});

it('your own votes are read in one request for the proofs on screen, and none are asked for when there are no proofs', async () => {
  const filters = [];
  const from = vi.fn((table) => {
    const chain = query({ data: [{ proof_id: 'p1', legit: true }, { proof_id: 'p2', legit: false }], error: null });
    chain.select = (columns) => { filters.push(['select', table, columns]); return chain; };
    chain.eq = (column, value) => { filters.push(['eq', column, value]); return chain; };
    chain.in = (column, values) => { filters.push(['in', column, values]); return chain; };
    return chain;
  });
  const lib = loadLibrary('groupChat', { supabase: { from }, mocks: { './media': {} } });
  expect([...(await lib.fetchMyProofVotes('A', ['p1', 'p2']))]).toEqual([['p1', true], ['p2', false]]);
  expect(filters).toEqual([['select', 'group_proof_votes', 'proof_id, legit'], ['eq', 'user_id', 'A'], ['in', 'proof_id', ['p1', 'p2']]]);
  expect((await lib.fetchMyProofVotes('A', [])).size).toBe(0);
  expect(from).toHaveBeenCalledTimes(1);
});

it('if your votes can\'t be read, the error comes back (so the screen keeps the votes it shows)', async () => {
  const failure = { message: 'Network request failed' };
  const from = vi.fn(() => {
    const chain = query({ data: null, error: failure });
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.in = () => chain;
    return chain;
  });
  const lib = loadLibrary('groupChat', { supabase: { from }, mocks: { './media': {} } });
  await expect(lib.fetchMyProofVotes('A', ['p1'])).rejects.toMatchObject(failure);
});

it('the app\'s "does this proof count?" rule (tests/unit/group-proof-parity.test.mjs checks it against the database)', () => {
  const lib = loadLibrary('groupChat', { mocks: { './media': {} } });
  const cases = [
    [{ proof_legit: 0, proof_cap: 0, proof_legacy: false }, 'waiting', false],
    [{ proof_legit: 0, proof_cap: 0, proof_legacy: true }, 'legacy', true],
    [{ proof_legit: 1, proof_cap: 0, proof_legacy: false }, 'counts', true],
    [{ proof_legit: 1, proof_cap: 1, proof_legacy: true }, 'tie', false],
    [{ proof_legit: 0, proof_cap: 1, proof_legacy: true }, 'cap', false],
    [{ proof_legit: 3, proof_cap: 2, proof_legacy: false }, 'counts', true],
    [{}, 'legacy', true], // a server without votes yet: the old rule
  ];
  for (const [proof, outcome, counts] of cases) {
    expect(lib.proofOutcome(proof)).toBe(outcome);
    expect(lib.proofCounts(proof)).toBe(counts);
  }
});

it('a live group chat change says what happened and which message', () => {
  const handlers = [];
  const channel = { on: (_kind, _filter, handler) => { handlers.push(handler); return channel; }, subscribe: () => channel };
  const lib = loadLibrary('groupChat', { supabase: { channel: () => channel, removeChannel: () => {} }, mocks: { './media': {} } });
  const changes = [];
  const stop = lib.subscribeToGroupChat('test-group', (change) => changes.push(change));
  handlers[0]({ eventType: 'UPDATE', new: { id: 'p1', proof_legit: 2, proof_cap: 0 }, old: { id: 'p1' } });
  handlers[0]({ eventType: 'DELETE', new: {}, old: { id: 'gone' } });
  handlers[0]({ eventType: 'INSERT', new: { id: 'm2', body: 'hi' }, old: {} });
  expect(changes).toEqual([
    { event: 'UPDATE', message: { id: 'p1', proof_legit: 2, proof_cap: 0 } },
    { event: 'DELETE', message: { id: 'gone' } },
    { event: 'INSERT', message: { id: 'm2', body: 'hi' } },
  ]);
  stop();
});
