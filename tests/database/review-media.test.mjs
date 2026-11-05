// Review package DB-1: keeps, reports, report evidence and file cleanup.
// Every check runs all migrations in a local, in-memory PostgreSQL (PGlite).
// Nothing here talks to a live project.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { asUser, createLocalDatabase, friend, seedUsers } from './local-db.mjs';

let db;
let users;
before(async () => { db = await createLocalDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('truncate auth.users cascade; truncate storage.objects, net.sent restart identity; truncate private.media_cleanup_claims;');
  // The table for "deleted, but kept for a report" files only exists once the fix is in.
  await db.exec("do $$ begin if to_regclass('private.media_deferred_deletions') is not null then truncate private.media_deferred_deletions; end if; end $$;");
  users = await seedUsers(db);
});

const rpc = (i, sql, args = []) => asUser(db, users[i], (tx) => tx.query(sql, args));
const server = (sql, args = []) => asUser(db, null, (tx) => tx.query(sql, args), 'service_role');
const one = async (run) => (await run).rows[0];
const stored = async (path) => (await db.query('select count(*)::int as n from storage.objects where name=$1', [path])).rows[0].n;
const evidence = async () => (await db.query('select object_name from private.report_media_evidence order by object_name')).rows.map((r) => r.object_name);
const claims = async () => (await db.query('select count(*)::int as n from private.media_cleanup_claims')).rows[0].n;
const outcome = (run) => run.then(() => 'ok', (error) => `error: ${error.message}`);

async function upload(i, folder, name = `${randomUUID()}.jpg`) {
  const path = folder === 'mystery' ? `mystery/${name}` : `${users[i]}/${folder}/${name}`;
  await rpc(i, "insert into storage.objects(bucket_id,name) values('media',$1)", [path]);
  return path;
}
async function post(i, extra = {}) {
  const path = await upload(i, 'posts');
  const fields = { user_id: users[i], media_path: path, ...extra };
  const keys = Object.keys(fields);
  const id = (await rpc(i, `insert into posts(${keys}) values(${keys.map((_, n) => `$${n + 1}`)}) returning id`, Object.values(fields))).rows[0].id;
  return { id, path };
}
async function story(i, extra = {}) {
  const path = await upload(i, 'stories');
  const fields = { user_id: users[i], media_path: path, ...extra };
  const keys = Object.keys(fields);
  const id = (await rpc(i, `insert into stories(${keys}) values(${keys.map((_, n) => `$${n + 1}`)}) returning id`, Object.values(fields))).rows[0].id;
  return { id, path };
}
async function message(i, j, extra = {}) {
  await friend(db, users[i], users[j]);
  const fields = { sender_id: users[i], recipient_id: users[j], kind: 'text', body: 'hello', ...extra };
  const keys = Object.keys(fields);
  return (await rpc(i, `insert into messages(${keys}) values(${keys.map((_, n) => `$${n + 1}`)}) returning *`, Object.values(fields))).rows[0];
}
async function snap(i, j) {
  const path = await upload(i, 'snaps');
  return { path, ...(await message(i, j, { kind: 'snap', body: null, media_path: path })) };
}
async function group(members) {
  for (const i of members) await friend(db, users[0], users[i]);
  return (await rpc(0, "select create_peek_group('QA review group',$1::uuid[],current_date) as id", [members.map((i) => users[i])])).rows[0].id;
}
async function oldStory(i = 0) {
  const s = await story(i);
  await db.query("update stories set expires_at=now()-interval '8 days' where id=$1", [s.id]);
  return s;
}
// A report as the app sends it (src/lib/safety.ts reportContent): a direct insert into reports.
const report = (i, type, id, reported = users[0]) => rpc(i,
  'insert into reports(reporter_id,reported_user_id,content_type,content_id,reason) values($1,$2,$3,$4,$5) returning id',
  [users[i], reported, type, id, 'spam']);
const reportId = async (...args) => (await report(...args)).rows[0].id;
const deleteFile = (i, path) => rpc(i, "delete from storage.objects where bucket_id='media' and name=$1", [path]);
// Exactly what Storage runs for remove([path]). Storage sends the returned rows back to the caller
// (supabase-js remove() gives them as `data`), so the number of rows is part of the answer.
const removeFile = (i, path) => rpc(i, "delete from storage.objects where bucket_id='media' and name = any($1) returning name", [[path]])
  .then((r) => `ok, ${r.rows.length} rows returned`, (error) => `error: ${error.message}`);
// The daily cleanup, the way supabase/functions/cleanup-media runs it (service role).
async function dailyCleanup() {
  const names = (await server('select name from claim_media_cleanup(1000)')).rows.map((r) => r.name);
  if (names.length) await server("delete from storage.objects where bucket_id='media' and name = any($1) returning name", [names]);
  return names;
}
// Inserts rows the way old data may already look in the live database (before the new keep rule).
async function legacyKeep(i, fields) {
  await db.exec('set session_replication_role = replica');
  try {
    const keys = Object.keys(fields);
    await db.query(`insert into keeps(user_id,media_type,${keys}) values($1,'photo',${keys.map((_, n) => `$${n + 2}`)})`, [users[i], ...Object.values(fields)]);
  } finally { await db.exec('set session_replication_role = origin'); }
}

