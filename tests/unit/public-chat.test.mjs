import { expect, it } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

// The public chat's data code (src/lib/publicChat.ts): photos only, and a failed post leaves no file behind.
function load({ insertError = null, status = 'ok', statusError = null, channel = 'testing' } = {}) {
  const done = { uploaded: [], deleted: [], inserted: [] };
  const lib = loadLibrary('publicChat', {
    supabase: {
      rpc: async (name) => (name === 'public_chat_status' ? { data: status, error: statusError } : { data: true, error: null }),
      from: () => ({ insert: async (row) => { done.inserted.push(row); return { error: insertError }; } }),
    },
    mocks: {
      './lensDiagnostics': { updateChannel: () => channel },
      './media': {
        uploadCapture: async (me, folder, capture) => {
          done.uploaded.push([me, folder, capture.kind]);
          return { fields: { media_path: `${me}/${folder}/photo.jpg` } };
        },
        deleteMedia: async (paths) => { done.deleted.push(...paths); },
      },
    },
  });
  return { lib, done };
}

it('a photo is uploaded to your public folder and posted with only its path (the server fills in the rest)', async () => {
  const { lib, done } = load();
  await lib.sendPublicPhoto('alice', { kind: 'photo', uri: 'file://a.jpg' });
  expect(done.uploaded).toEqual([['alice', 'public', 'photo']]);
  expect(done.inserted).toEqual([{ media_path: 'alice/public/photo.jpg' }]);
  expect(done.deleted).toEqual([]);
});

it('videos are refused before anything is uploaded', async () => {
  const { lib, done } = load();
  await expect(lib.sendPublicPhoto('alice', { kind: 'video', uri: 'file://a.mp4' })).rejects.toThrow(/photos only/);
  expect(done.uploaded).toEqual([]);
});

it('when the server says no (slow mode, under 18), the uploaded file is removed again', async () => {
  const { lib, done } = load({ insertError: new Error('Slow mode is on') });
  await expect(lib.sendPublicPhoto('alice', { kind: 'photo', uri: 'file://a.jpg' })).rejects.toThrow(/Slow mode/);
  expect(done.deleted).toEqual(['alice/public/photo.jpg']);
});

it('your place in the room: the server\'s answer, or "unavailable" when it can\'t be asked', async () => {
  expect(await load({ status: 'under_18' }).lib.fetchPublicChatStatus()).toBe('under_18');
  expect(await load({ status: 'no_birthday' }).lib.fetchPublicChatStatus()).toBe('no_birthday');
  expect(await load({ status: null, statusError: new Error('no such function') }).lib.fetchPublicChatStatus()).toBe('unavailable');
  expect(await load({ status: 'something else' }).lib.fetchPublicChatStatus()).toBe('unavailable');
});

it('the public chat is only switched on for the testing channel: everywhere else the server is not even asked', async () => {
  for (const channel of ['production', 'preview', null]) {
    const { lib } = load({ channel, status: 'ok' });
    expect(lib.PUBLIC_CHAT_FOR_EVERYONE).toBe(false);
    expect(lib.publicChatSwitchedOn()).toBe(false);
    expect(await lib.fetchPublicChatStatus()).toBe('unavailable');
  }
  const { lib } = load({ channel: 'testing', status: 'ok' });
  expect(lib.publicChatSwitchedOn()).toBe(true);
  expect(await lib.fetchPublicChatStatus()).toBe('ok');
});
