// Launch safety (supabase/migrations/20261220000000_launch_safety.sql):
// 1. Adding someone under 18 (or with no birthday) always sends a friend request, even to a public account.
//    Adults with a public account are still friends at once. No other way makes a logged-in person friends
//    with an under-18 without that person's OK.
// 2. A community dare idea only becomes everyone's dare after the owner approved it (approved_at).
// Every check runs all migrations in a local, in-memory PostgreSQL (PGlite) with invented users.
// Nothing here talks to a live project.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMigrationFile, asUser, createLocalDatabase, seedUsers } from './local-db.mjs';

const MIGRATION = '20261220000000_launch_safety.sql';

let db;
let users;
before(async () => { db = await createLocalDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('truncate auth.users cascade; truncate storage.objects, net.sent restart identity;');
  users = await seedUsers(db, 10);
});

const rpc = (i, sql, args = []) => asUser(db, users[i], (tx) => tx.query(sql, args));
const add = async (i, j) => (await rpc(i, 'select send_friend_request($1) as state', [users[j]])).rows[0].state;
const birthday = (i, years) => rpc(i, 'select set_birthday((current_date - make_interval(years => $1))::date)', [years]);
const link = async (i, j) => (await db.query(
  'select requester_id, addressee_id, status, accepted_at from friendships where least(requester_id,addressee_id)=least($1::uuid,$2::uuid) and greatest(requester_id,addressee_id)=greatest($1::uuid,$2::uuid)',
  [users[i], users[j]])).rows;
const pushTitles = async () => (await db.query('select body from net.sent order by id')).rows.flatMap((r) => r.body).map((p) => p.title);
const outcome = (run) => run.then(() => 'ok', (error) => `error: ${error.message}`);
// A function of the server running for a logged-in person (like send_friend_request does): it can write the
// friendships table directly, the app can't.
async function asServerFor(i, sql, args = []) {
  return db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [users[i]]);
    return tx.query(sql, args);
  });
}

// ---------------------------------------------------------------------------
// 1. Friend adds and under-18s
// ---------------------------------------------------------------------------

test('Adding a public under-18 sends a request they must accept, and the adder sees "Requested"', async () => {
  await birthday(0, 30);
  await birthday(1, 15);
  await db.query("insert into push_tokens(token,user_id,platform) values('ExponentPushToken[qa-teen]',$1,'ios')", [users[1]]);
  assert.equal((await db.query('select is_private from profiles where id=$1', [users[1]])).rows[0].is_private, false);

  assert.equal(await add(0, 1), 'pending');
  assert.deepEqual((await link(0, 1)).map((r) => [r.requester_id, r.status, r.accepted_at]), [[users[0], 'pending', null]]);
  // Tapping Add again changes nothing.
  assert.equal(await add(0, 1), 'pending');
  assert.equal((await link(0, 1)).length, 1);
  // The teen gets a friend request push, not "X added you as a friend".
  assert.deepEqual(await pushTitles(), ['New friend request 👋']);
  // Not friends yet: no chat, no map, no friends-only posts.
  assert.equal((await db.query('select private.are_friends($1,$2) as yes', [users[0], users[1]])).rows[0].yes, false);
  // What the app reads to draw the button: a request you sent ("Requested").
  const mine = (await rpc(0, 'select requester_id, status from friendships')).rows;
  assert.deepEqual(mine, [{ requester_id: users[0], status: 'pending' }]);

  // Someone else can't accept it for them.
  const id = (await rpc(1, 'select id from friendships')).rows[0].id;
  await rpc(2, 'select respond_to_friend_request($1,true)', [id]);
  assert.equal((await link(0, 1))[0].status, 'pending');
  // The teen says yes: now they're friends.
  await rpc(1, 'select respond_to_friend_request($1,true)', [id]);
  assert.equal((await link(0, 1))[0].status, 'accepted');
  assert.equal(await add(0, 1), 'accepted');
});

