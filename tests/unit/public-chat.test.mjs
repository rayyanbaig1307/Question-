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

it('the public chat is on for everyone since 22 Nov: every channel asks the server (which still checks 18+)', async () => {
  for (const channel of ['production', 'testing', 'preview', null]) {
    const { lib } = load({ channel, status: 'ok' });
    expect(lib.PUBLIC_CHAT_FOR_EVERYONE).toBe(true);
    expect(lib.publicChatSwitchedOn()).toBe(true);
    expect(await lib.fetchPublicChatStatus()).toBe('ok');
    expect(await load({ channel, status: 'under_18' }).lib.fetchPublicChatStatus()).toBe('under_18');
  }
});

it('deleting your own photo removes its row and then its file, without asking can_cleanup_snap (it always says no for public files)', async () => {
  const done = { deleted: [], rpcs: [], rows: [] };
  const lib = loadLibrary('publicChat', {
    supabase: {
      rpc: async (name) => { done.rpcs.push(name); return { data: false, error: null }; },
      from: () => ({ delete: () => ({ eq: async (column, value) => { done.rows.push([column, value]); return { error: null }; } }) }),
    },
    mocks: {
      './lensDiagnostics': { updateChannel: () => 'production' },
      './media': { uploadCapture: async () => ({ fields: {} }), deleteMedia: async (paths) => { done.deleted.push(...paths); } },
    },
  });
  await lib.deletePublicPhoto({ id: 'p1', media_path: 'alice/public/photo.jpg' });
  expect(done.rows).toEqual([['id', 'p1']]);
  expect(done.deleted).toEqual(['alice/public/photo.jpg']);
  expect(done.rpcs).toEqual([]);
});

it('if the row cannot be deleted, the file is left alone', async () => {
  const done = { deleted: [] };
  const lib = loadLibrary('publicChat', {
    supabase: { rpc: async () => ({ data: true, error: null }), from: () => ({ delete: () => ({ eq: async () => ({ error: new Error('nope') }) }) }) },
    mocks: {
      './lensDiagnostics': { updateChannel: () => 'production' },
      './media': { uploadCapture: async () => ({ fields: {} }), deleteMedia: async (paths) => { done.deleted.push(...paths); } },
    },
  });
  await expect(lib.deletePublicPhoto({ id: 'p1', media_path: 'alice/public/photo.jpg' })).rejects.toThrow('nope');
  expect(done.deleted).toEqual([]);
});

// ---- Messages and stickers (20270102000000_public_chat_text.sql) ----
// A fake server for the messages: records what is sent, answers like PostgREST.
function room({ photos = [], messages = [], messagesError = null, messagesStatus = 200, sendError = null } = {}) {
  const done = { sent: [], deleted: [], channels: [], removed: [] };
  const query = (table) => {
    const rows = table === 'public_photos' ? photos : messages;
    const error = table === 'public_messages' ? messagesError : null;
    const status = table === 'public_messages' ? messagesStatus : 200;
    const chain = { select: () => chain, order: () => chain, limit: async () => ({ data: error ? null : rows, error, status }) };
    return chain;
  };
  const lib = loadLibrary('publicChat', {
    supabase: {
      from: (table) => ({
        ...query(table),
        insert: (row) => ({
          select: () => ({
            single: async () => {
              done.sent.push([table, row]);
              return sendError ? { data: null, error: sendError } : { data: { id: 'new', sender_id: 'alice', created_at: 'now', hidden: false, ...row }, error: null };
            },
          }),
        }),
        delete: () => ({ eq: async (column, value) => { done.deleted.push([table, column, value]); return { error: null }; } }),
      }),
      channel: (name) => {
        const channel = { name, tables: [], on: (kind, filter) => { channel.tables.push(filter.table); return channel; }, subscribe: () => channel };
        done.channels.push(channel);
        return channel;
      },
      removeChannel: (channel) => done.removed.push(channel.name),
    },
    mocks: { './lensDiagnostics': { updateChannel: () => 'production' }, './media': { uploadCapture: async () => ({}), deleteMedia: async () => {} } },
  });
  return { lib, done };
}

