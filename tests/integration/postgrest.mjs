import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { asUser, friend } from '../database/local-db.mjs';
import { startLocalRest } from './runtime.mjs';

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
    const path = `${users[0]}/posts/rest-reported-evidence.jpg`;
    const storageHeaders = { 'Content-Profile': 'storage' };
    assert.equal((await request('objects', { method: 'POST', body: { bucket_id: 'media', name: path }, headers: storageHeaders })).status, 201);
    const inserted = await request('posts', { method: 'POST', body: { user_id: users[0], media_path: path, caption: 'reported fixture' }, headers: { Prefer: 'return=representation' } });
    assert.equal(inserted.status, 201);
    const id = inserted.data[0].id;
    assert.equal((await request('reports', { user: 1, method: 'POST', body: { reporter_id: users[1], reported_user_id: users[0], content_type: 'post', content_id: id, reason: 'spam' } })).status, 201);
    assert.equal((await request(`posts?id=eq.${id}`, { method: 'DELETE' })).status, 204);
    const deleted = await request(`objects?name=eq.${encodeURIComponent(path)}`, { method: 'DELETE', headers: storageHeaders });
    assert.ok(deleted.status >= 400 && deleted.status < 500, JSON.stringify(deleted));
    assert.equal((await db.query('select count(*)::int as n from storage.objects where name=$1', [path])).rows[0].n, 1);
    // Ordinary unreported content still deletes normally.
    const ordinary = `${users[0]}/posts/rest-unreported-delete.jpg`;
    assert.equal((await request('objects', { method: 'POST', body: { bucket_id: 'media', name: ordinary }, headers: storageHeaders })).status, 201);
    assert.equal((await request(`objects?name=eq.${encodeURIComponent(ordinary)}`, { method: 'DELETE', headers: storageHeaders })).status, 204);
  });
  await check('a still-valid deleted-account JWT cannot upload orphan media', async () => {
    const jwt = token(39);
    await db.query('delete from auth.users where id=$1', [users[39]]);
    const result = await request('objects', { jwt, method: 'POST', body: { bucket_id: 'media', name: `${users[39]}/posts/deleted-account.jpg` }, headers: { 'Content-Profile': 'storage' } });
    assert.equal(result.status, 403);
  });
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
  // Keep a demonstrated, accepted-scope medium finding separate from passing
  // regressions. Public names are filtered only by the current phone code.
  const moderation = await request(`profiles?id=eq.${users[38]}`, { user: 38, method: 'PATCH', body: { username: 'f.u.c.k' } });
  if (moderation.status === 204 || moderation.status === 200) {
    knownIssues.push({ severity: 'medium', name: 'Direct REST bypasses the client-only public-name word filter', status: moderation.status, reproduction: 'PATCH own profiles row with username f.u.c.k bypasses the documented name ban', proposedFix: 'Share the exact nuanced word policy with trusted server/database writes; preserve real-name exceptions.' });
    console.log('KNOWN MEDIUM: client-only public name moderation bypass confirmed by HTTP');
  }
} finally {
  await mkdir(new URL('../../.qa/', import.meta.url), { recursive: true });
  const result = { engine: 'PostgreSQL 16 + PostgREST 16.5, real HTTP/JWT/roles/RLS; Auth signup and Storage service not running', revision: 'a9e5ddf88e785bd8378b2b7d9dcd7e341df439b1', original, stress, checks, metrics, knownIssues };
  await writeFile(new URL(`../../.qa/rest-${original ? 'before' : 'after'}.json`, import.meta.url), JSON.stringify(result, null, 2));
  await runtime.stop();
}
console.log(`${checks.filter(row => row.passed).length} passed; ${checks.filter(row => !row.passed).length} failed`);
if (checks.some(row => !row.passed)) process.exitCode = 1;
