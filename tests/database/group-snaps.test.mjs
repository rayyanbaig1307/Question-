// Group snaps 📸 and 1:1 camera-roll photos (supabase/migrations/20261229000000_group_snaps.sql, the owner, 21 Nov).
// A picture taken with the camera inside a group chat is a snap: each person opens it once and replays it once
// within 24 hours, then it's gone – unless someone saves it in the chat, which makes it a normal photo for the
// whole group. Old app versions never "open" it, so Storage never gives them the picture.
// In a 1:1 chat a picture from the camera roll is a peek that's saved from the start (a normal photo).
// Every check runs the real migrations in a local, in-memory PostgreSQL (PGlite) with invented people.
// Nothing here talks to a live project.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { asUser, createLocalDatabase, friend, seedUsers } from './local-db.mjs';

const MIGRATION = new URL('../../supabase/migrations/20261229000000_group_snaps.sql', import.meta.url);

let db;
let users;
before(async () => { db = await createLocalDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('truncate auth.users cascade; truncate storage.objects, net.sent restart identity;');
  users = await seedUsers(db, 8);
});

const rpc = (i, sql, args = []) => asUser(db, users[i], (tx) => tx.query(sql, args));
const failure = (run) => run.then(() => 'ok', (error) => error.message);
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const count = async (sql, args = []) => (await one(`select count(*)::int as n from ${sql}`, args)).n;
// The local database's clock counts whole milliseconds: wait a moment so that "later" really is later.
const waitAMoment = () => new Promise((resolve) => setTimeout(resolve, 5));

// A group made by users[0] with the given others (all of them users[0]'s friends).
async function makeGroup(members = [1, 2, 3], name = 'Squad') {
  for (const i of members) await friend(db, users[0], users[i]);
  return (await rpc(0, 'select create_peek_group($1,$2::uuid[],current_date) as id', [name, members.map((i) => users[i])])).rows[0].id;
}
async function addLater(grp, i) {
  await friend(db, users[0], users[i]);
  await rpc(0, 'select add_to_peek_group($1,$2::uuid[],current_date)', [grp, [users[i]]]);
}
// A file uploaded by person i into their own folder.
async function upload(i, folder = 'snaps', ext = 'jpg') {
  const path = `${users[i]}/${folder}/${randomUUID()}.${ext}`;
  await rpc(i, "insert into storage.objects(bucket_id,name) values('media',$1)", [path]);
  return path;
}
// Send a snap from the group chat's camera, the way the app does.
async function sendSnap(grp, i, { video = false } = {}) {
  const media = await upload(i, 'snaps', video ? 'mp4' : 'jpg');
  const poster = video ? await upload(i) : null;
  return (await rpc(i, `insert into group_messages(group_id,kind,media_path,media_type,poster_path)
    values($1,'snap',$2,$3,$4) returning *`, [grp, media, video ? 'video' : 'photo', poster])).rows[0];
}
// Can person i download this file? (Storage only hands out files the person can "see" in storage.objects.)
const canGet = async (i, path) => (await rpc(i, 'select count(*)::int as n from storage.objects where name = $1', [path])).rows[0].n === 1;
const open = async (i, id) => (await rpc(i, 'select open_group_snap($1) as ok', [id])).rows[0].ok;
const replay = async (i, id) => (await rpc(i, 'select replay_group_snap($1) as ok', [id])).rows[0].ok;
const save = async (i, id, on = true) => (await rpc(i, 'select set_group_snap_saved($1,$2) as ok', [id, on])).rows[0].ok;
// Move a snap (and its opens) back in time.
const age = (id, interval) => db.query(`update group_messages set created_at = created_at - $2::interval where id = $1`, [id, interval]);
const openedAgo = (id, i, interval) => db.query(
  'update group_snap_opens set opened_at = opened_at - $3::interval, replayed_at = replayed_at - $3::interval where message_id = $1 and user_id = $2',
  [id, users[i], interval]);
async function pushTo(i) {
  const token = `ExponentPushToken[qa-group-snap-${i}]`;
  await db.query("insert into push_tokens(token,user_id,platform) values($1,$2,'ios') on conflict (token) do update set user_id = excluded.user_id", [token, users[i]]);
  return token;
}
const pushesTo = async (token) => (await db.query(
  "select body->0->>'title' as title, body->0->>'body' as body from net.sent where body->0->>'to' = $1 order by id", [token])).rows;
