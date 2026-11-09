// Personal invite links (supabase/migrations/20261223000000_invite_links.sql).
// Every check runs the real migrations in a local, in-memory PostgreSQL (PGlite) with invented people.
// Nothing here talks to a live project.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMigrationFile, asUser, createLocalDatabase, friend, seedUsers, userId } from './local-db.mjs';

const MIGRATION = '20261223000000_invite_links.sql';
const NOT_WORKING = "This invite link doesn't work any more";
const TOO_MANY = "You've used a lot of invites today – try again tomorrow";
const BUSY = 'This invite link is busy – try again tomorrow';
const LOG_IN = 'Please log in again';
const SWITCHED = 'Your login has changed - please try again';
const BUSY_PUSH = 'Lots of people used your invite link today – not you? Get a new link';
const CODE_SHAPE = /^[23456789BCDFGHJKLMNPQRSTVWXZ]{10}$/;

let db;
let users;
before(async () => { db = await createLocalDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  // private.past_links is not linked to profiles (on purpose), so "cascade" doesn't reach it: empty it too.
  await db.exec('truncate auth.users cascade; truncate private.past_links, storage.objects, net.sent restart identity;');
  users = await seedUsers(db, 8);
});

const as = (id, sql, args = []) => asUser(db, id, (tx) => tx.query(sql, args));
const rpc = (i, sql, args = []) => as(users[i], sql, args);
const failure = (run) => run.then(() => 'ok', (error) => error.message);
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const count = async (sql, args = []) => (await one(`select count(*)::int as n from ${sql}`, args)).n;
const birthday = (id, years) => as(id, 'select set_birthday((current_date - make_interval(years => $1))::date)', [years]);
const codeOf = async (id) => (await as(id, 'select my_invite_code() as code')).rows[0].code;
const preview = async (id, code) => (await as(id, 'select * from invite_preview($1)', [code])).rows;
const accept = async (id, code, expected = id) => (await as(id, 'select accept_invite($1,$2) as result', [code, expected])).rows[0].result;
const links = async (a, b) => (await db.query(
  `select requester_id, addressee_id, status, created_at from friendships
    where least(requester_id,addressee_id)=least($1::uuid,$2::uuid) and greatest(requester_id,addressee_id)=greatest($1::uuid,$2::uuid)`,
  [a, b])).rows;
const pairState = async (a, b) => (await links(a, b)).map((r) => [r.requester_id, r.addressee_id, r.status]);
async function pushTo(id) {
  const token = `ExponentPushToken[qa-invite-${id}]`;
  await db.query("insert into push_tokens(token,user_id,platform) values($1,$2,'ios') on conflict (token) do update set user_id = excluded.user_id", [token, id]);
  return token;
}
const pushes = async () => (await db.query(
  "select body->0->>'to' as to, body->0->>'title' as title, body->0->>'body' as body, body->0->'data' as data from net.sent order by id")).rows;
const pushTitlesTo = async (token) => (await pushes()).filter((p) => p.to === token).map((p) => p.title);
// More invented people (for the daily limits). Their ids never clash with seedUsers.
async function morePeople(howMany, from = 100) {
  const ids = [];
  for (let n = from; n < from + howMany; n++) {
    const id = userId(n);
    await db.query('insert into auth.users(id,email,raw_user_meta_data) values ($1,$2,$3)', [
      id, `qa${n}@example.invalid`, { username: `qa_user_${n}`, display_name: `QA ${n}` }]);
    ids.push(id);
  }
  return ids;
}
const ban = (id, until = "now() + interval '30 days'") => db.query(`update auth.users set banned_until = ${until} where id = $1`, [id]);
const can = async (role, fn) => (await one("select has_function_privilege($1, $2, 'EXECUTE') as ok", [role, fn])).ok;
const FUNCTIONS = ['public.my_invite_code()', 'public.reset_invite_code()', 'public.invite_preview(text)', 'public.accept_invite(text,uuid)'];
const HELPERS = ['private.clean_invite_code(text)', 'private.new_invite_code()', 'private.is_banned(uuid)', 'private.invite_user_ok(uuid)',
  'private.check_invite_limits(uuid,uuid)', 'private.remember_past_link()', 'private.forget_past_links()'];

// ---------------------------------------------------------------------------
// 1. The code
// ---------------------------------------------------------------------------

test('Your invite code: 10 safe letters, the same every time, different for everyone, and only yours to read', async () => {
  const mine = await codeOf(users[0]);
  assert.match(mine, CODE_SHAPE);
  assert.equal(await codeOf(users[0]), mine);
  const codes = new Set([mine]);
  for (const id of users.slice(1)) codes.add(await codeOf(id));
  assert.equal(codes.size, users.length);
  for (const code of codes) assert.match(code, CODE_SHAPE);
  // Many new codes: always the right shape, never the same twice.
  const made = (await db.query('select private.new_invite_code() as code from generate_series(1, 3000)')).rows.map((r) => r.code);
  assert.equal(new Set(made).size, made.length);
  for (const code of made) assert.match(code, CODE_SHAPE);
  // You can read only your own code.
  assert.deepEqual((await rpc(0, 'select user_id, code from invite_codes')).rows, [{ user_id: users[0], code: mine }]);
  // Nobody can write the table around the functions.
  for (const sql of [
    "insert into invite_codes(user_id, code) values ($1, 'BBBBBBBBBB')",
    "update invite_codes set code = 'BBBBBBBBBB' where user_id = $1",
    'delete from invite_codes where user_id = $1',
  ]) {
    assert.match(await failure(rpc(0, sql, [users[0]])), /permission denied/, sql);
  }
  assert.equal(await codeOf(users[0]), mine);
});

