// Posting your drop opens EVERY drop (supabase/migrations/20261228000000_drop_unlock.sql, the owner, 21 Nov 2026).
// Before, a friend's drop only opened if you had posted your own drop that SAME day, so older drops stayed
// "Give a peek to get a peek 🙈" forever. Now your drop opens every drop you may see until the next day's drop
// goes off (drops from your drop's day and before: an hour longer); drops from days you posted stay open (old app
// versions only know that rule).
// Runs all migrations in a local, in-memory PostgreSQL (PGlite) with invented users. No live project.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { asUser, createLocalDatabase, friend, seedUsers } from './local-db.mjs';

let db;
let users;
before(async () => { db = await createLocalDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('truncate auth.users cascade; truncate storage.objects, net.sent restart identity;');
  users = await seedUsers(db, 6);
});

const rpc = (i, sql, args = []) => asUser(db, users[i], (tx) => tx.query(sql, args));
// Today's date in UTC, and `n` days before it, as 'YYYY-MM-DD'.
async function daysAgo(n) {
  return (await db.query("select ((now() at time zone 'utc')::date - $1::int)::text as d", [n])).rows[0].d;
}
// A drop post for `day` (posted from time zone `offset`, minutes ahead of UTC). Written straight into the table,
// because the app can only post today's drop – the tests need drops from other days too.
async function drop(i, day, { offset = 0, audience = 'everyone' } = {}) {
  const media = `${users[i]}/posts/${randomUUID()}.jpg`;
  const blur = `${users[i]}/blurs/${randomUUID()}.jpg`;
  await db.exec('set session_replication_role = replica');
  try {
    const { rows } = await db.query(
      `insert into posts(user_id, media_path, blur_path, drop_day, drop_offset_minutes, drop_late_seconds, audience)
       values ($1, $2, $3, $4, $5, 0, $6) returning id`,
      [users[i], media, blur, day, offset, audience]);
    return { id: rows[0].id, media, blur };
  } finally {
    await db.exec('set session_replication_role = origin');
  }
}
// Your own drop that is still the current one (the next drop for you is tomorrow), or one long gone.
const currentDrop = async (i) => drop(i, await daysAgo(0), { offset: 0 });
const oldDrop = async (i, n = 3) => drop(i, await daysAgo(n), { offset: 0 });
// Could this person download the file? (Asked like the storage rule does, as them.)
const canOpen = (i, file) => db.transaction(async (tx) => {
  await tx.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', 'authenticated', true)", [users[i]]);
  return (await tx.query('select private.can_read_media($1) as ok', [file])).rows[0].ok;
});
const groupHold = async (i, postId) =>
  (await rpc(i, 'select public.group_hold(p) as held from posts p where p.id = $1', [postId])).rows[0].held;

test('No drop of your own: every drop stays a blurry preview', async () => {
  await friend(db, users[0], users[1]);
  const today = await currentDrop(0);
  const older = await oldDrop(0, 5);
  for (const post of [today, older]) {
    assert.equal(await canOpen(1, post.media), false);
    assert.equal(await canOpen(1, post.blur), true);
  }
});

test('Posting your drop opens every drop you can see – friends\' and public accounts\', old ones too', async () => {
  await friend(db, users[0], users[1]);
  const friendsToday = await currentDrop(0);
  const friendsOld = await oldDrop(0, 5);
  const friendsOlder = await oldDrop(0, 9);
  const strangersOld = await oldDrop(2, 4); // a public account, not a friend (Home's "everyone" part)
  assert.equal(await canOpen(1, friendsOld.media), false);
  await currentDrop(1);
  for (const post of [friendsToday, friendsOld, friendsOlder, strangersOld]) {
    assert.equal(await canOpen(1, post.media), true, `drop ${post.id} should be open`);
  }
});

test('Who may see a drop at all is unchanged: private accounts, close friends and blocks still win', async () => {
  await friend(db, users[0], users[1]);
  await currentDrop(1);
  // A private account you're not friends with.
  await db.query('update profiles set is_private = true where id = $1', [users[3]]);
  const privateDrop = await oldDrop(3, 2);
  assert.equal(await canOpen(1, privateDrop.media), false);
  assert.equal(await canOpen(1, privateDrop.blur), false);
  // A friend's drop for close friends only (you're not on the list).
  const closeOnly = await drop(0, await daysAgo(2), { audience: 'close_friends' });
  assert.equal(await canOpen(1, closeOnly.media), false);
  // Someone who blocked you.
  const blocker = await oldDrop(4, 2);
  assert.equal(await canOpen(1, blocker.media), true);
  await db.query('insert into blocks(blocker_id, blocked_id) values ($1, $2)', [users[4], users[1]]);
  assert.equal(await canOpen(1, blocker.media), false);
});