const claimDaily = async () => (await asUser(db, null, (tx) => tx.query('select name from claim_media_cleanup(1000)'), 'service_role')).rows.map((r) => r.name);
const inUse = async (path, days) => (await one('select private.media_path_in_use($1, $2) as used', [path, days])).used;

// ---------------------------------------------------------------------------
// 1. Sending
// ---------------------------------------------------------------------------
test('A snap is a photo or video in your own snaps folder, with no text; it never arrives saved', async () => {
  const grp = await makeGroup();
  const snap = await sendSnap(grp, 1);
  assert.equal(snap.kind, 'snap');
  assert.equal(snap.sender_id, users[1]);
  assert.equal(snap.saved_at, null);
  const video = await sendSnap(grp, 2, { video: true });
  assert.equal(video.media_type, 'video');

  const insert = (i, cols, vals) => failure(rpc(i, `insert into group_messages(group_id,kind,${cols}) values($1,'snap',${vals.map((_, n) => `$${n + 2}`)})`, [grp, ...vals]));
  // Not in the snaps folder (a "group" file can be opened by every member at any time).
  assert.match(await insert(1, 'media_path,media_type', [await upload(1, 'group'), 'photo']), /group_messages_content/);
  // A poster in another folder, no media type, with text, no file.
  assert.match(await insert(1, 'media_path,media_type,poster_path', [await upload(1), 'video', await upload(1, 'group')]), /group_messages_content/);
  assert.match(await insert(1, 'media_path', [await upload(1)]), /group_messages_content/);
  assert.match(await insert(1, 'media_path,media_type,body', [await upload(1), 'photo', 'hi']), /group_messages_content/);
  assert.match(await insert(1, 'media_type', ['photo']), /group_messages_content/);
  // Someone else's file, or someone outside the group.
  assert.match(await insert(1, 'media_path,media_type', [await upload(2), 'photo']), /group_messages_own_files/);
  assert.match(await insert(5, 'media_path,media_type', [await upload(5), 'photo']), /row-level security/);
  // The app can't send it already saved.
  const sneaky = (await rpc(1, `insert into group_messages(group_id,kind,media_path,media_type,saved_at,saved_by)
    values($1,'snap',$2,'photo',now(),$3) returning saved_at, saved_by`, [grp, await upload(1), users[1]])).rows[0];
  assert.deepEqual(sneaky, { saved_at: null, saved_by: null });
  // And nobody can change a message afterwards (no update rule): only set_group_snap_saved saves.
  await rpc(1, 'update group_messages set saved_at = now() where id = $1', [snap.id]);
  assert.equal((await one('select saved_at from group_messages where id = $1', [snap.id])).saved_at, null);
});

test('Camera-roll photos, group dare proofs and group photos keep working exactly as before', async () => {
  const grp = await makeGroup();
  const photo = (await rpc(1, "insert into group_messages(group_id,kind,media_path,media_type) values($1,'photo',$2,'photo') returning *", [grp, await upload(1, 'group')])).rows[0];
  const dare = (await rpc(0, "insert into group_messages(group_id,kind,body) values($1,'dare','Do a cartwheel') returning id", [grp])).rows[0];
  const proof = (await rpc(2, "insert into group_messages(group_id,kind,dare_id,media_path,media_type) values($1,'proof',$2,$3,'photo') returning *", [grp, dare.id, await upload(2, 'group')])).rows[0];
  for (const i of [0, 2, 3]) assert.equal(await canGet(i, photo.media_path), true, `photo for ${i}`);
  for (const i of [0, 1, 3]) assert.equal(await canGet(i, proof.media_path), true, `proof for ${i}`);
  assert.equal(await canGet(5, photo.media_path), false);
  // Their files stay "in use" for as long as their messages are there, however old.
  await age(photo.id, '30 days');
  assert.equal(await inUse(photo.media_path, 1), true);
  assert.equal(await inUse(photo.media_path, 7), true);
  // A snap's file in the "group" folder would be refused, and a "photo" in the snaps folder isn't a snap
  // (nobody else can open it: no "free photo" through the back door).
  const wrong = (await rpc(1, "insert into group_messages(group_id,kind,media_path,media_type) values($1,'photo',$2,'photo') returning *", [grp, await upload(1, 'snaps')])).rows[0];
  assert.equal(await canGet(2, wrong.media_path), false);
});