test('No birthday saved counts as under 18; an adult with a public account is still friends at once', async () => {
  await birthday(0, 30);
  await birthday(2, 18);                          // exactly 18 today: an adult
  await birthday(3, 17);
  assert.equal(await add(0, 1), 'pending');       // no birthday
  assert.equal(await add(0, 2), 'accepted');      // adult, public
  assert.equal(await add(0, 3), 'pending');       // 17
  assert.equal((await link(0, 2))[0].status, 'accepted');
  // Private adults still get a request.
  await birthday(4, 40);
  await rpc(4, 'update profiles set is_private=true where id=$1', [users[4]]);
  assert.equal(await add(0, 4), 'pending');
  // An adult's public account doesn't depend on the adder's age: a teen adding an adult is friends at once
  // (the teen chose it), like before.
  assert.equal(await add(3, 2), 'accepted');
});

test('A teen saying yes works every way: accepting, or adding back the person who asked them', async () => {
  await birthday(0, 30);
  await birthday(1, 14);
  await birthday(2, 16);
  assert.equal(await add(0, 1), 'pending');
  // Adding back the person who asked you is your yes.
  assert.equal(await add(1, 0), 'accepted');
  assert.equal((await link(0, 1))[0].status, 'accepted');
  // Two teens: a request too, and the second one adding back makes them friends.
  assert.equal(await add(1, 2), 'pending');
  assert.equal(await add(2, 1), 'accepted');
  // The adult adding someone who already asked them (a teen asking an adult with a private account).
  await rpc(0, 'update profiles set is_private=true where id=$1', [users[0]]);
  assert.equal(await add(2, 0), 'pending');
  assert.equal(await add(0, 2), 'accepted');
});

test('Blocks still stop friend adds both ways, also for teens', async () => {
  await birthday(0, 30);
  await birthday(1, 15);
  await rpc(1, 'select block_user($1)', [users[0]]);
  assert.match(await outcome(add(0, 1)), /cannot add/);
  assert.match(await outcome(add(1, 0)), /cannot add/);
  assert.equal((await link(0, 1)).length, 0);
  // A request is removed by a block.
  await rpc(1, 'delete from blocks where blocker_id=$1', [users[1]]);
  assert.equal(await add(0, 1), 'pending');
  await rpc(1, 'select block_user($1)', [users[0]]);
  assert.equal((await link(0, 1)).length, 0);
});

test('The second lock: no server function can make a logged-in person friends with a teen without their OK', async () => {
  await birthday(0, 30);
  await birthday(1, 15);
  await birthday(2, 25);
  // A function saving an accepted friendship from the adult to the teen: it becomes a normal request.
  await asServerFor(0, "insert into friendships(requester_id,addressee_id,status,accepted_at) values($1,$2,'accepted',now())", [users[0], users[1]]);
  assert.deepEqual((await link(0, 1)).map((r) => [r.status, r.accepted_at]), [['pending', null]]);
  // ... and the adult can't accept their own request for the teen.
  assert.match(await outcome(asServerFor(0, "update friendships set status='accepted', accepted_at=now() where requester_id=$1", [users[0]])),
    /accept your friend request/);
  assert.equal((await link(0, 1))[0].status, 'pending');
  // A friendship made in the teen's name (the teen as the one who "asked") is refused.
  await db.query('delete from friendships');
  assert.match(await outcome(asServerFor(0, "insert into friendships(requester_id,addressee_id,status,accepted_at) values($1,$2,'accepted',now())", [users[1], users[0]])),
    /accept your friend request/);
  // A third person can't make two others friends when one is a teen.
  assert.match(await outcome(asServerFor(2, "insert into friendships(requester_id,addressee_id,status,accepted_at) values($1,$2,'accepted',now())", [users[0], users[1]])),
    /accept your friend request/);
  assert.equal((await link(0, 1)).length, 0);
  // The teen accepting is fine.
  await asServerFor(0, 'insert into friendships(requester_id,addressee_id) values($1,$2)', [users[0], users[1]]);
  await asServerFor(1, "update friendships set status='accepted', accepted_at=now() where addressee_id=$1", [users[1]]);
  assert.equal((await link(0, 1))[0].status, 'accepted');
  // Between adults nothing changes.
  await asServerFor(0, "insert into friendships(requester_id,addressee_id,status,accepted_at) values($1,$2,'accepted',now())", [users[0], users[2]]);
  assert.equal((await link(0, 2))[0].status, 'accepted');
  // The owner in the dashboard (nobody logged in) is not checked.
  await db.query("insert into friendships(requester_id,addressee_id,status,accepted_at) values($1,$2,'accepted',now())", [users[3], users[1]]);
  assert.equal((await link(3, 1))[0].status, 'accepted');
});