test('Codes are forgiving when typed: small letters, spaces and dashes are fine; anything else is not a code', async () => {
  await birthday(users[0], 30);
  const code = await codeOf(users[0]);
  const typed = ` ${code.slice(0, 3).toLowerCase()}-${code.slice(3, 6)} ${code.slice(6).toLowerCase()} `;
  assert.equal((await preview(users[1], typed))[0].id, users[0]);
  assert.equal(await accept(users[1], typed), 'friends');
  // The wrong shape: too short, too long, a vowel or a look-alike letter, something huge, nothing.
  for (const bad of [code.slice(0, 9), `${code}2`, `A${code.slice(1)}`, `O${code.slice(1)}`, `0${code.slice(1)}`, code.repeat(5000), '', null]) {
    assert.deepEqual(await preview(users[2], bad), [], String(bad).slice(0, 20));
    assert.equal(await failure(accept(users[2], bad)), NOT_WORKING, String(bad).slice(0, 20));
  }
});

test('Get a new link: the old one stops working, and requests that came in through it in the last 7 days go', async () => {
  // users[0] is under 18, so everyone who uses their link sends a request.
  await birthday(users[0], 15);
  const old = await codeOf(users[0]);
  assert.equal(await accept(users[1], old), 'requested');
  assert.equal(await accept(users[2], old), 'requested');
  // A request from 8 days ago (through the link), a normal friend request, and one the teen already said yes to.
  assert.equal(await accept(users[3], old), 'requested');
  await db.query("update private.invite_accepts set used_at = now() - interval '8 days' where accepter = $1", [users[3]]);
  assert.equal((await rpc(4, 'select send_friend_request($1) as r', [users[0]])).rows[0].r, 'pending');
  assert.equal(await accept(users[5], old), 'requested');
  const asked = (await db.query('select id from friendships where requester_id = $1', [users[5]])).rows[0].id;
  await rpc(0, 'select respond_to_friend_request($1, true)', [asked]);

  const fresh = (await rpc(0, 'select reset_invite_code() as code')).rows[0].code;
  assert.match(fresh, CODE_SHAPE);
  assert.notEqual(fresh, old);
  assert.equal(await codeOf(users[0]), fresh);
  assert.equal(await count('invite_codes where user_id = $1', [users[0]]), 1);
  // The old link is dead, for preview and for accepting.
  assert.deepEqual(await preview(users[6], old), []);
  assert.equal(await failure(accept(users[6], old)), NOT_WORKING);
  assert.equal((await preview(users[6], fresh))[0].id, users[0]);
  // Recent requests through the link are gone; the older one, the normal one and the friendship stay.
  assert.deepEqual(await links(users[0], users[1]), []);
  assert.deepEqual(await links(users[0], users[2]), []);
  assert.deepEqual(await pairState(users[3], users[0]), [[users[3], users[0], 'pending']]);
  assert.deepEqual(await pairState(users[4], users[0]), [[users[4], users[0], 'pending']]);
  assert.deepEqual(await pairState(users[5], users[0]), [[users[5], users[0], 'accepted']]);
  // Those people can't send it again straight away with the new link (nothing happens for 7 days).
  await db.exec('truncate net.sent restart identity');
  assert.equal(await accept(users[1], fresh), 'requested');
  assert.deepEqual(await links(users[0], users[1]), []);
  assert.deepEqual(await pushes(), []);
  // Someone who never had a code gets one from "Get a new link" too.
  const first = (await rpc(7, 'select reset_invite_code() as code')).rows[0].code;
  assert.match(first, CODE_SHAPE);
  assert.equal(await codeOf(users[7]), first);
});

// ---------------------------------------------------------------------------
// 2. Who sent it (the invite screen)
// ---------------------------------------------------------------------------