// ---------------------------------------------------------------------------
// 2. Opening: old apps never get the picture
// ---------------------------------------------------------------------------
test('Nobody but the sender can download a snap until they open it, and then only for 5 minutes', async () => {
  const grp = await makeGroup();
  const snap = await sendSnap(grp, 1, { video: true });
  // An old app (or the new chat list) asking for the files straight away: refused.
  for (const i of [0, 2, 3]) {
    assert.equal(await canGet(i, snap.media_path), false, `user ${i} before opening`);
    assert.equal(await canGet(i, snap.poster_path), false, `poster for ${i} before opening`);
  }
  assert.equal(await canGet(1, snap.media_path), true, 'the sender always can');
  // Open: allowed once.
  assert.equal(await open(2, snap.id), true);
  assert.equal(await canGet(2, snap.media_path), true);
  assert.equal(await canGet(2, snap.poster_path), true);
  assert.equal(await canGet(3, snap.media_path), false, 'opening is per person');
  assert.equal(await open(2, snap.id), false, 'a second open is refused');
  // 5 minutes later the file is refused again.
  await openedAgo(snap.id, 2, '6 minutes');
  assert.equal(await canGet(2, snap.media_path), false);
  // One replay: 5 more minutes.
  assert.equal(await replay(2, snap.id), true);
  assert.equal(await canGet(2, snap.media_path), true);
  assert.equal(await replay(2, snap.id), false, 'only one replay');
  await openedAgo(snap.id, 2, '6 minutes');
  assert.equal(await canGet(2, snap.media_path), false);
  // A replay before opening is refused; the sender can't open or replay their own.
  assert.equal(await replay(3, snap.id), false);
  assert.equal(await open(1, snap.id), false);
  assert.equal(await replay(1, snap.id), false);
  // Not a snap, or a made-up id.
  const text = (await rpc(1, "insert into group_messages(group_id,kind,body) values($1,'text','hi') returning id", [grp])).rows[0];
  assert.equal(await open(2, text.id), false);
  assert.equal(await open(2, randomUUID()), false);
  // Logged out.
  assert.equal(await failure(asUser(db, null, (tx) => tx.query('select open_group_snap($1)', [snap.id]))), 'Please log in again');
});

// Person i on one of their phones or tablets: every app login carries its own session id in its claims (it stays
// the same when the login refreshes itself), like a real Supabase login.
const onLogin = (i, session, sql, args = []) => db.transaction(async (tx) => {
  await tx.exec('set local role authenticated');
  await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: users[i], role: 'authenticated', session_id: session })]);
  return tx.query(sql, args);
});
const canGetOn = async (i, session, path) => (await onLogin(i, session, 'select count(*)::int as n from storage.objects where name = $1', [path])).rows[0].n === 1;

test('Only the phone that opened a snap can download it: an old app on another phone or tablet of the same account gets nothing', async () => {
  const grp = await makeGroup();
  const snap = await sendSnap(grp, 1, { video: true });
  // Ana (person 2) opens it on her phone; her tablet (an older app) reloads the chat in the same 5 minutes.
  assert.equal((await onLogin(2, 'phone', 'select open_group_snap($1) as ok', [snap.id])).rows[0].ok, true);
  for (const path of [snap.media_path, snap.poster_path]) {
    assert.equal(await canGetOn(2, 'phone', path), true, 'the phone that opened it');
    assert.equal(await canGetOn(2, 'tablet', path), false, 'another login of the same account');
  }
  // The same phone after its login refreshed itself (same session id): still fine.
  assert.equal(await canGetOn(2, 'phone', snap.media_path), true);
  // The one replay, on the tablet: now the tablet may download it, and the phone not any more.
  assert.equal((await onLogin(2, 'tablet', 'select replay_group_snap($1) as ok', [snap.id])).rows[0].ok, true);
  assert.equal(await canGetOn(2, 'tablet', snap.media_path), true);
  assert.equal(await canGetOn(2, 'phone', snap.media_path), false);
  // The 5 minutes still end it, on every login.
  await openedAgo(snap.id, 2, '6 minutes');
  assert.equal(await canGetOn(2, 'tablet', snap.media_path), false);
  // The app can't read which login opened it (only the server knows); the other columns it can.
  assert.match(await failure(rpc(2, 'select session_id from group_snap_opens')), /permission denied/);
  assert.match(await failure(rpc(1, 'select * from group_snap_opens')), /permission denied/);
  assert.deepEqual((await rpc(1, 'select user_id, screenshot_at from group_snap_opens')).rows, [{ user_id: users[2], screenshot_at: null }]);
  // A request that carries no login id at all (not something a signed-in app sends): only the 5 minutes decide.
  assert.equal(await open(3, snap.id), true);
  assert.equal(await canGetOn(3, 'any', snap.media_path), true);
  assert.equal((await onLogin(0, 'laptop', 'select open_group_snap($1) as ok', [snap.id])).rows[0].ok, true);
  assert.equal(await canGet(0, snap.media_path), true);
  // Saved: a normal photo, on every login of everyone in the group.
  assert.equal(await save(1, snap.id), true);
  assert.equal(await canGetOn(2, 'phone', snap.media_path), true);
  assert.equal(await canGetOn(2, 'old tablet', snap.media_path), true);
});

