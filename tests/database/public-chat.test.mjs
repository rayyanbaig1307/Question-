// The public chat (supabase/migrations/20261225000000_public_chat.sql): one room, photos only, 18 and over.
// Runs all migrations in a local, in-memory PostgreSQL (PGlite) with invented users.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { asUser, createLocalDatabase, seedUsers } from './local-db.mjs';

let db;
let users;
before(async () => { db = await createLocalDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('truncate auth.users cascade; truncate storage.objects, net.sent restart identity;');
  users = await seedUsers(db, 6);
});

const rpc = (i, sql, args = []) => asUser(db, users[i], (tx) => tx.query(sql, args));
const outcome = (run) => run.then(() => 'ok', (error) => `${error.code}: ${error.message}`);
// A saved birthday: `years` years old today.
const born = (i, years) => db.query(
  "insert into age_checks(user_id,birthday,blocked) values($1, (current_date - make_interval(years => $2))::date, $2 < 18)", [users[i], years]);
const path = (i) => `${users[i]}/public/${randomUUID()}.jpg`;
const post = (i, file = path(i)) => rpc(i, 'insert into public_photos(media_path) values($1) returning *', [file]);
const seen = async (i) => (await rpc(i, 'select id from public_photos order by created_at')).rows.map((r) => r.id);
const status = async (i) => (await rpc(i, 'select public_chat_status() as s')).rows[0].s;
// Jump over slow mode: make this person's photos look a minute older.
const wait = (i) => db.query("update public_photos set created_at = created_at - interval '1 minute' where sender_id = $1", [users[i]]);
// Could this person open the file? (Asked as the database owner, pretending to be them, like the storage rule does.)
const canOpen = (i, file) => db.transaction(async (tx) => {
  await tx.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', 'authenticated', true)", [users[i]]);
  return (await tx.query('select private.can_read_media($1) as ok', [file])).rows[0].ok;
});

test('Only people 18 and over get in: no birthday and under 18 can\'t see, post or open photos', async () => {
  await born(0, 25); await born(1, 19); await born(2, 16); // users[3] has no birthday
  assert.equal(await status(0), 'ok');
  assert.equal(await status(2), 'under_18');
  assert.equal(await status(3), 'no_birthday');

  const photo = (await post(0)).rows[0];
  assert.equal(photo.sender_id, users[0]);
  assert.equal(photo.hidden, false);
  assert.deepEqual(await seen(1), [photo.id]);
  assert.deepEqual(await seen(2), []);
  assert.deepEqual(await seen(3), []);
  assert.match(await outcome(post(2)), /only for people 18 and over/);
  assert.match(await outcome(post(3)), /only for people 18 and over/);

  assert.equal(await canOpen(1, photo.media_path), true);
  assert.equal(await canOpen(2, photo.media_path), false);
  assert.equal(await canOpen(3, photo.media_path), false);
});

test('Photos only, in your own public folder, as yourself', async () => {
  await born(0, 25); await born(1, 25);
  // Someone else's folder, or another kind of folder.
  assert.match(await outcome(post(0, path(1))), /public_photos_own_file/);
  assert.match(await outcome(post(0, `${users[0]}/posts/${randomUUID()}.jpg`)), /public_photos_own_file/);
  // You can't post as someone else, or pre-hide / back-date a photo.
  assert.match(await outcome(rpc(0, 'insert into public_photos(sender_id,media_path) values($1,$2)', [users[1], path(1)])), /permission denied/);
  assert.match(await outcome(rpc(0, 'insert into public_photos(media_path,hidden) values($1,true)', [path(0)])), /permission denied/);
  // Nobody can change a photo afterwards.
  const photo = (await post(0)).rows[0];
  assert.match(await outcome(rpc(0, 'update public_photos set hidden = false where id = $1', [photo.id])), /permission denied/);
});

test('Slow mode: one photo every 30 seconds, 40 a day', async () => {
  await born(0, 25);
  assert.equal(await outcome(post(0)), 'ok');
  assert.match(await outcome(post(0)), /Slow mode is on/);
  await wait(0);
  assert.equal(await outcome(post(0)), 'ok');
  for (let n = 0; n < 38; n++) { await wait(0); await post(0); }
  await wait(0);
  assert.match(await outcome(post(0)), /a lot of photos for one day/);
});

test('Reports: anyone in the room can report; 3 different people hide the photo; blocked people don\'t see each other', async () => {
  for (const i of [0, 1, 2, 3, 4]) await born(i, 30);
  await born(5, 15);
  const photo = (await post(0)).rows[0];
  const report = (i) => rpc(i, "insert into reports(reporter_id,content_type,content_id,reason) values($1,'public_photo',$2,'nudity')", [users[i], photo.id]);
  // Under 18: can't see it, so can't report it.
  assert.match(await outcome(report(5)), /can't be reported/);
  assert.equal(await outcome(report(1)), 'ok');
  assert.equal(await outcome(report(2)), 'ok');
  assert.deepEqual(await seen(4), [photo.id]);
  assert.equal(await outcome(report(3)), 'ok');
  // Hidden for everyone else; its sender still sees it; its file can't be opened by others any more.
  assert.deepEqual(await seen(4), []);
  assert.deepEqual(await seen(0), [photo.id]);
  assert.equal(await canOpen(4, photo.media_path), false);
  const saved = (await db.query("select reported_user_id from reports where content_type='public_photo'")).rows;
  assert.equal(saved.length, 3);
  assert.ok(saved.every((r) => r.reported_user_id === users[0]));

  // Blocks work both ways.
  await wait(0);
  const second = (await post(0)).rows[0];
  await db.query('insert into blocks(blocker_id,blocked_id) values($1,$2)', [users[4], users[0]]);
  assert.deepEqual(await seen(4), []);
  assert.equal(await canOpen(4, second.media_path), false);
  assert.deepEqual(await seen(1), [second.id]);
});

test('You can delete your own photo, not someone else\'s; a photo in the room keeps its file', async () => {
  await born(0, 25); await born(1, 25);
  const photo = (await post(0)).rows[0];
  assert.equal((await db.query('select private.media_path_in_use($1, 1) as used', [photo.media_path])).rows[0].used, true);
  await rpc(1, 'delete from public_photos where id = $1', [photo.id]);
  assert.deepEqual(await seen(0), [photo.id]);
  await rpc(0, 'delete from public_photos where id = $1', [photo.id]);
  assert.deepEqual(await seen(0), []);
  assert.equal((await db.query('select private.media_path_in_use($1, 1) as used', [photo.media_path])).rows[0].used, false);
});