test('The invite screen shows who sent it, and nothing for unknown codes, banned or deleted accounts, or blocks either way', async () => {
  await db.query("update profiles set avatar_path = $1 || '/avatar.jpg', display_name = 'Sam' where id = $1::uuid", [users[0]]);
  const code = await codeOf(users[0]);
  const sam = { id: users[0], username: 'qa_user_0', display_name: 'Sam', avatar_path: `${users[0]}/avatar.jpg` };
  assert.deepEqual(await preview(users[1], code), [sam]);
  // Your own code shows you (the app then says "That's your own invite").
  assert.deepEqual(await preview(users[0], code), [sam]);
  assert.deepEqual(await preview(users[1], 'BCDFGHJKLM'), []);
  // Blocks either way: nothing, and accepting gives the same message as an unknown code.
  await rpc(0, 'select block_user($1)', [users[2]]);
  await rpc(3, 'select block_user($1)', [users[0]]);
  for (const i of [2, 3]) {
    assert.deepEqual(await preview(users[i], code), [], `block ${i}`);
    assert.equal(await failure(accept(users[i], code)), NOT_WORKING, `block ${i}`);
  }
  // A banned account's link doesn't work; when the ban is over, it works again.
  await ban(users[0]);
  assert.deepEqual(await preview(users[1], code), []);
  assert.equal(await failure(accept(users[1], code)), NOT_WORKING);
  await ban(users[0], "now() - interval '1 day'");
  assert.deepEqual(await preview(users[1], code), [sam]);
  // A banned person can't look at or use invites at all.
  await ban(users[4]);
  assert.equal(await failure(preview(users[4], code)), LOG_IN);
  assert.equal(await failure(accept(users[4], code)), LOG_IN);
  assert.equal(await failure(codeOf(users[4])), LOG_IN);
  assert.equal(await failure(rpc(4, 'select reset_invite_code()')), LOG_IN);
  // A deleted account's link is gone with it.
  await db.query('delete from auth.users where id = $1', [users[0]]);
  assert.deepEqual(await preview(users[1], code), []);
  assert.equal(await failure(accept(users[1], code)), NOT_WORKING);
  assert.equal(await count('invite_codes'), 0);
  assert.equal(await count('friendships'), 0);
});

// ---------------------------------------------------------------------------
// 3. Accepting
// ---------------------------------------------------------------------------

test('An adult with a public account: friends straight away, and only the link owner gets a notification', async () => {
  await birthday(users[0], 30);
  const owner = await pushTo(users[0]);
  const guest = await pushTo(users[1]);
  const code = await codeOf(users[0]);
  assert.equal(await accept(users[1], code), 'friends');
  // The person who tapped is the one who asked; the link owner said yes by sharing the link.
  const [row] = await links(users[0], users[1]);
  assert.deepEqual([row.requester_id, row.addressee_id, row.status], [users[1], users[0], 'accepted']);
  assert.equal((await one('select private.are_friends($1,$2) as yes', [users[0], users[1]])).yes, true);
  assert.deepEqual(await pushes(), [{ to: owner, title: 'You have a new friend 🎉', body: 'QA 1 added you as a friend', data: { type: 'friends' } }]);
  assert.deepEqual(await pushTitlesTo(guest), []);
  // Again: already friends, nothing new.
  assert.equal(await accept(users[1], code), 'already');
  assert.equal((await pushes()).length, 1);
  // Written down once (a second tap that changed nothing isn't counted).
  assert.deepEqual((await db.query('select accepter, inviter, outcome, accepter_adult from private.invite_accepts')).rows,
    [{ accepter: users[1], inviter: users[0], outcome: 'friends', accepter_adult: false }]);
  assert.equal(await count('private.invite_uses where inviter = $1 and invitee = $2', [users[0], users[1]]), 1);
  // The link owner's Inbox shows "added you as a friend".
  const activity = (await rpc(0, 'select * from my_activity()')).rows;
  assert.ok(activity.some((a) => a.kind === 'added_you' && a.actor_id === users[1]), JSON.stringify(activity));
});

test('Under 18, no birthday or a private account: a friend request to the link owner (the app can\'t tell which)', async () => {
  await birthday(users[0], 15);                   // under 18
  // users[1] has no birthday
  await birthday(users[2], 40);
  await rpc(2, 'update profiles set is_private = true where id = $1', [users[2]]);
  const tokens = [await pushTo(users[0]), await pushTo(users[1]), await pushTo(users[2])];
  const guest = await pushTo(users[5]);
  await birthday(users[5], 30);
  for (const i of [0, 1, 2]) {
    assert.equal(await accept(users[5], await codeOf(users[i])), 'requested', `owner ${i}`);
    assert.deepEqual(await pairState(users[5], users[i]), [[users[5], users[i], 'pending']], `owner ${i}`);
    assert.equal((await one('select private.are_friends($1,$2) as yes', [users[5], users[i]])).yes, false);
    assert.deepEqual(await pushTitlesTo(tokens[i]), ['New friend request 👋'], `owner ${i}`);
  }
  assert.equal((await pushes()).find((p) => p.to === tokens[0]).body, 'QA 5 wants to be friends');
  assert.deepEqual(await pushTitlesTo(guest), []);
  // Tapping again changes nothing and sends nothing.
  assert.equal(await accept(users[5], await codeOf(users[0])), 'requested');
  assert.equal((await pushes()).length, 3);
  // The teen says yes in the app as usual.
  const id = (await rpc(0, 'select id from friendships where addressee_id = $1', [users[0]])).rows[0].id;
  await rpc(0, 'select respond_to_friend_request($1, true)', [id]);
  assert.equal(await accept(users[5], await codeOf(users[0])), 'already');
  // Someone under 18 using an adult's public link is friends at once (they chose it), like "Add friend".
  await birthday(users[3], 30);
  await birthday(users[4], 14);
  assert.equal(await accept(users[4], await codeOf(users[3])), 'friends');
});