// ---------------------------------------------------------------------------
// 1. Keeps can only point at files in their owner's own folder.
// ---------------------------------------------------------------------------
test('A keep cannot point its poster or overlay at someone else\'s file', async () => {
  const victim = await story(0);
  const mine = await upload(1, 'keeps');
  for (const column of ['poster_path', 'overlay_path']) {
    await assert.rejects(
      () => rpc(1, `insert into keeps(user_id,media_path,media_type,${column}) values($1,$2,'video',$3)`, [users[1], mine, victim.path]),
      /own|folder|yours|security|violat/i,
    );
  }
  // Editing your own keep later cannot sneak a foreign file in either.
  const keep = (await rpc(1, "insert into keeps(user_id,media_path,media_type) values($1,$2,'photo') returning id", [users[1], mine])).rows[0].id;
  await assert.rejects(() => rpc(1, 'update keeps set overlay_path=$2 where id=$1', [keep, victim.path]), /own|folder|yours|security|violat/i);
  await assert.rejects(() => rpc(1, 'update keeps set poster_path=$2 where id=$1', [keep, `mystery/${randomUUID()}.jpg`]), /own|folder|yours|security|violat/i);
  // Trusted code paths are held to the same rule.
  await assert.rejects(() => db.query("insert into keeps(user_id,media_path,media_type,poster_path) values($1,$2,'video',$3)", [users[1], mine, victim.path]), /own|folder|yours/i);
  // So the owner can still delete her own story file.
  await rpc(0, 'delete from stories where id=$1', [victim.id]);
  assert.equal(await outcome(deleteFile(0, victim.path)), 'ok');
  await dailyCleanup();
  assert.equal(await stored(victim.path), 0);
});

test('A keep saved by the app (photo, or video with poster and overlay) still works and can be removed', async () => {
  const media = await upload(0, 'keeps', `${randomUUID()}.mp4`);
  const poster = await upload(0, 'keeps');
  const overlay = await upload(0, 'keeps', `${randomUUID()}.png`);
  const keep = (await rpc(0, "insert into keeps(user_id,media_path,media_type,poster_path,overlay_path) values($1,$2,'video',$3,$4) returning *", [users[0], media, poster, overlay])).rows[0];
  assert.equal(keep.poster_path, poster);
  const photo = await upload(0, 'keeps');
  await rpc(0, "insert into keeps(user_id,media_path,media_type) values($1,$2,'photo')", [users[0], photo]);
  // While the keep exists its files are in use; after deleting the keep they can be removed.
  await assert.rejects(() => deleteFile(0, poster), /Cleanup cancelled/);
  await rpc(0, 'delete from keeps where id=$1', [keep.id]);
  for (const path of [media, poster, overlay]) assert.equal(await outcome(deleteFile(0, path)), 'ok');
  await dailyCleanup();
  assert.equal((await db.query('select count(*)::int as n from storage.objects where name=any($1)', [[media, poster, overlay]])).rows[0].n, 0);
});

test('An old keep row that already points at someone else\'s file cannot pin that file', async () => {
  const victim = await oldStory(0);
  await legacyKeep(1, { media_path: await upload(1, 'keeps'), poster_path: victim.path });
  // The daily cleanup still finds the expired story file ...
  assert.deepEqual((await server('select name from media_cleanup_candidates(100)')).rows, [{ name: victim.path }]);
  // ... and the owner can still delete it herself.
  assert.equal(await outcome(deleteFile(0, victim.path)), 'ok');
  await dailyCleanup();
  assert.equal(await stored(victim.path), 0);
  // Updating unrelated columns of the old row keeps working.
  await db.query('update keeps set created_at=now() where user_id=$1', [users[1]]);
});

// ---------------------------------------------------------------------------
// 2. INSERT ... ON CONFLICT DO NOTHING cannot attach evidence to an old report.
// ---------------------------------------------------------------------------
test('A skipped report insert (on conflict do nothing) saves no evidence', async () => {
  const mine = await post(1);
  const victim = await post(0);
  const id = await reportId(2, 'post', mine.id, users[1]);
  assert.deepEqual(await evidence(), [mine.path]);
  const skipped = await rpc(2,
    "insert into reports(id,reporter_id,reported_user_id,content_type,content_id,reason) values($1,$2,$3,'post',$4,'spam') on conflict(id) do nothing returning id",
    [id, users[2], users[0], victim.id]);
  assert.equal(skipped.rows.length, 0);
  assert.deepEqual(await evidence(), [mine.path], 'nothing new may be pinned');
  assert.equal((await db.query('select count(*)::int as n from reports')).rows[0].n, 1);
  await rpc(0, 'delete from posts where id=$1', [victim.id]);
  assert.equal(await outcome(deleteFile(0, victim.path)), 'ok');
  await dailyCleanup();
  assert.equal(await stored(victim.path), 0);
});

