// Deleting and leaving a group (supabase/migrations/20261229000000_group_snaps.sql, the owner, 21 Nov).
// The maker can delete any time; anyone who is the only one left can delete; everyone else leaves. The last one
// out deletes the group; when the maker leaves, whoever has been in the group longest becomes the maker. A deleted
// group's chat files (everyone's) go to the daily cleanup, except files a report still needs.
// Every check runs the real migrations in a local, in-memory PostgreSQL (PGlite) with invented people.
// Nothing here talks to a live project.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { asUser, createLocalDatabase, friend, seedUsers } from './local-db.mjs';

const MIGRATION = new URL('../../supabase/migrations/20261229000000_group_snaps.sql', import.meta.url);

const ONLY_MAKER = 'Only the person who made this group can delete it. You can leave it instead.';

let db;
let users;
before(async () => { db = await createLocalDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('truncate auth.users cascade; truncate storage.objects, net.sent restart identity; truncate private.avatar_deferred_deletions;');
  users = await seedUsers(db, 8);
});

const rpc = (i, sql, args = []) => asUser(db, users[i], (tx) => tx.query(sql, args));
const failure = (run) => run.then(() => 'ok', (error) => error.message);
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const count = async (sql, args = []) => (await one(`select count(*)::int as n from ${sql}`, args)).n;
const waitAMoment = () => new Promise((resolve) => setTimeout(resolve, 5));
// How many entries of PostgreSQL's shared lock table this connection uses right now (see review-robustness).
const lockEntries = async (tx) => (await tx.query('select count(*)::int as n from pg_locks where pid=pg_backend_pid()')).rows[0].n;

// A group made by person `maker` with the given others (all of them the maker's friends).
async function makeGroup(maker = 0, members = [1, 2, 3], name = 'Squad') {
  for (const i of members) await friend(db, users[maker], users[i]);
  return (await rpc(maker, 'select create_peek_group($1,$2::uuid[],current_date) as id', [name, members.map((i) => users[i])])).rows[0].id;
}
async function addLater(grp, adder, i) {
  await friend(db, users[adder], users[i]);
  await rpc(adder, 'select add_to_peek_group($1,$2::uuid[],current_date)', [grp, [users[i]]]);
}
const deleteGroup = (i, grp) => failure(rpc(i, 'select delete_peek_group($1)', [grp]));
const leaveGroup = async (i, grp) => (await rpc(i, 'select leave_peek_group($1) as r', [grp])).rows[0].r;
const exists = async (grp) => (await count('peek_groups where id = $1', [grp])) === 1;
const maker = async (grp) => (await one('select created_by from peek_groups where id = $1', [grp])).created_by;
const members = async (grp) => (await db.query('select user_id from peek_group_members where group_id = $1 order by user_id', [grp])).rows.map((r) => r.user_id);
async function upload(i, folder = 'group', ext = 'jpg') {
  const path = `${users[i]}/${folder}/${randomUUID()}.${ext}`;
  await rpc(i, "insert into storage.objects(bucket_id,name) values('media',$1)", [path]);
  return path;
}
const queued = async (paths) => (await db.query(
  'select object_name from private.media_deferred_deletions where object_name = any($1) order by 1', [paths])).rows.map((r) => r.object_name);

// ---------------------------------------------------------------------------
// 1. Who may delete
// ---------------------------------------------------------------------------
test('The maker can delete the group any time; someone else can\'t while others are in it', async () => {
  const grp = await makeGroup(0, [1, 2, 3]);
  assert.equal(await deleteGroup(1, grp), ONLY_MAKER);
  assert.equal(await deleteGroup(5, grp), 'This group is gone', 'not in it');
  assert.equal(await deleteGroup(1, randomUUID()), 'This group is gone');
  assert.equal(await failure(asUser(db, null, (tx) => tx.query('select delete_peek_group($1)', [grp]))), 'Please log in again');
  assert.equal(await exists(grp), true);
  await rpc(1, "insert into group_messages(group_id,kind,body) values($1,'text','hi')", [grp]);
  assert.equal(await deleteGroup(0, grp), 'ok');
  assert.equal(await exists(grp), false);
  assert.equal(await count('peek_group_members where group_id = $1', [grp]), 0);
  assert.equal(await count('group_messages where group_id = $1', [grp]), 0);
  // Visitors can't call it at all.
  assert.match(await failure(asUser(db, null, (tx) => tx.query('select delete_peek_group($1)', [grp]), 'anon')), /permission denied/);
});

