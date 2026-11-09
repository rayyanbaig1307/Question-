// Dare safety on the server (supabase/migrations/20261224000000_dare_safety.sql). The same cases run against
// the app in tests/unit/dare-safety.test.mjs, so both always agree. Runs all migrations in a local, in-memory
// PostgreSQL (PGlite) with invented users.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { asUser, createLocalDatabase, friend, seedUsers } from './local-db.mjs';

const { cases } = JSON.parse(readFileSync('tests/support/dare-safety-cases.json', 'utf8'));
let db;
let users;
before(async () => { db = await createLocalDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('truncate auth.users cascade; truncate storage.objects, net.sent restart identity;');
  users = await seedUsers(db, 4);
});
const rpc = (i, sql, args = []) => asUser(db, users[i], (tx) => tx.query(sql, args));
const outcome = (run) => run.then(() => 'ok', (error) => `${error.code}: ${error.message}`);

test('The database sorts every dare exactly like the app', async () => {
  const wrong = [];
  for (const [dare, expected] of cases) {
    const got = (await db.query('select private.dare_problem($1) as p', [dare])).rows[0].p;
    if (got !== expected) wrong.push(`${dare} → ${got} (expected ${expected})`);
  }
  assert.deepEqual(wrong, []);
});

test('Bad dares are refused in friend chats, group chats and dare ideas; fine ones go through', async () => {
  for (const i of [1, 2]) await friend(db, users[0], users[i]);
  const chatDare = (body) => rpc(0, "insert into messages(sender_id,recipient_id,kind,body) values($1,$2,'dare',$3)", [users[0], users[1], body]);
  assert.equal(await outcome(chatDare('Do 20 push-ups right now')), 'ok');
  assert.equal(await outcome(chatDare('Show me ur asshole')), "23514: That dare isn't allowed – nothing sexual and no nudity. 🙏");
  assert.match(await outcome(chatDare('kill a cat')), /no hurting anyone/);
  // Normal chat messages aren't dares, so they aren't checked (private chats stay unfiltered).
  assert.equal(await outcome(rpc(0, "insert into messages(sender_id,recipient_id,kind,body) values($1,$2,'text','I could kill for pizza')", [users[0], users[1]])), 'ok');

  const grp = (await rpc(0, "select create_peek_group('Squad',$1::uuid[],current_date) as id", [[users[1], users[2]]])).rows[0].id;
  const groupDare = (body) => rpc(1, "insert into group_messages(group_id,kind,body) values($1,'dare',$2)", [grp, body]);
  assert.equal(await outcome(groupDare('Sing in public')), 'ok');
  assert.match(await outcome(groupDare('Bully the new kid')), /no hate, bullying/);

  assert.match(await outcome(rpc(2, 'insert into dare_ideas(text) values($1)', ['rape someone'])), /no hurting anyone/);
  assert.equal(await outcome(rpc(2, 'insert into dare_ideas(text) values($1)', ['Wear socks on your hands all day'])), 'ok');
});

test('No more than 40 dares in 10 minutes from one person', async () => {
  await friend(db, users[0], users[1]);
  for (let n = 0; n < 40; n++) {
    await rpc(0, "insert into messages(sender_id,recipient_id,kind,body) values($1,$2,'dare',$3)", [users[0], users[1], `Do ${n} jumps`]);
  }
  assert.match(await outcome(rpc(0, "insert into messages(sender_id,recipient_id,kind,body) values($1,$2,'dare','One more')", [users[0], users[1]])), /Slow down/);
});