// ---------------------------------------------------------------------------
// 3. You can only report what you can see; the reported person comes from the content.
// ---------------------------------------------------------------------------
test('Reports of content the reporter cannot see are refused and pin nothing', async () => {
  // A private account's post, seen by a stranger.
  await db.query('update profiles set is_private=true where id=$1', [users[0]]);
  const hidden = await post(0);
  await assert.rejects(() => report(5, 'post', hidden.id));
  // A close-friends post and story, seen by a friend who is not a close friend.
  await db.query('update profiles set is_private=false where id=$1', [users[0]]);
  await friend(db, users[0], users[1]);
  const closePost = await post(0, { audience: 'close_friends' });
  const closeStory = await story(0, { audience: 'close_friends' });
  await assert.rejects(() => report(1, 'post', closePost.id));
  await assert.rejects(() => report(1, 'story', closeStory.id));
  // A friends-only story, seen by a stranger.
  const plainStory = await story(0);
  await assert.rejects(() => report(5, 'story', plainStory.id));
  // A private 1:1 snap between two other people.
  const peek = await snap(0, 2);
  await assert.rejects(() => report(5, 'message', peek.id));
  // A comment under a post the reporter cannot see.
  await db.query('update profiles set is_private=true where id=$1', [users[0]]);
  const comment = (await rpc(1, "insert into comments(user_id,post_id,body) values($1,$2,'nice photo') returning id", [users[1], hidden.id])).rows[0].id;
  await assert.rejects(() => report(5, 'comment', comment, users[1]));
  // A Guess Who post of someone who is not your friend, directly or through the app's function.
  const guessPath = await upload(0, 'mystery');
  const guess = (await rpc(0, 'insert into mystery_posts(user_id,media_path) values($1,$2) returning id', [users[0], guessPath])).rows[0].id;
  await assert.rejects(() => report(5, 'post', guess));
  await assert.rejects(() => rpc(5, "select report_mystery($1,'spam')", [guess]));
  assert.equal((await db.query('select count(*)::int as n from reports')).rows[0].n, 0);
  assert.deepEqual(await evidence(), []);
});

test('The reported person is taken from the content, not from what the app sends', async () => {
  await friend(db, users[0], users[1]);
  const p = await post(0);
  const s = await story(0);
  const m = await snap(0, 1);
  const c = (await rpc(2, "insert into comments(user_id,post_id,body) values($1,$2,'what a view') returning id", [users[2], p.id])).rows[0].id;
  for (const [type, id, author] of [['post', p.id, users[0]], ['story', s.id, users[0]], ['message', m.id, users[0]], ['comment', c, users[2]]]) {
    const row = (await report(1, type, id, users[7])).rows[0];
    const saved = (await db.query('select reported_user_id from reports where id=$1', [row.id])).rows[0];
    assert.equal(saved.reported_user_id, author, `${type} report must name the real author`);
  }
});

test('A Guess Who post cannot be reported directly to learn who posted it', async () => {
  await friend(db, users[0], users[1]);
  const guessPath = await upload(0, 'mystery');
  const guess = (await rpc(0, 'insert into mystery_posts(user_id,media_path) values($1,$2) returning id', [users[0], guessPath])).rows[0].id;
  // A direct insert would let the reporter read back reported_user_id, so it is refused.
  await assert.rejects(() => report(1, 'post', guess, users[1]));
  assert.equal((await rpc(1, 'select * from reports')).rows.length, 0);
  // The app's own Guess Who report still works and stays anonymous to the reporter.
  await rpc(1, "select report_mystery($1,'spam')", [guess]);
  assert.equal((await rpc(1, 'select * from reports')).rows.length, 0);
  const saved = (await db.query('select reported_user_id,anonymous_content from reports')).rows[0];
  assert.deepEqual(saved, { reported_user_id: users[0], anonymous_content: true });
  assert.deepEqual(await evidence(), [guessPath]);
});

test('Every report the current app sends still works', async () => {
  await friend(db, users[0], users[1]);
  const p = await post(0);
  const s = await story(0);
  const m = await message(0, 1);
  const c = (await rpc(0, "insert into comments(user_id,post_id,body) values($1,$2,'my own caption note') returning id", [users[0], p.id])).rows[0].id;
  const g = await group([1, 2]);
  const gm = (await rpc(0, "insert into group_messages(group_id,sender_id,kind,body) values($1,$2,'text','hi all') returning id", [g, users[0]])).rows[0].id;
  // reportContent(): post, story, message, comment, group message, profile and hit up ('user').
  for (const [type, id] of [['post', p.id], ['story', s.id], ['message', m.id], ['comment', c], ['group_message', gm]]) {
    await report(1, type, id);
  }
  await report(1, 'user', users[0]);
  await rpc(3, "insert into reports(reporter_id,reported_user_id,content_type,content_id,reason) values($1,$2,'user',$2,'other')", [users[3], users[0]]);
  // An old app that leaves content_id empty for a profile report.
  await rpc(4, "insert into reports(reporter_id,reported_user_id,content_type,reason) values($1,$2,'user','spam')", [users[4], users[0]]);
  // The recipient can report an old opened peek; the sender can report their own chat too.
  const oldPeek = await snap(0, 1);
  await db.query("update messages set opened_at=now()-interval '3 days' where id=$1", [oldPeek.id]);
  await report(1, 'message', oldPeek.id);
  // A story that has just expired can still be reported by a friend who saw it.
  const expired = await oldStory(0);
  await report(1, 'story', expired.id);
  // Guess Who and community dare ideas use their own functions.
  const guess = (await rpc(0, 'insert into mystery_posts(user_id,media_path) values($1,$2) returning id', [users[0], await upload(0, 'mystery')])).rows[0].id;
  await rpc(1, "select report_mystery($1,'spam')", [guess]);
  const idea = (await rpc(0, "insert into dare_ideas(user_id,text) values($1,'Wear a silly hat today') returning id", [users[0]])).rows[0].id;
  await rpc(1, "select report_dare_idea($1,'spam')", [idea]);
  const rows = (await db.query('select content_type,reported_user_id,status from reports order by created_at')).rows;
  assert.equal(rows.length, 12);
  assert.ok(rows.every((r) => r.reported_user_id === users[0] && r.status === 'open'));
});

