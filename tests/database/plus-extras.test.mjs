// Peekaboo+ extras (supabase/migrations/20261218000000_plus_extras.sql): Peek-a-Save, drop rewind and the
// Guess Who hint. Every check runs all migrations in a local, in-memory PostgreSQL (PGlite) with invented
// users. Nothing here talks to a live project.
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
  users = await seedUsers(db, 8);
});

const rpc = (i, sql, args = []) => asUser(db, users[i], (tx) => tx.query(sql, args));
const one = async (i, sql, args = []) => (await rpc(i, sql, args)).rows[0];
const giveTester = (i) => db.query("insert into plus_members(user_id,expires_at) values($1, now() + interval '30 days')", [users[i]]);
const pushes = async () => (await db.query('select body from net.sent order by id')).rows.flatMap((r) => r.body);
const today = async () => (await db.query('select private.current_dare_day()::text as d')).rows[0].d;

// Old rows the app can't make any more (past dare days, finished chat dares): saved with the triggers off.
async function raw(sql, args = []) {
  await db.exec('set session_replication_role = replica');
  try { return await db.query(sql, args); } finally { await db.exec('set session_replication_role = origin'); }
}
// Both people did the daily dare on each of these days back from today (2 = the day before yesterday).
async function bothDid(i, j, daysBack) {
  for (const who of [i, j]) {
    for (const back of daysBack) {
      await raw("insert into posts(user_id,media_path,dare_day) values($1,$2,private.current_dare_day() - $3::int)",
        [users[who], `${users[who]}/posts/${randomUUID()}.jpg`, back]);
    }
  }
}
// A finished chat dare between two people, `hoursAgo` hours ago.
const doneDare = (i, j, hoursAgo) => raw(
  "insert into messages(sender_id,recipient_id,kind,body,dare_state,dare_claimed_at,dare_done_at) values($1,$2,'dare','QA dare','done',now()-make_interval(hours=>$3),now()-make_interval(hours=>$3))",
  [users[i], users[j], hoursAgo]);
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, n) => from + n);
const outcome = (run) => run.then(() => 'ok', (error) => `error: ${error.message}`);

// ---------------------------------------------------------------------------
// 🙈 Peek-a-Save
// ---------------------------------------------------------------------------

test('A broken daily dare streak shows up for 24 hours, and a Plus member can save it once a month', async () => {
  await friend(db, users[0], users[1]);
  await friend(db, users[0], users[2]);
  await db.query("insert into push_tokens(token,user_id,platform) values('ExponentPushToken[qa1]',$1,'ios')", [users[1]]);
  // A 12-day streak that ended the day before yesterday (so yesterday was missed).
  await bothDid(0, 1, range(2, 13));
  // A 1-day streak is too small to bother with.
  await bothDid(0, 2, [2]);
  const broken = (await rpc(0, 'select kind, friend_id, streak from my_broken_streaks()')).rows;
  assert.deepEqual(broken, [{ kind: 'daily_dare', friend_id: users[1], streak: 12 }]);
  // The friend sees it too.
  assert.deepEqual((await rpc(1, 'select kind, friend_id, streak from my_broken_streaks()')).rows,
    [{ kind: 'daily_dare', friend_id: users[0], streak: 12 }]);
  assert.equal((await one(0, 'select streak from dare_streaks() where friend_id=$1', [users[1]])).streak, 0);

  // Without Plus it's refused, and nothing is used up.
  assert.match(await outcome(rpc(0, "select peek_a_save('daily_dare',$1)", [users[1]])), /Peekaboo\+/);
  assert.equal((await db.query('select count(*)::int as n from peek_a_saves')).rows[0].n, 0);

  await giveTester(0);
  assert.deepEqual(await one(0, 'select plus, saves_left from plus_allowances()'), { plus: true, saves_left: 1 });
  assert.equal((await one(0, "select peek_a_save('daily_dare',$1) as n", [users[1]])).n, 12);
  // The streak is back for both of you (the saved day joins it up but doesn't count as a day).
  assert.equal((await one(0, 'select streak from dare_streaks() where friend_id=$1', [users[1]])).streak, 12);
  assert.equal((await one(1, 'select streak from dare_streaks() where friend_id=$1', [users[0]])).streak, 12);
  assert.deepEqual((await rpc(0, 'select * from my_broken_streaks()')).rows, []);
  // Doing today's dare together makes it 13.
  await bothDid(0, 1, [0]);
  assert.equal((await one(1, 'select streak from dare_streaks() where friend_id=$1', [users[0]])).streak, 13);

  // The friend got the push.
  const sent = await pushes();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, '🙈 QA 0 used Peek-a-Save on your streak!');
  assert.equal(sent[0].to, 'ExponentPushToken[qa1]');
  assert.match(sent[0].body, /12-day dare streak is back/);

  // Only one a month.
  assert.equal((await one(0, 'select saves_left from plus_allowances()')).saves_left, 0);
  await bothDid(0, 2, range(3, 6));
  await raw('delete from posts where user_id=$1 and dare_day=private.current_dare_day() - 2', [users[2]]);
  await bothDid(0, 2, [2]);
  assert.match(await outcome(rpc(0, "select peek_a_save('daily_dare',$1)", [users[2]])), /this month/);
});