test('Once the next drop goes off, older drops lock again – drops from days you posted stay open', async () => {
  await friend(db, users[0], users[1]);
  const sameDay = await oldDrop(0, 3);
  const otherDay = await oldDrop(0, 5);
  const today = await currentDrop(0);
  await oldDrop(1, 3); // your last drop was 3 days ago: long since replaced by newer drops
  assert.equal(await canOpen(1, sameDay.media), true, 'the old same-day rule still opens it');
  assert.equal(await canOpen(1, otherDay.media), false);
  assert.equal(await canOpen(1, today.media), false);
});

test('The window ends when your next drop goes off (in the time zone you posted from)', async () => {
  // Of all the drops anyone could have posted in the last few days, from any time zone: the one whose next drop
  // goes off soonest after now (a few seconds of room, so the test can't be caught out by the clock), and the
  // one whose next drop went off most recently, more than an hour ago (older drops get that hour more – see the
  // next test). (At some times of day no drop goes off anywhere for a few
  // hours, so these aren't always minutes away; the exact moment is checked against the app in
  // tests/unit/drop-unlock-parity.test.mjs.)
  const { rows: [pick] } = await db.query(`
    with options as (
      select d::date as day, o as offset_minutes, private.next_drop_at(d::date, o) as next_at
        from generate_series((now() at time zone 'utc')::date - 3, (now() at time zone 'utc')::date, interval '1 day') d,
             generate_series(-720, 840) o
    )
    select (select row_to_json(x) from (select day::text, offset_minutes, next_at from options
             where next_at > now() + interval '5 seconds' order by next_at limit 1) x) as still_open,
           (select row_to_json(x) from (select day::text, offset_minutes, next_at from options
             where next_at <= now() - interval '1 hour' order by next_at desc limit 1) x) as just_over`);
  await friend(db, users[0], users[1]);
  await friend(db, users[0], users[2]);
  const friendsOld = await oldDrop(0, 9);
  await drop(1, pick.still_open.day, { offset: pick.still_open.offset_minutes });
  await drop(2, pick.just_over.day, { offset: pick.just_over.offset_minutes });
  assert.equal(await canOpen(1, friendsOld.media), true, JSON.stringify(pick.still_open));
  assert.equal(await canOpen(2, friendsOld.media), false, JSON.stringify(pick.just_over));
});

test('The clocks going back can\'t lock older drops early: they get an hour more, new days\' drops lock on time', async () => {
  // My drop from yesterday, "posted" from a time zone that puts its next drop `minutes` from now (the database's
  // clock can't be moved, so the drop is moved instead).
  const offsetFor = async (day, minutes) => (await db.query(`
    select round(extract(epoch from (($1::date + 1) + make_interval(mins => private.drop_minute($1::date + 1)))
                 - ((now() at time zone 'utc') + make_interval(mins => $2::int))) / 60)::int as o`, [day, minutes])).rows[0].o;
  const yesterday = await daysAgo(1);
  for (const i of [1, 2, 3, 4]) await friend(db, users[0], users[i]);
  const friendsOld = await oldDrop(0, 5);
  const friendsNew = await currentDrop(0); // today's: a day after mine
  // [my next drop, in minutes from now] → [older drop open?, new day's drop open?]
  const cases = [[30, true, true], [-30, true, false], [-50, true, false], [-70, false, false]];
  for (const [n, [minutes, olderOpen, newerOpen]] of cases.entries()) {
    const i = n + 1;
    await drop(i, yesterday, { offset: await offsetFor(yesterday, minutes) });
    assert.equal(await canOpen(i, friendsOld.media), olderOpen, `older drop, next drop ${minutes} min from now`);
    assert.equal(await canOpen(i, friendsNew.media), newerOpen, `new day's drop, next drop ${minutes} min from now`);
    // Who Peeked follows the same rule.
    await rpc(i, 'select mark_drop_seen($1, true)', [friendsOld.id]);
    const { rows: [seen] } = await db.query('select revealed from drop_views where post_id = $1 and viewer_id = $2', [friendsOld.id, users[i]]);
    assert.equal(seen.revealed, olderOpen);
  }
  // The New York example: Saturday's drop posted in summer time (4 h behind UTC) would lock Sunday's older drops
  // an hour before Sunday's drop goes off in winter time (5 h behind) – that hour is covered now.
  const { rows: [ny] } = await db.query(`
    select extract(epoch from private.next_drop_at('2027-11-06', -300) - private.next_drop_at('2027-11-06', -240))::int as gap`);
  assert.equal(ny.gap, 3600);
});