test('Your own link, and friend requests that already exist either way', async () => {
  await birthday(users[0], 30);
  const code = await codeOf(users[0]);
  assert.equal(await accept(users[0], code), 'self');
  assert.equal(await count('friendships'), 0);
  assert.equal(await count('private.invite_accepts'), 0);
  // Already friends.
  await friend(db, users[0], users[1]);
  assert.equal(await accept(users[1], code), 'already');
  // The link owner had asked you (you have no birthday, so it was a request): this is your yes.
  assert.equal((await rpc(0, 'select send_friend_request($1) as r', [users[2]])).rows[0].r, 'pending');
  const owner = await pushTo(users[0]);
  const guest = await pushTo(users[2]);
  await db.exec('truncate net.sent restart identity');
  assert.equal(await accept(users[2], code), 'friends');
  assert.deepEqual(await pairState(users[0], users[2]), [[users[0], users[2], 'accepted']]);
  assert.deepEqual(await pushes(), [{ to: owner, title: 'You have a new friend 🎉', body: 'QA 2 accepted your friend request', data: { type: 'friends' } }]);
  assert.deepEqual(await pushTitlesTo(guest), []);
  // You had asked them (a private account): it stays a request, nothing changes and nobody is notified.
  await birthday(users[3], 30);
  await rpc(3, 'update profiles set is_private = true where id = $1', [users[3]]);
  assert.equal((await rpc(4, 'select send_friend_request($1) as r', [users[3]])).rows[0].r, 'pending');
  const before = await links(users[3], users[4]);
  await db.exec('truncate net.sent restart identity');
  assert.equal(await accept(users[4], await codeOf(users[3])), 'requested');
  assert.deepEqual(await links(users[3], users[4]), before);
  assert.deepEqual(await pushes(), []);
  assert.deepEqual((await db.query('select outcome from private.invite_accepts order by id')).rows.map((r) => r.outcome), ['accepted_request']);
});

test('Using the same person\'s link again only sends a request, and nothing at all happens for 7 days after a removal', async () => {
  await birthday(users[0], 30);
  const owner = await pushTo(users[0]);
  const code = await codeOf(users[0]);
  assert.equal(await accept(users[1], code), 'friends');
  // users[1] unfriends: the pair is remembered (smaller id first).
  await rpc(1, 'delete from friendships where requester_id = $1', [users[1]]);
  assert.deepEqual((await db.query('select person_a, person_b from private.past_links')).rows, [{ person_a: users[0], person_b: users[1] }]);
  await db.exec('truncate net.sent restart identity');
  // Within 7 days: "requested", but nothing is saved and nobody is notified.
  assert.equal(await accept(users[1], code), 'requested');
  assert.deepEqual(await links(users[0], users[1]), []);
  assert.deepEqual(await pushes(), []);
  // Later: only a request, never friends straight away.
  await db.query("update private.past_links set removed_at = now() - interval '8 days'");
  assert.equal(await accept(users[1], code), 'requested');
  assert.deepEqual(await pairState(users[1], users[0]), [[users[1], users[0], 'pending']]);
  assert.deepEqual(await pushTitlesTo(owner), ['New friend request 👋']);

  // A teen who said no: the same person can't ask again through the link for 7 days.
  await birthday(users[2], 15);
  const teen = await pushTo(users[2]);
  const teenCode = await codeOf(users[2]);
  assert.equal(await accept(users[3], teenCode), 'requested');
  const id = (await rpc(2, 'select id from friendships where addressee_id = $1', [users[2]])).rows[0].id;
  await rpc(2, 'select respond_to_friend_request($1, false)', [id]);
  assert.equal(await accept(users[3], teenCode), 'requested');
  assert.deepEqual(await links(users[2], users[3]), []);
  assert.deepEqual(await pushTitlesTo(teen), ['New friend request 👋']);
  // A block that was taken away again counts as a removal too.
  await rpc(4, 'select send_friend_request($1)', [users[0]]);
  await rpc(0, 'select block_user($1)', [users[4]]);
  await rpc(0, 'delete from blocks where blocker_id = $1', [users[0]]);
  assert.equal(await accept(users[4], code), 'requested');
  assert.deepEqual(await links(users[0], users[4]), []);
  // Old friends (made the normal way, never through a link) who unfriended long ago: only a request.
  const [pal] = await morePeople(1);
  await friend(db, users[0], pal);
  await as(pal, 'delete from friendships where addressee_id = $1', [pal]);
  await db.query("update private.past_links set removed_at = now() - interval '30 days'");
  assert.equal(await accept(pal, code), 'requested');
  assert.deepEqual(await pairState(pal, users[0]), [[pal, users[0], 'pending']]);
  // Someone who used the link before (even with no removal remembered) only sends a request.
  await db.query('insert into private.invite_uses(inviter, invitee) values ($1, $2)', [users[0], users[5]]);
  assert.equal(await accept(users[5], code), 'requested');
  assert.deepEqual(await pairState(users[5], users[0]), [[users[5], users[0], 'pending']]);
  // Someone new still becomes friends at once. (An adult: three under-18s already used this link today,
  // so a new under-18 would get "busy" – see the child-safety test.)
  await birthday(users[6], 30);
  assert.equal(await accept(users[6], code), 'friends');
});