test('A locked drop post can be reported, but only the blurry preview is kept as evidence', async () => {
  await friend(db, users[0], users[1]);
  const p = await post(0, { blur_path: await upload(0, 'blurs') });
  await db.exec('set session_replication_role = replica');
  try { await db.query('update posts set drop_day=current_date where id=$1', [p.id]); } finally { await db.exec('set session_replication_role = origin'); }
  const blur = (await db.query('select blur_path from posts where id=$1', [p.id])).rows[0].blur_path;
  await report(1, 'post', p.id);
  assert.deepEqual(await evidence(), [blur]);
});

// ---------------------------------------------------------------------------
// 4. Evidence policy: comments, dismissed reports, the owner's release and deferred deletion.
// ---------------------------------------------------------------------------
test('A comment report does not pin the parent post\'s photo', async () => {
  await friend(db, users[0], users[1]);
  await friend(db, users[0], users[2]);
  const p = await post(0);
  const c = (await rpc(1, "insert into comments(user_id,post_id,body) values($1,$2,'not nice') returning id", [users[1], p.id])).rows[0].id;
  await report(2, 'comment', c, users[1]);
  assert.deepEqual(await evidence(), []);
  await rpc(0, 'delete from posts where id=$1', [p.id]);
  assert.equal(await outcome(deleteFile(0, p.path)), 'ok');
  await dailyCleanup();
  assert.equal(await stored(p.path), 0);
});

test('A dismissed report releases its evidence; a reviewed report keeps it', async () => {
  const dismissed = await post(0);
  const reviewed = await post(0);
  const a = await reportId(1, 'post', dismissed.id);
  const b = await reportId(1, 'post', reviewed.id);
  await db.query("update reports set status='dismissed' where id=$1", [a]);
  await db.query("update reports set status='reviewed' where id=$1", [b]);
  assert.deepEqual(await evidence(), [reviewed.path]);
  for (const item of [dismissed, reviewed]) await rpc(0, 'delete from posts where id=$1', [item.id]);
  assert.equal(await outcome(deleteFile(0, dismissed.path)), 'ok');
  assert.equal(await outcome(deleteFile(0, reviewed.path)), 'ok', 'the delete must not fail visibly');
  await dailyCleanup();
  assert.equal(await stored(dismissed.path), 0);
  assert.equal(await stored(reviewed.path), 1, 'the reviewed report keeps its evidence');
});

test('Only the owner (service role) can release one report\'s evidence', async () => {
  const p = await post(0);
  const id = await reportId(1, 'post', p.id);
  await assert.rejects(() => rpc(1, 'select release_report_evidence($1)', [id]));
  await assert.rejects(() => rpc(0, 'select release_report_evidence($1)', [id]));
  assert.deepEqual(await evidence(), [p.path]);
  assert.equal((await server('select release_report_evidence($1) as n', [id])).rows[0].n, 1);
  assert.deepEqual(await evidence(), []);
  // The report itself stays for the record.
  assert.equal((await db.query('select status from reports where id=$1', [id])).rows[0].status, 'open');
  await rpc(0, 'delete from posts where id=$1', [p.id]);
  assert.equal(await outcome(deleteFile(0, p.path)), 'ok');
  await dailyCleanup();
  assert.equal(await stored(p.path), 0);
});