test('A screenshot of a snap tells its sender once; not for a saved snap, your own, or someone who never opened it', async () => {
  const grp = await makeGroup([1, 2, 3, 4]);
  const token = await pushTo(1);
  const snap = await sendSnap(grp, 1);
  const shot = async (i, id) => (await rpc(i, 'select group_snap_screenshot($1) as ok', [id])).rows[0].ok;
  assert.equal(await shot(2, snap.id), false, 'not opened (yet)');
  assert.equal(await shot(6, snap.id), false, 'not in the group');
  assert.equal(await shot(1, snap.id), false, 'your own snap');
  assert.equal(await open(2, snap.id), true);
  assert.equal(await shot(2, snap.id), true);
  assert.equal(await shot(2, snap.id), false, 'once per snap');
  assert.deepEqual(await pushesTo(token), [{ title: '👯 Squad', body: 'QA 2: 📸 Took a screenshot of your snap' }]);
  // The sender sees who took one (under the snap in the chat); the others only their own row.
  const shots = async (i) => (await rpc(i, 'select user_id, screenshot_at is not null as shot from group_snap_opens where message_id = $1 order by user_id', [snap.id])).rows;
  assert.deepEqual(await shots(1), [{ user_id: users[2], shot: true }]);
  assert.deepEqual(await shots(3), []);
  // The sender muted the group chat: still noted under the snap, but no push.
  await rpc(1, 'select set_group_chat_muted($1,true)', [grp]);
  assert.equal(await open(3, snap.id), true);
  assert.equal(await shot(3, snap.id), true);
  assert.equal((await pushesTo(token)).length, 1);
  await rpc(1, 'select set_group_chat_muted($1,false)', [grp]);
  // Blocked after opening: nothing.
  assert.equal(await open(4, snap.id), true);
  await db.query('insert into blocks(blocker_id,blocked_id) values($1,$2)', [users[1], users[4]]);
  assert.equal(await shot(4, snap.id), false);
  // A saved snap is a normal photo: no notice.
  const saved = await sendSnap(grp, 1);
  assert.equal(await open(2, saved.id), true);
  assert.equal(await save(2, saved.id), true);
  assert.equal(await shot(2, saved.id), false);
  assert.equal((await pushesTo(token)).length, 1);
  // Nobody can write it themselves, and visitors can't call it.
  assert.match(await failure(rpc(2, 'update group_snap_opens set screenshot_at = null where message_id = $1', [snap.id])), /permission denied/);
  assert.equal(await failure(asUser(db, null, (tx) => tx.query('select group_snap_screenshot($1)', [snap.id]))), 'Please log in again');
  assert.match(await failure(asUser(db, null, (tx) => tx.query('select group_snap_screenshot($1)', [snap.id]), 'anon')), /permission denied/);
});

test('A snap ends 24 hours after it was sent: no more opening or replaying', async () => {
  const grp = await makeGroup();
  const snap = await sendSnap(grp, 1);
  const other = await sendSnap(grp, 1);
  assert.equal(await open(2, snap.id), true);
  await age(snap.id, '24 hours 1 minute');
  await age(other.id, '24 hours 1 minute');
  assert.equal(await replay(2, snap.id), false);
  assert.equal(await open(3, snap.id), false);
  assert.equal(await open(3, other.id), false);
  assert.equal(await canGet(3, other.media_path), false);
});