test('The login checks: the right account, logged in, with an account', async () => {
  await birthday(users[0], 30);
  const code = await codeOf(users[0]);
  // The phone switched accounts while the invite screen was open.
  assert.equal(await failure(accept(users[1], code, users[2])), SWITCHED);
  assert.equal(await failure(accept(users[1], code, null)), SWITCHED);
  // Not logged in.
  for (const sql of ['select my_invite_code()', 'select reset_invite_code()', 'select * from invite_preview($1)', 'select accept_invite($1, null)']) {
    const args = sql.includes('$1') ? [code] : [];
    assert.equal(await failure(asUser(db, null, (tx) => tx.query(sql, args))), LOG_IN, sql);
  }
  // A login of an account that was deleted a moment ago.
  await db.query('delete from auth.users where id = $1', [users[1]]);
  assert.equal(await failure(accept(users[1], code)), LOG_IN);
  assert.equal(await failure(codeOf(users[1])), LOG_IN);
  // Visitors who aren't logged in can't run any of it.
  for (const fn of FUNCTIONS) {
    assert.equal(await can('anon', fn), false, fn);
    assert.equal(await can('authenticated', fn), true, fn);
  }
  for (const fn of HELPERS) for (const role of ['anon', 'authenticated']) assert.equal(await can(role, fn), false, `${role} ${fn}`);
  assert.match(await failure(asUser(db, null, (tx) => tx.query('select * from invite_preview($1)', [code]), 'anon')), /permission denied/);
  assert.match(await failure(asUser(db, null, (tx) => tx.query('select accept_invite($1, null)', [code]), 'anon')), /permission denied/);
  assert.equal(await count('friendships'), 0);
});

test('Nobody can read or write the invite history, or run the helpers', async () => {
  await birthday(users[0], 30);
  assert.equal(await accept(users[1], await codeOf(users[0])), 'friends');
  for (const table of ['private.invite_uses', 'private.past_links', 'private.invite_accepts', 'private.invite_alerts']) {
    for (const role of ['authenticated', 'anon']) {
      for (const sql of [`select * from ${table}`, `delete from ${table}`]) {
        assert.match(await failure(asUser(db, users[1], (tx) => tx.query(sql), role)), /permission denied/, `${role}: ${sql}`);
      }
    }
  }
  assert.match(await failure(rpc(1, 'select private.new_invite_code()')), /permission denied/);
  assert.match(await failure(rpc(1, 'select private.check_invite_limits($1,$2)', [users[1], users[0]])), /permission denied/);
  assert.match(await failure(asUser(db, null, (tx) => tx.query('select * from invite_codes'), 'anon')), /permission denied/);
  assert.equal(await count('private.invite_accepts'), 1);
});

test('A block made while the friendship is being saved undoes everything', async () => {
  await birthday(users[0], 30);
  const owner = await pushTo(users[0]);
  const code = await codeOf(users[0]);
  // Stand-in for someone tapping Block at that exact moment.
  await db.exec(`
    create function public.qa_block_during_invite() returns trigger language plpgsql as $$
    begin insert into public.blocks(blocker_id, blocked_id) values (new.addressee_id, new.requester_id); return new; end; $$;
    create trigger qa_block_during_invite after insert on public.friendships for each row execute function public.qa_block_during_invite();`);
  try {
    assert.equal(await failure(accept(users[1], code)), NOT_WORKING);
  } finally {
    await db.exec('drop trigger qa_block_during_invite on public.friendships; drop function public.qa_block_during_invite();');
  }
  assert.equal(await count('friendships'), 0);
  assert.equal(await count('private.invite_accepts'), 0);
  assert.equal(await count('private.invite_uses'), 0);
  assert.deepEqual(await pushTitlesTo(owner), []);
  assert.equal(await accept(users[1], code), 'friends');
});

// ---------------------------------------------------------------------------
// 4. Limits
// ---------------------------------------------------------------------------

test('You can use 20 invite links a day; unfriending does not give any back', async () => {
  const owners = await morePeople(22);
  const codes = [];
  for (const id of owners) {
    await birthday(id, 30);
    codes.push(await codeOf(id));
  }
  // Taps that change nothing don't count.
  assert.equal(await accept(users[0], await codeOf(users[0])), 'self');
  await friend(db, users[0], owners[21]);
  assert.equal(await accept(users[0], codes[21]), 'already');
  for (let n = 0; n < 20; n++) assert.equal(await accept(users[0], codes[n]), 'friends', `invite ${n + 1}`);
  assert.equal(await failure(accept(users[0], codes[20])), TOO_MANY);
  assert.deepEqual(await links(users[0], owners[20]), []);
  // Still "already" (nothing to change) when over the limit.
  assert.equal(await accept(users[0], codes[21]), 'already');
  // Unfriending everyone doesn't give invites back.
  await rpc(0, 'delete from friendships where requester_id = $1', [users[0]]);
  assert.equal(await failure(accept(users[0], codes[20])), TOO_MANY);
  // A day later it works again.
  await db.query("update private.invite_accepts set used_at = now() - interval '25 hours'");
  assert.equal(await accept(users[0], codes[20]), 'friends');
  // Someone else was never limited by this.
  assert.equal(await accept(users[1], codes[0]), 'friends');
});