test('An owner can "delete" a reported file: it is kept for the report, then cleaned up once released', async () => {
  const p = await post(0);
  const id = await reportId(1, 'post', p.id);
  await rpc(0, 'delete from posts where id=$1', [p.id]);
  assert.equal(await outcome(deleteFile(0, p.path)), 'ok');
  assert.equal(await stored(p.path), 1, 'the bytes stay as evidence');
  // To the owner it looks deleted.
  assert.equal((await rpc(0, "select name from storage.objects where bucket_id='media' and name=$1", [p.path])).rows.length, 0);
  // While the report is open the daily cleanup leaves it alone.
  assert.deepEqual((await server('select name from claim_media_cleanup(100)')).rows, []);
  // The service role cannot simply delete it either (release it first).
  await assert.rejects(() => server("delete from storage.objects where bucket_id='media' and name=$1", [p.path]), /Cleanup cancelled/);
  // Once the report is dismissed the daily cleanup picks the file up.
  await db.query("update reports set status='dismissed' where id=$1", [id]);
  assert.deepEqual((await server('select name from claim_media_cleanup(100)')).rows, [{ name: p.path }]);
  await server("delete from storage.objects where bucket_id='media' and name=$1", [p.path]);
  assert.equal(await stored(p.path), 0);
  assert.equal((await db.query('select count(*)::int as n from private.media_deferred_deletions')).rows[0].n, 0);
});

test('A deferred file released by the owner\'s function is picked up by the daily cleanup', async () => {
  await friend(db, users[0], users[1]);
  const peek = await snap(0, 1);
  const id = await reportId(1, 'message', peek.id);
  await rpc(0, 'delete from messages where id=$1', [peek.id]);
  assert.equal((await rpc(0, 'select can_cleanup_snap($1) as ok', [peek.path])).rows[0].ok, true);
  assert.equal(await outcome(deleteFile(0, peek.path)), 'ok');
  assert.equal(await stored(peek.path), 1);
  assert.deepEqual((await server('select name from media_cleanup_candidates(100)')).rows, []);
  await server('select release_report_evidence($1)', [id]);
  assert.deepEqual((await server('select name from claim_media_cleanup(100)')).rows, [{ name: peek.path }]);
  await server("delete from storage.objects where bucket_id='media' and name=$1", [peek.path]);
  assert.equal(await stored(peek.path), 0);
});

test('Normal uploads still work the way Storage saves them (insert/upsert with returning)', async () => {
  // Storage writes the file record with "insert ... returning" (and "on conflict ... do update" for upsert),
  // so the "looks deleted" rule must also pass for a brand-new row.
  const path = `${users[0]}/posts/${randomUUID()}.jpg`;
  assert.equal((await rpc(0, "insert into storage.objects(bucket_id,name) values('media',$1) returning name", [path])).rows[0].name, path);
  const other = `${users[0]}/posts/${randomUUID()}.jpg`;
  const upsert = await rpc(0, "insert into storage.objects(bucket_id,name) values('media',$1) on conflict(bucket_id,name) do update set metadata='{}' returning name", [other]);
  assert.equal(upsert.rows[0].name, other);
  assert.equal((await rpc(0, 'select name from storage.objects where name=any($1)', [[path, other]])).rows.length, 2);
});

// ---------------------------------------------------------------------------
// 5. No report oracle, and no private helper callable by app users.
// ---------------------------------------------------------------------------
async function senderView(kind, reported) {
  // Everything the sender (user 0) can observe after unsending a file the recipient may have reported.
  let path; let id; let table;
  if (kind === 'voice') {
    path = await upload(0, 'voice', `${randomUUID()}.m4a`);
    id = (await message(0, 1, { kind: 'voice', body: null, media_path: path, audio_ms: 1500 })).id;
    table = 'messages';
  } else if (kind === 'snap') {
    const s = await snap(0, 1); path = s.path; id = s.id; table = 'messages';
  } else if (kind === 'old-snap') {
    // Not unsent: an opened peek more than a day old.
    const s = await snap(0, 1); path = s.path; id = s.id; table = null;
    await db.query("update messages set opened_at=now()-interval '2 days' where id=$1", [id]);
  } else {
    const g = await group([1, 2]);
    path = await upload(0, 'group');
    id = (await rpc(0, "insert into group_messages(group_id,sender_id,kind,media_path,media_type) values($1,$2,'photo',$3,'photo') returning id", [g, users[0], path])).rows[0].id;
    table = 'group_messages';
  }
  if (reported) await report(1, kind === 'group' ? 'group_message' : 'message', id);
  if (table) await rpc(0, `delete from ${table} where id=$1`, [id]);
  const view = {};
  view.canCleanUp = (await rpc(0, 'select can_cleanup_snap($1) as ok', [path])).rows[0].ok;
  view.remove = await removeFile(0, path);
  view.stillListed = (await rpc(0, "select count(*)::int as n from storage.objects where bucket_id='media' and name=$1", [path])).rows[0].n;
  view.canCleanUpAgain = (await rpc(0, 'select can_cleanup_snap($1) as ok', [path])).rows[0].ok;
  view.removeAgain = await removeFile(0, path);
  view.reupload = await outcome(rpc(0, "insert into storage.objects(bucket_id,name) values('media',$1)", [path]));
  view.reuse = await outcome(rpc(0, "insert into keeps(user_id,media_path,media_type) values($1,$2,'photo')", [users[0], path]));
  view.signedRead = (await rpc(0, 'select private.can_read_media($1) as ok', [path])).rows[0].ok;
  view.seesReports = (await rpc(0, 'select count(*)::int as n from reports')).rows[0].n;
  return view;
}