it('a message is tidied and sent as text (the server fills in who and when)', async () => {
  const { lib, done } = room();
  const sent = await lib.sendPublicText('  hi   there\n\nyou  ');
  expect(done.sent).toEqual([['public_messages', { kind: 'text', body: 'hi there you' }]]);
  expect(sent.body).toBe('hi there you');
});

it('links, phone numbers, slurs and empty or too long messages are stopped before anything is sent', async () => {
  const { lib, done } = room();
  await expect(lib.sendPublicText('go to example.com')).rejects.toThrow("Links aren't allowed in the public chat.");
  await expect(lib.sendPublicText('call 555 123 4567')).rejects.toThrow("Phone numbers aren't allowed in the public chat.");
  await expect(lib.sendPublicText('you f4ggot')).rejects.toThrow("That word isn't allowed on Peekaboo.");
  await expect(lib.sendPublicText('   ')).rejects.toThrow('Messages can be 1 to 300 characters.');
  await expect(lib.sendPublicText('a'.repeat(301))).rejects.toThrow('Messages can be 1 to 300 characters.');
  expect(done.sent).toEqual([]);
  // Swearing is allowed (the owner's choice), and 300 emoji are 300 characters.
  expect(lib.checkPublicText('this is fucking great')).toBe(null);
  expect(lib.checkPublicText('😂'.repeat(300))).toBe(null);
  // Nothing you can see (zero-width spaces, a Hangul filler, a blank braille cell), or a pile of accent marks.
  await expect(lib.sendPublicText('\u200B\u200B\u200B')).rejects.toThrow('Messages can be 1 to 300 characters.');
  expect(lib.checkPublicText('\u3164')).toBe('Messages can be 1 to 300 characters.');
  expect(lib.checkPublicText(`a${'\u0301'.repeat(20)}`)).toBe('Too many accent marks on one letter.');
  expect(lib.hasPublicText('\u2800 \u200B')).toBe(false);
  expect(done.sent).toEqual([]);
});

it('a direction character is taken out before sending, so reversed text can\'t show up as a link', async () => {
  const { lib, done } = room();
  await lib.sendPublicText('go to \u202Emoc.elpmaxe\u202C now');
  expect(done.sent).toEqual([['public_messages', { kind: 'text', body: 'go to moc.elpmaxe now' }]]);
  await expect(lib.sendPublicText('\u202Dexample.com\u202C')).rejects.toThrow("Links aren't allowed in the public chat.");
});

it('a link or phone number in your name or username: you can\'t post, and it isn\'t shown in the room', () => {
  const { lib } = room();
  const words = 'Your name or username looks like a link or a phone number. Change it in Edit profile to post in the public chat.';
  expect(lib.checkPublicName({ username: 'jess', display_name: 'add me t.me/promo123 📲' })).toBe(words);
  expect(lib.checkPublicName({ username: 'promo123.com', display_name: 'Jess' })).toBe(words);
  expect(lib.checkPublicName({ username: 'jess', display_name: 'Jess 07911 123456' })).toBe(words);
  expect(lib.checkPublicName({ username: 'jess.smith', display_name: 'Jess 🌸' })).toBe(null);
  expect(lib.checkPublicName(null)).toBe(null);
  expect(lib.publicChatName({ username: 'jess', display_name: 'Jess 🌸' })).toBe('Jess 🌸');
  expect(lib.publicChatName({ username: 'jess', display_name: 'add me t.me/promo123' })).toBe('jess');
  expect(lib.publicChatName({ username: 'promo123.com', display_name: 'site dot com' })).toBe('Someone');
  expect(lib.publicChatName({ username: 'jess', display_name: null })).toBe('jess');
  expect(lib.publicChatName(null)).toBe('Someone');
});