test('Someone who is the only one left can delete the group, even if they didn\'t make it', async () => {
  const grp = await makeGroup(0, [1, 2]);
  await rpc(2, 'select leave_peek_group($1)', [grp]);
  assert.equal(await deleteGroup(1, grp), ONLY_MAKER);
  await rpc(0, 'select leave_peek_group($1)', [grp]);
  assert.deepEqual(await members(grp), [users[1]]);
  assert.equal(await deleteGroup(1, grp), 'ok');
  assert.equal(await exists(grp), false);
});

test('A group whose maker is gone (an old app left, or no maker at all): the longest-standing member counts as the maker', async () => {
  const grp = await makeGroup(0, [1, 2, 3]);
  // As if the maker had left before this update (no hand-over then): a maker who isn't in the group.
  await db.query('update peek_groups set created_by = $2 where id = $1', [grp, users[6]]);
  assert.equal(await deleteGroup(2, grp), ONLY_MAKER);
  assert.equal(await deleteGroup(0, grp), 'ok', 'users[0] has been in it longest (the same moment as 1-3, lowest id)');
  // No maker at all (the maker deleted their account before this update).
  const other = await makeGroup(0, [1, 2]);
  await db.query('update peek_groups set created_by = null where id = $1', [other]);
  assert.equal(await deleteGroup(2, other), ONLY_MAKER);
  assert.equal(await deleteGroup(0, other), 'ok');
});

// ---------------------------------------------------------------------------
// 2. Leaving
// ---------------------------------------------------------------------------
test('Leaving: you\'re taken out; the maker leaving hands the group to whoever has been in it longest; the last one out deletes it', async () => {
  // users[3] makes it with 4 and 5; users[1] (a lower id) joins later.
  const grp = await makeGroup(3, [4, 5]);
  await waitAMoment();
  await addLater(grp, 3, 1);
  assert.equal(await leaveGroup(5, grp), 'left');
  assert.equal(await maker(grp), users[3]);
  assert.equal(await failure(rpc(5, 'select leave_peek_group($1)', [grp])), 'This group is gone', 'not in it any more');
  // The maker leaves: users[4] (there from the start) takes over, not users[1] (joined later).
  assert.equal(await leaveGroup(3, grp), 'left');
  assert.equal(await maker(grp), users[4]);
  assert.deepEqual(await members(grp), [users[1], users[4]].sort());
  // The new maker can now delete it, or take people out (the old app's way).
  assert.equal((await rpc(4, 'delete from peek_group_members where group_id = $1 and user_id = $2 returning user_id', [grp, users[1]])).rows.length, 1);
  // The last one out deletes the group.
  assert.equal(await leaveGroup(4, grp), 'deleted');
  assert.equal(await exists(grp), false);
  assert.equal(await failure(asUser(db, null, (tx) => tx.query('select leave_peek_group($1)', [grp]))), 'Please log in again');
});