test('A sender sees exactly the same answers whether or not the recipient reported the message', async () => {
  for (const kind of ['voice', 'snap', 'old-snap', 'group']) {
    const quiet = await senderView(kind, false);
    const reported = await senderView(kind, true);
    assert.deepEqual(reported, quiet, `${kind}: answers must not depend on a report`);
    assert.match(quiet.remove, /^ok/);
  }
});

test('A post, story or Guess Who author sees the same delete result whether or not it was reported', async () => {
  await friend(db, users[0], users[1]);
  const run = async (kind, reported) => {
    let id; let path; let table;
    if (kind === 'post') ({ id, path } = await post(0)), table = 'posts';
    else if (kind === 'story') ({ id, path } = await story(0)), table = 'stories';
    else {
      path = await upload(0, 'mystery');
      id = (await rpc(0, 'insert into mystery_posts(user_id,media_path) values($1,$2) returning id', [users[0], path])).rows[0].id;
      table = 'mystery_posts';
    }
    if (reported) {
      if (kind === 'guess') await rpc(1, "select report_mystery($1,'spam')", [id]);
      else await report(1, kind, id);
    }
    await rpc(0, `delete from ${table} where id=$1`, [id]);
    const view = {
      remove: await removeFile(0, path),
      listed: (await rpc(0, 'select count(*)::int as n from storage.objects where name=$1', [path])).rows[0].n,
      uploadedByMe: (await rpc(0, 'select private.uploaded_by_me($1) as ok', [path])).rows[0].ok,
      removeAgain: await removeFile(0, path),
      reupload: await outcome(rpc(0, "insert into storage.objects(bucket_id,name) values('media',$1)", [path])),
    };
    // ... and the same again after the next daily cleanup.
    await dailyCleanup();
    view.afterCleanup = {
      listed: (await rpc(0, 'select count(*)::int as n from storage.objects where name=$1', [path])).rows[0].n,
      uploadedByMe: (await rpc(0, 'select private.uploaded_by_me($1) as ok', [path])).rows[0].ok,
      remove: await removeFile(0, path),
      reupload: await outcome(rpc(0, "insert into storage.objects(bucket_id,name) values('media',$1)", [path])),
    };
    return view;
  };
  for (const kind of ['post', 'story', 'guess']) {
    assert.deepEqual(await run(kind, true), await run(kind, false), `${kind}: answers must not depend on a report`);
  }
});

test('Every delete by an app user waits for the daily cleanup, reported or not', async () => {
  const quiet = await post(0);
  const reported = await post(0);
  await report(1, 'post', reported.id);
  for (const item of [quiet, reported]) {
    await rpc(0, 'delete from posts where id=$1', [item.id]);
    // Storage answers "nothing removed" in both cases ...
    assert.equal(await removeFile(0, item.path), 'ok, 0 rows returned');
    // ... the file looks deleted to its owner, and the bytes are still there for now.
    assert.equal((await rpc(0, 'select count(*)::int as n from storage.objects where name=$1', [item.path])).rows[0].n, 0);
    assert.equal(await stored(item.path), 1);
  }
  // The daily cleanup removes the file nobody needs and keeps the reported one (still hidden).
  assert.deepEqual(await dailyCleanup(), [quiet.path]);
  assert.equal(await stored(quiet.path), 0);
  assert.equal(await stored(reported.path), 1);
  assert.equal((await rpc(0, 'select count(*)::int as n from storage.objects where name=$1', [reported.path])).rows[0].n, 0);
  // A file that is still in use cannot be deleted (same message as before, reported or not).
  const used = await post(0);
  assert.match(await removeFile(0, used.path), /Cleanup cancelled because media is still in use/);
});

test('After the daily cleanup an owner sees the same thing whether or not their old peek, story or Guess Who was reported', async () => {
  await friend(db, users[0], users[1]);
  const run = async (kind, reported) => {
    let path; let id;
    if (kind === 'snap') {
      ({ path, id } = await snap(0, 1));
      if (reported) await report(1, 'message', id);
      await db.query("update messages set opened_at=now()-interval '8 days' where id=$1", [id]);
    } else if (kind === 'story') {
      ({ path, id } = await story(0));
      if (reported) await report(1, 'story', id);
      await db.query("update stories set expires_at=now()-interval '8 days' where id=$1", [id]);
    } else {
      path = await upload(0, 'mystery');
      id = (await rpc(0, 'insert into mystery_posts(user_id,media_path) values($1,$2) returning id', [users[0], path])).rows[0].id;
      if (reported) await rpc(1, "select report_mystery($1,'spam')", [id]);
      await db.query("update mystery_posts set expires_at=now()-interval '8 days' where id=$1", [id]);
    }
    await dailyCleanup();
    const view = {
      listed: (await rpc(0, 'select count(*)::int as n from storage.objects where name=$1', [path])).rows[0].n,
      uploadedByMe: (await rpc(0, 'select private.uploaded_by_me($1) as ok', [path])).rows[0].ok,
      canRead: (await rpc(0, 'select private.can_read_media($1) as ok', [path])).rows[0].ok,
      canCleanUp: (await rpc(0, 'select can_cleanup_snap($1) as ok', [path])).rows[0].ok,
      remove: await removeFile(0, path),
      reupload: await outcome(rpc(0, "insert into storage.objects(bucket_id,name) values('media',$1)", [path])),
    };
    if (kind !== 'guess') view.reuse = await outcome(rpc(0, "insert into keeps(user_id,media_path,media_type) values($1,$2,'photo')", [users[0], path]));
    return { view, stored: await stored(path) };
  };
  for (const kind of ['snap', 'story', 'guess']) {
    const quiet = await run(kind, false);
    const reported = await run(kind, true);
    assert.deepEqual(reported.view, quiet.view, `${kind}: answers must not depend on a report`);
    assert.equal(quiet.view.listed, 0);
    // The report still has its evidence; the other file is really gone.
    assert.deepEqual([quiet.stored, reported.stored], [0, 1], kind);
  }
});