test('One link can be used 20 times a day; its owner gets one notification when it gets busy', async () => {
  await birthday(users[0], 30);
  const owner = await pushTo(users[0]);
  const code = await codeOf(users[0]);
  const guests = await morePeople(23);
  for (const id of guests) await birthday(id, 25);
  for (let n = 0; n < 19; n++) assert.equal(await accept(guests[n], code), 'friends', `guest ${n + 1}`);
  assert.ok(!(await pushes()).some((p) => p.body === BUSY_PUSH));
  // The 20th use: still works, and the owner is told once.
  assert.equal(await accept(guests[19], code), 'friends');
  const busy = (await pushes()).filter((p) => p.body === BUSY_PUSH);
  assert.deepEqual(busy, [{ to: owner, title: '🔗 Your invite link', body: BUSY_PUSH, data: { type: 'friends' } }]);
  // The 21st: refused, nothing saved.
  assert.equal(await failure(accept(guests[20], code)), BUSY);
  assert.equal(await failure(accept(guests[21], code)), BUSY);
  assert.deepEqual(await links(users[0], guests[20]), []);
  assert.equal(await count("friendships where addressee_id = $1 and status = 'accepted'", [users[0]]), 20);
  // A day later the link works again; the owner isn't told twice within a day.
  await db.query("update private.invite_accepts set used_at = now() - interval '25 hours'");
  assert.equal(await accept(guests[20], code), 'friends');
  assert.equal((await pushes()).filter((p) => p.body === BUSY_PUSH).length, 1);
  // The person who tapped never gets the owner's notifications.
  const guestToken = await pushTo(guests[22]);
  assert.equal(await accept(guests[22], code), 'friends');
  assert.deepEqual(await pushTitlesTo(guestToken), []);
});

test('Child safety: after 3 under-18s use one adult\'s link in a day, more under-18s get "busy", nothing reaches the adult, and the alert people hear once', async () => {
  await birthday(users[0], 30);
  const owner = await pushTo(users[0]);
  await db.query('insert into private.report_alert_people(user_id) values ($1)', [users[7]]);
  const alerts = await pushTo(users[7]);
  const code = await codeOf(users[0]);
  for (const i of [1, 2, 3]) {
    await birthday(users[i], 15);
    assert.equal(await accept(users[i], code), 'friends', `teen ${i}`);
  }
  assert.deepEqual(await pushTitlesTo(alerts), []);
  // The 4th under-18 (no birthday counts as under 18): "busy". Nothing the adult could see or accept:
  // no friendship row (not even a request) and no notification to the adult (or to the teen).
  const fourth = await pushTo(users[4]);
  assert.equal(await accept(users[4], code), 'busy');
  assert.deepEqual(await links(users[0], users[4]), []);
  assert.equal(await count("friendships where addressee_id = $1 and status = 'pending'", [users[0]]), 0);
  assert.deepEqual(await pushTitlesTo(owner), Array(3).fill('You have a new friend 🎉'));
  assert.deepEqual(await pushTitlesTo(fourth), []);
  assert.equal(await count('private.invite_uses where invitee = $1', [users[4]]), 0);
  // The people who get report alerts are told, once.
  const told = (await pushes()).filter((p) => p.to === alerts);
  assert.equal(told.length, 1);
  assert.equal(told[0].title, '🚩 Invite link check');
  assert.equal(told[0].body, 'Lots of under-18s used one invite link today (its owner is an adult or has no birthday saved), '
    + "so more under-18s can't use it for now. Check private.invite_accepts in Supabase.");
  assert.deepEqual(told[0].data, { type: 'invite_check', inviter: users[0] });
  assert.equal(await count("private.invite_alerts where inviter = $1 and kind = 'under_18'", [users[0]]), 1);
  // The 5th: "busy" too, but no second alert that day. Tapping again is "busy" again.
  await birthday(users[5], 16);
  assert.equal(await accept(users[5], code), 'busy');
  assert.equal(await accept(users[4], code), 'busy');
  assert.deepEqual(await links(users[0], users[5]), []);
  assert.equal((await pushes()).filter((p) => p.to === alerts).length, 1);
  // Adults are not affected.
  await birthday(users[6], 30);
  assert.equal(await accept(users[6], code), 'friends');
  assert.deepEqual(await pushTitlesTo(owner), Array(4).fill('You have a new friend 🎉'));
  // Every try is written down, the stopped ones as "held".
  assert.deepEqual((await db.query('select accepter, outcome, accepter_adult, friendship_id is null as nothing_saved from private.invite_accepts order by id')).rows.map(
    (r) => [r.accepter, r.outcome, r.accepter_adult, r.nothing_saved]), [
    [users[1], 'friends', false, false], [users[2], 'friends', false, false], [users[3], 'friends', false, false],
    [users[4], 'held', false, true], [users[5], 'held', false, true], [users[4], 'held', false, true],
    [users[6], 'friends', true, false],
  ]);
  // Stopped tries count towards the link's 20 a day: 7 so far, 13 more stopped tries make 20, and then
  // even an adult gets "busy". The adult still never hears about any of the stopped tries.
  const kids = await morePeople(13);
  for (const id of kids) assert.equal(await accept(id, code), 'busy');
  const [grownUp] = await morePeople(1, 200);
  await birthday(grownUp, 40);
  assert.equal(await failure(accept(grownUp, code)), BUSY);
  assert.deepEqual(await pushTitlesTo(owner), Array(4).fill('You have a new friend 🎉'));
  assert.equal(await count("friendships where addressee_id = $1 and status = 'pending'", [users[0]]), 0);

  // The same for an adult with a private account (they would only get requests): after 3 under-18s,
  // more under-18s get "busy" and send nothing. Its own alert goes out (one a day for each link).
  const [quiet, ...teens] = await morePeople(5, 300);
  await birthday(quiet, 35);
  await as(quiet, 'update profiles set is_private = true where id = $1', [quiet]);
  const quietToken = await pushTo(quiet);
  const quietCode = await codeOf(quiet);
  for (const id of teens.slice(0, 3)) assert.equal(await accept(id, quietCode), 'requested');
  assert.equal(await accept(teens[3], quietCode), 'busy');
  assert.deepEqual(await links(quiet, teens[3]), []);
  assert.deepEqual(await pushTitlesTo(quietToken), Array(3).fill('New friend request 👋'));
  assert.equal((await pushes()).filter((p) => p.to === alerts).length, 2);

  // A day later, under-18s are friends at once again.
  await db.query("update private.invite_accepts set used_at = now() - interval '25 hours'");
  const [teen] = await morePeople(1, 400);
  await birthday(teen, 15);
  assert.equal(await accept(teen, code), 'friends');
});

