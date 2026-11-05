import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { asUser, friend } from '../database/local-db.mjs';
import { startLocalRest } from './runtime.mjs';
import { createClient } from '@supabase/supabase-js';
import { loadLibrary } from '../unit/libHarness.mjs';

const original = process.env.QA_ORIGINAL === '1';
const stress = process.env.QA_STRESS === '1';
const writeRequests = stress ? 2400 : 240;
const writeConcurrency = stress ? 64 : 24;
const readRequests = stress ? 10000 : 1000;
const readConcurrency = stress ? 128 : 32;
const runtime = await startLocalRest({ includeFixes: !original, syntheticUsers: stress ? 100 : 40 });
const { users, db, request, token } = runtime;
const checks = [];
const metrics = [];
const knownIssues = [];
let post, message, group, groupMessage;
const own = (index, sql, params = []) => asUser(db, users[index], tx => tx.query(sql, params));
const check = async (name, fn) => {
  try { await fn(); checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { checks.push({ name, passed: false, error: error.message }); console.log(`FAIL ${name}: ${error.message}`); }
};
try {
  post = (await own(0, 'insert into posts(user_id,media_path,caption) values($1,$2,$3) returning id', [users[0], `${users[0]}/posts/rest.jpg`, 'REST fixture'])).rows[0].id;
  message = (await own(0, "insert into messages(sender_id,recipient_id,kind,body) values($1,$2,'text','private hello') returning id", [users[0], users[1]])).rows[0].id;
  await friend(db, users[4], users[5]);
  group = (await own(4, "select create_peek_group('REST test group',$1::uuid[],current_date) as id", [[users[5]]])).rows[0].id;
  groupMessage = (await own(4, "insert into group_messages(group_id,sender_id,body) values($1,$2,'group secret') returning id", [group, users[4]])).rows[0].id;

  await check('valid signed JWT reads its authorized public data', async () => {
    const result = await request(`posts?id=eq.${post}`);
    assert.equal(result.status, 200); assert.equal(result.data[0].id, post);
  });
  await check('anonymous request cannot read profile rows', async () => {
    const result = await request('profiles?select=id', { user: null });
    assert.equal(result.status, 200); assert.deepEqual(result.data, []);
  });
  for (const [name, jwt] of [
    ['expired token', token(0, { exp: Math.floor(Date.now()/1000)-300 })],
    ['future token', token(0, { nbf: Math.floor(Date.now()/1000)+300 })],
    ['wrong signature', token(0, {}, 'different-local-test-key-which-is-long-enough')],
    ['malformed token', 'not-a-jwt'],
    ['forged service role without signature', token(0).replace(/\.[^.]+$/, '.forged')],
  ]) {
    await check(`real HTTP gateway rejects ${name}`, async () => {
      const result = await request('profiles?select=id', { jwt });
      assert.equal(result.status, 401); assert.equal(Array.isArray(result.data), false);
    });
  }
  await check('authenticator cannot assume ungranted service role', async () => {
    const result = await request('profiles?select=id', { jwt: token(0, { role: 'service_role' }) });
    assert.equal(result.status, 403);
  });
  await check('other account cannot update profile through HTTP', async () => {
    const result = await request(`profiles?id=eq.${users[0]}`, { user: 2, method: 'PATCH', body: { bio: 'stolen' }, headers: { Prefer: 'return=representation' } });
    assert.equal(result.status, 200); assert.deepEqual(result.data, []);
    assert.equal((await db.query('select bio from profiles where id=$1', [users[0]])).rows[0].bio, '');
  });
  await check('owner can update and read their profile through HTTP', async () => {
    const result = await request(`profiles?id=eq.${users[0]}`, { method: 'PATCH', body: { bio: 'QA 👀 bio' }, headers: { Prefer: 'return=representation' } });
    assert.equal(result.status, 200); assert.equal(result.data[0].bio, 'QA 👀 bio');
  });
  // OPEN-05: in a search pattern "_" means "any one letter". The app now sends "\_" so that a search for
  // "qsrch_ab_c" finds only that exact start, not look-alikes such as "qsrch_abxc".
  await check('username search with an escaped underscore is an exact "starts with" through REST', async () => {
    const names = ['qsrch_ab_c', 'qsrch_ab_c.two', 'qsrch_abxc', 'qsrchxab_c'];
    for (const [n, username] of names.entries()) {
      await db.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)', [
        `00000000-0000-4000-8005-${String(n + 1).padStart(12, '0')}`, `search${n}@example.invalid`, { username, display_name: `Search ${n}` },
      ]);
    }
    const search = async pattern => {
      const result = await request(`profiles?select=username&username=ilike.${encodeURIComponent(pattern)}&order=username`, { user: 1 });
      assert.equal(result.status, 200); return result.data.map(row => row.username);
    };
    // What the app sends now (likePrefix in src/lib/friends.ts).
    assert.deepEqual(await search('qsrch\\_ab\\_c%'), ['qsrch_ab_c', 'qsrch_ab_c.two']);
    // What the app used to send: the look-alikes slipped in.
    assert.deepEqual(await search('qsrch_ab_c%'), ['qsrch_ab_c', 'qsrch_ab_c.two', 'qsrch_abxc', 'qsrchxab_c']);
  });
  // OPEN-05, end to end: the check above sends a hand-written pattern. This one runs the app's own
  // searchUsers (src/lib/friends.ts) through the real supabase-js client, so it fails if the app stops
  // escaping "_" (QA_ORIGINAL=1 loads the old friends.ts and this check fails there, as it should).
  await check("the app's own searchUsers through supabase-js finds only real \"starts with\" matches", async () => {
    const names = ['qapp_ab_c', 'qapp_ab_c.two', 'qapp_abxc', 'qappxab_c'];
    for (const [n, username] of names.entries()) {
      await db.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)', [
        `00000000-0000-4000-8006-${String(n + 1).padStart(12, '0')}`, `appsearch${n}@example.invalid`, { username, display_name: `App search ${n}` },
      ]);
    }
    // supabase-js builds <url>/rest/v1/...; the local PostgREST serves the same API at its root.
    const sent = [];
    const supabase = createClient('http://local.invalid', 'local-test-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: {
        headers: { Authorization: `Bearer ${token(1)}` },
        fetch: (url, init) => {
          const local = String(url).replace('http://local.invalid/rest/v1', runtime.base);
          sent.push(decodeURIComponent(new URL(local).search));
          return fetch(local, init);
        },
      },
    });
    const { searchUsers } = loadLibrary('friends', { supabase });
    const find = async typed => (await searchUsers(typed, users[1])).map(row => row.username);

    assert.deepEqual(await find('qapp_ab_c'), ['qapp_ab_c', 'qapp_ab_c.two']);
    assert.ok(sent.at(-1).includes('username=ilike.qapp\\_ab\\_c%'), sent.at(-1));
    // Capital letters and a leading "@" are cleaned the same way.
    assert.deepEqual(await find('@QAPP_AB'), ['qapp_ab_c', 'qapp_ab_c.two', 'qapp_abxc']);
    // A search wildcard the person types does not widen the search.
    assert.deepEqual(await find('qapp%c'), []);
    assert.deepEqual(await find('qapp*c'), []);
    // A lone "_" finds only names that really start with "_", never every account.
    assert.ok((await find('_')).every(name => name.startsWith('_')));
  });
  await own(0, 'update profiles set is_private=true where id=$1', [users[0]]);
  await check('private profile posts stay hidden from a stranger through REST', async () => {
    const result = await request(`posts?id=eq.${post}`, { user: 2 });
    assert.equal(result.status, 200); assert.deepEqual(result.data, []);
  });
  await check('friend can read private profile posts through REST', async () => {
    const result = await request(`posts?id=eq.${post}`, { user: 1 });
    assert.equal(result.status, 200); assert.equal(result.data[0].id, post);
  });
  await check('explicit author foreign-key embedding works in actual PostgREST', async () => {
    const result = await request(`posts?id=eq.${post}&select=*,author:profiles!posts_user_id_fkey(*)`, { user: 1 });
    assert.equal(result.status, 200); assert.equal(result.data[0].author.id, users[0]);
  });
  await check('new computed post fields and author embedding work together', async () => {
    const result = await request(`posts?id=eq.${post}&select=*,group_hold,peek_stats,dare_hype,author:profiles!posts_user_id_fkey(*)`);
    assert.equal(result.status, 200); assert.equal(result.data[0].id, post);
  });
  await check('non-participant cannot read direct messages over HTTP', async () => {
    const result = await request(`messages?id=eq.${message}`, { user: 2 });
    assert.equal(result.status, 200); assert.deepEqual(result.data, []);
  });
  await check('the actual conversation story join is not ambiguous', async () => {
    const result = await request(`messages?id=eq.${message}&select=*,story:stories(media_path,media_type,poster_path)`, { user: 1 });
    assert.equal(result.status, 200); assert.equal(result.data[0].id, message);
  });
  await check('forged direct-message sender is rejected at HTTP boundary', async () => {
    const result = await request('messages', { user: 2, method: 'POST', body: { sender_id: users[0], recipient_id: users[1], kind: 'text', body: 'forged' } });
    assert.equal(result.status, 403);
  });
  await check('SQL and HTML shaped text stays literal through HTTP', async () => {
    const body = "👀 <script>globalThis.__qa_xss=1</script> '; DROP TABLE profiles; --";
    const result = await request('messages', { method: 'POST', body: { sender_id: users[0], recipient_id: users[1], kind: 'text', body }, headers: { Prefer: 'return=representation' } });
    assert.equal(result.status, 201); assert.equal(result.data[0].body, body);
    assert.ok((await db.query('select count(*)::int as n from profiles')).rows[0].n >= users.length);
  });
  for (const [label, route, body] of [
    ['empty text', 'messages', { sender_id: users[0], recipient_id: users[1], kind: 'text', body: '' }],
    ['huge text', 'messages', { sender_id: users[0], recipient_id: users[1], kind: 'text', body: 'x'.repeat(2001) }],
    ['wrong UUID type', 'messages', { sender_id: 42, recipient_id: users[1], kind: 'text', body: 'hello' }],
    ['negative voice duration', 'messages', { sender_id: users[0], recipient_id: users[1], kind: 'voice', media_path: `${users[0]}/voice/bad.m4a`, audio_ms: -1 }],
  ]) {
    await check(`HTTP rejects ${label}`, async () => {
      const result = await request(route, { method: 'POST', body }); assert.equal(result.status, 400);
    });
  }
  await check('batch insert is atomic when a later row is invalid', async () => {
    const before = (await db.query('select count(*)::int as n from posts')).rows[0].n;
    const result = await request('posts', { method: 'POST', body: [
      { user_id: users[0], media_path: `${users[0]}/posts/batch-a.jpg`, caption: 'valid first' },
      { user_id: users[0], media_path: `${users[0]}/posts/batch-b.jpg`, caption: 'x'.repeat(301) },
    ] });
    assert.equal(result.status, 400);
    assert.equal((await db.query('select count(*)::int as n from posts')).rows[0].n, before);
  });
  await check('duplicate like cannot create two records through REST', async () => {
    const body = { post_id: post, user_id: users[1] };
    assert.equal((await request('likes', { user: 1, method: 'POST', body })).status, 201);
    assert.equal((await request('likes', { user: 1, method: 'POST', body })).status, 409);
  });
  await check('group member can read messages with nested reply foreign key present', async () => {
    const result = await request(`group_messages?group_id=eq.${group}&select=*`, { user: 5 });
    assert.equal(result.status, 200); assert.equal(result.data[0].id, groupMessage);
  });
  await check('nonmember cannot read group text through REST', async () => {
    const result = await request(`group_messages?group_id=eq.${group}`, { user: 3 });
    assert.equal(result.status, 200); assert.deepEqual(result.data, []);
  });
  await check('nonmember cannot inject a group message over HTTP', async () => {
    const result = await request('group_messages', { user: 3, method: 'POST', body: { group_id: group, sender_id: users[3], body: 'intruder' } });
    assert.equal(result.status, 403);
  });
  await check('group summary RPC has correct sender and body', async () => {
    const result = await request('rpc/my_group_chats', { user: 5, method: 'POST', body: {} });
    assert.equal(result.status, 200); assert.equal(result.data.find(row => row.group_id === group).last_sender, users[4]);
  });
  await check('owner can pin a same-group message through RPC', async () => {
    const result = await request('rpc/pin_group_message', { user: 4, method: 'POST', body: { grp: group, message: groupMessage } });
    assert.equal(result.status, 204);
  });
  await check('nonmember cannot pin a group message', async () => {
    const result = await request('rpc/pin_group_message', { user: 3, method: 'POST', body: { grp: group, message: groupMessage } });
    assert.ok(result.status >= 400 && result.status < 500);
  });
  await check('member reaction can be created and read through REST', async () => {
    const result = await request('group_message_reactions', { user: 5, method: 'POST', body: { message_id: groupMessage, user_id: users[5], emoji: '❤️' }, headers: { Prefer: 'return=representation' } });
    assert.equal(result.status, 201); assert.equal(result.data[0].emoji, '❤️');
  });
  await check('nonmember cannot read group reactions', async () => {
    const result = await request(`group_message_reactions?message_id=eq.${groupMessage}`, { user: 3 });
    assert.equal(result.status, 200); assert.deepEqual(result.data, []);
  });
  await check('blocking a group sender hides their text through actual REST', async () => {
    assert.equal((await request('rpc/block_user', { user: 5, method: 'POST', body: { target: users[4] } })).status, 204);
    const result = await request(`group_messages?id=eq.${groupMessage}`, { user: 5 });
    assert.equal(result.status, 200); assert.deepEqual(result.data, []);
  });
  await check('group summaries do not reveal a blocked sender through RPC', async () => {
    const result = await request('rpc/my_group_chats', { user: 5, method: 'POST', body: {} });
    assert.equal(result.status, 200);
    assert.equal(result.data.find(row => row.group_id === group)?.last_sender ?? null, null);
  });
  await check('reactions cannot reveal a blocked group message through REST', async () => {
    const result = await request(`group_message_reactions?message_id=eq.${groupMessage}`, { user: 5 });
    assert.equal(result.status, 200); assert.deepEqual(result.data, []);
  });
  await check('removing a member immediately revokes REST access', async () => {
    assert.equal((await request(`peek_group_members?group_id=eq.${group}&user_id=eq.${users[5]}`, { user: 4, method: 'DELETE' })).status, 204);
    const result = await request(`group_messages?group_id=eq.${group}`, { user: 5 });
    assert.equal(result.status, 200); assert.deepEqual(result.data, []);
  });
  await check('activity cannot reveal a reply after post access is revoked', async () => {
    const p = (await own(6, 'insert into posts(user_id,media_path) values($1,$2) returning id', [users[6], `${users[6]}/posts/activity.jpg`])).rows[0].id;
    const parent = (await own(7, "insert into comments(post_id,user_id,body) values($1,$2,'my old comment') returning id", [p, users[7]])).rows[0].id;
    await own(8, "insert into comments(post_id,user_id,body,parent_id) values($1,$2,'private reply secret',$3)", [p, users[8], parent]);
    await own(6, 'update profiles set is_private=true where id=$1', [users[6]]);
    const result = await request('rpc/my_activity', { user: 7, method: 'POST', body: {} });
    assert.equal(result.status, 200); assert.equal(result.data.filter(row => row.post_id === p).length, 0);
  });
  await check('hidden direct message is absent in direct REST reads', async () => {
    assert.equal((await request('rpc/hide_message', { user: 1, method: 'POST', body: { message } })).status, 204);
    const result = await request(`messages?id=eq.${message}`, { user: 1 });
    assert.equal(result.status, 200); assert.deepEqual(result.data, []);
    assert.equal((await request(`messages?id=eq.${message}`)).data.length, 1);
  });
  for (const [name, body] of [
    ['media_cleanup_candidates', { max_files: 1000 }],
    ['media_cleanup_key_ok', { given: 'wrong' }],
    ['account_mystery_files', { account: users[0] }],
    ['reserve_username_auth_attempt', { attempt_kind: 'fail', attempt_key: 'user', max_attempts: 8, window_minutes: 15 }],
    ['claim_media_cleanup', { max_files: 1000 }],
    ['begin_account_media_deletion', { account: users[0] }],
  ]) {
    await check(`ordinary JWT cannot call privileged ${name}`, async () => {
      const result = await request(`rpc/${name}`, { user: 2, method: 'POST', body }); assert.ok([403,404].includes(result.status));
    });
  }
  // Username login limits: app users (signed in or not) cannot reserve tries or give them back.
  if (!original) {
    const reservation = '7c1f6a1e-2b4d-4c8a-9e0f-123456789abc';
    for (const [name, body] of [
      ['reserve_username_auth_attempt', { attempt_kind: 'fail', attempt_key: 'pair:rest@198.51.100.1', max_attempts: 8, window_minutes: 15, attempt_id: reservation }],
      ['refund_username_auth_attempt', { attempt_id: reservation }],
    ]) {
      for (const [who, user] of [['anonymous request', null], ['ordinary JWT', 2]]) {
        await check(`${who} cannot call username limit function ${name}`, async () => {
          await asUser(db, null, tx => tx.query("select public.reserve_username_auth_attempt('fail','pair:rest@198.51.100.1',8,15,$1)", [reservation]), 'service_role');
          const before = (await db.query('select count(*)::int as n from public.username_auth_log where reservation=$1', [reservation])).rows[0].n;
          const result = await request(`rpc/${name}`, { user, method: 'POST', body });
          assert.ok([401, 403, 404].includes(result.status), `status ${result.status}`);
          const after = (await db.query('select count(*)::int as n from public.username_auth_log where reservation=$1', [reservation])).rows[0].n;
          assert.equal(after, before);
        });
      }
    }
  }
  await check('HEAD count and pagination preserve authorization', async () => {
    const result = await request(`posts?id=eq.${post}&select=id&limit=1`, { user: 2, method: 'HEAD', headers: { Prefer: 'count=exact' } });
    assert.equal(result.status, 200); assert.match(result.headers.get('content-range'), /\/0$/);
  });
  await check('malformed filter and negative range return controlled errors', async () => {
    assert.equal((await request('posts?id=eq.not-a-uuid')).status, 400);
    const result = await request('posts?limit=-1'); assert.ok([400,416].includes(result.status));
  });
  await check('HTTP Storage metadata enforces the real owned-folder policy', async () => {
    const result = await request('objects', { user: 2, method: 'POST', body: { bucket_id: 'media', name: `${users[0]}/posts/stolen-upload.jpg` }, headers: { 'Content-Profile': 'storage' } });
    assert.equal(result.status, 403);
  });
  await check('reported file survives author content deletion through real HTTP', async () => {
    // Review DB-1: an app delete never fails and never shows whether the file was reported.
    // Two posts are made the same way; one is reported. The author deletes both posts and files.
    const storageHeaders = { 'Content-Profile': 'storage' };
    const views = {};
    const paths = {};
    for (const kind of ['reported', 'quiet']) {
      const path = `${users[0]}/posts/rest-${kind}-evidence.jpg`;
      paths[kind] = path;
      assert.equal((await request('objects', { method: 'POST', body: { bucket_id: 'media', name: path }, headers: storageHeaders })).status, 201);
      const inserted = await request('posts', { method: 'POST', body: { user_id: users[0], media_path: path, caption: `${kind} fixture` }, headers: { Prefer: 'return=representation' } });
      assert.equal(inserted.status, 201);
      const id = inserted.data[0].id;
      if (kind === 'reported') {
        assert.equal((await request('reports', { user: 1, method: 'POST', body: { reporter_id: users[1], reported_user_id: users[0], content_type: 'post', content_id: id, reason: 'spam' } })).status, 201);
      }
      assert.equal((await request(`posts?id=eq.${id}`, { method: 'DELETE' })).status, 204);
      const answer = async (result) => [result.status, result.data];
      const file = `objects?name=eq.${encodeURIComponent(path)}`;
      views[kind] = {
        // With return=representation the author sees how many file rows were really removed.
        remove: await answer(await request(file, { method: 'DELETE', headers: { ...storageHeaders, Prefer: 'return=representation' } })),
        listed: await answer(await request(`objects?select=name&name=eq.${encodeURIComponent(path)}`, { headers: { 'Accept-Profile': 'storage' } })),
        removeAgain: await answer(await request(file, { method: 'DELETE', headers: storageHeaders })),
      };
    }
    assert.deepEqual(views.reported, views.quiet, 'the author must get the same answers with and without a report');
    // The file is gone for the author at once; Storage gets no row back, so it deletes no bytes yet.
    assert.deepEqual(views.quiet.remove, [200, []]);
    assert.deepEqual(views.quiet.listed, [200, []]);
    const stored = async (path) => (await db.query('select count(*)::int as n from storage.objects where name=$1', [path])).rows[0].n;
    assert.deepEqual([await stored(paths.reported), await stored(paths.quiet)], [1, 1]);
    // The daily cleanup (service role, like supabase/functions/cleanup-media) really deletes the
    // unreported file and keeps the reported one as evidence.
    const service = (sql, args) => asUser(db, null, (tx) => tx.query(sql, args), 'service_role');
    const swept = (await service('select name from claim_media_cleanup(1000)')).rows.map((r) => r.name);
    assert.ok(swept.includes(paths.quiet) && !swept.includes(paths.reported), JSON.stringify(swept));
    await service("delete from storage.objects where bucket_id='media' and name = any($1)", [swept]);
    assert.deepEqual([await stored(paths.reported), await stored(paths.quiet)], [1, 0]);
    // After the cleanup the author still sees nothing either way.
    for (const path of Object.values(paths)) {
      const listed = await request(`objects?select=name&name=eq.${encodeURIComponent(path)}`, { headers: { 'Accept-Profile': 'storage' } });
      assert.deepEqual([listed.status, listed.data], [200, []], path);
    }
  });
  await check('the Community dares list loads with the app code (no ambiguous author link, no idea without its writer)', async () => {
    // dare_ideas links to profiles directly (user_id) and also through dare_votes, so a plain
    // "author:profiles(*)" is ambiguous and PostgREST answers 300 / PGRST201. The app must name the link.
    const idea = await request('dare_ideas', { user: 35, method: 'POST', body: { user_id: users[35], text: 'Sing the chorus of a song you love' }, headers: { Prefer: 'return=representation' } });
    assert.equal(idea.status, 201, JSON.stringify(idea.data));
    const supabase = createClient('http://local.invalid', 'local-test-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: {
        headers: { Authorization: `Bearer ${token(36)}` },
        fetch: (url, init) => fetch(String(url).replace('http://local.invalid/rest/v1', runtime.base), init),
      },
    });
    const memory = new Map();
    const AsyncStorage = { getItem: async key => memory.get(key) ?? null, setItem: async (key, value) => { memory.set(key, value); }, removeItem: async key => { memory.delete(key); } };
    const { fetchIdeas } = loadLibrary('communityDares', { supabase, mocks: { '@react-native-async-storage/async-storage': { __esModule: true, default: AsyncStorage } } });
    for (const sort of ['top', 'new']) {
      const ideas = await fetchIdeas(users[36], sort);
      const mine = ideas.find(row => row.id === idea.data[0].id);
      assert.ok(mine, `the new idea is listed (${sort})`);
      assert.equal(mine.author.id, users[35]);
      assert.equal(mine.mine, false);
    }
    // If the writer blocks you, their profile is hidden from you. Their idea must drop out of your list,
    // not arrive with no author (the screen would crash reading the author's name).
    const blocked = await request('rpc/block_user', { user: 35, method: 'POST', body: { target: users[36], expected_user_id: users[35] } });
    assert.ok(blocked.status < 300, JSON.stringify(blocked.data));
    const afterBlock = await fetchIdeas(users[36], 'new');
    assert.ok(afterBlock.every(row => row.author), 'no idea without its writer');
    assert.ok(!afterBlock.some(row => row.id === idea.data[0].id), "the blocker's idea is left out");
  });
  await check('a hidden dare idea cannot be reported directly through HTTP to learn who wrote it', async () => {
    // Final DB fix: with "return=representation" a direct report used to send back reported_user_id,
    // the writer of an idea that three reports had hidden.
    const made = await request('dare_ideas', { user: 30, method: 'POST', body: { user_id: users[30], text: 'Hop on one foot for a minute' }, headers: { Prefer: 'return=representation' } });
    assert.equal(made.status, 201);
    const idea = made.data[0].id;
    for (const n of [31, 32, 33]) assert.equal((await request('rpc/report_dare_idea', { user: n, method: 'POST', body: { idea, reason: 'spam' } })).status, 204);
    assert.equal((await db.query('select hidden from dare_ideas where id=$1', [idea])).rows[0].hidden, true);
    const direct = async (content_id) => {
      const result = await request('reports', { user: 34, method: 'POST', body: { reporter_id: users[34], reported_user_id: users[34], content_type: 'dare_idea', content_id, reason: 'spam' }, headers: { Prefer: 'return=representation' } });
      return [result.status, result.data?.message ?? result.data];
    };
    const hidden = await direct(idea);
    assert.equal(hidden[0], 400, JSON.stringify(hidden));
    assert.match(hidden[1], /gone or you can't see it/);
    assert.doesNotMatch(JSON.stringify(hidden), new RegExp(users[30]));
    // Same answer as for an idea that never existed.
    assert.deepEqual(hidden, await direct('00000000-0000-4000-8000-0000000000ff'));
  });
  await check('a still-valid deleted-account JWT cannot upload orphan media', async () => {
    const jwt = token(39);
    await db.query('delete from auth.users where id=$1', [users[39]]);
    const result = await request('objects', { jwt, method: 'POST', body: { bucket_id: 'media', name: `${users[39]}/posts/deleted-account.jpg` }, headers: { 'Content-Profile': 'storage' } });
    assert.equal(result.status, 403);
  });
  // Group dares: the group votes Legit 🔥 or Cap 🧢 on each proof (20261216000000_group_dare_votes.sql).
  // users[9] dares the group, users[14] posts proof, users[15] votes; users[3] is not in the group.
  if (!original) {
    await check('group dare proof votes through real REST: members vote, the poster and outsiders are refused, totals are live on the proof, leaving takes your vote away', async () => {
      await friend(db, users[9], users[14]);
      await friend(db, users[9], users[15]);
      const crew = (await own(9, "select create_peek_group('REST vote crew',$1::uuid[],current_date) as id", [[users[14], users[15]]])).rows[0].id;
      const dareId = (await own(9, "insert into group_messages(group_id,sender_id,kind,body) values($1,$2,'dare','Do ten jumps') returning id", [crew, users[9]])).rows[0].id;
      // The app can't post a proof that already has votes, or one marked as "from before voting".
      const posted = await request('group_messages', { user: 14, method: 'POST', headers: { Prefer: 'return=representation' }, body: {
        group_id: crew, sender_id: users[14], kind: 'proof', dare_id: dareId, media_path: `${users[14]}/group/rest-proof.jpg`, media_type: 'photo',
        proof_legit: 7, proof_cap: 0, proof_legacy: true } });
      assert.equal(posted.status, 201, JSON.stringify(posted.data));
      const proofId = posted.data[0].id;
      assert.deepEqual([posted.data[0].proof_legit, posted.data[0].proof_cap, posted.data[0].proof_legacy], [0, 0, false]);
      const voteAs = (user, legit, expected = users[user]) => request('rpc/vote_group_proof', { user, method: 'POST', body: { proof: proofId, legit, expected_user_id: expected } });
      // A member votes, and so does the person who sent the dare.
      let result = await voteAs(15, true);
      assert.equal(result.status, 200, JSON.stringify(result.data)); assert.deepEqual(result.data, { legit: 1, cap: 0, mine: true, legacy: false });
      result = await voteAs(9, false);
      assert.equal(result.status, 200, JSON.stringify(result.data)); assert.deepEqual(result.data, { legit: 1, cap: 1, mine: false, legacy: false });
      // Refused: the poster, someone outside the group, a different account than the one on screen, a visitor.
      for (const [user, expected, message] of [[14, users[14], "You can't vote on your own proof"], [3, users[3], 'Only people in this group can vote'], [15, users[9], 'Your login has changed - please try again']]) {
        const refused = await voteAs(user, true, expected);
        assert.equal(refused.status, 400, `${user}: ${refused.status} ${JSON.stringify(refused.data)}`); assert.equal(refused.data.message, message);
      }
      // Someone added to the group after the proof was posted can't vote on it (only people who were there).
      await friend(db, users[9], users[37]);
      await own(9, 'select add_to_peek_group($1,$2::uuid[],current_date)', [crew, [users[37]]]);
      const late = await voteAs(37, true);
      assert.equal(late.status, 400, JSON.stringify(late.data)); assert.equal(late.data.message, 'Only people who were in the group when this proof was posted can vote');
      // ...and can't move their join time back, or add a member row of their own, to get around that.
      const joinedBefore = (await db.query('select joined_at from peek_group_members where group_id=$1 and user_id=$2', [crew, users[37]])).rows[0].joined_at;
      const moved = await request(`peek_group_members?group_id=eq.${crew}&user_id=eq.${users[37]}`, { user: 37, method: 'PATCH', body: { joined_at: '2020-01-01T00:00:00Z' } });
      assert.ok([401, 403].includes(moved.status), `PATCH joined_at ${moved.status} ${JSON.stringify(moved.data)}`);
      const added = await request('peek_group_members', { user: 3, method: 'POST', body: { group_id: crew, user_id: users[3], added_by: users[9], joined_day: '2020-01-01', joined_at: '2020-01-01T00:00:00Z' } });
      assert.ok([401, 403].includes(added.status), `POST member ${added.status} ${JSON.stringify(added.data)}`);
      assert.deepEqual((await db.query('select joined_at from peek_group_members where group_id=$1 and user_id=$2', [crew, users[37]])).rows[0].joined_at, joinedBefore);
      assert.equal((await db.query('select count(*)::int as n from peek_group_members where group_id=$1 and user_id=$2', [crew, users[3]])).rows[0].n, 0);
      assert.equal((await voteAs(37, true)).data.message, 'Only people who were in the group when this proof was posted can vote');
      const visitor = await request('rpc/vote_group_proof', { user: null, method: 'POST', body: { proof: proofId, legit: true, expected_user_id: users[15] } });
      assert.ok([401, 403, 404].includes(visitor.status), `visitor ${visitor.status}`);
      // The totals, as every member reads them over REST; nobody outside the group sees the proof.
      for (const user of [9, 14, 15]) {
        const row = await request(`group_messages?id=eq.${proofId}&select=proof_legit,proof_cap,proof_legacy`, { user });
        assert.equal(row.status, 200); assert.deepEqual(row.data, [{ proof_legit: 1, proof_cap: 1, proof_legacy: false }]);
      }
      assert.deepEqual((await request(`group_messages?id=eq.${proofId}`, { user: 3 })).data, []);
      // Votes are anonymous: you read only your own; the poster reads none.
      assert.deepEqual((await request(`group_proof_votes?proof_id=eq.${proofId}&select=user_id,legit`, { user: 15 })).data, [{ user_id: users[15], legit: true }]);
      assert.deepEqual((await request(`group_proof_votes?proof_id=eq.${proofId}`, { user: 14 })).data, []);
      // Nobody can change the totals or write a vote around the vote function.
      const patched = await request(`group_messages?id=eq.${proofId}`, { user: 14, method: 'PATCH', body: { proof_legit: 50, proof_legacy: true }, headers: { Prefer: 'return=representation' } });
      assert.ok([200, 404].includes(patched.status), `PATCH ${patched.status}`); assert.deepEqual(patched.status === 200 ? patched.data : [], []);
      const forged = await request('group_proof_votes', { user: 14, method: 'POST', body: { proof_id: proofId, user_id: users[14], legit: true } });
      assert.ok([401, 403].includes(forged.status), `forged vote ${forged.status}`);
      assert.deepEqual((await db.query('select proof_legit, proof_cap, proof_legacy from group_messages where id=$1', [proofId])).rows[0], { proof_legit: 1, proof_cap: 1, proof_legacy: false });
      // The app's own voteGroupProof and fetchMyProofVotes (src/lib/groupChat.ts) through supabase-js.
      const supabase = createClient('http://local.invalid', 'local-test-key', {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { headers: { Authorization: `Bearer ${token(15)}` }, fetch: (url, init) => fetch(String(url).replace('http://local.invalid/rest/v1', runtime.base), init) },
      });
      const { voteGroupProof, fetchMyProofVotes, fetchMyGroupJoin } = loadLibrary('groupChat', { supabase, mocks: { './media': {} } });
      // (The library runs in its own sandbox, so its answers are copied into plain values before comparing.)
      const plain = (value) => JSON.parse(JSON.stringify(value));
      assert.deepEqual(plain([...(await fetchMyProofVotes(users[15], [proofId]))]), [[proofId, true]]);
      // Your join time, as the app reads it (for hiding the buttons on proofs from before you joined).
      const myJoin = await fetchMyGroupJoin(crew, users[15]);
      const realJoin = (await db.query('select joined_at from peek_group_members where group_id=$1 and user_id=$2', [crew, users[15]])).rows[0].joined_at;
      assert.equal(Date.parse(myJoin), realJoin.getTime());
      assert.equal(await fetchMyGroupJoin(crew, users[3]), null, 'not in the group: no join time');
      assert.deepEqual(plain(await voteGroupProof(users[15], proofId, null)), { legit: 0, cap: 1, mine: null, legacy: false });
      assert.equal((await fetchMyProofVotes(users[15], [proofId])).size, 0);
      assert.deepEqual(plain(await voteGroupProof(users[15], proofId, true)), { legit: 1, cap: 1, mine: true, legacy: false });
      // The phone is logged in as users[15] now, but the screen still belongs to users[9]: refused.
      await assert.rejects(() => voteGroupProof(users[9], proofId, false), (error) => /login has changed/.test(error.message));
      assert.equal((await db.query('select count(*)::int as n from group_proof_votes where proof_id=$1', [proofId])).rows[0].n, 2);
      // A vote only counts while you're in the group: users[15] leaves over REST, and their vote goes with them.
      const left = await request(`peek_group_members?group_id=eq.${crew}&user_id=eq.${users[15]}`, { user: 15, method: 'DELETE' });
      assert.ok([200, 204].includes(left.status), `leave ${left.status} ${JSON.stringify(left.data)}`);
      const after = await request(`group_messages?id=eq.${proofId}&select=proof_legit,proof_cap`, { user: 9 });
      assert.deepEqual(after.data, [{ proof_legit: 0, proof_cap: 1 }]);
      const gone = await voteAs(15, true);
      assert.equal(gone.status, 400); assert.equal(gone.data.message, 'Only people in this group can vote');
      assert.equal((await db.query('select count(*)::int as n from group_proof_votes where proof_id=$1', [proofId])).rows[0].n, 1);
    });
  }
  await check(`${writeRequests} concurrent group writes keep exact counts, authors and unread state`, async () => {
    const groups = [];
    for (let n = 0; n < 6; n++) {
      const owner = 10 + n*4;
      const members = [owner, owner+1, owner+2, owner+3];
      for (const member of members.slice(1)) await friend(db, users[owner], users[member]);
      const result = await request('rpc/create_peek_group', { user: owner, method: 'POST', body: { group_name: `HTTP load ${n}`, members: members.slice(1).map(index => users[index]), today: new Date().toISOString().slice(0,10) } });
      assert.equal(result.status, 200);
      groups.push({ id: result.data, owner, members });
    }
    let next = 0;
    const ids = new Set();
    const start = performance.now();
    await Promise.all(Array.from({ length: writeConcurrency }, async () => {
      while (next < writeRequests) {
        const n = next++;
        const item = groups[n % groups.length];
        const user = item.members[Math.floor(n/groups.length) % item.members.length];
        const result = await request('group_messages', { user, method: 'POST', body: { group_id: item.id, sender_id: users[user], kind: 'text', body: `Concurrent HTTP message ${n} 👀` }, headers: { Prefer: 'return=representation' } });
        assert.equal(result.status, 201); assert.equal(result.data[0].sender_id, users[user]); ids.add(result.data[0].id);
      }
    }));
    assert.equal(ids.size, writeRequests);
    assert.equal((await db.query('select count(*)::int as n from group_messages where group_id=any($1)', [groups.map(item => item.id)])).rows[0].n, writeRequests);
    const item = groups[0];
    const before = await request('rpc/my_group_chats', { user: item.owner, method: 'POST', body: {} });
    assert.equal(before.data.find(row => row.group_id === item.id).unread, writeRequests / 8);
    assert.equal((await request('rpc/mark_group_chat_read', { user: item.owner, method: 'POST', body: { grp: item.id } })).status, 204);
    const after = await request('rpc/my_group_chats', { user: item.owner, method: 'POST', body: {} });
    assert.equal(after.data.find(row => row.group_id === item.id).unread, 0);
    metrics.push({ name: 'real REST write metrics', requests: writeRequests, syntheticUsers: 24, concurrency: writeConcurrency, durationMs: Math.round(performance.now()-start) });
  });
  await check(`${readRequests} overlapping requests cannot leak roles between reused connections`, async () => {
    let next = 0;
    const durations = [];
    const start = performance.now();
    await Promise.all(Array.from({ length: readConcurrency }, async () => {
      while (next < readRequests) {
        const n = next++;
        const at = performance.now();
        const user = n % users.length;
        const result = await request(`posts?id=eq.${post}&select=id`, { user });
        assert.equal(result.status, 200); assert.equal(result.data.length, user <= 1 ? 1 : 0);
        durations.push(performance.now()-at);
      }
    }));
    durations.sort((a,b) => a-b);
    metrics.push({ name: 'real REST load metrics', requests: readRequests, syntheticUsers: users.length, concurrency: readConcurrency, durationMs: Math.round(performance.now()-start), p95Ms: Math.round(durations[Math.ceil(readRequests*.95)-1]) });
  });
  // OPEN-01 (was "KNOWN MEDIUM: client-only public name moderation bypass"): the database now runs the same
  // word filter as the app, so skipping the app and calling the REST API directly no longer gets a bad name in.
  await check('HTTP PATCH of own username to f.u.c.k is rejected by the database word filter', async () => {
    const before = (await db.query('select username from profiles where id=$1', [users[38]])).rows[0].username;
    const result = await request(`profiles?id=eq.${users[38]}`, { user: 38, method: 'PATCH', body: { username: 'f.u.c.k' } });
    assert.equal(result.status, 400);
    assert.equal(result.data.code, '23514');
    assert.equal(result.data.message, "Let's keep it clean – that word can't be in a username or name.");
    assert.equal((await db.query('select username from profiles where id=$1', [users[38]])).rows[0].username, before);
  });
  // The owner's choice: a display name may swear (only @usernames can't), but a slur is still refused.
  await check('HTTP PATCH of a display name: swearing in fancy letters (ｆｕｃｋ) saves, a slur in fancy letters (ｒｅｔａｒｄ) is rejected', async () => {
    const swearing = await request(`profiles?id=eq.${users[38]}`, { user: 38, method: 'PATCH', body: { display_name: 'ｆｕｃｋ' }, headers: { Prefer: 'return=representation' } });
    assert.equal(swearing.status, 200, JSON.stringify(swearing.data)); assert.equal(swearing.data[0].display_name, 'ｆｕｃｋ');
    const result = await request(`profiles?id=eq.${users[38]}`, { user: 38, method: 'PATCH', body: { display_name: 'ｒｅｔａｒｄ' } });
    assert.equal(result.status, 400); assert.equal(result.data.code, '23514');
    assert.equal(result.data.message, "That word isn't allowed on Peekaboo.");
    assert.equal((await db.query('select display_name from profiles where id=$1', [users[38]])).rows[0].display_name, 'ｆｕｃｋ');
  });
  await check('HTTP rename to a legitimate username and real-name display name still works', async () => {
    const result = await request(`profiles?id=eq.${users[38]}`, { user: 38, method: 'PATCH', body: { username: 'rest_clean_name', display_name: 'Moby Dick' }, headers: { Prefer: 'return=representation' } });
    assert.equal(result.status, 200); assert.equal(result.data.length, 1);
    assert.deepEqual((await db.query('select username, display_name from profiles where id=$1', [users[38]])).rows[0], { username: 'rest_clean_name', display_name: 'Moby Dick' });
  });
  // OPEN-01 review: characters you can't see (zero-width space, soft hyphen…) and Cyrillic/Greek look-alike
  // letters must not split or hide a word on this older PostgreSQL either.
  // Swearing is checked on the username (the word filter says no before the username format rule does); slurs on
  // the display name and bio.
  await check('HTTP PATCH with an invisible character or a Cyrillic look-alike letter inside a word is rejected', async () => {
    const NAME = "Let's keep it clean – that word can't be in a username or name.";
    const WORD = "That word isn't allowed on Peekaboo.";
    for (const [body, message] of [
      [{ username: 'cu\u200bnt' }, NAME], [{ username: '\u0441unt' }, NAME],
      [{ display_name: 'ki\u200bke' }, WORD], [{ display_name: '\u0441hink' }, WORD],
      [{ bio: 'n\u0456gger' }, WORD], [{ bio: 'sh\u00adit n\u2060igger' }, WORD],
    ]) {
      const result = await request(`profiles?id=eq.${users[38]}`, { user: 38, method: 'PATCH', body });
      assert.equal(result.status, 400, JSON.stringify(body)); assert.equal(result.data.code, '23514', JSON.stringify(body));
      assert.equal(result.data.message, message, JSON.stringify(body));
    }
    const cases = [
      ['cu​nt', 'name', 'cunt'], ['sh­it', 'name', 'shit'], ['c⁠unt', 'name', 'cunt'], ['fu﻿ck', 'name', 'fuck'],
      ['fu\u{E0020}ck', 'name', 'fuck'], ['сunt', 'name', 'cunt'], ['СUNT', 'name', 'cunt'], ['nіgger', 'content', 'nigger'],
      ['fυck', 'name', 'fuck'], ['Moby Dіck', 'name', null], ['Алексей', 'name', null],
      ['Love ❤️', 'name', null], ['ki\u200bke', 'content', 'kike'], ['\u0441hink', 'content', 'chink'], ['cu\u200bnt', 'content', null],
    ];
    for (const [text, place, word] of cases) {
      assert.equal((await db.query('select private.blocked_word($1,$2) as w', [text, place])).rows[0].w, word, JSON.stringify(text));
    }
  });
  // OPEN-01 review: accents ("fück") must not split a word on this PostgreSQL either, and real names with
  // accents ("José", "Moby Dïck") must still save.
  await check('HTTP PATCH with an accented letter inside a word is rejected; accented real names still save', async () => {
    const NAME = "Let's keep it clean – that word can't be in a username or name.";
    const WORD = "That word isn't allowed on Peekaboo.";
    for (const [body, message] of [
      [{ username: 'fück' }, NAME], [{ username: 'cünt' }, NAME], [{ username: 'shït' }, NAME], [{ username: 'fu\u0308ck' }, NAME],
      [{ display_name: 'nïgger' }, WORD], [{ display_name: 'Fággót' }, WORD], [{ display_name: 're\u0301ta\u0301rd' }, WORD],
      [{ bio: 'nïgger' }, WORD],
    ]) {
      const result = await request(`profiles?id=eq.${users[38]}`, { user: 38, method: 'PATCH', body });
      assert.equal(result.status, 400, JSON.stringify(body)); assert.equal(result.data.code, '23514', JSON.stringify(body));
      assert.equal(result.data.message, message, JSON.stringify(body));
    }
    // Swearing with accents is fine in a display name, like real names with accents.
    for (const name of ['José', 'Zoë', 'Björk', 'Renée', 'Łukasz', 'Ñandú', 'Ågot', 'Алёна', 'Νίκος', 'Moby Dïck', 'Fück Öff']) {
      const result = await request(`profiles?id=eq.${users[38]}`, { user: 38, method: 'PATCH', body: { display_name: name }, headers: { Prefer: 'return=representation' } });
      assert.equal(result.status, 200, `${name}: ${JSON.stringify(result.data)}`); assert.equal(result.data[0].display_name, name);
    }
    const cases = [
      ['fück', 'name', 'fuck'], ['cünt', 'name', 'cunt'], ['nïgger', 'content', 'nigger'], ['shït', 'name', 'shit'],
      ['fu\u1ab0ck', 'name', 'fuck'], ['fu\u1dc0ck', 'name', 'fuck'], ['fu\u20ddck', 'name', 'fuck'], ['fu\ufe20ck', 'name', 'fuck'],
      ['n\u0457gger', 'content', 'nigger'], ['Dïck', 'name', null], ['José', 'name', null], ['Ζωή', 'name', null],
    ];
    for (const [text, place, word] of cases) {
      assert.equal((await db.query('select private.blocked_word($1,$2) as w', [text, place])).rows[0].w, word, JSON.stringify(text));
    }
  });
  // OPEN-01 review: a huge text is refused by the access rules or the length limit without the word filter
  // reading through it first.
  await check('HTTP POST of a multi-megabyte comment on someone else\'s behalf is refused quickly', async () => {
    const huge = `${'nigger '.repeat(300_000)}x`;
    const started = performance.now();
    const result = await request('comments', { user: 38, method: 'POST', body: { user_id: users[0], post_id: post, body: huge } });
    assert.ok([401, 403].includes(result.status), `${result.status} ${JSON.stringify(result.data).slice(0, 200)}`);
    assert.equal(result.data.code, '42501');
    const ownBio = await request(`profiles?id=eq.${users[38]}`, { user: 38, method: 'PATCH', body: { bio: huge } });
    assert.equal(ownBio.status, 400); assert.equal(ownBio.data.code, '23514');
    assert.match(ownBio.data.message, /profiles_bio_length/);
    metrics.push({ name: 'huge word-filter text refused', durationMs: Math.round(performance.now() - started) });
  });
  await check('HTTP dare card in a 1:1 chat is private chat and is not word-filtered', async () => {
    const result = await request('messages', { method: 'POST', body: { sender_id: users[0], recipient_id: users[1], kind: 'dare', body: 'Be an errand runner for the day' }, headers: { Prefer: 'return=representation' } });
    assert.equal(result.status, 201, JSON.stringify(result.data)); assert.equal(result.data[0].body, 'Be an errand runner for the day');
  });
} finally {
  await mkdir(new URL('../../.qa/', import.meta.url), { recursive: true });
  const result = { engine: 'PostgreSQL 16 + PostgREST 16.5, real HTTP/JWT/roles/RLS; Auth signup and Storage service not running', revision: 'a9e5ddf88e785bd8378b2b7d9dcd7e341df439b1', original, stress, checks, metrics, knownIssues };
  await writeFile(new URL(`../../.qa/rest-${original ? 'before' : 'after'}.json`, import.meta.url), JSON.stringify(result, null, 2));
  await runtime.stop();
}
console.log(`${checks.filter(row => row.passed).length} passed; ${checks.filter(row => !row.passed).length} failed`);
if (checks.some(row => !row.passed)) process.exitCode = 1;