test('Only people who were in the group when it was sent, are still in it and aren\'t blocked can open it', async () => {
  const grp = await makeGroup([1, 2, 3, 4]);
  const snap = await sendSnap(grp, 1);
  // Someone added later.
  await waitAMoment();
  await addLater(grp, 5);
  assert.equal(await open(5, snap.id), false);
  assert.equal(await canGet(5, snap.media_path), false);
  // Someone who blocked the sender (or was blocked).
  await db.query('insert into blocks(blocker_id,blocked_id) values($1,$2)', [users[2], users[1]]);
  assert.equal(await open(2, snap.id), false);
  assert.equal(await canGet(2, snap.media_path), false);
  // Someone who opened it and then left the group.
  assert.equal(await open(3, snap.id), true);
  await rpc(3, 'delete from peek_group_members where group_id = $1 and user_id = $2', [grp, users[3]]);
  assert.equal(await canGet(3, snap.media_path), false);
  assert.equal(await replay(3, snap.id), false);
  // Someone outside the group.
  assert.equal(await open(6, snap.id), false);
  assert.equal(await canGet(6, snap.media_path), false);
  // A block that comes after opening also ends the window.
  assert.equal(await open(4, snap.id), true);
  await db.query('insert into blocks(blocker_id,blocked_id) values($1,$2)', [users[1], users[4]]);
  assert.equal(await canGet(4, snap.media_path), false);
});

// ---------------------------------------------------------------------------
// 3. Saving: a saved snap is a normal photo for the whole group
// ---------------------------------------------------------------------------
test('The sender, or anyone who opened it, can save it; then everyone in the group can open it any time', async () => {
  const grp = await makeGroup([1, 2, 3]);
  const snap = await sendSnap(grp, 1);
  // You have to open it first (or be the sender); outsiders can't.
  assert.equal(await save(2, snap.id), false);
  assert.equal(await save(6, snap.id), false);
  assert.equal(await open(2, snap.id), true);
  assert.equal(await save(2, snap.id), true);
  assert.equal(await save(2, snap.id), false, 'already saved');
  const row = await one('select saved_at, saved_by from group_messages where id = $1', [snap.id]);
  assert.equal(row.saved_by, users[2]);
  assert.ok(row.saved_at);
  // Everyone in the group can now download it, any time – also someone who joined later, and old apps.
  await waitAMoment();
  await addLater(grp, 4);
  await openedAgo(snap.id, 2, '1 hour');
  await age(snap.id, '3 days');
  for (const i of [0, 2, 3, 4]) assert.equal(await canGet(i, snap.media_path), true, `user ${i}`);
  assert.equal(await canGet(6, snap.media_path), false, 'not outsiders');
  assert.equal(await open(4, snap.id), true, 'opening a saved snap always works');
  assert.equal(await open(3, snap.id), true);
  assert.equal(await replay(3, snap.id), false, 'no replay needed for a saved snap');
  // A block still wins.
  await db.query('insert into blocks(blocker_id,blocked_id) values($1,$2)', [users[1], users[3]]);
  assert.equal(await canGet(3, snap.media_path), false);
  // Still a file in use while saved (the cleanup leaves it).
  assert.equal(await inUse(snap.media_path, 1), true);
  assert.equal(await inUse(snap.media_path, 7), true);
  // Unsave: only the person who saved it, or the sender. Over 24 hours old, it's then gone at once.
  assert.equal(await save(0, snap.id, false), false);
  assert.equal(await save(2, snap.id, false), true);
  assert.equal(await canGet(0, snap.media_path), false);
  assert.equal(await canGet(2, snap.media_path), false);
  // Too old to save again.
  assert.equal(await save(1, snap.id), false);

  // The sender can save their own snap (before anyone opened it); the sender can unsave it too.
  const own = await sendSnap(grp, 1);
  assert.equal(await save(1, own.id), true);
  assert.equal(await canGet(3, own.media_path), false, 'blocked');
  assert.equal(await canGet(0, own.media_path), true);
  assert.equal(await save(1, own.id, false), true);
  assert.equal(await canGet(0, own.media_path), false);
});