test('Peek-a-Save refuses streaks that broke more than 24 hours ago, non-friends and made-up streaks', async () => {
  await giveTester(0);
  await friend(db, users[0], users[1]);
  // Ended 3 days ago: two days were missed, too late to save.
  await bothDid(0, 1, range(3, 10));
  assert.deepEqual((await rpc(0, 'select * from my_broken_streaks()')).rows, []);
  assert.match(await outcome(rpc(0, "select peek_a_save('daily_dare',$1)", [users[1]])), /24 hours/);
  // Still alive (done yesterday): nothing to save.
  await bothDid(0, 1, [1, 2]);
  assert.match(await outcome(rpc(0, "select peek_a_save('daily_dare',$1)", [users[1]])), /24 hours/);
  // Not a friend.
  await bothDid(0, 3, range(2, 6));
  assert.match(await outcome(rpc(0, "select peek_a_save('daily_dare',$1)", [users[3]])), /friend/);
  assert.match(await outcome(rpc(0, "select peek_a_save('something',$1)", [users[1]])), /doesn't look right/);
  // Nobody can write the table directly.
  assert.match(await outcome(rpc(0,
    "insert into peek_a_saves(user_id,friend_id,kind,saved_day,used_month,streak) values($1,$2,'daily_dare',current_date,current_date,5)",
    [users[0], users[1]])), /permission|security/);
  assert.equal((await db.query('select count(*)::int as n from peek_a_saves')).rows[0].n, 0);
  assert.deepEqual(await pushes(), []);
});

test('A broken chat dare streak can be saved within 24 hours and keeps counting', async () => {
  await giveTester(1);
  await friend(db, users[0], users[1]);
  // Three dares, the newest 3.5 days ago: broke 12 hours ago.
  await doneDare(0, 1, 84);
  await doneDare(1, 0, 120);
  await doneDare(0, 1, 150);
  assert.equal((await one(0, 'select chat_dare_streak($1) as n', [users[1]])).n, 0);
  assert.deepEqual((await rpc(1, 'select kind, friend_id, streak from my_broken_streaks()')).rows,
    [{ kind: 'chat_dare', friend_id: users[0], streak: 3 }]);
  assert.equal((await one(1, "select peek_a_save('chat_dare',$1) as n", [users[0]])).n, 3);
  assert.equal((await one(0, 'select chat_dare_streak($1) as n', [users[1]])).n, 3);
  assert.equal((await one(1, 'select chat_dare_streak($1) as n', [users[0]])).n, 3);
  // The next dare (done after the save) adds one.
  await db.query("update peek_a_saves set saved_at = now() - interval '2 hours'");
  await doneDare(1, 0, 1);
  assert.equal((await one(0, 'select chat_dare_streak($1) as n', [users[1]])).n, 4);
  // Both can see the saved row; others can't.
  assert.equal((await rpc(0, 'select id from peek_a_saves')).rows.length, 1);
  assert.equal((await rpc(2, 'select id from peek_a_saves')).rows.length, 0);

  // A streak whose last dare was 4.5 days ago is gone for good.
  await giveTester(2);
  await friend(db, users[2], users[3]);
  await doneDare(2, 3, 108);
  await doneDare(3, 2, 130);
  assert.match(await outcome(rpc(2, "select peek_a_save('chat_dare',$1)", [users[3]])), /24 hours/);
});

// ---------------------------------------------------------------------------
// ⏰ Drop rewind
// ---------------------------------------------------------------------------

// Time zones (minutes ahead of UTC) where today's drop already happened at least 5 minutes ago, each giving a
// different local day.
async function lateOffsets() {
  const { rows } = await db.query(`
    with o as (
      select m, ((now() at time zone 'utc') + make_interval(mins => m)) as local_now from generate_series(-720, 840, 15) m
    )
    select distinct on (local_now::date) m from o
     where local_now - (local_now::date + make_interval(mins => private.drop_minute(local_now::date))) > interval '5 minutes'
     order by local_now::date, m`);
  return rows.map((r) => r.m);
}
async function dropPost(i, offset, rewind) {
  const path = `${users[i]}/posts/${randomUUID()}.jpg`;
  return one(i, 'insert into posts(user_id,media_path,drop_offset_minutes,drop_rewound) values($1,$2,$3,$4) returning id, drop_late_seconds, drop_rewound',
    [users[i], path, offset, rewind]);
}

test('A Plus member can post one late drop a week without the late label; the server checks it', async () => {
  // (The zones span 26 hours, so some zone is always past its drop, whatever the time now.)
  const offsets = await lateOffsets();
  assert.ok(offsets.length >= 1, 'need a time zone where the drop is late');
  // Without Plus, asking for a rewind changes nothing.
  const free = await dropPost(0, offsets[0], true);
  assert.equal(free.drop_rewound, false);
  assert.ok(free.drop_late_seconds > 120);

  await giveTester(1);
  assert.equal((await one(1, 'select rewinds_left from plus_allowances()')).rewinds_left, 1);
  const rewound = await dropPost(1, offsets[0], true);
  assert.equal(rewound.drop_rewound, true);
  assert.equal(rewound.drop_late_seconds, 0);
  const used = await one(1, 'select post_id, late_seconds from drop_rewinds');
  assert.equal(used.post_id, rewound.id);
  assert.ok(used.late_seconds > 120, 'the real lateness is kept');
  assert.equal((await one(1, 'select rewinds_left from plus_allowances()')).rewinds_left, 0);
  // Can't be changed afterwards.
  await rpc(1, 'update posts set drop_rewound=false, drop_late_seconds=999 where id=$1', [rewound.id]);
  assert.deepEqual(await one(1, 'select drop_rewound, drop_late_seconds from posts where id=$1', [rewound.id]),
    { drop_rewound: true, drop_late_seconds: 0 });
  // A second late drop the same week is posted late – even after deleting the rewound one (it still used up
  // the rewind; deleting it also frees that day, so this works at any time of day).
  await rpc(1, 'delete from posts where id=$1', [rewound.id]);
  assert.equal((await one(1, 'select rewinds_left from plus_allowances()')).rewinds_left, 0);
  const second = await dropPost(1, offsets[0], true);
  assert.equal(second.drop_rewound, false);
  assert.ok(second.drop_late_seconds > 120);
  // A late drop posted later can't be rewound by changing it either.
  await rpc(0, 'update posts set drop_rewound=true where id=$1', [free.id]);
  assert.equal((await one(0, 'select drop_rewound from posts where id=$1', [free.id])).drop_rewound, false);
  // Nobody can write the table directly or see other people's rewinds.
  assert.match(await outcome(rpc(0, 'insert into drop_rewinds(user_id,week_start,post_id,late_seconds) values($1,current_date,$2,5)',
    [users[0], free.id])), /permission|security/);
  assert.equal((await rpc(0, 'select * from drop_rewinds')).rows.length, 0);
});

// ---------------------------------------------------------------------------
// 🕵️ Guess Who hint
// ---------------------------------------------------------------------------

async function mystery(i) {
  const path = `mystery/${randomUUID()}.jpg`;
  await rpc(i, "insert into storage.objects(bucket_id,name) values('media',$1)", [path]);
  return (await one(i, 'insert into mystery_posts(user_id,media_path) values($1,$2) returning id', [users[i], path])).id;
}

test('A Plus member gets one hint per Guess Who post, and it never says who posted it', async () => {
  for (const i of [1, 2, 3, 4, 5]) await friend(db, users[0], users[i]);
  for (const i of [2, 3, 4]) await friend(db, users[1], users[i]);
  const post = await mystery(0);
  // Without Plus: refused.
  assert.match(await outcome(rpc(1, 'select mystery_hint($1)', [post])), /Peekaboo\+/);
  await giveTester(1);
  const hint = (await one(1, 'select mystery_hint($1) as h', [post])).h;
  assert.equal(typeof hint, 'string');
  assert.ok(hint.length > 5);
  for (const secret of [users[0], 'QA 0', 'qa_user_0']) assert.ok(!hint.includes(secret), `hint gives away ${secret}: ${hint}`);
  assert.match(hint, /^(Their name starts with|They joined Peekaboo|Their @username is)/);
  // Asking again gives the same hint, and only one is kept.
  assert.equal((await one(1, 'select mystery_hint($1) as h', [post])).h, hint);
  assert.deepEqual((await rpc(1, 'select post_id, hint from mystery_hints')).rows, [{ post_id: post, hint }]);
  // Other people can't see your hint, or write hints themselves.
  assert.equal((await rpc(0, 'select * from mystery_hints')).rows.length, 0);
  assert.match(await outcome(rpc(2, 'insert into mystery_hints(post_id,user_id,hint) values($1,$2,$3)', [post, users[2], 'x'])), /permission|security/);
  // The hint doesn't change what the feed tells you.
  assert.equal((await one(1, 'select poster from mystery_feed() where id=$1', [post])).poster, null);

  // Not for your own post, not after you've guessed, not for posts you can't see.
  await giveTester(0);
  assert.match(await outcome(rpc(0, 'select mystery_hint($1)', [post])), /yours/);
  await giveTester(2);
  await rpc(2, 'select guess_mystery($1,$2)', [post, users[3]]);
  assert.match(await outcome(rpc(2, 'select mystery_hint($1)', [post])), /already guessed/);
  await giveTester(6);
  assert.match(await outcome(rpc(6, 'select mystery_hint($1)', [post])), /gone/);
});