test('Old app versions leaving directly, and deleted accounts, follow the same rules', async () => {
  const grp = await makeGroup(0, [1, 2, 3]);
  // The maker takes someone out: nothing else changes.
  await rpc(0, 'delete from peek_group_members where group_id = $1 and user_id = $2', [grp, users[3]]);
  assert.equal(await maker(grp), users[0]);
  // The maker leaves the old way (a plain delete of their own row): users[1] takes over.
  await rpc(0, 'delete from peek_group_members where group_id = $1 and user_id = $2', [grp, users[0]]);
  assert.equal(await maker(grp), users[1]);
  // The new maker deletes their account: users[2] takes over.
  await db.query('delete from auth.users where id = $1', [users[1]]);
  assert.equal(await maker(grp), users[2]);
  // The last one deletes their account: the group goes too (no empty group left behind).
  await rpc(2, "insert into group_messages(group_id,kind,body) values($1,'text','bye')", [grp]);
  await db.query('delete from auth.users where id = $1', [users[2]]);
  assert.equal(await exists(grp), false);
  assert.equal(await count('group_messages where group_id = $1', [grp]), 0);
  // The last one leaving the old way also deletes it.
  const other = await makeGroup(4, [5]);
  await rpc(5, 'delete from peek_group_members where group_id = $1 and user_id = $2', [other, users[5]]);
  await rpc(4, 'delete from peek_group_members where group_id = $1 and user_id = $2', [other, users[4]]);
  assert.equal(await exists(other), false);
  // The maker's old direct delete still works.
  const third = await makeGroup(4, [6]);
  assert.equal((await rpc(4, 'delete from peek_groups where id = $1 returning id', [third])).rows.length, 1);
  assert.equal((await rpc(6, 'delete from peek_groups where id = $1 returning id', [await makeGroup(4, [6])])).rows.length, 0, 'not by someone else');
});

test('Leaving still takes your votes with you, and a group with votes, proofs and Guess Whos can be deleted', async () => {
  const grp = await makeGroup(0, [1, 2, 3]);
  const dare = (await rpc(0, "insert into group_messages(group_id,kind,body) values($1,'dare','Sing') returning id", [grp])).rows[0].id;
  const proof = (await rpc(1, "insert into group_messages(group_id,kind,dare_id,media_path,media_type) values($1,'proof',$2,$3,'photo') returning id", [grp, dare, await upload(1)])).rows[0].id;
  await rpc(2, 'select vote_group_proof($1,true,$2)', [proof, users[2]]);
  await rpc(3, 'select vote_group_proof($1,false,$2)', [proof, users[3]]);
  assert.equal(await leaveGroup(2, grp), 'left');
  assert.deepEqual(await one('select proof_legit, proof_cap from group_messages where id = $1', [proof]), { proof_legit: 0, proof_cap: 1 });
  await rpc(3, "insert into mystery_posts(user_id,group_id,media_path) values($1,$2,$3)", [users[3], grp, await (async () => {
    const p = `mystery/${randomUUID()}.jpg`;
    await rpc(3, "insert into storage.objects(bucket_id,name) values('media',$1)", [p]);
    return p;
  })()]);
  assert.equal(await deleteGroup(0, grp), 'ok');
  assert.equal(await count('group_proof_votes'), 0);
  assert.equal(await count('mystery_posts where group_id = $1', [grp]), 0);
});