// ---------------------------------------------------------------------------
// 4. Who opened it
// ---------------------------------------------------------------------------
test('You see your own opens; the sender sees who opened theirs; nobody can write them directly', async () => {
  const grp = await makeGroup([1, 2, 3]);
  const snap = await sendSnap(grp, 1);
  await open(2, snap.id);
  await open(3, snap.id);
  await replay(3, snap.id);
  const seen = async (i) => (await rpc(i, 'select user_id, replayed_at is not null as replayed from group_snap_opens order by user_id')).rows;
  assert.deepEqual(await seen(1), [{ user_id: users[2], replayed: false }, { user_id: users[3], replayed: true }]);
  assert.deepEqual(await seen(2), [{ user_id: users[2], replayed: false }]);
  assert.deepEqual(await seen(0), []);
  // Blocked people aren't listed for the sender.
  await db.query('insert into blocks(blocker_id,blocked_id) values($1,$2)', [users[3], users[1]]);
  assert.deepEqual(await seen(1), [{ user_id: users[2], replayed: false }]);
  // Nobody writes the table directly (it would let you open a snap again, or forever).
  assert.match(await failure(rpc(2, 'insert into group_snap_opens(message_id,user_id) values($1,$2)', [snap.id, users[2]])), /permission denied/);
  assert.match(await failure(rpc(2, 'update group_snap_opens set opened_at = now() where message_id = $1', [snap.id])), /permission denied/);
  assert.match(await failure(rpc(2, 'delete from group_snap_opens where message_id = $1', [snap.id])), /permission denied/);
  assert.match(await failure(asUser(db, null, (tx) => tx.query('select * from group_snap_opens'), 'anon')), /permission denied/);
  // Deleting the snap (or the account) takes its opens with it.
  await rpc(1, 'delete from group_messages where id = $1', [snap.id]);
  assert.equal(await count('group_snap_opens where message_id = $1', [snap.id]), 0);
});

// ---------------------------------------------------------------------------
// 5. Push and Chat list
// ---------------------------------------------------------------------------
test('Push and Chat list say "📸 Sent a snap"; muted and blocked people get no push', async () => {
  const grp = await makeGroup([1, 2, 3]);
  const tokens = {};
  for (const i of [0, 1, 2, 3]) tokens[i] = await pushTo(i);
  await rpc(3, 'select set_group_chat_muted($1,true)', [grp]);
  await db.query('insert into blocks(blocker_id,blocked_id) values($1,$2)', [users[2], users[1]]);
  await sendSnap(grp, 1);
  assert.deepEqual(await pushesTo(tokens[0]), [{ title: '👯 Squad', body: 'QA 1: 📸 Sent a snap' }]);
  for (const i of [1, 2, 3]) assert.deepEqual(await pushesTo(tokens[i]), [], `user ${i}`);
  const line = (await rpc(0, 'select * from my_group_chats()')).rows.find((r) => r.group_id === grp);
  assert.equal(line.last_body, '📸 Sent a snap');
  assert.equal(line.last_sender, users[1]);
  assert.equal(line.unread, 1);
  assert.equal((await one("select private.group_message_preview('snap', null) as p")).p, '📸 Sent a snap');
  // The other kinds are unchanged.
  assert.equal((await one("select private.group_message_preview('photo', null) as p")).p, '📷 Photo');
  assert.equal((await one("select private.group_message_preview('proof', null) as p")).p, '📸 Posted proof – legit or cap?');
});

// ---------------------------------------------------------------------------
// 6. Files: the daily cleanup and reports
// ---------------------------------------------------------------------------
test('Old snaps that nobody saved go to the daily cleanup; saved and reported ones stay', async () => {
  const grp = await makeGroup([1, 2, 3]);
  const fresh = await sendSnap(grp, 1);
  const old = await sendSnap(grp, 1, { video: true });
  const saved = await sendSnap(grp, 1);
  const reported = await sendSnap(grp, 1);
  await open(2, saved.id);
  await save(2, saved.id);
  await open(2, reported.id);
  await rpc(2, "insert into reports(reporter_id,content_type,content_id,reason) values($1,'group_message',$2,'nudity')", [users[2], reported.id]);
  // While it can still be opened (and a day after), the sender's app can't delete it.
  assert.equal(await inUse(fresh.media_path, 1), true);
  assert.equal((await rpc(1, 'select can_cleanup_snap($1) as ok', [fresh.media_path])).rows[0].ok, false);
  await age(fresh.id, '2 days 1 minute');
  assert.equal(await inUse(fresh.media_path, 1), false);
  assert.equal(await inUse(fresh.media_path, 7), true, 'the daily cleanup waits 8 days, for reports');
  assert.equal((await rpc(1, 'select can_cleanup_snap($1) as ok', [fresh.media_path])).rows[0].ok, true);
  // 8 days on: the daily cleanup takes the old one (all its files), but not the saved or reported one.
  for (const snap of [old, saved, reported]) await age(snap.id, '8 days 1 minute');
  const claimed = await claimDaily();
  assert.ok(claimed.includes(old.media_path), 'old snap claimed');
  assert.ok(claimed.includes(old.poster_path), 'old snap poster claimed');
  assert.ok(!claimed.includes(saved.media_path), 'saved snap kept');
  assert.ok(!claimed.includes(reported.media_path), 'reported snap kept');
  // The reported one now looks deleted to everyone (step 1 of the cleanup), like every reported old peek.
  assert.equal(await count('private.media_deferred_deletions where object_name = $1', [reported.media_path]), 1);
  assert.equal(await count('private.report_media_evidence where object_name = $1', [reported.media_path]), 1);
  assert.equal(await canGet(1, reported.media_path), false);
  // The daily cleanup really deletes the old files.
  await asUser(db, null, (tx) => tx.query('delete from storage.objects where name = any($1)', [[old.media_path, old.poster_path]]), 'service_role');
  assert.equal(await count('storage.objects where name = any($1)', [[old.media_path, old.poster_path]]), 0);
});