// ---------------------------------------------------------------------------
// 5. Accounts and the migration itself
// ---------------------------------------------------------------------------

test('Child safety also covers a link whose owner never saved a birthday (skipping the birthday can\'t dodge it); a teen\'s own link is not held', async () => {
  // users[0] never saved a birthday: their link sends requests, and after 3 under-18s the 4th gets "busy".
  const code = await codeOf(users[0]);
  for (const i of [1, 2, 3]) {
    await birthday(users[i], 15);
    assert.equal(await accept(users[i], code), 'requested', `teen ${i}`);
  }
  await birthday(users[4], 14);
  assert.equal(await accept(users[4], code), 'busy');
  assert.deepEqual(await links(users[0], users[4]), []);
  assert.equal(await count("private.invite_accepts where inviter = $1 and outcome = 'held'", [users[0]]), 1);
  // A 15-year-old's own link, used by 4 classmates: never held (they all just send requests).
  await birthday(users[5], 15);
  const teenCode = await codeOf(users[5]);
  for (const id of await morePeople(4)) {
    await birthday(id, 15);
    assert.equal(await accept(id, teenCode), 'requested');
  }
  assert.equal(await count("private.invite_accepts where inviter = $1 and outcome = 'held'", [users[5]]), 0);
});

test('Deleting an account still works and takes its code and invite history with it', async () => {
  await birthday(users[0], 30);
  const code = await codeOf(users[0]);
  assert.equal(await accept(users[1], code), 'friends');
  assert.equal(await accept(users[2], code), 'friends');
  await rpc(2, 'delete from friendships where requester_id = $1', [users[2]]);
  await codeOf(users[1]);
  assert.equal(await count('private.past_links'), 1);
  // Deleting an account with friends doesn't write down any "removed" friendships.
  await db.query('delete from auth.users where id = $1', [users[0]]);
  for (const table of ['invite_codes', 'private.invite_uses', 'private.past_links', 'private.invite_accepts']) {
    assert.equal(await count(`${table} where ${table === 'invite_codes' ? 'user_id' : table === 'private.past_links' ? 'person_a' : 'inviter'} = $1`, [users[0]]), 0, table);
  }
  assert.equal(await count('private.past_links'), 0);
  assert.equal(await count('friendships'), 0);
  assert.equal(await count('invite_codes'), 1);
  assert.equal(await failure(accept(users[3], code)), NOT_WORKING);
  // The removed-friendship lines go with either person's account (the one with the bigger id too).
  const [small, big] = [users[4], users[5]].sort();
  await friend(db, small, big);
  await as(small, 'delete from friendships where requester_id = $1 or addressee_id = $1', [small]);
  assert.deepEqual((await db.query('select person_a, person_b from private.past_links')).rows, [{ person_a: small, person_b: big }]);
  await db.query('delete from auth.users where id = $1', [big]);
  assert.equal(await count('private.past_links'), 0);
});

