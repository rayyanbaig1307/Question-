// "How did you hear about Peekaboo?" (supabase/migrations/20261227000000_heard_about.sql). Runs all migrations in
// a local, in-memory PostgreSQL (PGlite) with invented users.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { asUser, createLocalDatabase, seedUsers } from './local-db.mjs';

let db;
let users;
before(async () => { db = await createLocalDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('truncate auth.users cascade; truncate storage.objects, net.sent restart identity;');
  users = await seedUsers(db, 3);
});
const rpc = (i, sql, args = []) => asUser(db, users[i], (tx) => tx.query(sql, args));
const needs = async (i) => (await rpc(i, 'select needs_heard_about() as n')).rows[0].n;
const save = (i, answer, other = null) => rpc(i, 'select save_heard_about($1, $2)', [answer, other]);
const outcome = (run) => run.then(() => 'ok', (error) => error.message);

test('A new account is asked once; answering or skipping stops it; the first answer counts', async () => {
  assert.equal(await needs(0), true);
  await save(0, 'tiktok');
  assert.equal(await needs(0), false);
  await save(0, 'instagram');
  assert.deepEqual((await db.query('select source, detail from heard_about where user_id=$1', [users[0]])).rows, [{ source: 'tiktok', detail: null }]);

  await save(1, 'skipped');
  assert.equal(await needs(1), false);
});

test('"Other" keeps a few words (trimmed, at most 100 characters); other answers keep none', async () => {
  await save(0, 'other', `  ${'x'.repeat(150)}  `);
  await save(1, 'friend', 'my cousin');
  const rows = (await db.query('select user_id, detail from heard_about')).rows;
  assert.equal(rows.find((r) => r.user_id === users[0]).detail.length, 100);
  assert.equal(rows.find((r) => r.user_id === users[1]).detail, null);
  assert.match(await outcome(save(2, 'facebook')), /Pick one of the answers/);
});

test('Older accounts are never asked, and nobody can read the answers through the app', async () => {
  await db.query("update profiles set created_at = now() - interval '10 days' where id = $1", [users[2]]);
  assert.equal(await needs(2), false);
  await save(0, 'youtube');
  assert.match(await outcome(rpc(0, 'select * from heard_about')), /permission denied/);
  assert.match(await outcome(rpc(1, "insert into heard_about(user_id, source) values($1, 'tiktok')", [users[1]])), /permission denied/);
});