test('Reports: anyone in the group can report a snap, and its files are kept for the report', async () => {
  const grp = await makeGroup([1, 2, 3]);
  const snap = await sendSnap(grp, 1);
  const report = (i) => failure(rpc(i, "insert into reports(reporter_id,content_type,content_id,reason) values($1,'group_message',$2,'nudity')", [users[i], snap.id]));
  assert.equal(await report(6), 'That message is gone');
  assert.equal(await report(3), 'ok');
  const saved = await one("select reported_user_id from reports where content_type = 'group_message' and content_id = $1", [snap.id]);
  assert.equal(saved.reported_user_id, users[1]);
  const kept = (await db.query('select object_name from private.report_media_evidence')).rows.map((r) => r.object_name);
  assert.deepEqual(kept, [snap.media_path]);
  // The sender deletes it: the row goes, the file waits for the report.
  await rpc(1, 'delete from group_messages where id = $1', [snap.id]);
  assert.equal((await rpc(1, 'select can_cleanup_snap($1) as ok', [snap.media_path])).rows[0].ok, true);
  await rpc(1, 'delete from storage.objects where name = $1', [snap.media_path]);
  assert.equal(await count('storage.objects where name = $1', [snap.media_path]), 1, 'kept for the report');
  assert.equal(await canGet(1, snap.media_path), false, 'but it looks deleted');
});

// ---------------------------------------------------------------------------
// 7. 1:1 chats: a camera-roll photo is a peek that's saved from the start
// ---------------------------------------------------------------------------
test('1:1: a peek sent "saved" arrives saved by its sender, says "Sent you a photo 📷" and never disappears', async () => {
  await friend(db, users[0], users[1]);
  const token = await pushTo(1);
  const send = async (extra = '', args = []) => (await rpc(0, `insert into messages(sender_id,recipient_id,kind,media_path,media_type${extra ? ',saved_at' : ''})
    values($1,$2,'snap',$3,'photo'${extra}) returning *`, [users[0], users[1], await upload(0), ...args])).rows[0];
  const photo = await send(',$4', ['2000-01-01T00:00:00Z']);
  assert.equal(photo.saved_by, users[0]);
  assert.equal(photo.saved_at.getTime(), photo.created_at.getTime(), 'saved "now", whatever time the app sent');
  assert.equal(photo.opened_at, null, 'still "new" until it is opened');
  const peek = await send();
  assert.equal(peek.saved_at, null);
  assert.deepEqual((await pushesTo(token)).map((p) => p.body), ['Sent you a photo 📷', 'Sent you a peek 👀']);
  // Opened long ago: the photo still opens, the peek doesn't.
  await rpc(1, 'select open_snap($1)', [photo.id]);
  await rpc(1, 'select open_snap($1)', [peek.id]);
  await db.query("update messages set opened_at = now() - interval '30 days' where id = any($1)", [[photo.id, peek.id]]);
  assert.equal(await canGet(1, photo.media_path), true);
  assert.equal(await canGet(1, peek.media_path), false);
  assert.equal(await canGet(2, photo.media_path), false, 'nobody else');
  assert.equal(await inUse(photo.media_path, 7), true);
  assert.ok(!(await claimDaily()).includes(photo.media_path));
  // Only for peeks you send yourself: other kinds, and rows written by the server, still arrive unsaved.
  const text = (await rpc(0, "insert into messages(sender_id,recipient_id,kind,body,saved_at) values($1,$2,'text','hi',now()) returning saved_at, saved_by", [users[0], users[1]])).rows[0];
  assert.deepEqual(text, { saved_at: null, saved_by: null });
  const server = (await db.query("insert into messages(sender_id,recipient_id,kind,media_path,media_type,saved_at,saved_by) values($1,$2,'snap',$3,'photo',now(),$2) returning saved_at, saved_by", [users[0], users[1], `${users[0]}/snaps/x.jpg`])).rows[0];
  assert.deepEqual(server, { saved_at: null, saved_by: null });
  // Either person can still unsave it (old apps offer that); then it's a normal opened peek.
  assert.equal((await rpc(1, 'select set_snap_saved($1,false) as ok', [photo.id])).rows[0].ok, true);
  assert.equal(await canGet(1, photo.media_path), false);
});