test('App users cannot call the private cleanup or evidence helpers', async () => {
  const p = await post(0);
  await report(1, 'post', p.id);
  for (const sql of [
    'select private.media_cleanup_safe($1,1)',
    'select private.media_cleanup_eligible($1)',
    "select * from private.report_media_paths('post',$1::uuid)",
  ]) {
    const arg = sql.includes('report_media_paths') ? p.id : p.path;
    await assert.rejects(() => rpc(6, sql, [arg]), /permission denied/);
  }
});

// The full list of functions an app user (authenticated) or a visitor (anon) may run.
// A new function gets EXECUTE for everyone by default in PostgreSQL. If this test fails after
// adding a migration, either revoke the new function from public/anon/authenticated or add it
// here on purpose.
const AUTHENTICATED_ALLOWED = [
  'private.are_friends(a uuid, b uuid)',
  'private.can_read_media(object_name text)',
  'private.can_see_post(target_post uuid)',
  'private.can_see_posts(owner uuid)',
  'private.can_see_stories(owner uuid)',
  'private.can_see_story(target_story uuid)',
  'private.can_use_group_typing_topic(topic text)',
  'private.can_use_typing_topic(topic text)',
  'private.comment_post(target_comment uuid)',
  'private.current_dare_day()',
  'private.drop_minute(day date)',
  'private.group_holds_drop(viewer uuid, poster uuid, day date)',
  'private.has_blocked(blocker uuid, target uuid)',
  'private.in_audience(poster uuid, who text)',
  'private.in_group_message(message uuid, person uuid)',
  'private.in_message(message uuid, person uuid)',
  'private.is_blocked(a uuid, b uuid)',
  'private.is_group_member(grp uuid, person uuid)',
  'private.is_sharing_location(target uuid)',
  'private.media_deletion_deferred(path_value text)',
  'private.post_owner(target_post uuid)',
  'private.safe_dare_text(words text)',
  'private.story_owner(target_story uuid)',
  'private.suggested_dare_recently(person uuid)',
  'private.uploaded_by_me(object_name text)',
  'private.valid_group_waveform(bars integer[])',
  'private.valid_waveform(bars smallint[])',
  'public.accept_legal(doc text, ver text)',
  'public.add_to_peek_group(grp uuid, members uuid[], today date)',
  'public.block_mystery_poster(post uuid)',
  'public.block_user(target uuid)',
  'public.block_user(target uuid, expected_user_id uuid)',
  'public.can_cleanup_snap(object_name text)',
  'public.chat_dare_streak(friend uuid)',
  'public.claim_chat_dare(dare uuid)',
  'public.clear_chat(friend uuid)',
  'public.confirm_chat_dare(dare uuid, ok boolean)',
  'public.create_peek_group(group_name text, members uuid[], today date)',
  'public.dare_friends(targets uuid[], source_post uuid)',
  'public.dare_hype(post posts)',
  'public.dare_streaks()',
  'public.dare_verdict(post posts)',
  'public.friends_of(person uuid)',
  'public.get_profile_stats(target uuid)',
  'public.give_forfeit(nomination uuid, choice text)',
  'public.group_hold(post posts)',
  'public.guess_mystery(post uuid, guess uuid)',
  'public.hide_message(message uuid)',
  'public.hit_up(target uuid, note text)',
  'public.hit_up_status(target uuid)',
  'public.is_plus(person uuid)',
  'public.mark_chat_read(friend uuid)',
  'public.mark_drop_seen(post uuid, did_reveal boolean)',
  'public.mark_group_chat_read(grp uuid)',
  'public.my_activity()',
  'public.my_group_chats()',
  'public.my_profile_views()',
  'public.mystery_feed()',
  'public.nudge_group_member(grp uuid, target uuid, day date)',
  'public.open_snap(message_id uuid)',
  'public.peek_group_status(day date, only_group uuid)',
  'public.peek_stats(post posts)',
  'public.pick_daily_dare(for_day date)',
  'public.pin_group_message(grp uuid, message uuid)',
  'public.post_screenshots(post uuid)',
  'public.rate_dare(post uuid, rating text)',
  'public.recent_daily_dares(days integer)',
  'public.record_profile_view(target uuid)',
  'public.record_screenshot(kind text, target uuid)',
  'public.record_story_view(story uuid)',
  'public.register_push_token(push_token text, phone text, utc_offset integer)',
  'public.rename_peek_group(grp uuid, group_name text)',
  'public.replay_snap(message_id uuid)',
  'public.report_dare_idea(idea uuid, reason text)',
  'public.report_mystery(post uuid, reason text)',
  'public.respond_hit_up(hit uuid, accept boolean)',
  'public.respond_to_friend_request(request_id uuid, accept boolean)',
  'public.send_friend_request(target uuid)',
  'public.set_birthday(day date)',
  'public.set_group_chat_muted(grp uuid, muted boolean)',
  'public.set_group_photo(grp uuid, photo text)',
  'public.set_show_in_profile_views(show boolean)',
  'public.set_snap_saved(message_id uuid, save boolean)',
  'public.story_insights(story uuid)',
  'public.unregister_push_token(push_token text)',
  'public.username_available(name text)',
  'public.vote_dare(post uuid, legit boolean)',
];
const ANON_ALLOWED = [
  'public.username_available(name text)',
];
async function executable(role) {
  return (await db.query(`
    select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public','private')
       and has_function_privilege($1, p.oid, 'EXECUTE')
       and has_schema_privilege($1, n.oid, 'USAGE')
     order by 1`, [role])).rows.map((r) => r.fn);
}
test('Only allow-listed functions can be run by app users and visitors', async () => {
  assert.deepEqual(await executable('authenticated'), AUTHENTICATED_ALLOWED);
  assert.deepEqual(await executable('anon'), ANON_ALLOWED);
  for (const fn of ['private.media_cleanup_safe(path_value text, retention_days integer)', 'private.media_cleanup_eligible(path_value text)']) {
    assert.ok(!AUTHENTICATED_ALLOWED.includes(fn), `${fn} must stay private`);
  }
});