// ---------------------------------------------------------------------------
// 3. The files of a deleted group
// ---------------------------------------------------------------------------
test('Deleting a group sends every member\'s chat files to the daily cleanup; reported ones and files still used elsewhere stay', async () => {
  const grp = await makeGroup(0, [1, 2, 3]);
  const keep = await makeGroup(0, [1], 'Other');
  const photo = await upload(1);
  const video = await upload(2, 'group', 'mp4');
  const poster = await upload(2);
  const voice = await upload(3, 'voice', 'm4a');
  const snap = await upload(1, 'snaps');
  const reported = await upload(2);
  const shared = await upload(1);
  const gone = `${users[1]}/group/${randomUUID()}.jpg`; // its file is already gone from Storage
  const ins = (i, kind, extra, vals) => rpc(i, `insert into group_messages(group_id,kind,${extra}) values(${['$1', `'${kind}'`, ...vals.map((_, n) => `$${n + 2}`)]}) returning id`, [grp, ...vals]);
  await ins(1, 'photo', 'media_path,media_type', [photo, 'photo']);
  await ins(2, 'video', 'media_path,media_type,poster_path', [video, 'video', poster]);
  await ins(3, 'voice', 'media_path,audio_ms', [voice, 1200]);
  await ins(1, 'snap', 'media_path,media_type', [snap, 'photo']);
  const bad = (await ins(2, 'photo', 'media_path,media_type', [reported, 'photo'])).rows[0].id;
  await ins(1, 'photo', 'media_path,media_type', [shared, 'photo']);
  await ins(1, 'photo', 'media_path,media_type', [gone, 'photo']);
  // The same file is also in another group's chat.
  await rpc(1, "insert into group_messages(group_id,kind,media_path,media_type) values($1,'photo',$2,'photo')", [keep, shared]);
  await rpc(3, "insert into reports(reporter_id,content_type,content_id,reason) values($1,'group_message',$2,'nudity')", [users[3], bad]);
  // Someone deleting their own message while the group is still there: not queued here (the app does that).
  const own = await upload(3);
  const mine = (await ins(3, 'photo', 'media_path,media_type', [own, 'photo'])).rows[0].id;
  await rpc(3, 'delete from group_messages where id = $1', [mine]);
  assert.deepEqual(await queued([own]), []);

  assert.equal(await deleteGroup(0, grp), 'ok');
  const all = [photo, video, poster, voice, snap, reported];
  assert.deepEqual(await queued([...all, shared, gone]), [...all].sort());
  // They look deleted at once, even to the people who sent them.
  assert.equal(await count('storage.objects where name = $1', [photo]), 1);
  assert.equal((await rpc(1, 'select count(*)::int as n from storage.objects where name = $1', [photo])).rows[0].n, 0);
  // The daily cleanup takes them all, except the one a report needs; the shared file stays for the other group.
  const claimed = (await asUser(db, null, (tx) => tx.query('select name from claim_media_cleanup(1000)'), 'service_role')).rows.map((r) => r.name);
  for (const path of [photo, video, poster, voice, snap]) assert.ok(claimed.includes(path), path);
  assert.ok(!claimed.includes(reported), 'kept for the report');
  assert.ok(!claimed.includes(shared), 'still used in the other group');
  assert.equal((await rpc(1, 'select count(*)::int as n from storage.objects where name = $1', [shared])).rows[0].n, 1);
});

test('The old direct delete by the maker queues the files too', async () => {
  const grp = await makeGroup(0, [1, 2]);
  const photo = await upload(2);
  await rpc(2, "insert into group_messages(group_id,kind,media_path,media_type) values($1,'photo',$2,'photo')", [grp, photo]);
  await rpc(0, 'delete from peek_groups where id = $1', [grp]);
  assert.deepEqual(await queued([photo]), [photo]);
});

test('Deleting a group with 3,000 photos uses only a few lock table entries', { timeout: 300_000 }, async () => {
  const grp = await makeGroup(0, [1]);
  await db.query(`insert into storage.objects(bucket_id,name,owner_id)
    select 'media',$1::text||'/group/big-'||g||'.jpg',$1::text from generate_series(1,3000) g`, [users[1]]);
  await db.query(`insert into public.group_messages(group_id,sender_id,kind,media_path,media_type)
    select $1::uuid,$2::uuid,'photo',$2::text||'/group/big-'||g||'.jpg','photo' from generate_series(1,3000) g`, [grp, users[1]]);
  const held = await asUser(db, users[0], async (tx) => {
    await tx.query('select delete_peek_group($1)', [grp]);
    return lockEntries(tx);
  });
  assert.ok(held <= 400, `deleting the group used ${held} lock table entries`);
  assert.equal(await count('group_messages where group_id = $1', [grp]), 0);
  assert.equal(await count("private.media_deferred_deletions where object_name like $1", [`${users[1]}/group/big-%`]), 3000);
});

