import { expect, it } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

// 👀 Group snaps (src/lib/groupChat.ts) and 📷 one-on-one photos from Photos (src/lib/chat.ts), against the server
// contract of supabase/migrations/20261229000000_group_snaps.sql.

// A fake server: records inserts, RPCs, uploads and removed files. `insertError`: what an insert answers with.
// `inserted`: the row an insert with .select() gives back. `rpc`: answers per function name.
function backend({ insertError = null, inserted = { id: 'new-row', saved_at: null }, rpc = {}, selectRows = [] } = {}) {
  const calls = { inserts: [], rpc: [], uploads: [], removed: [], selects: [] };
  const bucket = {
    upload: async (path) => { calls.uploads.push(path); return { error: null }; },
    remove: async (paths) => { calls.removed.push(...paths); return { error: null }; },
  };
  const supabase = {
    auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
    storage: { from: () => bucket },
    rpc: async (name, args) => { calls.rpc.push([name, args]); return rpc[name] ?? { data: true, error: null }; },
    from: (table) => {
      const chain = {
        insert(row) { calls.inserts.push({ table, row }); return chain; },
        select(columns) { calls.selects.push({ table, columns }); return chain; },
        in(column, values) { calls.selects.push({ table, in: [column, values] }); return chain; },
        eq() { return chain; },
        single() { return chain; },
        maybeSingle() { return chain; },
        then(resolve, reject) {
          const last = calls.inserts.at(-1);
          const answer = last && last.table === table
            ? { data: insertError ? null : inserted, error: insertError }
            : { data: selectRows, error: null };
          return Promise.resolve(answer).then(resolve, reject);
        },
      };
      return chain;
    },
  };
  const load = (name) => loadLibrary(name, { supabase });
  return { load, calls };
}

const photo = { kind: 'photo', uri: 'file:///photo.jpg' };

it('a group snap is uploaded to YOUR snaps folder (never the group folder) and saved as kind snap', async () => {
  const b = backend();
  await b.load('groupChat').sendGroupSnap('A', 'squad', photo);
  expect(b.calls.uploads).toEqual(['A/snaps/test-file.jpg']);
  expect(b.calls.inserts).toEqual([{ table: 'group_messages', row: { group_id: 'squad', kind: 'snap', media_path: 'A/snaps/test-file.jpg', media_type: 'photo', poster_path: null, overlay_path: null } }]);
  expect(JSON.stringify(b.calls.inserts[0].row)).not.toMatch(/saved_at|body|dare_id/);
});

it('a refused group snap removes its upload and keeps the real reason', async () => {
  const no = { code: '42501', message: 'new row violates row-level security policy' };
  const b = backend({ insertError: no });
  await expect(b.load('groupChat').sendGroupSnap('A', 'squad', photo)).rejects.toBe(no);
  expect(b.calls.removed).toEqual(['A/snaps/test-file.jpg']);
});

it('a server without group snaps yet: the snap is NOT sent as a normal photo; you are told what to do', async () => {
  for (const constraint of ['group_messages_kind_check', 'group_messages_content']) {
    const b = backend({ insertError: { code: '23514', message: `new row for relation "group_messages" violates check constraint "${constraint}"` } });
    const groupChat = b.load('groupChat');
    await expect(groupChat.sendGroupSnap('A', 'squad', photo)).rejects.toThrow(groupChat.SNAPS_NOT_READY);
    expect(b.calls.inserts).toHaveLength(1);
    expect(b.calls.removed).toEqual(['A/snaps/test-file.jpg']);
  }
});

it('a photo picked from Photos for the group still goes to the group folder as a normal photo', async () => {
  const b = backend();
  await b.load('groupChat').sendGroupCapture('A', 'squad', photo);
  expect(b.calls.uploads).toEqual(['A/group/test-file.jpg']);
  expect(b.calls.inserts[0].row.kind).toBe('photo');
});

it('open / replay / save call the server functions with the contract names and arguments', async () => {
  const b = backend({ rpc: { open_group_snap: { data: true, error: null }, replay_group_snap: { data: false, error: null }, set_group_snap_saved: { data: true, error: null } } });
  const groupChat = b.load('groupChat');
  await expect(groupChat.openGroupSnap('s1')).resolves.toBe(true);
  await expect(groupChat.replayGroupSnap('s1')).resolves.toBe(false);
  await expect(groupChat.setGroupSnapSaved('s1', true)).resolves.toBe(true);
  expect(b.calls.rpc).toEqual([
    ['open_group_snap', { message: 's1' }],
    ['replay_group_snap', { message: 's1' }],
    ['set_group_snap_saved', { message: 's1', save: true }],
  ]);
});

