import { expect, it, vi } from 'vitest';
import { query } from '../api/edgeHarness.mjs';
import { loadLibrary } from './libHarness.mjs';

// Deleting a message removes its row first, then tidies up its photo or voice file.
// Once the row is gone the message IS deleted, so a failed tidy-up must not be shown as "could not delete".

const peek = { id: 'm1', sender_id: 'A', recipient_id: 'B', kind: 'snap', media_path: 'A/snaps/p.jpg', poster_path: null, overlay_path: null };

function chatLibrary({ deleteResult = { data: null, error: null }, rpc = async () => ({ data: true, error: null }), remove = vi.fn(async () => {}) } = {}) {
  const deletes = [];
  const lib = loadLibrary('chat', {
    supabase: {
      from: (table) => { const chain = query(deleteResult); chain.delete = () => { deletes.push(table); return chain; }; return chain; },
      rpc,
    },
    mocks: { './media': { deleteMedia: remove, mediaFiles: (p) => [p.media_path, p.poster_path, p.overlay_path].filter(Boolean) } },
  });
  return { lib, deletes, remove };
}

it('a deleted peek whose file cannot be removed still counts as deleted (the problem is only logged)', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const { lib, deletes, remove } = chatLibrary({ remove: vi.fn(async () => { throw new Error('Synthetic storage outage'); }) });
    await expect(lib.deleteMessage(peek)).resolves.toBeUndefined();
    expect(deletes).toEqual(['messages']);
    expect(remove).toHaveBeenCalledExactlyOnceWith(['A/snaps/p.jpg']);
    expect(warning).toHaveBeenCalled();
  } finally { warning.mockRestore(); }
});

it('a deleted voice note whose clean-up check throws (bad signal) still counts as deleted', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const voice = { ...peek, kind: 'voice', media_path: 'A/voice/v.m4a' };
    const { lib, remove } = chatLibrary({ rpc: async () => { throw new TypeError('Network request failed'); } });
    await expect(lib.deleteMessage(voice)).resolves.toBeUndefined();
    expect(remove).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalled();
  } finally { warning.mockRestore(); }
});

it('a message the server refuses to delete still reports the error, and its file is left alone', async () => {
  const failure = { message: 'permission denied', code: '42501' };
  const { lib, remove } = chatLibrary({ deleteResult: { data: null, error: failure } });
  await expect(lib.deleteMessage(peek)).rejects.toMatchObject(failure);
  expect(remove).not.toHaveBeenCalled();
});

it('a deleted peek whose file is no longer needed has its file removed', async () => {
  const { lib, remove } = chatLibrary();
  await expect(lib.deleteMessage(peek)).resolves.toBeUndefined();
  expect(remove).toHaveBeenCalledExactlyOnceWith(['A/snaps/p.jpg']);
});