// ---------------------------------------------------------------------------
// 4. Groups from before this update, and group pictures
// ---------------------------------------------------------------------------
// The old app's "Leave group" just took your own member row out (the trigger that now tidies up wasn't there yet).
async function oldAppLeaves(grp, who) {
  await db.exec('alter table public.peek_group_members disable trigger peek_group_members_after_leave');
  try {
    await db.query('delete from peek_group_members where group_id = $1 and user_id = any($2)', [grp, who.map((i) => users[i])]);
  } finally {
    await db.exec('alter table public.peek_group_members enable trigger peek_group_members_after_leave');
  }
}
const runMigrationAgain = async () => db.exec(await readFile(MIGRATION, 'utf8'));
async function avatar(i) {
  const path = `${users[i]}/${randomUUID()}.jpg`;
  await rpc(i, "insert into storage.objects(bucket_id,name) values('avatars',$1)", [path]);
  return path;
}
const queuedPictures = async () => (await db.query('select object_name from private.avatar_deferred_deletions order by 1')).rows.map((r) => r.object_name);
const claimPictures = async () => (await asUser(db, null, (tx) => tx.query('select name from claim_avatar_cleanup(1000)'), 'service_role')).rows.map((r) => r.name).sort();

test('Groups everyone had already left before this update are deleted when it runs; their files go to the daily cleanup', async () => {
  const grp = await makeGroup(0, [1, 2]);
  const kept = await makeGroup(0, [1], 'Still here');
  const photo = await upload(1);
  const reported = await upload(2);
  await rpc(1, "insert into group_messages(group_id,kind,media_path,media_type) values($1,'photo',$2,'photo')", [grp, photo]);
  const bad = (await rpc(2, "insert into group_messages(group_id,kind,media_path,media_type) values($1,'photo',$2,'photo') returning id", [grp, reported])).rows[0].id;
  await rpc(1, "insert into reports(reporter_id,content_type,content_id,reason) values($1,'group_message',$2,'nudity')", [users[1], bad]);
  const mystery = `mystery/${randomUUID()}.jpg`;
  await rpc(2, "insert into storage.objects(bucket_id,name) values('media',$1)", [mystery]);
  await rpc(2, 'insert into mystery_posts(user_id,group_id,media_path) values($1,$2,$3)', [users[2], grp, mystery]);
  const picture = await avatar(1);
  await rpc(1, 'select set_group_photo($1,$2)', [grp, picture]);
  // Everybody leaves with the old app: the empty group stays behind, with its chat and files.
  await oldAppLeaves(grp, [0, 1, 2]);
  assert.equal(await exists(grp), true, 'the old app left it behind');
  assert.equal(await count('group_messages where group_id = $1', [grp]), 2);

  await runMigrationAgain();
  assert.equal(await exists(grp), false);
  assert.equal(await exists(kept), true, 'a group with people in it stays');
  assert.equal(await count('group_messages where group_id = $1', [grp]), 0);
  assert.equal(await count('mystery_posts where group_id = $1', [grp]), 0);
  assert.deepEqual(await queued([photo, reported, mystery]), [photo, reported, mystery].sort());
  assert.deepEqual(await queuedPictures(), [picture]);
  // The daily cleanup takes them, except the file the report still needs.
  const claimed = (await asUser(db, null, (tx) => tx.query('select name from claim_media_cleanup(1000)'), 'service_role')).rows.map((r) => r.name);
  assert.ok(claimed.includes(photo), 'chat photo');
  assert.ok(claimed.includes(mystery), 'Guess Who photo');
  assert.ok(!claimed.includes(reported), 'kept for the report');
  assert.equal((await one('select private.media_cleanup_eligible($1) as ok', [reported])).ok, false);
  // A third run changes nothing more.
  await runMigrationAgain();
  assert.equal(await exists(kept), true);
});