it('a screenshot of a group snap asks the server to tell its sender; true only when they were told', async () => {
  const told = backend({ rpc: { group_snap_screenshot: { data: true, error: null } } });
  await expect(told.load('groupChat').groupSnapScreenshot('s1')).resolves.toBe(true);
  expect(told.calls.rpc).toEqual([['group_snap_screenshot', { message: 's1' }]]);
  const notTold = backend({ rpc: { group_snap_screenshot: { data: false, error: null } } });
  await expect(notTold.load('groupChat').groupSnapScreenshot('s1')).resolves.toBe(false);
  const failed = backend({ rpc: { group_snap_screenshot: { data: null, error: new Error('offline') } } });
  await expect(failed.load('groupChat').groupSnapScreenshot('s1')).rejects.toThrow('offline');
});

it('a snap opened on this phone but never shown can be tried again for a few minutes, per login', () => {
  const groupChat = backend().load('groupChat');
  const at = Date.parse('2026-11-21T12:00:00Z');
  expect(groupChat.groupSnapUnshown('A', 's1', at)).toBe(null);
  groupChat.noteGroupSnapUnshown('A', 's1', 'replay', at);
  expect(groupChat.groupSnapUnshown('A', 's1', at + 60_000)).toBe('replay');
  expect(groupChat.groupSnapUnshown('B', 's1', at + 60_000)).toBe(null, 'someone else signed in on this phone');
  expect(groupChat.groupSnapUnshown('A', 's1', at + groupChat.UNSHOWN_RETRY_MS)).toBe(null, 'the chat stops offering it');
  expect(groupChat.groupSnapUnshown('A', 's1', at + groupChat.UNSHOWN_RETRY_MS, 30_000)).toBe('replay', 'the viewer gives half a minute more');
  expect(groupChat.UNSHOWN_RETRY_MS + 30_000).toBeLessThan(5 * 60 * 1000);
  groupChat.forgetGroupSnapUnshown('A', 's1');
  expect(groupChat.groupSnapUnshown('A', 's1', at + 1)).toBe(null);
});

it('who opened which snap is read from group_snap_opens and grouped by snap', async () => {
  const rows = [
    { message_id: 's1', user_id: 'B', opened_at: '2026-11-21T07:00:00Z', replayed_at: null },
    { message_id: 's1', user_id: 'C', opened_at: '2026-11-21T07:01:00Z', replayed_at: '2026-11-21T07:02:00Z' },
    { message_id: 's2', user_id: 'B', opened_at: '2026-11-21T07:03:00Z', replayed_at: null },
  ];
  const b = backend({ selectRows: rows });
  const opens = await b.load('groupChat').fetchGroupSnapOpens(['s1', 's2']);
  // (Never session_id: which login opened it stays on the server, and the app isn't allowed to read it.)
  expect(b.calls.selects).toContainEqual({ table: 'group_snap_opens', columns: 'message_id,user_id,opened_at,replayed_at,screenshot_at' });
  expect(b.calls.selects).toContainEqual({ table: 'group_snap_opens', in: ['message_id', ['s1', 's2']] });
  expect(opens.get('s1').map((o) => o.user_id)).toEqual(['B', 'C']);
  expect(opens.get('s2')).toHaveLength(1);
  // Nothing to ask about: no request.
  const none = backend();
  expect((await none.load('groupChat').fetchGroupSnapOpens([])).size).toBe(0);
  expect(none.calls.selects).toEqual([]);
});

it('how a snap looks: new → replay → opened; expired after 24 h; sent before you joined; yours; saved', () => {
  const { groupSnapLook } = backend().load('groupChat');
  const now = Date.parse('2026-11-21T12:00:00Z');
  const snap = { sender_id: 'B', created_at: '2026-11-21T11:00:00Z', saved_at: null };
  const joined = '2026-11-01T00:00:00Z';
  expect(groupSnapLook(snap, 'A', undefined, joined, now)).toBe('new');
  expect(groupSnapLook(snap, 'A', { replayed_at: null }, joined, now)).toBe('replay');
  expect(groupSnapLook(snap, 'A', { replayed_at: '2026-11-21T11:30:00Z' }, joined, now)).toBe('opened');
  const old = { ...snap, created_at: '2026-11-20T11:59:00Z' };
  expect(groupSnapLook(old, 'A', undefined, joined, now)).toBe('expired');
  expect(groupSnapLook(old, 'A', { replayed_at: null }, joined, now)).toBe('opened', 'no replay after 24 hours');
  expect(groupSnapLook(snap, 'A', undefined, '2026-11-21T11:30:00Z', now)).toBe('before-joined');
  // Join time not known yet: the server decides, so you can try.
  expect(groupSnapLook(snap, 'A', undefined, null, now)).toBe('new');
  expect(groupSnapLook({ ...snap, sender_id: 'A' }, 'A', undefined, joined, now)).toBe('sent');
  expect(groupSnapLook({ ...old, saved_at: '2026-11-20T12:30:00Z' }, 'A', undefined, joined, now)).toBe('saved');
  // Opened on this phone a moment ago but it didn't load: "Tap to view" (it still counts as the first look), also
  // when the opens haven't loaded yet and also after a replay that didn't load.
  expect(groupSnapLook(snap, 'A', { replayed_at: null }, joined, now, true)).toBe('retry');
  expect(groupSnapLook(snap, 'A', undefined, joined, now, true)).toBe('retry');
  expect(groupSnapLook(snap, 'A', { replayed_at: '2026-11-21T11:59:00Z' }, joined, now, true)).toBe('retry');
  expect(groupSnapLook({ ...snap, sender_id: 'A' }, 'A', undefined, joined, now, true)).toBe('sent');
});