it('a sticker is sent by its name only; the server\'s "no" (slow mode, Peekaboo+) comes back as it is', async () => {
  const { lib, done } = room();
  await lib.sendPublicSticker('googly-eyes');
  expect(done.sent).toEqual([['public_messages', { kind: 'sticker', sticker: 'googly-eyes' }]]);
  const slow = room({ sendError: new Error('Slow mode is on – one message every 5 seconds 🐢') });
  await expect(slow.lib.sendPublicSticker('word-lol')).rejects.toThrow(/Slow mode/);
});

it('the room: photos and messages newest first; photos only when the server has no messages yet', async () => {
  const photos = [{ id: 'p1', created_at: '2026-11-22T10:00:02Z' }];
  const messages = [{ id: 'm2', kind: 'text', created_at: '2026-11-22T10:00:03Z' }, { id: 'm1', kind: 'text', created_at: '2026-11-22T10:00:01Z' }];
  const both = await room({ photos, messages }).lib.fetchPublicChat();
  expect(both.textOn).toBe(true);
  expect(both.items.map((item) => item.id)).toEqual(['m2', 'p1', 'm1']);
  expect(both.items[1].kind).toBe('photo');
  // A server without the table (PostgREST's "no such table", the database's, a 404), or with messages switched off
  // (no permission): photos only.
  for (const [messagesError, messagesStatus] of [
    [{ code: 'PGRST205', message: "Could not find the table 'public.public_messages' in the schema cache" }, 404],
    [{ code: '42P01', message: 'relation "public.public_messages" does not exist' }, 404],
    [{ code: '42501', message: 'permission denied for table public_messages' }, 403],
    [{ message: 'Not found' }, 404],
  ]) {
    const old = await room({ photos, messagesError, messagesStatus }).lib.fetchPublicChat();
    expect(old.textOn, JSON.stringify(messagesError)).toBe(false);
    expect(old.items.map((item) => item.id)).toEqual(['p1']);
  }
});

it('any other error loading the messages is a real error, not "this server has no messages"', async () => {
  const photos = [{ id: 'p1', created_at: '2026-11-22T10:00:02Z' }];
  for (const [messagesError, messagesStatus] of [
    [{ message: 'TypeError: Network request failed' }, 0],
    [{ code: '57014', message: 'canceling statement due to statement timeout' }, 500],
    [{ code: 'PGRST301', message: 'JWT expired' }, 401],
    [{ message: 'Bad gateway' }, 502],
  ]) {
    await expect(room({ photos, messagesError, messagesStatus }).lib.fetchPublicChat()).rejects.toBe(messagesError);
  }
  expect(room().lib.serverHasNoMessages(null, 200)).toBe(false);
});

it('when a list was cut short, the room stops where it ran out (no gap)', () => {
  const { lib } = room();
  const photos = [{ id: 'p', created_at: '2026-11-22T09:00:00Z' }];
  const messages = [{ id: 'm2', created_at: '2026-11-22T10:00:02Z' }, { id: 'm1', created_at: '2026-11-22T10:00:01Z' }];
  // Only 2 messages fit: the photo is older than the oldest one, so it waits until the messages before it load.
  expect(lib.mergePublicChat(photos, messages, 60, 2).map((item) => item.id)).toEqual(['m2', 'm1']);
  expect(lib.mergePublicChat(photos, messages, 60, 100).map((item) => item.id)).toEqual(['m2', 'm1', 'p']);
});

it('live updates: photos always, messages only when the server has them; leaving stops both', () => {
  const { lib, done } = room();
  const stopOld = lib.subscribeToPublicChat(() => {});
  expect(done.channels.map((c) => c.tables.join())).toEqual(['public_photos']);
  stopOld();
  const stop = lib.subscribeToPublicChat(() => {}, { text: true });
  expect(done.channels.slice(1).map((c) => c.tables.join())).toEqual(['public_photos', 'public_messages']);
  stop();
  expect(done.removed.length).toBe(3);
});

it('you delete your own message by its id', async () => {
  const { lib, done } = room();
  await lib.deletePublicMessage('m1');
  expect(done.deleted).toEqual([['public_messages', 'id', 'm1']]);
});