test('Group Peek: today\'s drops still wait for the whole group; an old day\'s wait ends once that day is over', async () => {
  for (const i of [1, 2]) await friend(db, users[0], users[i]);
  await rpc(0, "select create_peek_group('QA drop group', $1::uuid[], current_date)", [[users[1], users[2]]]);
  await db.query("update peek_group_members set joined_day = current_date - 30");
  const oldDay = await daysAgo(3);
  const friendsOld = await drop(0, oldDay);
  const friendsToday = await currentDrop(0);
  await currentDrop(1);
  await drop(1, oldDay);
  // users[2] posted neither day.
  assert.equal(await groupHold(1, friendsToday.id), true);
  assert.equal(await canOpen(1, friendsToday.media), false);
  assert.equal(await groupHold(1, friendsOld.id), false, 'nobody can post that day\'s drop any more');
  assert.equal(await canOpen(1, friendsOld.media), true);
  // The last one posts today's drop: today's group drops open.
  await currentDrop(2);
  assert.equal(await groupHold(1, friendsToday.id), false);
  assert.equal(await canOpen(1, friendsToday.media), true);
  // The cut-off: the day after, at 12:00 UTC (midnight at UTC-12, the last place that day ends).
  const { rows: [cut] } = await db.query("select private.drop_day_over_at('2026-11-20')::text as at");
  assert.match(cut.at, /^2026-11-21 12:00:00\+00/);
});

test('Who Peeked: a reveal only counts when the drop was open for you', async () => {
  await friend(db, users[0], users[1]);
  await friend(db, users[0], users[2]);
  const friendsOld = await oldDrop(0, 4);
  await currentDrop(1);
  await rpc(1, 'select mark_drop_seen($1, true)', [friendsOld.id]);
  await rpc(2, 'select mark_drop_seen($1, true)', [friendsOld.id]); // no drop of their own
  const { rows } = await db.query('select viewer_id, revealed from drop_views where post_id = $1 order by viewer_id', [friendsOld.id]);
  assert.deepEqual(rows.map((r) => [r.viewer_id, r.revealed]), [[users[1], true], [users[2], false]]);
});

test('A report keeps the full drop as evidence only when it was open for the reporter', async () => {
  await friend(db, users[0], users[1]);
  await friend(db, users[0], users[2]);
  const friendsOld = await oldDrop(0, 4);
  await currentDrop(1);
  const kept = async (i) => (await db.query(
    "select array_agg(path order by path) as paths from private.report_evidence_paths('post', $1, $2) path where path is not null",
    [friendsOld.id, users[i]])).rows[0].paths;
  assert.deepEqual(await kept(1), [friendsOld.blur, friendsOld.media].sort());
  assert.deepEqual(await kept(2), [friendsOld.blur]);
});

test('The three checks use the one rule, the new helpers are private, and running the migration again changes nothing', async () => {
  const definition = async (fn) => (await db.query('select pg_get_functiondef($1::regprocedure) as d', [fn])).rows[0].d;
  const fns = ['private.can_read_media(text)', 'private.report_evidence_paths(text,uuid,uuid)', 'public.mark_drop_seen(uuid,boolean)'];
  const before = [];
  for (const fn of fns) {
    const d = await definition(fn);
    assert.equal(d.split('drop_open_for').length - 1, 1, fn);
    assert.doesNotMatch(d, /mine\.drop_day/, `${fn} still has the old same-day check`);
    before.push(d);
  }
  // Public chat's lines (20261225000000_public_chat.sql) are still there.
  assert.match(before[0], /can_read_public_photo/);
  assert.match(before[1], /public_photos/);
  const sql = await readFile(new URL('../../supabase/migrations/20261228000000_drop_unlock.sql', import.meta.url), 'utf8');
  await db.exec(sql);
  for (const [n, fn] of fns.entries()) assert.equal(await definition(fn), before[n]);
  for (const fn of ['private.next_drop_at(date,integer)', 'private.drop_open_for(uuid,date)', 'private.drop_day_over_at(date)']) {
    for (const role of ['anon', 'authenticated']) {
      const { rows } = await db.query('select has_function_privilege($1, $2, \'execute\') as ok', [role, fn]);
      assert.equal(rows[0].ok, false, `${role} can run ${fn}`);
    }
  }
});

test('A database where the spot to change is missing stops the migration instead of skipping it', async () => {
  // Pretend an unknown later change rewrote mark_drop_seen (in a transaction that is undone afterwards).
  await assert.rejects(db.transaction(async (tx) => {
    const d = (await tx.query("select pg_get_functiondef('public.mark_drop_seen(uuid,boolean)'::regprocedure) as d")).rows[0].d;
    await tx.exec(d.replace('not private.drop_open_for(me, day)', 'false'));
    const sql = await readFile(new URL('../../supabase/migrations/20261228000000_drop_unlock.sql', import.meta.url), 'utf8');
    await tx.exec(sql.replace(/^begin;$/m, '').replace(/^commit;$/m, ''));
  }), /could not find the spot to change in (public\.)?mark_drop_seen/);
});