it('who may save or unsave a snap (the same rule as set_group_snap_saved)', () => {
  const { canSaveGroupSnap, canUnsaveGroupSnap } = backend().load('groupChat');
  const now = Date.parse('2026-11-21T12:00:00Z');
  const snap = { kind: 'snap', sender_id: 'B', created_at: '2026-11-21T11:00:00Z', saved_at: null, saved_by: null };
  expect(canSaveGroupSnap(snap, 'A', undefined, now)).toBe(false);
  expect(canSaveGroupSnap(snap, 'A', { replayed_at: null }, now)).toBe(true);
  expect(canSaveGroupSnap(snap, 'B', undefined, now)).toBe(true);
  expect(canSaveGroupSnap({ ...snap, created_at: '2026-11-20T11:00:00Z' }, 'B', undefined, now)).toBe(false);
  expect(canSaveGroupSnap({ ...snap, kind: 'photo' }, 'B', undefined, now)).toBe(false);
  const saved = { ...snap, saved_at: '2026-11-21T11:10:00Z', saved_by: 'C' };
  expect(canSaveGroupSnap(saved, 'C', {}, now)).toBe(false);
  expect(canUnsaveGroupSnap(saved, 'C')).toBe(true);
  expect(canUnsaveGroupSnap(saved, 'B')).toBe(true);
  expect(canUnsaveGroupSnap(saved, 'A')).toBe(false);
  expect(canUnsaveGroupSnap(snap, 'B')).toBe(false);
});

// ---------------------------------------------------------------------------
// 📷 One-on-one: a picture from Photos = a peek saved from the start (old app versions show it as a saved peek).
// ---------------------------------------------------------------------------
it('a one-on-one photo is a snap row with saved_at set, in your snaps folder; the server saving it is enough', async () => {
  const b = backend({ inserted: { id: 'm1', saved_at: '2026-11-21T07:00:00.123456+00:00' } });
  await b.load('chat').sendChatPhoto('A', 'B', photo);
  expect(b.calls.uploads).toEqual(['A/snaps/test-file.jpg']);
  const { row } = b.calls.inserts[0];
  expect(row).toMatchObject({ sender_id: 'A', recipient_id: 'B', kind: 'snap', media_path: 'A/snaps/test-file.jpg', media_type: 'photo' });
  expect(typeof row.saved_at).toBe('string');
  expect(b.calls.selects).toContainEqual({ table: 'messages', columns: 'id,saved_at' });
  expect(b.calls.rpc).toEqual([], 'no extra save needed');
});

it('a server from before photos (it clears saved_at): the photo is saved straight after with set_snap_saved', async () => {
  const b = backend({ inserted: { id: 'm1', saved_at: null } });
  await b.load('chat').sendChatPhoto('A', 'B', photo);
  expect(b.calls.rpc).toEqual([['set_snap_saved', { message_id: 'm1', save: true }]]);
});

it('if that late save fails, the photo is still sent once (no error, so Send is not pressed again)', async () => {
  const b = backend({ inserted: { id: 'm1', saved_at: null }, rpc: { set_snap_saved: { data: null, error: { message: 'Network request failed' } } } });
  const warning = console.warn;
  console.warn = () => {};
  try {
    await expect(b.load('chat').sendChatPhoto('A', 'B', photo)).resolves.toBeUndefined();
    expect(b.calls.inserts).toHaveLength(1);
  } finally { console.warn = warning; }
});

it('a refused one-on-one photo removes its upload and keeps the real reason', async () => {
  const no = { code: 'P0001', message: 'You can only message friends' };
  const b = backend({ insertError: no });
  await expect(b.load('chat').sendChatPhoto('A', 'B', photo)).rejects.toBe(no);
  expect(b.calls.removed).toEqual(['A/snaps/test-file.jpg']);
});

it('isChatPhoto: saved by its sender at the moment it was sent; a peek saved later is not a photo', () => {
  const { isChatPhoto } = backend().load('chat');
  const base = { kind: 'snap', sender_id: 'A', created_at: '2026-11-21T07:00:00.123456+00:00' };
  expect(isChatPhoto({ ...base, saved_at: '2026-11-21T07:00:00.123456+00:00', saved_by: 'A' })).toBe(true);
  expect(isChatPhoto({ ...base, saved_at: '2026-11-21T07:05:00+00:00', saved_by: 'A' })).toBe(false);
  expect(isChatPhoto({ ...base, saved_at: '2026-11-21T07:00:00.123456+00:00', saved_by: 'B' })).toBe(false);
  expect(isChatPhoto({ ...base, saved_at: null, saved_by: null })).toBe(false);
  expect(isChatPhoto({ ...base, kind: 'text', saved_at: base.created_at, saved_by: 'A' })).toBe(false);
});