// ---------------------------------------------------------------------------
// 8. The migration itself
// ---------------------------------------------------------------------------
test('The patched functions keep their earlier changes, the helpers are private, and a second run changes nothing', async () => {
  const definition = async (fn) => (await db.query('select pg_get_functiondef($1::regprocedure) as d', [fn])).rows[0].d;
  const fns = ['private.can_read_media(text)', 'private.media_path_in_use(text,integer)', 'private.prepare_report()',
    'private.report_evidence_paths(text,uuid,uuid)', 'private.expired_media_paths()', 'private.media_cleanup_eligible(text)'];
  const before = {};
  for (const fn of fns) before[fn] = await definition(fn);
  // The public chat, drop unlock and livestream lines are still there, and the new ones are there once.
  assert.match(before['private.can_read_media(text)'], /can_read_public_photo/);
  assert.match(before['private.can_read_media(text)'], /drop_open_for/);
  assert.equal(before['private.can_read_media(text)'].split('can_read_group_snap').length - 1, 1);
  assert.match(before['private.media_path_in_use(text,integer)'], /public_photo_in_use/);
  assert.equal(before['private.media_path_in_use(text,integer)'].split('g.saved_at is not null').length - 1, 1);
  assert.match(before['private.prepare_report()'], /live_report_author/);
  assert.match(before['private.prepare_report()'], /public_photos/);
  assert.match(before['private.report_evidence_paths(text,uuid,uuid)'], /drop_open_for/);
  const sql = await readFile(MIGRATION, 'utf8');
  await db.exec(sql);
  for (const fn of fns) assert.equal(await definition(fn), before[fn], fn);
  for (const fn of ['private.can_read_group_snap(text,uuid,uuid)', 'private.group_snap_open_for(uuid,uuid)',
    'private.group_maker(uuid)', 'private.after_group_member_left()', 'private.queue_deleted_group_files()',
    'private.expired_media_paths()', 'private.media_cleanup_eligible(text)', 'private.prepare_message_state()',
    'private.request_session()', 'private.avatar_in_use(text)', 'private.queue_old_group_photo()',
    'public.claim_avatar_cleanup(integer)']) {
    for (const role of ['anon', 'authenticated']) {
      assert.equal((await one("select has_function_privilege($1, $2, 'execute') as ok", [role, fn])).ok, false, `${role} can run ${fn}`);
    }
  }
  for (const fn of ['public.open_group_snap(uuid)', 'public.replay_group_snap(uuid)', 'public.set_group_snap_saved(uuid,boolean)',
    'public.group_snap_screenshot(uuid)', 'public.delete_peek_group(uuid)', 'public.leave_peek_group(uuid)',
    'public.peek_group_status(date,uuid)']) {
    assert.equal((await one("select has_function_privilege('authenticated', $1, 'execute') as ok", [fn])).ok, true, fn);
    assert.equal((await one("select has_function_privilege('anon', $1, 'execute') as ok", [fn])).ok, false, fn);
  }
});

test('A database where a spot to change is missing stops the migration instead of skipping it', async () => {
  await assert.rejects(db.transaction(async (tx) => {
    // Pretend an unknown later change rewrote the 1:1 peek rule (in a transaction that is undone afterwards).
    const d = (await tx.query("select pg_get_functiondef('private.can_read_media(text)'::regprocedure) as d")).rows[0].d;
    await tx.exec(d
      .replace("  elsif kind = 'snaps' and private.can_read_group_snap(object_name, owner, me) then\n    return true;\n", '')
      .replace("  elsif kind = 'snaps' then", "  elsif kind in ('snaps') then"));
    const sql = await readFile(MIGRATION, 'utf8');
    await tx.exec(sql.replace(/^begin;$/m, '').replace(/^commit;$/m, ''));
  }), /could not find the one spot to change in private\.can_read_media/);
});