test('Removed-friendship lines are not linked to profiles (so an unfriend never waits for an account deletion), and are cleaned up after everything else', async () => {
  // No links from past_links to profiles: writing a line never has to wait for (or get stuck with) an
  // account that is being deleted at that moment (tests/database/concurrency.mjs runs that race for real).
  assert.equal(await count("pg_constraint where conrelid = 'private.past_links'::regclass and contype = 'f'"), 0);
  const source = (await one("select prosrc from pg_proc where oid = 'private.remember_past_link()'::regprocedure")).prosrc;
  assert.doesNotMatch(source, /foreign_key_violation/, 'the old fallback for a missing profile could never run');
  // The clean-up trigger runs after every link that deletes things with the account (triggers run in name order).
  const order = await one(`select bool_and(t.tgname::text < 'zz_profiles_forget_past_links' collate "C") as later, count(*)::int as n
    from pg_trigger t where t.tgrelid = 'public.profiles'::regclass and t.tgisinternal`);
  assert.ok(order.n > 0 && order.later, JSON.stringify(order));
  // Stand-in for someone else's unfriend that finishes while the account is being deleted: removing the
  // account's friendships waits for that unfriend, so its line is there by the time they are removed.
  // Here the line is written while the friendships are removed. The clean-up runs after that: no line is left.
  const [leaver, pal, other] = [users[0], users[1], users[2]];
  await friend(db, leaver, pal);
  await friend(db, other, pal);
  await db.exec(`
    create function public.qa_line_during_deletion() returns trigger language plpgsql as $$
    begin insert into private.past_links(person_a, person_b) values (least(old.requester_id, old.addressee_id), greatest(old.requester_id, old.addressee_id))
      on conflict do nothing; return old; end; $$;
    create trigger qa_line_during_deletion before delete on public.friendships for each row execute function public.qa_line_during_deletion();`);
  try {
    await db.query('delete from auth.users where id = $1', [leaver]);
  } finally {
    await db.exec('drop trigger qa_line_during_deletion on public.friendships; drop function public.qa_line_during_deletion();');
  }
  assert.equal(await count('private.past_links where $1 in (person_a, person_b)', [leaver]), 0);
  // Other people's lines stay.
  await as(other, 'delete from friendships where requester_id = $1', [other]);
  assert.equal(await count('private.past_links'), 1);
});

test('Running the migration again changes nothing', async () => {
  await birthday(users[0], 30);
  const code = await codeOf(users[0]);
  assert.equal(await accept(users[1], code), 'friends');
  assert.equal(await accept(users[2], code), 'friends');
  await rpc(2, 'delete from friendships where requester_id = $1', [users[2]]);
  const snapshot = async () => ({
    codes: (await db.query('select * from invite_codes order by user_id')).rows,
    uses: (await db.query('select * from private.invite_uses order by inviter, invitee')).rows,
    past: (await db.query('select * from private.past_links order by person_a, person_b')).rows,
    log: (await db.query('select * from private.invite_accepts order by id')).rows,
    friends: (await db.query('select * from friendships order by id')).rows,
  });
  const before = await snapshot();
  // An earlier copy of the file linked past_links to profiles: running it again removes those links.
  await db.exec(`alter table private.past_links
    add constraint past_links_person_a_fkey foreign key (person_a) references public.profiles (id) on delete cascade,
    add constraint past_links_person_b_fkey foreign key (person_b) references public.profiles (id) on delete cascade`);
  // An earlier copy had no 'held' outcome and a held_for_safety column: running the file again fixes both.
  await db.exec(`alter table private.invite_accepts drop constraint invite_accepts_outcome_check;
    alter table private.invite_accepts add constraint invite_accepts_outcome_check
      check (outcome in ('friends', 'requested', 'accepted_request'));
    alter table private.invite_accepts add column held_for_safety boolean not null default false`);
  await applyMigrationFile(db, MIGRATION);
  await applyMigrationFile(db, MIGRATION);
  assert.deepEqual(await snapshot(), before);
  assert.equal(await count("information_schema.columns where table_schema = 'private' and table_name = 'invite_accepts' and column_name = 'held_for_safety'"), 0);
  assert.match((await one("select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'invite_accepts_outcome_check'")).d, /held/);
  assert.equal(await count("pg_trigger where tgname = 'friendships_remember_past_link'"), 1);
  assert.equal(await count("pg_trigger where tgname = 'zz_profiles_forget_past_links'"), 1);
  assert.equal(await count("pg_constraint where conrelid = 'private.past_links'::regclass and contype = 'f'"), 0);
  assert.equal(await count("pg_policies where tablename = 'invite_codes'"), 1);
  for (const fn of FUNCTIONS) {
    assert.equal(await can('authenticated', fn), true, fn);
    assert.equal(await can('anon', fn), false, fn);
  }
  for (const fn of HELPERS) assert.equal(await can('authenticated', fn), false, fn);
  // Everything still works.
  assert.equal(await codeOf(users[0]), code);
  assert.equal(await accept(users[3], code), 'friends');
  assert.equal(await accept(users[2], code), 'requested');
  assert.deepEqual(await links(users[0], users[2]), []);
});