test('App users still cannot write friendships directly', async () => {
  await birthday(0, 30);
  assert.match(await outcome(rpc(0, "insert into friendships(requester_id,addressee_id,status,accepted_at) values($1,$2,'accepted',now())", [users[0], users[1]])),
    /row-level security|permission denied/);
  assert.equal(await add(0, 1), 'pending');
  const changed = await rpc(0, "update friendships set status='accepted' where requester_id=$1 returning id", [users[0]]);
  assert.equal(changed.rows.length, 0);
  assert.equal((await link(0, 1))[0].status, 'pending');
});

test('Hit ups between adults still connect them; teens still cannot use hit ups', async () => {
  await birthday(0, 30);
  await birthday(1, 22);
  await birthday(2, 15);
  assert.equal((await rpc(0, 'select hit_up($1) as r', [users[1]])).rows[0].r, 'sent');
  const hit = (await rpc(1, 'select id from hit_ups')).rows[0].id;
  await rpc(1, 'select respond_hit_up($1,true)', [hit]);
  assert.equal((await link(0, 1))[0].status, 'accepted');
  assert.match(await outcome(rpc(0, 'select hit_up($1)', [users[2]])), /aren't available/);
  assert.match(await outcome(rpc(2, 'select hit_up($1)', [users[0]])), /18 and over/);
  assert.equal((await link(0, 2)).length, 0);
});

// ---------------------------------------------------------------------------
// 2. Community dares need the owner's OK
// ---------------------------------------------------------------------------

const today = () => 'private.current_dare_day()';
async function idea(i, text, votes = 3) {
  const id = (await rpc(i, 'insert into dare_ideas(user_id,text) values($1,$2) returning id', [users[i], text])).rows[0].id;
  for (let v = 0; v < votes; v++) {
    const voter = (i + 1 + v) % users.length;
    await rpc(voter, 'insert into dare_votes(idea_id,user_id) values($1,$2)', [id, users[voter]]);
  }
  return id;
}
const approve = (id, when = "now() - interval '2 days'") => db.query(`update dare_ideas set approved_at=${when} where id=$1`, [id]);
const pick = async (i = 0, day = today()) => (await rpc(i, `select * from pick_daily_dare(${day})`)).rows;

test('An idea with enough votes does not run until the owner approves it', async () => {
  const id = await idea(0, 'Wear a silly hat all day', 5);
  assert.equal((await db.query('select approved_at from dare_ideas where id=$1', [id])).rows[0].approved_at, null);
  // Not approved: nothing is picked, so the app shows the built-in dare.
  assert.deepEqual(await pick(1), []);
  assert.equal((await db.query('select count(*)::int as n from daily_dares')).rows[0].n, 0);
  // Approved before today's dare started: it runs, with the writer's name.
  await approve(id);
  const ran = await pick(2);
  assert.equal(ran.length, 1);
  assert.equal(ran[0].idea_id, id);
  assert.equal(ran[0].username, 'qa_user_0');
  assert.equal((await db.query('select used_on = private.current_dare_day() as today from dare_ideas where id=$1', [id])).rows[0].today, true);
  // Everyone gets the same one.
  assert.deepEqual(await pick(3), ran);
});

test('Only approved ideas with 3 or more votes can be picked, best votes first', async () => {
  const popular = await idea(0, 'Sing in the shower loudly', 6);       // most votes, not approved
  const few = await idea(1, 'Dance in the kitchen for a minute', 2);  // approved, too few votes
  const hidden = await idea(2, 'Talk like a pirate all day', 5);      // approved, then hidden by reports
  const good = await idea(3, 'Wear your shirt inside out today', 3);  // approved, enough votes
  for (const id of [few, hidden, good]) await approve(id);
  await db.query('update dare_ideas set hidden=true where id=$1', [hidden]);
  const ran = await pick(4);
  assert.deepEqual(ran.map((r) => r.idea_id), [good]);
  assert.equal((await db.query('select used_on from dare_ideas where id=$1', [popular])).rows[0].used_on, null);
});

test('An approval counts from the next new dare, so today\'s dare never changes halfway through the day', async () => {
  const id = await idea(0, 'Wear a silly hat all day', 4);
  await approve(id, 'now()');
  assert.deepEqual(await pick(1), []);
  // Approved a moment before today's dare started (10:00 UTC): it runs today.
  await approve(id, "((private.current_dare_day() + time '10:00') at time zone 'utc') - interval '1 second'");
  assert.deepEqual((await pick(1)).map((r) => r.idea_id), [id]);
});

test('People cannot approve ideas themselves', async () => {
  // A new idea always starts unapproved, whatever the app sends.
  const row = (await rpc(0, "insert into dare_ideas(user_id,text,approved_at) values($1,'Wear a silly hat all day',now()-interval '9 days') returning approved_at", [users[0]])).rows[0];
  assert.equal(row.approved_at, null);
  // And nobody can change an idea afterwards (not even their own).
  const id = (await db.query('select id from dare_ideas')).rows[0].id;
  for (const i of [0, 1]) {
    const changed = await rpc(i, "update dare_ideas set approved_at=now()-interval '9 days' where id=$1 returning id", [id]);
    assert.equal(changed.rows.length, 0);
  }
  assert.equal((await db.query('select approved_at from dare_ideas where id=$1', [id])).rows[0].approved_at, null);
  // Everyone can still read the idea (and see it isn't approved yet).
  assert.deepEqual((await rpc(1, 'select approved_at from dare_ideas where id=$1', [id])).rows, [{ approved_at: null }]);
});

test('Community dares that already ran stay as they were, approved or not', async () => {
  const old = await idea(0, 'Wear a silly hat all day', 3);
  await db.query(`insert into daily_dares(day,idea_id) values(${today()} - 3, $1)`, [old]);
  await db.query(`update dare_ideas set used_on=${today()} - 3 where id=$1`, [old]);
  const before = (await rpc(1, `select * from pick_daily_dare(${today()} - 3)`)).rows;
  assert.deepEqual(before.map((r) => [r.idea_id, r.text]), [[old, 'Wear a silly hat all day']]);
  const recent = (await rpc(1, 'select text from recent_daily_dares(30)')).rows;
  assert.deepEqual(recent, [{ text: 'Wear a silly hat all day' }]);
  // Today nothing approved: no community dare.
  assert.deepEqual(await pick(1), []);
});

test('Running the migration again changes nothing', async () => {
  await birthday(0, 30);
  await birthday(1, 15);
  await birthday(2, 30);
  const id = await idea(0, 'Wear a silly hat all day', 3);
  await approve(id);
  await applyMigrationFile(db, MIGRATION);
  await applyMigrationFile(db, MIGRATION);
  assert.equal(await add(0, 1), 'pending');
  assert.equal(await add(0, 2), 'accepted');
  assert.deepEqual((await pick(1)).map((r) => r.idea_id), [id]);
  const triggers = (await db.query("select count(*)::int as n from pg_trigger where tgname='friendships_need_their_ok'")).rows[0].n;
  assert.equal(triggers, 1);
  // The functions keep their rights: app users can call these two, nobody can call the helper.
  const can = async (role, fn) => (await db.query('select has_function_privilege($1,$2,\'execute\') as ok', [role, fn])).rows[0].ok;
  assert.equal(await can('authenticated', 'public.send_friend_request(uuid)'), true);
  assert.equal(await can('authenticated', 'public.pick_daily_dare(date)'), true);
  assert.equal(await can('anon', 'public.send_friend_request(uuid)'), false);
  assert.equal(await can('anon', 'public.pick_daily_dare(date)'), false);
  assert.equal(await can('authenticated', 'private.friendship_needs_their_ok()'), false);
  assert.equal(await can('authenticated', 'private.prepare_dare_idea()'), false);
});