// ---------------------------------------------------------------------------
// 6. can_cleanup_snap only claims files that really exist.
// ---------------------------------------------------------------------------
test('can_cleanup_snap does not add claims or file locks for files that do not exist', async () => {
  const locks = async () => (await db.query('select count(*)::int as n from private.media_path_locks')).rows[0].n;
  const before = await claims();
  const locksBefore = await locks();
  for (let n = 0; n < 50; n++) {
    assert.equal((await rpc(0, 'select can_cleanup_snap($1) as ok', [`${users[0]}/snaps/${randomUUID()}.jpg`])).rows[0].ok, true);
  }
  assert.equal(await claims(), before);
  // File lock rows are never removed, so made-up names must not add any.
  assert.equal(await locks(), locksBefore, 'made-up file names must not fill the file lock table');
  // A real file of yours is still claimed (so it cannot be re-used while it is deleted).
  const real = await upload(0, 'snaps');
  assert.equal((await rpc(0, 'select can_cleanup_snap($1) as ok', [real])).rows[0].ok, true);
  assert.equal(await claims(), before + 1);
  // Someone else's file is never yours to clean up.
  assert.equal((await rpc(1, 'select can_cleanup_snap($1) as ok', [real])).rows[0].ok, false);
});

// ---------------------------------------------------------------------------
// 7. The cleanup checks use indexes.
// ---------------------------------------------------------------------------
test('Cleanup and report lookups use indexes instead of full table scans', async () => {
  const x = `'${users[0]}/posts/x.jpg'`;
  const queries = [
    `select 1 from public.posts p where p.media_path=${x} or p.poster_path=${x} or p.overlay_path=${x} or p.blur_path=${x}`,
    `select 1 from public.keeps k where k.media_path=${x} or k.poster_path=${x} or k.overlay_path=${x}`,
    `select 1 from public.group_messages g where g.media_path=${x} or g.poster_path=${x} or g.overlay_path=${x}`,
    `select 1 from public.stories s where s.media_path=${x} or s.poster_path=${x} or s.overlay_path=${x}`,
    `select 1 from public.mystery_posts g where g.media_path=${x} or g.poster_path=${x} or g.overlay_path=${x}`,
    `select 1 from public.messages m where m.media_path=${x} or m.poster_path=${x} or m.overlay_path=${x}`,
    `select 1 from public.reports r where r.content_id='${users[0]}'`,
    `select 1 from private.report_media_evidence e where e.object_name=${x}`,
    `select 1 from private.media_deferred_deletions d where d.object_name=${x}`,
  ];
  await db.transaction(async (tx) => {
    await tx.exec('set local enable_seqscan = off');
    for (const sql of queries) {
      const plan = (await tx.query(`explain ${sql}`)).rows.map((r) => r['QUERY PLAN']).join('\n');
      assert.doesNotMatch(plan, /Seq Scan/, `${sql}\n${plan}`);
    }
  });
  // The helpers really use these single-column lookups (not "x in (a,b,c)" against a list).
  const body = (await db.query("select prosrc from pg_proc where proname='media_path_in_use'")).rows[0]?.prosrc ?? '';
  assert.match(body, /media_path\s*=\s*path_value/);
});
