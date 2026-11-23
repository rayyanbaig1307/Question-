// 📤 The outbox (src/lib/outbox.ts) gives each row its id on the phone before the first try. These checks run the
// real migrations (PGlite, invented users) to make sure that works for every table it sends to: an app user can
// insert with an id of their own, a second insert with the same id is refused as a duplicate (23505, the outbox's
// "it was saved after all"), and the sender can look the row up by id (what a retry does after a lost answer).
// The public chat has no id from the phone: its unique file name is the key.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { asUser, createLocalDatabase, friend, seedUsers } from './local-db.mjs';

let db;
let users;
before(async () => { db = await createLocalDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('truncate auth.users cascade; truncate storage.objects, net.sent restart identity;');
  users = await seedUsers(db, 4);
  await friend(db, users[0], users[1]);
  await friend(db, users[0], users[2]);
  await friend(db, users[1], users[2]);
});

const as = (i, sql, args = []) => asUser(db, users[i], (tx) => tx.query(sql, args));
const code = (run) => run.then(() => 'ok', (error) => error.code);
// A file the user uploaded themselves (the storage rules check that for some tables).
const file = async (i, path) => { await as(i, "insert into storage.objects(bucket_id,name) values('media',$1)", [path]); return path; };
// Insert once (works), the same id again (23505), then find it by id as the sender.
async function sameIdTwice(table, i, row) {
  const columns = Object.keys(row);
  const sql = `insert into ${table}(${columns.join(',')}) values(${columns.map((_, n) => `$${n + 1}`).join(',')})`;
  const values = Object.values(row);
  assert.equal(await code(as(i, sql, values)), 'ok', `${table}: first insert`);
  assert.equal(await code(as(i, sql, values)), '23505', `${table}: same id again`);
  const found = (await as(i, `select id from ${table} where id = $1`, [row.id])).rows;
  assert.deepEqual(found.map((r) => r.id), [row.id], `${table}: the sender finds it by id`);
}

test('messages: texts and peeks take the id from the phone, once (a peek to two friends: one id each)', async () => {
  await sameIdTwice('messages', 0, { id: randomUUID(), sender_id: users[0], recipient_id: users[1], kind: 'text', body: 'hi' });
  const snap = await file(0, `${users[0]}/snaps/${randomUUID()}.jpg`);
  await sameIdTwice('messages', 0, { id: randomUUID(), sender_id: users[0], recipient_id: users[1], kind: 'snap', media_path: snap, media_type: 'photo' });
  const ids = [randomUUID(), randomUUID()];
  await as(0, "insert into messages(id,sender_id,recipient_id,kind,media_path,media_type) values($1,$3,$4,'snap',$6,'photo'),($2,$3,$5,'snap',$6,'photo')", [ids[0], ids[1], users[0], users[1], users[2], snap]);
  assert.equal((await as(0, 'select count(*)::int as n from messages where id = any($1)', [ids])).rows[0].n, 2);
});

test('group messages take the id from the phone, once', async () => {
  const group = (await as(0, 'select create_peek_group($1,$2::uuid[],current_date) as id', ['Squad', [users[1], users[2]]])).rows[0].id;
  await sameIdTwice('group_messages', 0, { id: randomUUID(), group_id: group, body: 'hello group' });
});

test('posts (a drop too), stories, Guess Who and comments take the id from the phone, once', async () => {
  const photo = await file(0, `${users[0]}/posts/${randomUUID()}.jpg`);
  const postId = randomUUID();
  await sameIdTwice('posts', 0, { id: postId, user_id: users[0], media_path: photo, media_type: 'photo', caption: '' });
  // A drop: a time zone where the drop is surely over (11pm there), so the server takes it now.
  const utcMinutes = (await db.query("select (extract(hour from now() at time zone 'utc') * 60 + extract(minute from now() at time zone 'utc'))::int as m")).rows[0].m;
  let offset = 23 * 60 - utcMinutes;
  if (offset < -720) offset += 1440;
  if (offset > 840) offset -= 1440;
  const drop = await file(0, `${users[0]}/posts/${randomUUID()}.jpg`);
  await sameIdTwice('posts', 0, { id: randomUUID(), user_id: users[0], media_path: drop, media_type: 'photo', caption: '', drop_offset_minutes: offset });
  // A second drop the same day (another id) is a different "no": posts_one_drop_per_day, with no row under its id.
  const second = await file(0, `${users[0]}/posts/${randomUUID()}.jpg`);
  const again = await as(0, 'insert into posts(id,user_id,media_path,media_type,caption,drop_offset_minutes) values($1,$2,$3,$4,$5,$6)', [randomUUID(), users[0], second, 'photo', '', offset]).then(() => null, (error) => error);
  assert.equal(again?.code, '23505');
  assert.match(again.message, /posts_one_drop_per_day/);

  const story = await file(0, `${users[0]}/stories/${randomUUID()}.jpg`);
  await sameIdTwice('stories', 0, { id: randomUUID(), user_id: users[0], media_path: story, media_type: 'photo' });
  const mystery = await file(0, `mystery/${randomUUID()}.jpg`);
  await sameIdTwice('mystery_posts', 0, { id: randomUUID(), user_id: users[0], media_path: mystery, media_type: 'photo', caption: '' });
  await sameIdTwice('comments', 1, { id: randomUUID(), post_id: postId, user_id: users[1], body: 'nice one' });
});

test('the public chat: the sender finds the photo by its file; the same file again is refused (slow mode first, then 23505)', async () => {
  await db.query("insert into age_checks(user_id,birthday,blocked) values($1, (current_date - interval '25 years')::date, false)", [users[0]]);
  const photo = await file(0, `${users[0]}/public/${randomUUID()}.jpg`);
  assert.equal(await code(as(0, 'insert into public_photos(media_path) values($1)', [photo])), 'ok');
  // Right after: slow mode answers first (23514). That's why the outbox looks the file up before trying again.
  assert.equal(await code(as(0, 'insert into public_photos(media_path) values($1)', [photo])), '23514');
  assert.equal((await as(0, 'select count(*)::int as n from public_photos where media_path = $1', [photo])).rows[0].n, 1);
  // Once slow mode is over: the same file is a duplicate.
  await db.query("update public_photos set created_at = created_at - interval '1 minute' where sender_id = $1", [users[0]]);
  // Once the public chat has text messages (20270102000000), slow mode counts sends in its own log: move that back too.
  if ((await db.query("select to_regclass('private.public_chat_sends') as t")).rows[0].t) {
    await db.query("update private.public_chat_sends set sent_at = sent_at - interval '1 minute' where sender_id = $1", [users[0]]);
  }
  assert.equal(await code(as(0, 'insert into public_photos(media_path) values($1)', [photo])), '23505');
});
