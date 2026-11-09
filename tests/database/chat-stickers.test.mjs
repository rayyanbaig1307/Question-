// Stickers in chat (supabase/migrations/20261221000000_chat_stickers.sql): anyone can send the free stickers,
// only people with Peekaboo+ right now can send the Peekaboo+ ones ('plus-…'), in friend chats and group
// chats. Runs all migrations in a local, in-memory PostgreSQL (PGlite) with invented users.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { asUser, createLocalDatabase, friend, seedUsers } from './local-db.mjs';

let db;
let users;
before(async () => { db = await createLocalDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('truncate auth.users cascade; truncate storage.objects, net.sent restart identity;');
  users = await seedUsers(db, 4);
});

const rpc = (i, sql, args = []) => asUser(db, users[i], (tx) => tx.query(sql, args));
const outcome = (run) => run.then(() => 'ok', (error) => `error: ${error.message}`);
const givePlus = (i, days = 30) =>
  db.query("insert into plus_members(user_id,expires_at) values($1, now() + make_interval(days => $2)) on conflict (user_id) do update set expires_at = excluded.expires_at", [users[i], days]);
const sticker = (i, j, id, body = 'Sticker: test') =>
  rpc(i, "insert into messages(sender_id,recipient_id,kind,sticker,body) values($1,$2,'sticker',$3,$4) returning *", [users[i], users[j], id, body]);
const groupSticker = (i, grp, id) =>
  rpc(i, "insert into group_messages(group_id,kind,sticker,body) values($1,'sticker',$2,'Sticker: test') returning *", [grp, id]);

test('Free stickers go to friends; Peekaboo+ stickers need Peekaboo+ right now', async () => {
  await friend(db, users[0], users[1]);
  await db.query("insert into push_tokens(token,user_id,platform) values('ExponentPushToken[qa-st]',$1,'ios')", [users[1]]);

  const sent = (await sticker(0, 1, 'googly-eyes', 'Sticker: Googly eyes 👀')).rows[0];
  assert.equal(sent.kind, 'sticker');
  assert.equal(sent.sticker, 'googly-eyes');
  assert.equal(await outcome(sticker(0, 1, 'word-slay')), 'ok');
  // The friend gets "Sent you a sticker", not the text version.
  const pushes = (await db.query('select body from net.sent order by id')).rows.flatMap((r) => r.body);
  assert.ok(pushes.some((p) => p.body === 'Sent you a sticker ✨'), JSON.stringify(pushes));

  // No Peekaboo+: refused.
  assert.match(await outcome(sticker(0, 1, 'plus-slay')), /part of Peekaboo\+/);
  // With Peekaboo+: fine.
  await givePlus(0);
  assert.equal(await outcome(sticker(0, 1, 'plus-slay')), 'ok');
  // Peekaboo+ ran out: refused again.
  await db.query("update plus_members set expires_at = now() - interval '1 minute' where user_id = $1", [users[0]]);
  assert.match(await outcome(sticker(0, 1, 'plus-slay')), /part of Peekaboo\+/);
  // Someone else's Peekaboo+ doesn't count for you.
  await givePlus(1);
  assert.match(await outcome(sticker(0, 1, 'plus-bestie')), /part of Peekaboo\+/);
  // The friend still sees every sticker you sent, the Peekaboo+ one too.
  assert.equal((await rpc(1, "select count(*)::int as n from messages where kind = 'sticker'")).rows[0].n, 3);
});

test('Sticker messages must look right, and only friends can get them', async () => {
  await friend(db, users[0], users[1]);
  // Not a sticker name.
  assert.match(await outcome(sticker(0, 1, 'Not A Name!')), /check constraint/);
  // A sticker with no text version.
  assert.match(await outcome(rpc(0, "insert into messages(sender_id,recipient_id,kind,sticker) values($1,$2,'sticker','caught')", [users[0], users[1]])), /check constraint/);
  // A text message can't carry a sticker (so the Plus check can't be dodged with another kind).
  assert.match(await outcome(rpc(0, "insert into messages(sender_id,recipient_id,kind,body,sticker) values($1,$2,'text','hi','plus-slay')", [users[0], users[1]])), /check constraint/);
  // Not friends.
  assert.match(await outcome(sticker(0, 2, 'caught')), /row-level security/);
});

test('Group chats: free stickers for everyone, Peekaboo+ ones only with Peekaboo+', async () => {
  for (const i of [1, 2]) await friend(db, users[0], users[i]);
  const grp = (await rpc(0, "select create_peek_group('Squad',$1::uuid[],current_date) as id", [[users[1], users[2]]])).rows[0].id;

  const row = (await groupSticker(1, grp, 'peekaboo')).rows[0];
  assert.equal(row.sender_id, users[1]);
  assert.equal(row.sticker, 'peekaboo');
  assert.match(await outcome(groupSticker(1, grp, 'plus-bff')), /part of Peekaboo\+/);
  await givePlus(1);
  assert.equal(await outcome(groupSticker(1, grp, 'plus-bff')), 'ok');
  // Not in the group.
  assert.match(await outcome(groupSticker(3, grp, 'caught')), /row-level security/);
  // The group chat list shows "✨ Sticker".
  const last = (await rpc(2, 'select * from my_group_chats()')).rows[0];
  assert.match(JSON.stringify(last), /✨ Sticker/);
});