test('Groups whose maker left before this update: the app\'s list and the server pick the same maker', async () => {
  // Everyone picked when the group is made joins at the very same moment. The friends are given highest id first,
  // so the order they were added in is not the order of their ids.
  const grp = await makeGroup(0, [3, 2, 1]);
  const status = async (i, which = grp) => (await rpc(i, 'select user_id from peek_group_status(current_date, $1)', [which])).rows.map((r) => r.user_id);
  // The maker leaves with the old app (no hand-over then).
  await oldAppLeaves(grp, [0]);
  assert.equal(await maker(grp), users[0], 'the group still names the maker who left');
  // People who joined at the same moment come in id order, the same order the server uses for "longest in it".
  // (Without the id in the sort, ties come back in whatever order the database finds them.)
  assert.deepEqual(await status(3), [users[1], users[2], users[3]]);
  assert.match((await one("select pg_get_functiondef('public.peek_group_status(date,uuid)'::regprocedure) as d")).d, /order by m\.joined_at, m\.user_id/);
  await runMigrationAgain();
  assert.equal(await maker(grp), users[1], 'the longest-standing member (lowest id on a tie) is the maker now');
  // Only that person can delete it; the app shows Delete to exactly them (the first one in the list).
  assert.equal(await deleteGroup(3, grp), ONLY_MAKER);
  assert.equal(await deleteGroup(2, grp), ONLY_MAKER);
  assert.equal(await deleteGroup(1, grp), 'ok');
  // Someone added later still comes after everyone who was there first, whatever their id.
  const later = await makeGroup(4, [6]);
  await waitAMoment();
  await addLater(later, 4, 1);
  assert.deepEqual(await status(4, later), [users[4], users[6], users[1]]);
});

test('A deleted group\'s picture, and a replaced one, go to the daily cleanup – unless the same file is still used', async () => {
  const grp = await makeGroup(0, [1, 2]);
  const other = await makeGroup(0, [1], 'Other');
  const first = await avatar(1);
  const second = await avatar(1);
  const profilePicture = await avatar(1);
  const shared = await avatar(1);
  await db.query('update profiles set avatar_path = $1 where id = $2', [profilePicture, users[1]]);
  await rpc(1, 'select set_group_photo($1,$2)', [grp, first]);
  assert.deepEqual(await queuedPictures(), []);
  // A new picture: the old one goes. Taking it off: that one goes too.
  await rpc(1, 'select set_group_photo($1,$2)', [grp, second]);
  assert.deepEqual(await queuedPictures(), [first]);
  await rpc(1, 'select set_group_photo($1,null)', [grp]);
  assert.deepEqual(await queuedPictures(), [first, second].sort());
  // The same file as someone's profile picture, or as another group's picture: kept.
  await rpc(1, 'select set_group_photo($1,$2)', [grp, profilePicture]);
  await rpc(1, 'select set_group_photo($1,$2)', [other, shared]);
  await rpc(1, 'select set_group_photo($1,$2)', [grp, shared]);
  assert.deepEqual(await queuedPictures(), [first, second].sort(), 'the profile picture is not queued');
  assert.equal(await deleteGroup(0, grp), 'ok');
  assert.deepEqual(await queuedPictures(), [first, second].sort(), 'the other group still uses it');
  // The old direct delete by the maker (old apps) queues it too.
  assert.equal(await failure(rpc(0, 'delete from peek_groups where id = $1', [other])), 'ok');
  assert.deepEqual(await queuedPictures(), [first, second, shared].sort());

  // The daily cleanup gets them – only the service key can ask.
  assert.deepEqual(await claimPictures(), [first, second, shared].sort());
  assert.match(await failure(rpc(1, 'select * from claim_avatar_cleanup(10)')), /permission denied/);
  assert.match(await failure(rpc(1, 'select * from private.avatar_deferred_deletions')), /permission denied/);
  // Someone uses one of them again before the cleanup ran: it is kept, and forgotten.
  await db.query('update profiles set avatar_path = $1 where id = $2', [second, users[1]]);
  // The cleanup deleted one from storage: the next run forgets it.
  await asUser(db, null, (tx) => tx.query("delete from storage.objects where bucket_id = 'avatars' and name = $1", [first]), 'service_role');
  assert.deepEqual(await claimPictures(), [shared]);
  assert.deepEqual(await queuedPictures(), [shared]);
  // Group pictures that still belong to a group are never on the list; profile pictures neither.
  assert.equal(await count("storage.objects where bucket_id = 'avatars' and name = any($1)", [[profilePicture, second, shared]]), 3);
});
