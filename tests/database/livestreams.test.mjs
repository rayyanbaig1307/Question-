// Lives 🔴 (supabase/migrations/20261226000000_livestreams.sql): friends-only livestreams on LiveKit.
// Runs every migration in a local, in-memory PostgreSQL (PGlite) with invented people. Nothing here talks to
// LiveKit, Expo or a live project: pg_net, the Vault and pg_cron are the local stand-ins from local-db.mjs.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { asUser, createLocalDatabase, friend, migrationSql, seedUsers } from './local-db.mjs';

const MIGRATION = '20261226000000_livestreams.sql';
// The comment sentences (§9.6 of the design). The app's checkLiveComment must show exactly these.
const SAY = {
  word: "That word isn't allowed on Peekaboo.",
  harm: "That comment isn't allowed – no hurting anyone (or yourself), no violence and no abuse. 🙏",
  sexual: "That comment isn't allowed – nothing sexual. 🙏",
  hate: "That comment isn't allowed – no hate, bullying or slurs. 🙏",
  spam: 'That comment looks like spam – no links, phone numbers or the same thing over and over. 🙏',
  size: 'Comments can be 1 to 150 characters.',
  off: 'Comments are off for this live.',
  slow: 'Slow down a little – one comment every 3 seconds.',
  same: 'You just said that. 🙂',
  limit: "That's a lot of comments – let others have a turn.",
  busy: 'Lots of comments right now – try again in a moment.',
};

let db;
let users;
before(async () => { db = await createLocalDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  // The private logs have no links to accounts (on purpose), so "cascade" doesn't reach them: empty them too.
  await db.exec(`
    truncate auth.users cascade;
    truncate private.live_jobs, private.live_events, private.live_token_log, private.live_watch_rooms,
      private.live_snapshots, private.live_removed_comments, net.sent restart identity;
    update private.live_settings set who_can_go_live = 'everyone', max_minutes = 60, max_viewers = 20,
      lives_per_day = 3, max_live_now = 4, monthly_minutes = 4000, push_every = '2 hours', report_end_count = 2,
      empty_minutes = 5, host_month_minutes = 600, min_account_days = 0;`);
  users = await seedUsers(db, 14);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const as = (i, sql, args = []) => asUser(db, users[i], (tx) => tx.query(sql, args));
const server = (sql, args = []) => asUser(db, null, (tx) => tx.query(sql, args), 'service_role');
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const count = async (sql, args = []) => (await one(`select count(*)::int as n from ${sql}`, args)).n;
// The short code the app acts on (or 'ok').
const hint = (run) => run.then(() => 'ok', (e) => e.hint ?? `no hint: ${e.message}`);
const failure = (run) => run.then(() => 'ok', (e) => e.message);
const who = (id) => (id == null ? '-' : users.indexOf(id));
const born = (i, years) => db.query(
  `insert into age_checks(user_id,birthday,blocked) values($1,(current_date - make_interval(years => $2))::date,$2 < 18)
   on conflict (user_id) do update set birthday = excluded.birthday, blocked = excluded.blocked`, [users[i], years]);
const rules = (i) => db.query("insert into legal_acceptances(user_id,document,version) values($1,'live_rules','2026-11-20') on conflict do nothing", [users[i]]);
const ready = async (...list) => { for (const i of list) { await born(i, 30); await rules(i); } };
const befriend = async (a, ...others) => { for (const b of others) await friend(db, users[a], users[b]); };
const start = async (i) => (await as(i, 'select start_live($1) as id', [users[i]])).rows[0].id;
const onAir = (i, id) => as(i, 'select live_on_air($1)', [id]);
const join = async (i, id) => (await server('select live_join($1,$2) as r', [users[i], id])).rows[0].r;
const access = async (id, i) => (await one('select private.live_access($1,$2) as a', [id, i == null ? null : users[i]])).a;
const status = async (i, id) => (await as(i, 'select live_status($1) as s', [id])).rows[0].s;
const ping = async (i, id) => (await as(i, 'select live_ping($1) as s', [id])).rows[0].s;
const say = (i, id, text) => as(i, 'select * from send_live_comment($1,$2)', [id, text]);
const liveRow = (id) => one('select * from lives where id = $1', [id]);
const presence = (id, i) => one('select * from live_viewers where live_id = $1 and user_id = $2', [id, users[i]]);
const waiting = async () => (await db.query('select kind, person from private.live_jobs where done_at is null order by id'))
  .rows.map((r) => `${r.kind}:${who(r.person)}`);
const clearJobs = () => db.query('update private.live_jobs set done_at = now() where done_at is null');
const adminPosts = async () => (await db.query("select headers from net.sent where url like '%/functions/v1/live-admin'")).rows;
const pushes = async () => (await db.query("select body from net.sent where url = 'https://exp.host/--/api/v2/push/send' order by id")).rows.map((r) => r.body);
const claim = async (max = 25) => (await server('select live_jobs_claim($1) as j', [max])).rows[0].j;
const finish = (done, failed = [], recheck = []) => server('select live_jobs_finish($1::bigint[], $2::jsonb, $3::bigint[])', [done, JSON.stringify(failed), recheck]);
const sweep = () => db.query('select private.live_sweep()');
const ban = (i) => db.query("update auth.users set banned_until = now() + interval '1 day' where id = $1", [users[i]]);
const block = (a, b) => db.query('insert into blocks(blocker_id,blocked_id) values($1,$2)', [users[a], users[b]]);
// A live on air with these friends watching. The host is ready to go live.
async function goLive(host, viewers = []) {
  await ready(host);
  await befriend(host, ...viewers);
  if (!viewers.length) await befriend(host, 13);
  const id = await start(host);
  await onAir(host, id);
  for (const v of viewers) assert.equal((await join(v, id)).ok, true, `viewer ${v} joins`);
  return id;
}
// Pretend some time has passed for a presence row.
const stale = (id, i, seconds) => db.query(
  `update live_viewers set last_seen_at = last_seen_at - make_interval(secs => $3), joined_at = joined_at - make_interval(secs => $3)
    where live_id = $1 and user_id = $2`, [id, users[i], seconds]);
// The owner puts someone on the stage (the ask itself is tested on its own).
const putOn = (id, i) => db.query('update lives set cohost_id = $2, cohost_since = now() where id = $1', [id, users[i]]);

// ---------------------------------------------------------------------------
// 1. The migration
// ---------------------------------------------------------------------------
test('The migration runs twice; only comments and asks go out live; the minute check and the Vault key exist', async () => {
  const key = (await one("select secret from vault.secrets where name = 'live_admin_key'")).secret;
  assert.match(key, /^[0-9a-f]{64}$/);
  await db.exec(await migrationSql(MIGRATION));
  assert.equal((await one("select secret from vault.secrets where name = 'live_admin_key'")).secret, key, 'the key is made only once');
  assert.equal(await count("vault.secrets where name = 'live_admin_key'"), 1);
  assert.equal(await count('private.live_settings'), 1);
  assert.equal((await one('select who_can_go_live from private.live_settings')).who_can_go_live, 'everyone', "a second run keeps the owner's choice");
  const fresh = await one(`select column_default from information_schema.columns
    where table_schema = 'private' and table_name = 'live_settings' and column_name = 'who_can_go_live'`);
  assert.match(fresh.column_default, /'testers'/, 'lives start for testers only');
  const published = (await db.query(`select tablename from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename in ('lives','live_viewers','live_comments','live_invites') order by 1`)).rows.map((r) => r.tablename);
  assert.deepEqual(published, ['live_comments', 'live_invites']);
  assert.deepEqual(await one("select schedule, command from cron.job where jobname = 'peekaboo-live-sweep'"),
    { schedule: '* * * * *', command: 'select private.live_sweep()' });
  assert.equal(await count("cron.job where jobname = 'peekaboo-live-sweep'"), 1);
  // prepare_report has the live lines once, and still has the public chat lines.
  const body = (await one("select pg_get_functiondef('private.prepare_report()'::regprocedure) as d")).d;
  assert.equal(body.split('live_report_author').length - 1, 1);
  assert.match(body, /new\.content_type = 'public_photo'/);
  assert.match(body, /private\.in_public_chat\(me\)/);
  // The Live rules card is saved like the Terms.
  await as(0, "select accept_legal('live_rules','2026-11-20')");
  assert.equal(await count("legal_acceptances where document = 'live_rules'"), 1);
  assert.match(await failure(as(0, "select accept_legal('something_else','1')")), /legal_acceptances_document_check/);
  // Every function the migration makes runs with an empty search path and as its owner.
  const loose = (await db.query(`select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','private') and (p.proname like '%live%' or p.proname in ('can_host','connected','was_in_live','push_live','answer_cohost_invite','invite_cohost','cancel_cohost_invite','end_cohost','friends_live_now','start_live','end_live','set_push_capability'))
      and p.proname <> 'live_fail' and (not p.prosecdef or not ('search_path=""' = any (coalesce(p.proconfig, '{}'))))`)).rows.map((r) => r.fn);
  assert.deepEqual(loose, []);
});

// ---------------------------------------------------------------------------
// 2. Going live: every gate, in order
// ---------------------------------------------------------------------------
test('Going live: every reason, in order, the same in live_state and start_live', async () => {
  const why = async () => (await as(0, 'select live_state() as s')).rows[0].s.why_not;
  const tryStart = () => hint(as(0, 'select start_live($1)', [users[0]]));
  const expect = async (reason) => {
    assert.equal(await why(), reason);
    assert.equal(await tryStart(), reason ? `live_${reason}` : 'ok');
  };
  await db.query("update private.live_settings set who_can_go_live = 'nobody'");
  await expect('off');
  await db.query("update private.live_settings set who_can_go_live = 'testers'");
  await expect('testers');
  await db.query('insert into private.live_testers(user_id) values($1)', [users[0]]);
  await ban(0);
  await expect('banned');
  await db.query('update auth.users set banned_until = null where id = $1', [users[0]]);
  await db.query("insert into private.live_restrictions(user_id, until) values($1, now() + interval '1 hour')", [users[0]]);
  await expect('restricted');
  await db.query("update private.live_restrictions set until = now() - interval '1 second'");
  await expect('birthday');
  await born(0, 30);
  await expect('rules');
  await rules(0);
  await expect('no_friends');
  // A friend request isn't a friend, and neither is a blocked friend.
  await db.query("insert into friendships(requester_id,addressee_id,status) values($1,$2,'pending')", [users[0], users[1]]);
  await befriend(0, 2);
  await block(2, 0);
  await expect('no_friends');
  await befriend(0, 3);
  await db.query('update private.live_settings set min_account_days = 7');
  await expect('new_account');
  await db.query('update private.live_settings set min_account_days = 0');
  const state = (await as(0, 'select live_state() as s')).rows[0].s;
  assert.deepEqual({ ...state, my_live: null }, {
    can_go_live: true, why_not: null, my_live: null, max_minutes: 60, lives_left_today: 3, rules_accepted: true,
  });
  await expect(null);
  assert.equal((await as(0, 'select live_state() as s')).rows[0].s.my_live, (await one('select id from lives where host_id = $1', [users[0]])).id);
  // The login check.
  const wrong = await as(0, 'select start_live($1)', [users[1]]).catch((e) => e);
  assert.equal(wrong.code, '28000');
  assert.equal(wrong.hint, 'live_login');
  assert.equal(wrong.message, 'Your login changed – please log in again.');
});

test('The daily limit counts only lives that went on air; no_limits testers skip it; the month and busy limits', async () => {
  await ready(0, 4);
  await befriend(0, 1);
  await befriend(4, 1);
  // A start that never went on air doesn't count.
  await start(0);
  for (let n = 0; n < 3; n++) {
    const id = await start(0);
    await onAir(0, id);
    await as(0, 'select end_live($1, 0)', [id]);
  }
  assert.equal((await as(0, 'select live_state() as s')).rows[0].s.lives_left_today, 0);
  assert.equal(await hint(as(0, 'select start_live($1)', [users[0]])), 'live_daily_limit');
  await db.query('insert into private.live_testers(user_id, no_limits) values($1, true)', [users[0]]);
  assert.equal((await as(0, 'select live_state() as s')).rows[0].s.why_not, null);
  await db.query('delete from private.live_testers');
  await db.query(`update lives set on_air_at = on_air_at - interval '25 hours', started_at = started_at - interval '25 hours',
    ended_at = ended_at - interval '25 hours', ends_at = ends_at - interval '25 hours' where host_id = $1`, [users[0]]);
  assert.equal((await as(0, 'select live_state() as s')).rows[0].s.why_not, null);
  // 600 on-air minutes per host this month.
  await db.query(`insert into lives(id, host_id, room, started_at, on_air_at, ends_at, ended_at, ended_reason)
    select g, $1, 'live_' || g, m, m, m + interval '601 minutes', m + interval '601 minutes', 'host'
      from gen_random_uuid() g, (select (date_trunc('month', now() at time zone 'utc') at time zone 'utc') + interval '1 second' as m) t`, [users[0]]);
  assert.equal(await hint(as(0, 'select start_live($1)', [users[0]])), 'live_month_limit');
  await db.query('update private.live_settings set host_month_minutes = 0');
  // Busy: too many lives at once (my own open live doesn't count), or the month's minutes are used up.
  await db.query('update private.live_settings set max_live_now = 1, monthly_minutes = 0');
  const other = await start(4);
  assert.equal(await hint(as(0, 'select start_live($1)', [users[0]])), 'live_busy');
  await as(4, 'select end_live($1, 0)', [other]);
  assert.equal(await hint(as(0, 'select start_live($1)', [users[0]])), 'ok');
  assert.equal(await hint(as(0, 'select start_live($1)', [users[0]])), 'ok', 'my own open live never makes me busy');
  await db.query('update private.live_settings set max_live_now = 4, monthly_minutes = 100');
  assert.equal(await hint(as(4, 'select start_live($1)', [users[4]])), 'live_busy');
});

test('Starting again ends my live that was still open; two starts in a row leave one open live', async () => {
  await ready(0);
  await befriend(0, 1);
  const first = await start(0);
  const second = await start(0);
  assert.equal((await liveRow(first)).ended_reason, 'host_gone');
  await db.query("update lives set ends_at = now() - interval '1 second' where id = $1", [second]);
  const third = await start(0);
  assert.equal((await liveRow(second)).ended_reason, 'time');
  assert.equal(await count('lives where host_id = $1 and ended_at is null', [users[0]]), 1);
  const row = await liveRow(third);
  assert.equal(row.room, `live_${third}`);
  assert.equal(Math.round((row.ends_at - row.started_at) / 60000), 60);
  assert.equal(row.on_air_at, null);
  // Nobody is told about a live that isn't on air yet.
  assert.deepEqual(await pushes(), []);
  const started = await one("select detail from private.live_events where live_id = $1 and kind = 'start'", [third]);
  assert.deepEqual(started.detail, { host_age_group: 'adult', host_username: 'qa_user_0' });
});

// ---------------------------------------------------------------------------
// 3. The one rule
// ---------------------------------------------------------------------------
test('Who may watch: friends only, blocks both ways, bans, removed, ended, the stage rule', async () => {
  // 0 host. 1–6 friends. 7 stranger. 8 asked but not accepted. 9 and 10 are also friends of the co-host 6.
  await befriend(0, 1, 2, 3, 4, 5, 9, 10);
  await ready(6);
  const id = await goLive(0, [6]);
  await db.query("insert into friendships(requester_id,addressee_id,status) values($1,$2,'pending')", [users[0], users[8]]);
  assert.equal(await access(id, 0), 'host');
  assert.equal(await access(id, 1), 'viewer');
  assert.equal(await access(id, 7), 'not_allowed');
  assert.equal(await access(id, 8), 'not_allowed');
  assert.equal(await access(id, null), 'not_allowed');
  assert.equal(await one('select private.live_access(gen_random_uuid(), $1) as a', [users[1]]).then((r) => r.a), 'not_allowed');
  await block(0, 2);
  await block(3, 0);
  assert.equal(await access(id, 2), 'not_allowed');
  assert.equal(await access(id, 3), 'not_allowed');
  await ban(4);
  assert.equal(await access(id, 4), 'not_allowed');
  await join(5, id);
  await as(0, 'select remove_live_viewer($1,$2)', [id, users[5]]);
  assert.equal(await access(id, 5), 'removed');
  // The stage rule: while 6 is on, only friends of both may watch.
  await putOn(id, 6);
  assert.equal(await access(id, 6), 'cohost');
  assert.equal(await access(id, 1), 'paused', 'not a friend of the co-host');
  await befriend(6, 9, 10);
  assert.equal(await access(id, 9), 'viewer');
  await block(10, 6);
  assert.equal(await access(id, 10), 'paused', 'blocked with the co-host');
  await block(9, 1);
  assert.equal(await access(id, 9), 'viewer', 'a block between two viewers changes nothing');
  // A co-host who is stopped by the owner is a viewer again (and is taken off).
  await db.query('insert into private.live_restrictions(user_id) values($1)', [users[6]]);
  assert.equal(await access(id, 6), 'viewer');
  await db.query('delete from private.live_restrictions');
  // Ended, past its end time, or the host banned: friends see 'ended', strangers still learn nothing.
  await as(0, 'select end_live($1, 0)', [id]);
  assert.equal(await access(id, 0), 'ended');
  assert.equal(await access(id, 9), 'ended');
  assert.equal(await access(id, 7), 'not_allowed');
  const later = await start(0);
  assert.equal(await access(later, 9), 'viewer');
  await db.query("update lives set ends_at = now() - interval '1 second' where id = $1", [later]);
  assert.equal(await access(later, 0), 'ended');
  assert.equal(await access(later, 9), 'ended');
  await db.query("update lives set ended_at = now() where id = $1", [later]);
  const third = await start(0);
  await ban(0);
  assert.equal(await access(third, 9), 'ended');
  assert.equal(await access(third, 0), 'not_allowed', 'a banned host gets nothing');
});

// ---------------------------------------------------------------------------
// 4. Privacy rules
// ---------------------------------------------------------------------------
test('Privacy: lives and viewers are unreadable; comments only while allowed and not blocked; asks only for host and guest', async () => {
  await ready(1);
  await befriend(1, 2);
  const id = await goLive(0, [1, 2, 3]);
  for (const table of ['lives', 'live_viewers']) {
    assert.match(await failure(as(1, `select * from ${table}`)), /permission denied/);
    assert.match(await failure(asUser(db, null, (tx) => tx.query(`select * from ${table}`), 'anon')), /permission denied/);
  }
  assert.match(await failure(asUser(db, null, (tx) => tx.query('select * from live_comments'), 'anon')), /permission denied/);
  assert.match(await failure(asUser(db, null, (tx) => tx.query('select * from live_invites'), 'anon')), /permission denied/);
  await say(1, id, 'hi from 1');
  await say(2, id, 'hi from 2');
  await say(0, id, 'hi from the host');
  const read = async (i) => (await as(i, 'select body from live_comments order by created_at')).rows.map((r) => r.body);
  assert.deepEqual(await read(3), ['hi from 1', 'hi from 2', 'hi from the host']);
  assert.deepEqual(await read(7), [], 'a stranger');
  await block(2, 1);
  assert.deepEqual(await read(1), ['hi from 1', 'hi from the host'], 'blocked people never see each other');
  assert.deepEqual(await read(2), ['hi from 2', 'hi from the host']);
  // No direct writes anywhere.
  for (const sql of [
    "insert into live_comments(live_id,user_id,name,body) values($1,$2,'x','x')",
    'update live_comments set body = $1 where live_id = $1::uuid and user_id = $2',
    'delete from live_comments where live_id = $1 and user_id = $2',
    "insert into live_invites(live_id,host_id,guest_id,expires_at) values($1,$2,$2,now())",
  ]) {
    assert.match(await failure(as(1, sql, [id, users[1]])), /permission denied/, sql);
  }
  assert.match(await failure(as(0, 'update lives set ended_at = now() where id = $1', [id])), /permission denied/);
  await db.query("insert into push_tokens(token,user_id,platform,can_live) values('phone',$1,'ios',true)", [users[0]]);
  assert.deepEqual((await as(0, 'select can_live from push_tokens')).rows, [], 'phones are never readable by the app');
  // Asks: the host and the guest only. (The ask itself is tested below.)
  const invite = (await as(0, 'select invite_cohost($1,$2) as id', [id, users[1]])).rows[0].id;
  assert.equal((await as(0, 'select count(*)::int as n from live_invites')).rows[0].n, 1);
  assert.equal((await as(1, 'select count(*)::int as n from live_invites')).rows[0].n, 1);
  assert.equal((await as(3, 'select count(*)::int as n from live_invites')).rows[0].n, 0);
  assert.ok(invite);
  // After the end nobody reads the comments any more.
  await as(0, 'select end_live($1, 0)', [id]);
  assert.deepEqual(await read(3), []);
});

// ---------------------------------------------------------------------------
// 5. Comments
// ---------------------------------------------------------------------------
test('Comments: each sentence, the length, slow mode, the same twice, the caps, comments off, who may write', async () => {
  const id = await goLive(0, [1, 2]);
  const wrong = async (i, text) => {
    const e = await say(i, id, text).catch((x) => x);
    assert.ok(e instanceof Error, `"${text}" should be refused`);
    return `${e.hint}|${e.message}`;
  };
  const older = () => db.query("update live_comments set created_at = created_at - interval '11 seconds'");
  const slur = (await one("select (private.word_filter_list('hateful'))[1] as w")).w;
  assert.equal(await wrong(1, `you ${slur}`), `live_comment_word|${SAY.word}`);
  assert.equal(await wrong(1, 'i will kill you'), `live_comment_harm|${SAY.harm}`);
  assert.equal(await wrong(1, 'send nudes'), `live_comment_sexual|${SAY.sexual}`);
  assert.equal(await wrong(1, 'nazi stuff'), `live_comment_hate|${SAY.hate}`);
  assert.equal(await wrong(1, 'go to https://x.com'), `live_comment_spam|${SAY.spam}`);
  assert.equal(await wrong(1, 'call 555 123 4567'), `live_comment_spam|${SAY.spam}`);
  assert.equal(await wrong(1, '   '), `live_comment_size|${SAY.size}`);
  assert.equal(await wrong(1, 'a'.repeat(76) + ' ' + 'b'.repeat(74)), `live_comment_size|${SAY.size}`);
  // Spaces are tidied; the name and photo come from the profile.
  const saved = (await say(1, id, '  hi   there\n friend ')).rows[0];
  assert.equal(saved.body, 'hi there friend');
  assert.equal(saved.name, 'QA 1');
  assert.equal(saved.user_id, users[1]);
  assert.equal(await wrong(1, 'second one'), `live_comment_slow|${SAY.slow}`);
  await older();
  assert.equal(await wrong(1, 'HI there friend'), `live_comment_same|${SAY.same}`);
  assert.equal(await hint(say(1, id, 'something new')), 'ok');
  // 100 per person per live.
  await db.query(`insert into live_comments(live_id,user_id,name,body,created_at)
    select $1, $2, 'QA 1', 'old ' || n, now() - interval '1 hour' from generate_series(1, 98) n`, [id, users[1]]);
  await older();
  assert.equal(await wrong(1, 'one more'), `live_comment_limit|${SAY.limit}`);
  // 30 per live per 10 seconds.
  await db.query(`insert into live_comments(live_id,user_id,name,body) select $1, $2, 'QA 0', 'busy ' || n from generate_series(1, 30) n`, [id, users[0]]);
  assert.equal(await wrong(2, 'hello'), `live_comment_busy|${SAY.busy}`);
  await older();
  // Comments off: only the host can still write.
  await as(0, 'select set_live_comments($1, false)', [id]);
  assert.equal(await wrong(2, 'hello'), `live_comments_off|${SAY.off}`);
  assert.equal(await hint(say(0, id, 'host talking')), 'ok');
  assert.equal(await hint(as(1, 'select set_live_comments($1, true)', [id])), 'live_not_host');
  await as(0, 'select set_live_comments($1, true)', [id]);
  assert.equal(await hint(say(2, id, 'hello')), 'ok');
  // Someone who isn't really there (no ping for 2 minutes), a stranger, and an ended live.
  await stale(id, 2, 120);
  await older();
  assert.equal(await hint(say(2, id, 'still here?')), 'live_not_watching');
  assert.equal(await hint(say(7, id, 'hi')), 'live_not_watching');
  await as(0, 'select end_live($1, 0)', [id]);
  assert.equal(await hint(say(1, id, 'bye')), 'live_not_on');
});

test('Deleting a comment: its writer or the host; the words are kept privately', async () => {
  const id = await goLive(0, [1, 2]);
  const mine = (await say(1, id, 'first comment')).rows[0];
  assert.equal(await hint(as(2, 'select delete_live_comment($1)', [mine.id])), 'live_not_host');
  assert.equal((await one('select body from live_comments where id = $1', [mine.id])).body, 'first comment');
  await as(1, 'select delete_live_comment($1)', [mine.id]);
  const gone = await one('select body, deleted_at from live_comments where id = $1', [mine.id]);
  assert.equal(gone.body, '');
  assert.ok(gone.deleted_at);
  const kept = await one('select body, removed_by, live_id from private.live_removed_comments where comment_id = $1', [mine.id]);
  assert.deepEqual(kept, { body: 'first comment', removed_by: users[1], live_id: id });
  // The host deletes someone else's; deleting again changes nothing.
  const theirs = (await say(2, id, 'rude comment')).rows[0];
  await as(0, 'select delete_live_comment($1)', [theirs.id]);
  await as(0, 'select delete_live_comment($1)', [theirs.id]);
  assert.equal((await one('select removed_by from private.live_removed_comments where comment_id = $1', [theirs.id])).removed_by, users[0]);
  assert.equal(await count("private.live_events where kind = 'comment_deleted'"), 2);
  // The owner in the Table Editor only sets deleted_at: the words are still kept and emptied.
  await db.query("update live_comments set created_at = created_at - interval '5 seconds'");
  const third = (await say(2, id, 'owner removes this')).rows[0];
  await db.query('update live_comments set deleted_at = now() where id = $1', [third.id]);
  assert.equal((await one('select body from live_comments where id = $1', [third.id])).body, '');
  assert.equal((await one('select body from private.live_removed_comments where comment_id = $1', [third.id])).body, 'owner removes this');
});

// ---------------------------------------------------------------------------
// 6. Bringing a friend on
// ---------------------------------------------------------------------------
test('Asking a friend on: only the host, on air, watching, allowed, one at a time, 2 asks, none after a no, 10 a live', async () => {
  // 1 and 4 ready (birthday + rules); 2 has no birthday; 3 a friend who isn't watching; 7 a stranger.
  await ready(0, 1, 4);
  await befriend(0, 1, 2, 3, 4, 5);
  const id = await start(0);
  const ask = (guest, by = 0) => as(by, 'select invite_cohost($1,$2) as id', [id, users[guest]]);
  assert.equal(await hint(ask(1)), 'live_not_on', 'not on air yet');
  await onAir(0, id);
  for (const v of [1, 2, 4, 5]) await join(v, id);
  assert.equal(await hint(ask(1, 4)), 'live_not_host');
  assert.equal(await failure(ask(2)), "QA 2 can't come on right now.");
  assert.equal(await hint(ask(2)), 'live_guest_cant');
  assert.equal(await failure(ask(3)), "QA 3 isn't watching right now.");
  assert.equal(await hint(ask(7)), 'live_not_watching');
  assert.equal(await hint(ask(0)), 'live_not_watching');
  const first = (await ask(1)).rows[0].id;
  assert.equal(await hint(ask(4)), 'live_invite_open');
  // Only the guest sees the ask in their status.
  assert.equal((await status(1, id)).invite.id, first);
  assert.equal((await status(4, id)).invite, null);
  await as(0, 'select cancel_cohost_invite($1)', [id]);
  assert.equal((await one('select answer from live_invites where id = $1', [first])).answer, 'cancelled');
  // A second ask is allowed, then no more.
  const second = (await ask(1)).rows[0].id;
  await db.query("update live_invites set expires_at = now() - interval '1 second' where id = $1", [second]);
  assert.equal(await failure(ask(1)), "You can't ask QA 1 again this live.");
  assert.equal((await one('select answer from live_invites where id = $1', [second])).answer, null, 'the refused call changed nothing');
  // An ask that ran out leaves exactly one more; a "Not now" leaves none, also 5 minutes later.
  const toFour = (await ask(4)).rows[0].id;
  await db.query("update live_invites set expires_at = now() - interval '1 second' where id = $1", [toFour]);
  await db.query("update live_invites set answer = 'expired' where id = any($1)", [[second, toFour]]);
  const again = (await ask(4)).rows[0].id;
  assert.deepEqual((await as(4, 'select answer_cohost_invite($1, false) as r', [again])).rows[0].r, { role: 'viewer' });
  assert.equal((await one('select answer from live_invites where id = $1', [again])).answer, 'declined');
  await db.query("update live_invites set created_at = created_at - interval '5 minutes', answered_at = answered_at - interval '5 minutes'");
  assert.equal(await hint(ask(4)), 'live_invite_wait');
  // At most 10 asks per live.
  await db.query(`insert into live_invites(live_id,host_id,guest_id,created_at,expires_at,answer)
    select $1, $2, $3, now() - interval '1 hour', now() - interval '1 hour', 'expired' from generate_series(1, 6)`, [id, users[0], users[13]]);
  assert.equal(await count('live_invites where live_id = $1', [id]), 10);
  await ready(5);
  assert.equal(await hint(ask(5)), 'live_invite_limit');
});

test('Saying yes: needs birthday, testers and the Live rules (the ask stays open); only newly waiting viewers are checked', async () => {
  // 1 is asked. 3 is not a friend of 1 (will wait); 4 is a friend of both (keeps watching).
  await born(1, 20);
  await befriend(1, 4);
  const id = await goLive(0, [1, 3, 4]);
  const invite = (await as(0, 'select invite_cohost($1,$2) as id', [id, users[1]])).rows[0].id;
  const yes = () => as(1, 'select answer_cohost_invite($1, true) as r', [invite]);
  assert.equal(await hint(as(4, 'select answer_cohost_invite($1, true)', [invite])), 'live_invite_gone', 'only the guest');
  assert.equal(await hint(yes()), 'live_rules');
  assert.equal((await one('select answer from live_invites where id = $1', [invite])).answer, null, 'the ask stays open');
  await rules(1);
  await db.query("update private.live_settings set who_can_go_live = 'testers'");
  await db.query('insert into private.live_testers(user_id) values($1)', [users[0]]);
  assert.equal(await hint(yes()), 'live_testers');
  await db.query("update private.live_settings set who_can_go_live = 'everyone'");
  await clearJobs();
  assert.deepEqual((await yes()).rows[0].r, { role: 'cohost' });
  assert.deepEqual((await yes()).rows[0].r, { role: 'cohost' }, 'a second tap');
  const row = await liveRow(id);
  assert.equal(row.cohost_id, users[1]);
  assert.ok(row.cohost_since);
  assert.equal(row.stage_clean_at, null);
  assert.equal((await presence(id, 1)).was_cohost, true);
  assert.equal(await count("private.live_events where kind = 'cohost_on' and actor = $1", [users[1]]), 1);
  assert.deepEqual(await waiting(), ['check:3'], 'only the viewer who must now wait');
  assert.ok((await presence(id, 3)).left_at, 'they drop out of the list at once');
  assert.equal((await presence(id, 4)).left_at, null);
  // A second co-host can't come on at the same time.
  assert.equal(await hint(as(0, 'select invite_cohost($1,$2)', [id, users[4]])), 'live_has_cohost');
  // "Back to watching": the host takes them off; they are turned back into a viewer.
  await clearJobs();
  assert.equal(await hint(as(4, 'select end_cohost($1)', [id])), 'live_not_host');
  await as(0, 'select end_cohost($1)', [id]);
  assert.equal((await liveRow(id)).cohost_id, null);
  assert.deepEqual(await waiting(), ['demote:1']);
  assert.equal(await count("private.live_events where kind = 'cohost_off' and target = $1", [users[1]]), 1);
  // The former co-host pressing "Leave stage" late changes nothing and doesn't fail.
  assert.equal(await hint(as(1, 'select end_cohost($1)', [id])), 'ok');
});

test('An ask that ran out can\'t be accepted; saying no to it marks it as run out; an unfriended guest can\'t come on', async () => {
  await ready(1);
  const id = await goLive(0, [1]);
  const invite = (await as(0, 'select invite_cohost($1,$2) as id', [id, users[1]])).rows[0].id;
  await db.query("update live_invites set expires_at = now() - interval '1 second' where id = $1", [invite]);
  assert.equal(await hint(as(1, 'select answer_cohost_invite($1, true)', [invite])), 'live_invite_gone');
  assert.deepEqual((await as(1, 'select answer_cohost_invite($1, false) as r', [invite])).rows[0].r, { role: 'viewer' });
  assert.equal((await one('select answer from live_invites where id = $1', [invite])).answer, 'expired');
  const next = (await as(0, 'select invite_cohost($1,$2) as id', [id, users[1]])).rows[0].id;
  await db.query('delete from friendships where requester_id = $1 and addressee_id = $2', [users[0], users[1]]);
  assert.equal(await hint(as(1, 'select answer_cohost_invite($1, true)', [next])), 'live_not_watching');
  assert.equal((await liveRow(id)).cohost_id, null);
  // The live ending expires the open ask.
  await as(0, 'select end_live($1, 0)', [id]);
  assert.equal((await one('select answer from live_invites where id = $1', [next])).answer, 'expired');
  assert.equal(await hint(as(1, 'select answer_cohost_invite($1, true)', [next])), 'live_invite_gone');
});

// ---------------------------------------------------------------------------
// 7. The job list: what to do is decided when a job is picked up
// ---------------------------------------------------------------------------
test('live_jobs_claim decides every case, with back-off, no doubles, give-up and one re-check', async () => {
  // 0 host; 1 viewer; 2 waits (not a friend of the co-host 3); 4 removed; 3 co-host.
  await ready(3);
  await befriend(0, 3);
  await befriend(3, 1);
  const id = await goLive(0, [1, 2, 3, 4]);
  await as(0, 'select remove_live_viewer($1,$2)', [id, users[4]]);
  await putOn(id, 3);
  const { room } = await liveRow(id);
  await clearJobs();
  const add = async (kind, i, live = id, liveRoom = room) => (await one(
    'insert into private.live_jobs(live_id, room, person, kind) values($1,$2,$3,$4) returning id',
    [live, liveRoom, i == null ? null : users[i], kind])).id;
  const jobs = {
    endOn: await add('end'), auditOn: await add('audit'),
    checkViewer: await add('check', 1), checkPaused: await add('check', 2), checkRemoved: await add('check', 4), checkStranger: await add('check', 7),
    demoteCohost: await add('demote', 3), demoteViewer: await add('demote', 1), demotePaused: await add('demote', 2), demoteRemoved: await add('demote', 4),
  };
  const picked = await claim(100);
  const byId = Object.fromEntries(picked.map((p) => [p.job_id, p]));
  const action = (job) => (byId[job] ? `${byId[job].action}${byId[job].soft ? ' soft' : ''}${byId[job].recheck ? ' recheck' : ''}` : 'none');
  assert.deepEqual(Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, action(v)])), {
    endOn: 'none', auditOn: 'audit',
    checkViewer: 'none', checkPaused: 'remove soft recheck', checkRemoved: 'remove recheck', checkStranger: 'remove recheck',
    demoteCohost: 'none', demoteViewer: 'demote', demotePaused: 'remove soft recheck', demoteRemoved: 'remove recheck',
  });
  assert.deepEqual(byId[jobs.checkPaused], { job_id: Number(jobs.checkPaused), action: 'remove', room, identity: users[2], soft: true, recheck: true });
  assert.equal(byId[jobs.auditOn].identity, null);
  // Jobs that needed nothing are done; the others wait for live-admin's answer (and their next try moved back).
  assert.equal((await one('select done_at from private.live_jobs where id = $1', [jobs.endOn])).done_at !== null, true);
  const tried = await one('select tries, extract(epoch from next_try_at - now())::int as wait, done_at from private.live_jobs where id = $1', [jobs.checkPaused]);
  assert.equal(tried.tries, 1);
  assert.ok(tried.wait >= 28 && tried.wait <= 31, `first back-off ${tried.wait}`);
  assert.equal(tried.done_at, null);
  assert.deepEqual(await claim(100), [], 'nothing is picked up twice before its next try');
  // The same waiting job is never added twice.
  await db.query('select private.live_enqueue($1,$2,$3,$4)', [id, room, users[2], 'check']);
  await db.query('select private.live_enqueue($1,$2,$3,$4)', [id, room, users[2], 'check']);
  assert.equal(await count("private.live_jobs where person = $1 and kind = 'check' and tries = 0 and done_at is null", [users[2]]), 1);
  // Answers: done, failed (and given up at the 6th try), "not found" → exactly one re-check 60 seconds later.
  await finish([jobs.auditOn], [{ id: jobs.demoteViewer, error: 'timeout' }, { id: 'nonsense' }], [jobs.checkPaused]);
  assert.equal((await one('select last_error, done_at from private.live_jobs where id = $1', [jobs.demoteViewer])).last_error, 'timeout');
  assert.ok((await one('select done_at from private.live_jobs where id = $1', [jobs.auditOn])).done_at);
  const recheck = await one('select id, kind, person, is_recheck, extract(epoch from next_try_at - now())::int as wait from private.live_jobs where is_recheck');
  assert.equal(recheck.kind, 'check');
  assert.equal(recheck.person, users[2]);
  assert.ok(recheck.wait >= 58 && recheck.wait <= 61);
  await db.query('update private.live_jobs set next_try_at = now() where id = $1', [recheck.id]);
  const again = (await claim(100)).find((p) => p.job_id === Number(recheck.id));
  assert.deepEqual([again.action, again.soft, again.recheck], ['remove', true, false], 'a re-check never asks for another');
  await finish([], [], [recheck.id]);
  assert.equal(await count('private.live_jobs where is_recheck'), 1);
  await db.query('update private.live_jobs set tries = 6, next_try_at = now() where id = $1', [jobs.demoteRemoved]);
  await finish([], [{ id: jobs.demoteRemoved, error: 'unauthenticated' }]);
  const gaveUp = await one('select done_at, last_error from private.live_jobs where id = $1', [jobs.demoteRemoved]);
  assert.ok(gaveUp.done_at);
  assert.equal(gaveUp.last_error, 'gave up: unauthenticated');
  assert.equal(await count("private.live_events where kind = 'gave_up'"), 1);
  // A job picked up 6 times with no answer at all is given up when it comes round again.
  await db.query('update private.live_jobs set tries = 6, next_try_at = now() where id = $1', [jobs.demoteViewer]);
  assert.equal((await claim(100)).some((p) => p.job_id === Number(jobs.demoteViewer)), false);
  assert.match((await one('select last_error from private.live_jobs where id = $1', [jobs.demoteViewer])).last_error, /^gave up: timeout/);
  // max_jobs is respected.
  const extra = [await add('check', 5), await add('check', 6), await add('check', 7)];
  await claim(2);
  assert.equal(await count('private.live_jobs where id = any($1) and tries = 1', [extra]), 2);
});

test('live_jobs_claim after the end: end → close the room; checks and audits only while the room is watched', async () => {
  const id = await goLive(0, [1]);
  const { room } = await liveRow(id);
  await as(0, 'select end_live($1, 0)', [id]);
  await clearJobs();
  const add = async (kind, i) => (await one('insert into private.live_jobs(live_id, room, person, kind) values($1,$2,$3,$4) returning id',
    [id, room, i == null ? null : users[i], kind])).id;
  const end = await add('end');
  const audit = await add('audit');
  const check = await add('check', 1);
  const demote = await add('demote', 1);
  let byId = Object.fromEntries((await claim()).map((p) => [p.job_id, p]));
  assert.equal(byId[end].action, 'end_room');
  assert.equal(byId[audit].action, 'audit');
  assert.deepEqual([byId[check].action, byId[check].soft, byId[check].recheck], ['remove', false, true]);
  assert.equal(byId[demote], undefined);
  // Once the room isn't watched any more, nothing is left to do for audits and checks.
  await db.query("update private.live_watch_rooms set until = now() - interval '1 second'");
  const audit2 = await add('audit');
  const check2 = await add('check', 1);
  byId = Object.fromEntries((await claim()).map((p) => [p.job_id, p]));
  assert.equal(byId[audit2], undefined);
  assert.equal(byId[check2], undefined);
  // A deleted live's room is closed too.
  const gone = await start(0);
  const goneRoom = (await liveRow(gone)).room;
  await clearJobs();
  await db.query('delete from lives where id = $1', [gone]);
  assert.deepEqual(await waiting(), ['end:-']);
  byId = Object.fromEntries((await claim()).map((p) => [p.job_id, p]));
  assert.deepEqual(Object.values(byId).map((p) => [p.action, p.room]), [['end_room', goneRoom]]);
});

// ---------------------------------------------------------------------------
// 8. Triggers: unfriend, block, ban, account deletion, the owner's end
// ---------------------------------------------------------------------------
test('Unfriend and block take people out; a block between two viewers does nothing; one wake-up per transaction', async () => {
  // 1, 2 viewers; 3 co-host (friends with 2 only); 4 a viewer friend of both.
  await ready(3);
  await befriend(3, 2, 4);
  const id = await goLive(0, [1, 2, 3, 4]);
  await putOn(id, 3);
  await clearJobs();
  await db.exec('truncate net.sent restart identity');
  // Unfriend (as the app does it: deleting the friendship as the viewer).
  await as(2, 'delete from friendships where requester_id = $1 and addressee_id = $2', [users[0], users[2]]);
  assert.deepEqual(await waiting(), ['check:2']);
  assert.ok((await presence(id, 2)).left_at);
  const posts = await adminPosts();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].headers['x-live-key'], (await one("select secret from vault.secrets where name = 'live_admin_key'")).secret);
  // A block between the co-host and a viewer (no friendship with the host is touched).
  await clearJobs();
  await block(4, 3);
  assert.deepEqual(await waiting(), ['check:4']);
  assert.equal(await access(id, 4), 'paused');
  // A block between two viewers changes nothing.
  await clearJobs();
  await befriend(0, 5, 6);
  await join(5, id);
  await block(5, 1);
  assert.deepEqual(await waiting(), []);
  // block_user by the host: one transaction, one wake-up, however many jobs.
  await clearJobs();
  await db.exec('truncate net.sent restart identity');
  await as(0, 'select block_user($1)', [users[3]]);
  assert.deepEqual((await waiting()).sort(), ['check:3', 'demote:3']);
  assert.equal((await liveRow(id)).cohost_id, null, 'host and co-host blocked: the co-host comes off');
  assert.equal((await adminPosts()).length, 1);
});

test('A ban ends their live at once, or takes them out of others; the ban can never fail', async () => {
  const id = await goLive(0, [1]);
  const other = await goLive(2, [1]);
  await clearJobs();
  await ban(1);
  assert.deepEqual((await waiting()).sort(), ['check:1', 'check:1']);
  assert.ok((await presence(id, 1)).left_at);
  await ban(0);
  const row = await liveRow(id);
  assert.equal(row.ended_reason, 'safety');
  assert.ok((await waiting()).includes('end:-'));
  assert.equal((await liveRow(other)).ended_at, null);
});

test('Host account deletion: the row goes, the room is closed and watched, a copy is kept (90 days with an under-18 viewer)', async () => {
  await born(1, 15);
  await born(2, 30);
  const id = await goLive(0, [1, 2]);
  await say(1, id, 'hello host');
  const { room } = await liveRow(id);
  await clearJobs();
  await db.query('delete from auth.users where id = $1', [users[0]]);
  assert.equal(await count('lives where id = $1', [id]), 0);
  assert.deepEqual(await waiting(), ['end:-']);
  assert.ok((await one('select until > now() + interval \'19 minutes\' as ok from private.live_watch_rooms where room = $1', [room])).ok);
  const copy = await one("select reason, report_id, extract(day from keep_until - now())::int as days, snapshot from private.live_snapshots where live_id = $1", [id]);
  assert.equal(copy.reason, 'host_deleted');
  assert.equal(copy.report_id, null);
  assert.ok(copy.days >= 89, `kept ${copy.days} days`);
  assert.equal(copy.snapshot.live.host_id, users[0]);
  assert.equal(copy.snapshot.live.host_username, 'qa_user_0');
  assert.equal(copy.snapshot.live.host_age_group, 'adult');
  assert.deepEqual(copy.snapshot.viewers.map((v) => [v.user_id, v.age_group]).sort(), [[users[1], 'teen'], [users[2], 'adult']].sort());
  assert.deepEqual(copy.snapshot.comments.map((c) => c.body), ['hello host']);
  assert.ok(copy.snapshot.events.some((e) => e.kind === 'start'));
  // Only adults watching (or an under-18 host): 30 days.
  const adultsOnly = await goLive(3, [2]);
  await db.query('delete from auth.users where id = $1', [users[3]]);
  assert.ok((await one('select extract(day from keep_until - now())::int as d from private.live_snapshots where live_id = $1', [adultsOnly])).d <= 30);
  await befriend(4, 1);
  await ready(4);
  await born(4, 16);
  const teenHost = await start(4);
  await onAir(4, teenHost);
  await join(1, teenHost);
  await db.query('delete from auth.users where id = $1', [users[4]]);
  assert.ok((await one('select extract(day from keep_until - now())::int as d from private.live_snapshots where live_id = $1', [teenHost])).d <= 30);
  // No viewers: no copy.
  const empty = await goLive(5);
  await db.query('delete from auth.users where id = $1', [users[5]]);
  assert.equal(await count('private.live_snapshots where live_id = $1', [empty]), 0);
});

test('Co-host account deletion → demote → taken out for good; the owner ends a live by typing now()', async () => {
  await ready(3);
  await befriend(3, 1);
  const id = await goLive(0, [1, 3]);
  await putOn(id, 3);
  await clearJobs();
  await db.query('delete from auth.users where id = $1', [users[3]]);
  const row = await liveRow(id);
  assert.equal(row.cohost_id, null);
  assert.equal(row.cohost_since, null);
  const jobs = await db.query('select kind, person from private.live_jobs where done_at is null order by id');
  assert.ok(jobs.rows.some((r) => r.kind === 'demote' && r.person === users[3]), JSON.stringify(jobs.rows));
  const picked = (await claim()).filter((p) => p.identity === users[3]);
  assert.ok(picked.length >= 1);
  assert.ok(picked.every((p) => p.action === 'remove' && !p.soft));
  // The owner ends the live in the Table Editor: the reason fills itself in and the room is closed.
  await clearJobs();
  const invite = await db.query("insert into live_invites(live_id,host_id,guest_id,expires_at) values($1,$2,$3,now() + interval '1 minute') returning id", [id, users[0], users[1]]);
  await db.query('update lives set ended_at = now() where id = $1', [id]);
  const ended = await liveRow(id);
  assert.equal(ended.ended_reason, 'owner');
  assert.deepEqual(await waiting(), ['end:-']);
  assert.equal((await one('select answer from live_invites where id = $1', [invite.rows[0].id])).answer, 'expired');
  assert.ok((await presence(id, 1)).left_at, 'everyone counts as gone');
  assert.equal(await count("private.live_events where kind = 'end' and live_id = $1", [id]), 1);
});

test('A broken live helper can never stop a block, an unfriend, a decline, a ban or an account deletion; no live, no work', async () => {
  const id = await goLive(0, [1, 2, 3, 4]);
  await befriend(0, 5);
  await db.exec(`
    create or replace function private.live_enqueue(live uuid, room_name text, who uuid, job_kind text)
    returns void language plpgsql as $$ begin raise exception 'broken on purpose'; end; $$;
    create or replace function private.live_pair_changed(a uuid, b uuid)
    returns void language plpgsql as $$ begin raise exception 'broken on purpose'; end; $$;`);
  try {
    assert.equal(await hint(as(0, 'select block_user($1)', [users[1]])), 'ok');
    assert.equal(await count('blocks where blocker_id = $1', [users[0]]), 1);
    assert.equal(await hint(as(2, 'delete from friendships where requester_id = $1 and addressee_id = $2', [users[0], users[2]])), 'ok');
    assert.equal(await count('friendships where addressee_id = $1', [users[2]]), 0);
    await db.query("insert into friendships(requester_id,addressee_id,status) values($1,$2,'pending')", [users[6], users[0]]);
    const request = (await one('select id from friendships where requester_id = $1', [users[6]])).id;
    assert.equal(await hint(as(0, 'select respond_to_friend_request($1, false)', [request])), 'ok');
    assert.equal(await count('friendships where id = $1', [request]), 0);
    assert.equal(await hint(ban(3)), 'ok');
    assert.equal(await hint(db.query('delete from auth.users where id = $1', [users[4]])), 'ok');
    assert.equal(await count('profiles where id = $1', [users[4]]), 0);
    assert.equal(await hint(ban(0)), 'ok');
  } finally {
    await db.exec(await migrationSql(MIGRATION));
  }
  // With no live on, the triggers do nothing at all.
  await db.query("update lives set ended_at = now() where ended_at is null");
  await clearJobs();
  await db.exec('truncate net.sent restart identity');
  await db.query('update auth.users set banned_until = null');
  await befriend(7, 8, 9);
  await as(7, 'select block_user($1)', [users[8]]);
  await as(9, 'delete from friendships where requester_id = $1 and addressee_id = $2', [users[7], users[9]]);
  await ban(7);
  await db.query('delete from auth.users where id = $1', [users[9]]);
  assert.deepEqual(await waiting(), []);
  assert.equal(await count('net.sent'), 0);
  assert.ok(id);
});

test('Kick paths reach people whose phones stopped pinging, and drop them from the counts', async () => {
  const id = await goLive(0, [1, 2]);
  // 1's phone hasn't pinged for 5 minutes (and the minute check hasn't run yet).
  await stale(id, 1, 300);
  await clearJobs();
  await as(1, 'delete from friendships where requester_id = $1 and addressee_id = $2', [users[0], users[1]]);
  assert.deepEqual(await waiting(), ['check:1']);
  assert.ok((await presence(id, 1)).left_at);
});

// ---------------------------------------------------------------------------
// 9. The minute check
// ---------------------------------------------------------------------------
test('The minute check ends lives for each reason', async () => {
  await db.query('update private.live_settings set max_live_now = 50');
  for (const i of [0, 2, 4, 6, 8, 10, 12]) await ready(i);
  await befriend(0, 1); await befriend(2, 3); await befriend(4, 5); await befriend(6, 7);
  await befriend(8, 9); await befriend(10, 11); await befriend(12, 13);
  const time = await goLive(0); await db.query("update lives set ends_at = now() - interval '1 second' where id = $1", [time]);
  const gone = await goLive(2); await db.query("update lives set host_seen_at = now() - interval '91 seconds' where id = $1", [gone]);
  const neverOn = await start(4); await db.query("update lives set started_at = now() - interval '121 seconds' where id = $1", [neverOn]);
  const empty = await goLive(6); await db.query("update lives set last_viewer_at = now() - interval '301 seconds' where id = $1", [empty]);
  const watched = await goLive(8, [9]); await db.query("update lives set last_viewer_at = now() - interval '301 seconds' where id = $1", [watched]);
  const stopped = await goLive(10); await db.query('insert into private.live_restrictions(user_id) values($1)', [users[10]]);
  const fine = await goLive(12);
  await sweep();
  const reason = async (id) => (await liveRow(id)).ended_reason;
  assert.deepEqual([await reason(time), await reason(gone), await reason(neverOn), await reason(empty), await reason(watched), await reason(stopped), await reason(fine)],
    ['time', 'host_gone', 'host_gone', 'empty', null, 'safety', null]);
  // The owner switches lives off: running lives end within a minute.
  await db.query("update private.live_settings set who_can_go_live = 'nobody'");
  await sweep();
  assert.equal(await reason(fine), 'owner');
  assert.equal(await reason(watched), 'owner');
});

test('The minute check: stale and stopped co-hosts come off, people who left are marked, asks expire, checks and audits are queued', async () => {
  await ready(3, 5);
  await befriend(0, 3, 5);
  await befriend(3, 1);
  const id = await goLive(0, [1, 2, 3]);
  await putOn(id, 3);
  const other = await goLive(4, []);
  await clearJobs();
  // A co-host who stopped pinging.
  await stale(id, 3, 91);
  await stale(id, 1, 95);
  const invite = await db.query("insert into live_invites(live_id,host_id,guest_id,expires_at) values($1,$2,$3,now() - interval '1 second') returning id", [other, users[4], users[13]]);
  await sweep();
  assert.equal((await liveRow(id)).cohost_id, null);
  assert.ok((await waiting()).includes('demote:3'));
  const left = await presence(id, 1);
  assert.equal(left.left_at.getTime(), left.last_seen_at.getTime(), 'left when they were last seen');
  assert.equal((await one('select answer from live_invites where id = $1', [invite.rows[0].id])).answer, 'expired');
  // One audit per live on air, and one per watched room.
  const audits = (await db.query("select live_id from private.live_jobs where kind = 'audit' and done_at is null")).rows.map((r) => r.live_id).sort();
  assert.deepEqual(audits, [id, other].sort());
  await sweep();
  assert.equal(await count("private.live_jobs where kind = 'audit' and done_at is null"), 2, 'no doubles while waiting');
  await db.query("insert into private.live_watch_rooms(room, live_id, until) values('live_old', gen_random_uuid(), now() + interval '5 minutes')");
  await clearJobs();
  await sweep();
  assert.equal(await count("private.live_jobs where kind = 'audit' and room = 'live_old' and done_at is null"), 1);
  // A co-host stopped by the owner comes off within a minute.
  await join(5, id);
  await putOn(id, 5);
  await clearJobs();
  await db.query('insert into private.live_restrictions(user_id) values($1)', [users[5]]);
  assert.equal(await access(id, 5), 'viewer');
  await sweep();
  assert.equal((await liveRow(id)).cohost_id, null);
  assert.ok((await waiting()).includes('demote:5'));
  // Someone active in the last 2 minutes who may not watch any more is checked again; older rows aren't.
  await clearJobs();
  await join(2, id);
  await db.query('delete from friendships where requester_id = $1 and addressee_id = $2', [users[0], users[2]]);
  await clearJobs();
  await sweep();
  assert.ok((await waiting()).includes('check:2'));
  await clearJobs();
  await stale(id, 2, 180);
  await sweep();
  assert.ok(!(await waiting()).includes('check:2'));
  // Something due wakes live-admin.
  await db.exec('truncate net.sent restart identity');
  await sweep();
  assert.equal((await adminPosts()).length, 1);
});

test('The minute check cleans up after the right times', async () => {
  const id = await goLive(0, [1]);
  const comment = (await say(1, id, 'old comment')).rows[0];
  await as(0, 'select end_live($1, 0)', [id]);
  await db.query("update lives set ended_at = now() - interval '25 hours' where id = $1", [id]);
  await db.exec(`
    insert into private.live_events(live_id, at, kind) values (gen_random_uuid(), now() - interval '31 days', 'old');
    insert into private.live_removed_comments(comment_id, live_id, user_id, body, created_at, removed_at)
      values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'x', now(), now() - interval '31 days');
    insert into private.live_snapshots(live_id, reason, keep_until, snapshot) values (gen_random_uuid(), 'report', now() - interval '1 second', '{}');
    insert into private.live_snapshots(live_id, reason, keep_until, snapshot) values (gen_random_uuid(), 'report', now() + interval '1 day', '{}');
    insert into private.live_token_log(account, at, ok) values (gen_random_uuid(), now() - interval '25 hours', true);
    insert into private.live_watch_rooms(room, live_id, until) values ('live_gone', gen_random_uuid(), now() - interval '25 hours');
    insert into private.live_jobs(live_id, room, kind, done_at) values (gen_random_uuid(), 'live_x', 'end', now() - interval '8 days');`);
  await sweep();
  assert.equal(await count('live_comments where id = $1', [comment.id]), 0, 'comments go 24 hours after the end');
  assert.equal(await count('lives where id = $1', [id]), 1, 'the live itself stays 30 days');
  assert.equal(await count("private.live_events where kind = 'old'"), 0);
  assert.equal(await count("private.live_removed_comments where body = 'x'"), 0);
  assert.equal(await count('private.live_snapshots'), 1);
  assert.equal(await count("private.live_watch_rooms where room = 'live_gone'"), 0);
  assert.equal(await count("private.live_jobs where room = 'live_x'"), 0);
  assert.equal(await count("private.live_token_log where at < now() - interval '1 day'"), 0);
  // 30 days after the end the live goes, without a "host deleted" copy or a watched room.
  await db.query("update lives set ended_at = now() - interval '31 days' where id = $1", [id]);
  await db.query('delete from private.live_watch_rooms');
  await sweep();
  assert.equal(await count('lives where id = $1', [id]), 0);
  assert.equal(await count('live_viewers where live_id = $1', [id]), 0);
  assert.equal(await count("private.live_snapshots where reason = 'host_deleted'"), 0);
  assert.equal(await count('private.live_watch_rooms'), 0);
});

// ---------------------------------------------------------------------------
// 10. The audit
// ---------------------------------------------------------------------------
test('live_audit: who must go (soft or hard), who counts as here; an ended room empties and stays watched', async () => {
  // 1 viewer; 2 waits (not a friend of co-host 3); 4 removed; 5 a friend who never got a pass; 6 a viewer sending video.
  await ready(3);
  await befriend(0, 3, 5);
  await befriend(3, 1, 5, 6);
  const id = await goLive(0, [1, 2, 3, 4, 6]);
  await as(0, 'select remove_live_viewer($1,$2)', [id, users[4]]);
  await putOn(id, 3);
  const { room } = await liveRow(id);
  await stale(id, 1, 200);
  await db.query('update live_viewers set left_at = last_seen_at where live_id = $1 and user_id = $2', [id, users[1]]);
  await db.query("update lives set last_viewer_at = now() - interval '4 minutes' where id = $1", [id]);
  const listed = [users[0], users[1], users[2], users[3], users[4], users[5], users[6], users[7], 'not-a-uuid'];
  const result = (await server('select live_audit($1,$2,$3) as r', [room, listed, [users[0], users[3], users[6]]])).rows[0].r;
  assert.deepEqual(result, {
    remove: [
      { identity: users[2], soft: true },
      { identity: users[4], soft: false },
      { identity: users[6], soft: true },
      { identity: users[7], soft: false },
      { identity: 'not-a-uuid', soft: false },
    ],
    delete_room: false,
  });
  const back = await presence(id, 1);
  assert.equal(back.left_at, null, 'a phone whose pings fail still counts while LiveKit has it in the room');
  assert.ok(Date.now() - back.last_seen_at.getTime() < 5000);
  assert.equal(back.watch_seconds, 0, 'the audit adds no watching time');
  assert.equal(await count('live_viewers where live_id = $1 and user_id = $2', [id, users[5]]), 0, 'never makes a presence row');
  assert.ok(Date.now() - (await liveRow(id)).last_viewer_at.getTime() < 5000);
  // After the end: everyone goes for good, the room is closed and watched 15 more minutes.
  await as(0, 'select end_live($1, 0)', [id]);
  await db.query("update private.live_watch_rooms set until = now() + interval '1 minute' where room = $1", [room]);
  const ended = (await server('select live_audit($1,$2,$3) as r', [room, [users[0], users[1]], [users[0]]])).rows[0].r;
  assert.deepEqual(ended, { remove: [{ identity: users[0], soft: false }, { identity: users[1], soft: false }], delete_room: true });
  assert.ok((await one("select until > now() + interval '14 minutes' as ok from private.live_watch_rooms where room = $1", [room])).ok);
  assert.deepEqual((await server('select live_audit($1,$2,$3) as r', [room, [], []])).rows[0].r, { remove: [], delete_room: false });
  // A room that was never a live.
  assert.deepEqual((await server('select live_audit($1,$2,$3) as r', ['live_nothing', ['x'], []])).rows[0].r,
    { remove: [{ identity: 'x', soft: false }], delete_room: true });
});

// ---------------------------------------------------------------------------
// 11. Passes (live_join), the stage check
// ---------------------------------------------------------------------------
test('live_join: what each role gets, full, removed, waiting, and every request counted (31st in 10 minutes is busy)', async () => {
  await db.query('update private.live_settings set max_viewers = 2');
  await befriend(0, 1, 2, 3, 4);
  const id = await goLive(0);
  const { room } = await liveRow(id);
  const host = await join(0, id);
  assert.deepEqual(host, { ok: true, role: 'host', room, max_participants: 4, create_room: true, ttl: 600, stage_check: false, cohost_since: null });
  const viewer = await join(1, id);
  assert.deepEqual(viewer, { ok: true, role: 'viewer', room, max_participants: 4, create_room: false, ttl: 60, stage_check: false, cohost_since: null });
  await join(2, id);
  assert.deepEqual(await join(3, id), { ok: false, reason: 'full' });
  assert.equal((await join(1, id)).ok, true, 'someone already watching can always come back');
  assert.deepEqual(await join(7, id), { ok: false, reason: 'not_allowed' });
  await as(0, 'select remove_live_viewer($1,$2)', [id, users[2]]);
  assert.deepEqual(await join(2, id), { ok: false, reason: 'removed' });
  // A rejoin keeps the first join time, the removal and the watching time.
  await db.query("update live_viewers set first_joined_at = now() - interval '10 minutes', watch_seconds = 42 where live_id = $1 and user_id = $2", [id, users[1]]);
  await join(1, id);
  const row = await presence(id, 1);
  assert.equal(row.watch_seconds, 42);
  assert.ok(Date.now() - row.first_joined_at.getTime() > 9 * 60000);
  // A co-host's first pass needs a clean stage; later ones in the same turn don't.
  await ready(4);
  await join(4, id);
  await putOn(id, 4);
  const cohost = await join(4, id);
  assert.equal(cohost.role, 'cohost');
  assert.equal(cohost.ttl, 600);
  assert.equal(cohost.stage_check, true);
  assert.equal(cohost.cohost_since, (await one("select to_jsonb(cohost_since) #>> '{}' as s from lives where id = $1", [id])).s);
  assert.equal((await server('select live_stage_clean($1,$2) as ok', [id, cohost.cohost_since])).rows[0].ok, true);
  assert.equal((await join(4, id)).stage_check, false);
  assert.equal((await server("select live_stage_clean($1, now() - interval '1 hour') as ok", [id])).rows[0].ok, false, 'an old turn');
  // Join events are written at most once a minute per person.
  assert.equal(await count("private.live_events where kind = 'join' and actor = $1", [users[1]]), 1);
  // 30 requests per person per 10 minutes, refused ones included.
  await db.query('update lives set cohost_id = null where id = $1', [id]);
  await db.query('delete from private.live_token_log');
  for (let n = 0; n < 15; n++) await join(7, id);
  for (let n = 0; n < 15; n++) await join(1, id);
  assert.deepEqual(await join(7, id), { ok: false, reason: 'not_allowed' }, 'each person has their own count');
  // Refused requests count too: a stranger asking again and again is stopped at 30 as well.
  for (let n = 0; n < 14; n++) assert.deepEqual(await join(7, id), { ok: false, reason: 'not_allowed' });
  assert.deepEqual(await join(7, id), { ok: false, reason: 'busy' }, 'the 31st request in 10 minutes');
  assert.equal(await count('private.live_token_log where account = $1 and ok', [users[7]]), 0);
  await db.query('delete from private.live_token_log');
  for (let n = 0; n < 30; n++) await join(1, id);
  assert.deepEqual(await join(1, id), { ok: false, reason: 'busy' });
  assert.equal(await count('private.live_token_log where account = $1', [users[1]]), 31);
  assert.equal(await count('private.live_token_log where account = $1 and not ok', [users[1]]), 1);
});

test('The stage check: who must go first (waiting people softly), and whether a fresh pass could still come in', async () => {
  await ready(3);
  await befriend(0, 3, 5);
  await befriend(3, 1);
  const id = await goLive(0, [1, 2, 3]);
  await putOn(id, 3);
  const check = async (listed) => (await server('select live_stage_check($1,$2) as r', [id, listed])).rows[0].r;
  // 2 waits (not a friend of 3) and is in the room; 7 is a stranger.
  assert.deepEqual(await check([users[0], users[1], users[2], users[3], users[7]]),
    { remove: [{ identity: users[2], soft: true }, { identity: users[7], soft: false }], wait: false });
  // 2 got a pass less than a minute ago and isn't in the room yet: wait.
  assert.deepEqual(await check([users[0], users[3]]), { remove: [], wait: true });
  await stale(id, 2, 61);
  assert.deepEqual(await check([users[0], users[3]]), { remove: [], wait: false });
});

// ---------------------------------------------------------------------------
// 12. Status, pings, the list, leaving, the end
// ---------------------------------------------------------------------------
test('live_status / live_ping: what each person may see; waiting and removed people never see who is on', async () => {
  // 1 waits (not a friend of 3); 2 is removed; 4 a friend of both; 5 and 6 are friends of both but blocked with
  // the co-host (one each way), so they wait too.
  await ready(3);
  await befriend(0, 3, 5, 6);
  await befriend(3, 4, 5, 6);
  await block(5, 3);
  await block(3, 6);
  const id = await goLive(0, [1, 2, 4, 5, 6]);
  await join(3, id);
  await as(0, 'select remove_live_viewer($1,$2)', [id, users[2]]);
  await putOn(id, 3);
  await join(3, id);
  const host = await status(0, id);
  assert.equal(host.status, 'live');
  assert.equal(host.role, 'host');
  assert.equal(host.host.username, 'qa_user_0');
  assert.equal(host.cohost.id, users[3]);
  assert.equal(host.viewers, 1, 'only 4: not the co-host, not the waiting or removed');
  assert.equal(host.ended_reason, null);
  assert.equal(host.empty_ends_at, null);
  const fine = await status(4, id);
  assert.deepEqual([fine.status, fine.role, fine.cohost.username, fine.viewers], ['live', 'viewer', 'qa_user_3', 1]);
  for (const [i, state] of [[1, 'paused'], [2, 'removed'], [5, 'paused'], [6, 'paused']]) {
    const s = await status(i, id);
    assert.deepEqual([s.status, s.role, s.cohost, s.viewers, s.invite, s.ended_reason], [state, null, null, 0, null, null], `user ${i}`);
    assert.equal(s.host.id, users[0]);
  }
  assert.deepEqual(await status(7, id), { status: 'not_allowed', role: null, live_id: id });
  // Only friends who may watch see it on Home.
  const home = async (i) => (await as(i, 'select live_id, host_username, host_name, cohost_username from friends_live_now()')).rows;
  assert.deepEqual(await home(4), [{ live_id: id, host_username: 'qa_user_0', host_name: 'QA 0', cohost_username: 'qa_user_3' }]);
  for (const i of [1, 5, 6]) assert.deepEqual(await home(i), [], 'a waiting viewer never learns who is on');
  assert.deepEqual(await home(0), [], 'not my own');
  await db.query('insert into friend_settings(user_id, friend_id, mute_stories) values($1,$2,true)', [users[4], users[0]]);
  assert.deepEqual(await home(4), [], 'hidden stories hide the live too');
  // Pings: only someone who may watch is refreshed.
  await stale(id, 1, 40);
  await stale(id, 4, 40);
  await ping(1, id);
  await ping(4, id);
  assert.ok(Date.now() - (await presence(id, 1)).last_seen_at.getTime() > 30000, 'a waiting viewer is not refreshed');
  const pinged = await presence(id, 4);
  assert.ok(Date.now() - pinged.last_seen_at.getTime() < 5000);
  assert.ok(pinged.watch_seconds >= 39 && pinged.watch_seconds <= 41);
  await ping(4, id);
  assert.equal((await presence(id, 4)).watch_seconds, pinged.watch_seconds, 'pings closer than 10 seconds are skipped');
  await db.query("update lives set host_seen_at = now() - interval '60 seconds' where id = $1", [id]);
  await ping(0, id);
  assert.ok(Date.now() - (await liveRow(id)).host_seen_at.getTime() < 5000);
  assert.equal(await count('live_viewers where live_id = $1 and user_id = $2', [id, users[7]]), 0);
  await ping(7, id);
  assert.equal(await count('live_viewers where live_id = $1 and user_id = $2', [id, users[7]]), 0, 'a ping never makes a row');
  // The end: only the host learns why.
  await db.query("update lives set ended_at = now(), ended_reason = 'reports' where id = $1", [id]);
  assert.equal((await status(0, id)).ended_reason, 'reports');
  assert.equal((await status(0, id)).status, 'ended');
  const viewerEnd = await status(4, id);
  assert.deepEqual([viewerEnd.status, viewerEnd.ended_reason, viewerEnd.cohost], ['ended', null, null]);
});

test('The host alone sees who is watching, with who can be asked on; the host sees when an empty live will end', async () => {
  await ready(1);
  await befriend(1, 2);
  const id = await goLive(0, [1, 2, 3]);
  const list = async (i) => (await as(i, 'select user_id, is_cohost, can_cohost from live_viewers_list($1)', [id])).rows
    .map((r) => [who(r.user_id), r.is_cohost, r.can_cohost]);
  assert.deepEqual(await list(0), [[1, false, true], [2, false, false], [3, false, false]]);
  assert.deepEqual(await list(1), []);
  await putOn(id, 1);
  assert.deepEqual(await list(0), [[1, true, false], [2, false, false]], '3 waits now and is not listed');
  assert.deepEqual(await list(1), [], 'the co-host only gets the count');
  await stale(id, 2, 80);
  assert.deepEqual(await list(0), [[1, true, false]], 'gone quiet');
  // Nobody watching: the host's status says when the live will end by itself.
  const quiet = await goLive(5);
  const s = await status(5, quiet);
  const row = await liveRow(quiet);
  assert.equal(new Date(s.empty_ends_at).getTime(), row.last_viewer_at.getTime() + 5 * 60000);
});

test('Leaving, ending (with the numbers), and the person brought on leaving', async () => {
  await ready(1);
  await befriend(1, 2);
  const id = await goLive(0, [1, 2]);
  await putOn(id, 1);
  await say(2, id, 'nice');
  await as(1, 'select leave_live($1)', [id]);
  assert.equal((await liveRow(id)).cohost_id, null);
  assert.ok((await presence(id, 1)).left_at);
  await as(2, 'select leave_live($1)', [id]);
  assert.ok((await presence(id, 2)).left_at);
  await db.query("update lives set on_air_at = now() - interval '10 minutes' where id = $1", [id]);
  assert.equal(await hint(as(1, 'select end_live($1, 5)', [id])), 'live_not_host');
  const summary = (await as(0, 'select end_live($1, 5000000) as s', [id])).rows[0].s;
  assert.equal(summary.ended_reason, 'host');
  assert.equal(summary.viewers, 2);
  assert.equal(summary.comments, 1);
  assert.equal(summary.hearts, 1000000);
  assert.ok(summary.seconds >= 599 && summary.seconds <= 601);
  const again = (await as(0, 'select end_live($1, 3) as s', [id])).rows[0].s;
  assert.equal(again.hearts, 1000000, 'safe to repeat; hearts only while open');
  // Ending in the last 5 seconds counts as "time".
  const late = await start(0);
  await db.query("update lives set ends_at = now() + interval '3 seconds' where id = $1", [late]);
  assert.equal((await as(0, 'select end_live($1, -4) as s', [late])).rows[0].s.ended_reason, 'time');
  assert.equal((await liveRow(late)).hearts, 0);
});

test('remove_live_viewer only for someone who was there; also_block blocks them', async () => {
  const id = await goLive(0, [1]);
  await befriend(0, 2);
  assert.equal(await hint(as(0, 'select remove_live_viewer($1,$2)', [id, users[2]])), 'live_not_watching');
  assert.equal(await count('live_viewers where live_id = $1 and user_id = $2', [id, users[2]]), 0, 'nobody is planted');
  assert.equal(await hint(as(1, 'select remove_live_viewer($1,$2)', [id, users[0]])), 'live_not_host');
  await clearJobs();
  await as(0, 'select remove_live_viewer($1,$2,true)', [id, users[1]]);
  assert.ok((await presence(id, 1)).removed_at);
  assert.equal(await count('blocks where blocker_id = $1 and blocked_id = $2', [users[0], users[1]]), 1);
  assert.deepEqual(await waiting(), ['check:1']);
  assert.equal(await count("private.live_events where kind = 'remove' and target = $1", [users[1]]), 1);
});

test('Removed, waiting and just-unfriended people still inside the 75 seconds can\'t comment, aren\'t refreshed, aren\'t listed', async () => {
  await ready(3);
  await befriend(0, 3);
  const id = await goLive(0, [1, 2, 4]);
  await join(3, id);
  await as(0, 'select remove_live_viewer($1,$2)', [id, users[1]]);
  await db.query('update live_viewers set left_at = null where live_id = $1', [id]);
  await db.query('delete from friendships where requester_id = $1 and addressee_id = $2', [users[0], users[4]]);
  await db.query('update live_viewers set left_at = null where live_id = $1', [id]);
  await putOn(id, 3);
  await db.query('update live_viewers set left_at = null where live_id = $1', [id]);
  for (const i of [1, 2, 4]) {
    assert.ok(await one('select private.connected($1,$2) as c', [id, users[i]]).then((r) => r.c), `${i} still inside 75 s`);
    assert.equal(await hint(say(i, id, 'hello')), 'live_not_watching', `user ${i}`);
    await stale(id, i, 20);
    const before = (await presence(id, i)).last_seen_at.getTime();
    await ping(i, id);
    assert.equal((await presence(id, i)).last_seen_at.getTime(), before, `user ${i} not refreshed`);
  }
  assert.deepEqual((await as(0, 'select user_id from live_viewers_list($1)', [id])).rows.map((r) => who(r.user_id)), [3]);
});

// ---------------------------------------------------------------------------
// 13. Notifications
// ---------------------------------------------------------------------------
test('"is live" goes only to phones with the new app of friends who may watch, with the switch on; never at start; every 2 hours', async () => {
  await db.query('update private.live_settings set lives_per_day = 10');
  await befriend(0, 1, 2, 3, 4, 5);
  const token = (i, name, canLive = true) => db.query('insert into push_tokens(token,user_id,platform,can_live) values($1,$2,$3,$4)', [name, users[i], 'ios', canLive]);
  await token(1, 'ExponentPushToken[one]');
  await token(1, 'ExponentPushToken[one-old]', false);
  await token(2, 'ExponentPushToken[two]');
  await db.query('insert into notification_prefs(user_id, lives) values($1,false)', [users[2]]);
  await token(3, 'ExponentPushToken[three]');
  await db.query('insert into friend_settings(user_id, friend_id, mute_stories) values($1,$2,true)', [users[3], users[0]]);
  await token(4, 'ExponentPushToken[four]');
  await ban(4);
  await token(5, 'ExponentPushToken[five]');
  await block(5, 0);
  await befriend(7, 8);
  await token(7, 'ExponentPushToken[stranger]');
  await ready(0);
  const id = await start(0);
  assert.deepEqual(await pushes(), [], 'nothing at start');
  await onAir(0, id);
  assert.deepEqual(await pushes(), [[{
    to: 'ExponentPushToken[one]', title: '🔴 QA 0 is live', body: 'Tap to watch',
    data: { type: 'live', live: id, host: users[0] }, sound: 'default', channelId: 'default',
  }]]);
  await onAir(0, id);
  assert.equal((await pushes()).length, 1, 'safe to repeat');
  // The next live within 2 hours: no notification. App Review accounts (no_limits) skip the wait.
  await as(0, 'select end_live($1, 0)', [id]);
  const second = await start(0);
  await onAir(0, second);
  assert.equal((await pushes()).length, 1);
  await as(0, 'select end_live($1, 0)', [second]);
  await db.query('insert into private.live_testers(user_id, no_limits) values($1, true)', [users[0]]);
  const third = await start(0);
  await onAir(0, third);
  assert.equal((await pushes()).length, 2);
  await as(0, 'select end_live($1, 0)', [third]);
  await db.query('delete from private.live_testers');
  await db.query("update lives set pushed_at = pushed_at - interval '3 hours'");
  const fourth = await start(0);
  await onAir(0, fourth);
  assert.equal((await pushes()).length, 3);
});

test('Notifications go out 100 per request, and a failing request never stops going live', async () => {
  await befriend(0, 1);
  await db.query(`insert into push_tokens(token,user_id,platform,can_live)
    select 'ExponentPushToken[' || lpad(n::text, 3, '0') || ']', $1, 'ios', true from generate_series(1, 150) n`, [users[1]]);
  const id = await goLive(0);
  const sent = await pushes();
  assert.deepEqual(sent.map((b) => b.length), [100, 50]);
  assert.equal(new Set(sent.flat().map((m) => m.to)).size, 150);
  // pg_net down: going live still works.
  await as(0, 'select end_live($1, 0)', [id]);
  await db.query("update lives set pushed_at = null");
  const next = await start(0);
  await asUser(db, users[0], async (tx) => {
    await tx.query("select set_config('test.push_failure', 'on', true)");
    await tx.query('select live_on_air($1)', [next]);
  });
  assert.ok((await liveRow(next)).on_air_at);
});

test('set_push_capability changes only your own phone; register_push_token keeps one signature', async () => {
  await db.query("insert into push_tokens(token,user_id,platform) values('mine',$1,'ios'),('theirs',$2,'ios')", [users[0], users[1]]);
  await as(0, "select set_push_capability('mine', true)");
  await as(0, "select set_push_capability('theirs', true)");
  assert.deepEqual((await db.query('select token, can_live from push_tokens order by token')).rows, [
    { token: 'mine', can_live: true }, { token: 'theirs', can_live: false }]);
  await as(0, "select register_push_token('mine','ios',60)");
  assert.equal((await one("select can_live from push_tokens where token = 'mine'")).can_live, true, 'registering again keeps it');
  await as(0, "select set_push_capability('mine', false)");
  assert.equal((await one("select can_live from push_tokens where token = 'mine'")).can_live, false);
  assert.equal(await count("pg_proc where proname = 'register_push_token'"), 1);
});

test('The owner\'s teen check fires once when an adult\'s live has 5 under-18 viewers', async () => {
  await db.query('insert into private.report_alert_people(user_id) values($1)', [users[13]]);
  await db.query("insert into push_tokens(token,user_id,platform) values('owner-phone',$1,'ios')", [users[13]]);
  for (const i of [1, 2, 3, 4, 5, 6]) await born(i, 15);
  await befriend(0, 5, 6);
  const id = await goLive(0, [1, 2, 3, 4]);
  const alerts = async () => (await pushes()).filter((b) => b[0].title === '👀 Live check');
  assert.deepEqual(await alerts(), []);
  await join(5, id);
  const sent = await alerts();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0][0], { to: 'owner-phone', title: '👀 Live check', body: "An adult's live has 5 or more under-18 viewers",
    data: { type: 'report' }, sound: 'default', channelId: 'default' });
  assert.ok((await liveRow(id)).teen_alert_at);
  await join(6, id);
  assert.equal((await alerts()).length, 1, 'once per live');
  // An under-18 host's live never sends it.
  await ready(7);
  await born(7, 16);
  await befriend(7, 1, 2, 3, 4, 5);
  await db.query('update lives set ended_at = now() where host_id = $1', [users[0]]);
  const teenLive = await start(7);
  await onAir(7, teenLive);
  for (const i of [1, 2, 3, 4, 5]) await join(i, teenLive);
  assert.equal((await alerts()).length, 1);
});

// ---------------------------------------------------------------------------
// 14. Reports
// ---------------------------------------------------------------------------
test('Reports: only people who were there, for 24 hours; the co-host can be chosen; comment words go in the report while it is up', async () => {
  await ready(3);
  await befriend(0, 3, 5);
  await befriend(3, 1, 2, 4);
  const id = await goLive(0, [1, 2, 3, 4]);
  await putOn(id, 3);
  // (Here the reports must not end the live: that is tested below.)
  await db.query('update private.live_settings set report_end_count = 5');
  const report = (i, type, contentId, reported, details = null) => as(i,
    "insert into reports(reporter_id,reported_user_id,content_type,content_id,reason,details) values($1,$2,$3,$4,'bullying',$5) returning reported_user_id, details",
    [users[i], reported, type, contentId, details]);
  // A stranger, and a friend who never watched: refused.
  assert.match(await failure(report(7, 'live', id, users[0])), /can't be reported/);
  assert.match(await failure(report(5, 'live', id, users[0])), /can't be reported/);
  // The host, the co-host by choice, or the host when the choice wasn't on the stage.
  assert.equal((await report(1, 'live', id, users[0])).rows[0].reported_user_id, users[0]);
  assert.equal((await report(1, 'live', id, users[3])).rows[0].reported_user_id, users[3]);
  assert.equal((await report(4, 'live', id, users[2])).rows[0].reported_user_id, users[0]);
  // The same report again (here: 1 choosing someone who wasn't on, which means the host again) is quietly
  // skipped, and so is a report about yourself.
  assert.equal((await report(1, 'live', id, users[2])).rows.length, 0);
  assert.equal((await report(0, 'live', id, users[0])).rows.length, 0, 'the host reporting their own live');
  assert.equal(await count("reports where content_type = 'live'"), 3);
  // Each report keeps a frozen copy for 90 days.
  const copy = await one("select reason, extract(day from keep_until - now())::int as days, snapshot from private.live_snapshots where report_id is not null order by id limit 1");
  assert.equal(copy.reason, 'report');
  assert.ok(copy.days >= 89);
  assert.equal(copy.snapshot.live.cohost_id, users[3]);
  // A comment: the words go into the report while it is up. After a delete they don't (the reporter can read
  // their report back), but the owner still has them in the report's private copy.
  const c1 = (await say(2, id, 'mean words')).rows[0];
  assert.equal((await report(1, 'live_comment', c1.id, null, 'please look')).rows[0].details, 'Comment: "mean words"\nplease look');
  await as(2, 'select delete_live_comment($1)', [c1.id]);
  const after = (await report(4, 'live_comment', c1.id, null, 'it was mean')).rows[0];
  assert.equal(after.details, 'it was mean');
  assert.equal(after.reported_user_id, users[2]);
  assert.equal((await as(4, "select details from reports where reporter_id = $1 and content_type = 'live_comment'", [users[4]])).rows[0].details, 'it was mean');
  const kept = await one(`select x.snapshot from private.live_snapshots x join reports r on r.id = x.report_id
    where r.reporter_id = $1 and r.content_type = 'live_comment'`, [users[4]]);
  assert.equal(kept.snapshot.reported_comment.body, 'mean words');
  assert.equal(kept.snapshot.reported_comment.id, c1.id);
  // Someone who joins after a comment was deleted can't read its words through their own report either.
  await befriend(0, 6);
  await befriend(3, 6);
  assert.equal((await join(6, id)).ok, true);
  const late = (await report(6, 'live_comment', c1.id, null)).rows[0];
  assert.equal(late.details, null);
  assert.ok(!JSON.stringify((await as(6, 'select * from reports where reporter_id = $1', [users[6]])).rows).includes('mean words'));
  // 24 hours after the end: too late.
  await as(0, 'select end_live($1, 0)', [id]);
  assert.equal(await hint(report(2, 'live', id, users[0])), 'ok', 'still fine right after the end');
  await db.query("update lives set ended_at = now() - interval '25 hours' where id = $1", [id]);
  assert.match(await failure(report(4, 'live', id, users[0])), /can't be reported/);
  // The public chat lines still work.
  assert.match((await one("select pg_get_functiondef('private.prepare_report()'::regprocedure) as d")).d, /in_public_chat/);
});

test('Two reporters end the live and stop the host for 24 hours (never shortening the owner\'s stop); two hide a comment', async () => {
  await ready(3);
  await befriend(0, 3);
  await befriend(3, 1, 2);
  const id = await goLive(0, [1, 2, 3]);
  await putOn(id, 3);
  const report = (i, type, contentId, reported) => as(i,
    "insert into reports(reporter_id,reported_user_id,content_type,content_id,reason) values($1,$2,$3,$4,'bullying')",
    [users[i], reported, type, contentId]);
  // The co-host: two different reporters take them off (the same person twice counts once: the second time adds
  // no report and no copy).
  await report(1, 'live', id, users[3]);
  const copies = await count('private.live_snapshots');
  assert.equal((await report(1, 'live', id, users[3])).affectedRows ?? 0, 0);
  assert.equal(await count('private.live_snapshots'), copies);
  assert.equal(await count("reports where content_type = 'live' and reporter_id = $1", [users[1]]), 1);
  assert.equal((await liveRow(id)).cohost_id, users[3]);
  await report(2, 'live', id, users[3]);
  assert.equal((await liveRow(id)).cohost_id, null);
  const stop = await one('select reason, extract(epoch from until - now())::int as secs from private.live_restrictions where user_id = $1', [users[3]]);
  assert.equal(stop.reason, 'reports');
  assert.ok(stop.secs > 23.9 * 3600 && stop.secs <= 24 * 3600);
  // The owner's stops are never shortened or renamed.
  await db.query("insert into private.live_restrictions(user_id, until, reason) values($1, null, 'owner')", [users[0]]);
  await report(1, 'live', id, users[0]);
  await report(2, 'live', id, users[0]);
  const ended = await liveRow(id);
  assert.equal(ended.ended_reason, 'reports');
  assert.deepEqual(await one('select until, reason from private.live_restrictions where user_id = $1', [users[0]]), { until: null, reason: 'owner' });
  assert.equal((await status(0, id)).ended_reason, 'reports');
  assert.equal((await status(1, id)).ended_reason, null, 'viewers never learn why');
  // A later stop set by the owner stays later.
  const second = await goLive(5, [1, 2]);
  await db.query("insert into private.live_restrictions(user_id, until, reason) values($1, now() + interval '7 days', 'owner')", [users[5]]);
  await report(1, 'live', second, users[5]);
  await report(2, 'live', second, users[5]);
  const kept = await one("select reason, until > now() + interval '6 days' as later from private.live_restrictions where user_id = $1", [users[5]]);
  assert.deepEqual(kept, { reason: 'owner', later: true });
  // A comment reported by two people is hidden; its words are kept.
  const third = await goLive(6, [1, 2, 4]);
  const c = (await say(4, third, 'hurtful words')).rows[0];
  await report(1, 'live_comment', c.id, null);
  assert.equal((await one('select deleted_at from live_comments where id = $1', [c.id])).deleted_at, null);
  await report(2, 'live_comment', c.id, null);
  assert.equal((await one('select body from live_comments where id = $1', [c.id])).body, '');
  assert.deepEqual(await one('select body, removed_by from private.live_removed_comments where comment_id = $1', [c.id]),
    { body: 'hurtful words', removed_by: null }, 'the reports hid it; nobody deleted it');
  assert.equal(await count("private.live_restrictions where user_id = $1", [users[4]]), 0, 'a comment stops nobody');
});

test('Reports from people the reported person removed or blocked are kept but never count towards the automatic stop', async () => {
  const report = (i, id, reported) => as(i,
    "insert into reports(reporter_id,reported_user_id,content_type,content_id,reason) values($1,$2,'live',$3,'bullying')",
    [users[i], reported, id]);
  const votes = async (id) => (await db.query('select reporter_id, counts from private.live_report_votes where live_id = $1 order by created_at, reporter_id', [id]))
    .rows.map((r) => `${who(r.reporter_id)}:${r.counts}`);
  // A host removes and blocks two people, who then both report her: her live goes on and she isn't stopped,
  // but both reports and their copies are kept for the owner.
  const first = await goLive(0, [1, 2, 3]);
  await as(0, 'select remove_live_viewer($1,$2,true)', [first, users[1]]);
  await as(0, 'select remove_live_viewer($1,$2,true)', [first, users[2]]);
  await report(1, first, users[0]);
  await report(2, first, users[0]);
  assert.equal((await liveRow(first)).ended_at, null);
  assert.equal(await count('private.live_restrictions where user_id = $1', [users[0]]), 0);
  assert.equal(await count("reports where content_type = 'live' and content_id = $1", [first]), 2);
  assert.equal(await count('private.live_snapshots where live_id = $1', [first]), 2);
  assert.deepEqual((await votes(first)).sort(), ['1:false', '2:false']);
  // Someone who reports and THEN blocks the host (as the app suggests) still counts.
  const second = await goLive(4, [5, 6]);
  await report(5, second, users[4]);
  await block(5, 4);
  await report(6, second, users[4]);
  assert.equal((await liveRow(second)).ended_reason, 'reports');
  // A report made before the host removed and blocked its writer still counts (decided when it was filed).
  const third = await goLive(7, [8, 9]);
  await report(8, third, users[7]);
  await as(7, 'select remove_live_viewer($1,$2,true)', [third, users[8]]);
  await report(9, third, users[7]);
  assert.equal((await liveRow(third)).ended_reason, 'reports');
  assert.deepEqual(await votes(third), ['8:true', '9:true']);
  // A comment: its writer blocking a reporter takes that reporter's vote away too.
  const fourth = await goLive(10, [11, 12, 13]);
  const c = (await say(11, fourth, 'hello there')).rows[0];
  await block(11, 12);
  await as(12, "insert into reports(reporter_id,content_type,content_id,reason) values($1,'live_comment',$2,'bullying')", [users[12], c.id]);
  await as(13, "insert into reports(reporter_id,content_type,content_id,reason) values($1,'live_comment',$2,'bullying')", [users[13], c.id]);
  assert.equal((await one('select deleted_at from live_comments where id = $1', [c.id])).deleted_at, null);
});

test('Reports about the person brought on count only from people who could see them', async () => {
  // 3 is on with host 0. 1 and 2 are friends of both (3 then blocks them). 4 and 5 are only the host's friends
  // (they wait while 3 is on). 6 and 8 are friends of both and really watched.
  await ready(3);
  await befriend(0, 3);
  await befriend(3, 1, 2, 6, 8);
  const id = await goLive(0, [1, 2, 3, 4, 5, 6, 8]);
  await putOn(id, 3);
  const report = (i) => as(i,
    "insert into reports(reporter_id,reported_user_id,content_type,content_id,reason) values($1,$2,'live',$3,'bullying')",
    [users[i], users[3], id]);
  await block(3, 1);
  await block(3, 2);
  await report(1);
  await report(2);
  assert.equal((await liveRow(id)).cohost_id, users[3], 'people she blocked can\'t take her off');
  await report(4);
  await report(5);
  assert.equal((await liveRow(id)).cohost_id, users[3], 'people waiting (not her friends) never saw her');
  assert.equal(await count('private.live_restrictions'), 0);
  await report(6);
  await report(8);
  assert.equal((await liveRow(id)).cohost_id, null);
  assert.equal((await one('select reason from private.live_restrictions where user_id = $1', [users[3]])).reason, 'reports');
  assert.equal(await count("reports where content_type = 'live'"), 6, 'every report is kept');
});

test('Reports: more than 20 about one live from one person get a friendly no; reports aren\'t among the copy\'s 100 events', async () => {
  await db.query('update private.live_settings set report_end_count = 20');
  const id = await goLive(0, [1, 2]);
  const comments = [];
  for (let n = 0; n < 21; n++) {
    await db.query("update live_comments set created_at = created_at - interval '5 seconds' where user_id = $1", [users[2]]);
    comments.push((await say(2, id, `comment number ${n}`)).rows[0].id);
  }
  for (let n = 0; n < 20; n++) {
    await as(1, "insert into reports(reporter_id,content_type,content_id,reason) values($1,'live_comment',$2,'spam')", [users[1], comments[n]]);
  }
  assert.match(await failure(as(1, "insert into reports(reporter_id,content_type,content_id,reason) values($1,'live_comment',$2,'spam')", [users[1], comments[20]])),
    /a lot of reports for this live/);
  const copy = (await one('select snapshot from private.live_snapshots order by id desc limit 1')).snapshot;
  assert.equal(copy.report_count, 19, 'the reports before this one (the copy is made first)');
  assert.equal(copy.events.filter((e) => e.kind === 'report').length, 0);
  assert.ok(copy.events.some((e) => e.kind === 'start'));
});

test('Starting: at most 10 starts an hour per person (testers too), counting starts that never went on air', async () => {
  await ready(0);
  await befriend(0, 13);
  await db.query('insert into private.live_testers(user_id, no_limits) values($1, true)', [users[0]]);
  for (let n = 0; n < 10; n++) await start(0);
  assert.equal(await hint(as(0, 'select start_live($1)', [users[0]])), 'live_busy');
  assert.equal(await count('lives where host_id = $1', [users[0]]), 10);
  await db.query("update lives set started_at = started_at - interval '61 minutes' where host_id = $1", [users[0]]);
  assert.equal(await hint(as(0, 'select start_live($1)', [users[0]])), 'ok');
});

test('Testers are never added by a name someone else could take; @ayaan only while he is the owner\'s friend', async () => {
  const OWNER = 'df5aae76-7e6a-4e91-9645-5b897a533156';
  await db.query('insert into auth.users(id,email,raw_user_meta_data) values ($1,$2,$3)', [OWNER, 'owner@example.invalid', { username: 'owner_test', display_name: 'Owner' }]);
  const named = async (name) => {
    const id = `00000000-0000-4000-9000-${String(name.length).padStart(12, '0')}`;
    await db.query('insert into auth.users(id,email,raw_user_meta_data) values ($1,$2,$3)', [id, `${name}@example.invalid`, { username: name, display_name: name }]);
    assert.equal((await one('select username from profiles where id = $1', [id])).username, name);
    return id;
  };
  const ayaan = await named('ayaan');
  const review = await named('peekaboo_review');
  const review2 = await named('peekaboo_review2');
  await db.query('delete from private.live_testers');
  await db.exec(await migrationSql(MIGRATION));
  const testers = async () => (await db.query('select user_id from private.live_testers')).rows.map((r) => r.user_id).sort();
  assert.deepEqual(await testers(), [OWNER]);
  await friend(db, OWNER, ayaan);
  await db.exec(await migrationSql(MIGRATION));
  assert.deepEqual(await testers(), [OWNER, ayaan].sort());
  assert.ok(!(await testers()).includes(review) && !(await testers()).includes(review2));
});

test('A friend coming on has its own pass allowance: "Getting the stage ready…" retries never stop them watching', async () => {
  await ready(3);
  await befriend(0, 3);
  const id = await goLive(0, [3]);
  // 3 already used 29 of the 30 passes for watching.
  await db.query('insert into private.live_token_log(account, ok) select $1, true from generate_series(1, 28)', [users[3]]);
  await putOn(id, 3);
  // While the stage isn't ready yet, the app asks every 2 seconds for up to 70 seconds (35 times).
  for (let n = 0; n < 35; n++) {
    const pass = await join(3, id);
    assert.equal(pass.role, 'cohost', `stage request ${n + 1}`);
    assert.equal(pass.stage_check, true);
  }
  assert.equal(await count('private.live_token_log where account = $1 and stage', [users[3]]), 35);
  // It didn't work out: back to watching, with the watching allowance untouched.
  await as(3, 'select end_cohost($1)', [id]);
  assert.equal((await join(3, id)).role, 'viewer');
  assert.deepEqual(await join(3, id), { ok: false, reason: 'busy' }, 'the 31st watching pass');
  // The stage allowance has its own limit too (80 in 10 minutes).
  await db.query('delete from private.live_token_log');
  await putOn(id, 3);
  await db.query('insert into private.live_token_log(account, ok, stage) select $1, true, true from generate_series(1, 80)', [users[3]]);
  assert.deepEqual(await join(3, id), { ok: false, reason: 'busy' });
});

test('live_stage_allowlist: only the person on stage gets it – the host, them, and everyone who may watch them', async () => {
  // 3 is on with host 0. 1 and 2 are friends of both; 4 only the host's friend (waits, last seen 5 minutes
  // ago); 5 was removed.
  await ready(3);
  await befriend(0, 3);
  await befriend(3, 1, 2, 5);
  const id = await goLive(0, [1, 2, 3, 4, 5]);
  await as(0, 'select remove_live_viewer($1,$2)', [id, users[5]]);
  await stale(id, 4, 300);
  await putOn(id, 3);
  const list = async (i) => (await as(i, 'select live_stage_allowlist($1) as l', [id])).rows[0].l;
  assert.deepEqual(await list(3), [users[0], users[3], ...[users[1], users[2]].sort()]);
  for (const other of [0, 1, 4, 5, 7]) assert.deepEqual(await list(other), [], `user ${other} gets nothing`);
  // 3 blocks 2: 2 drops off the list.
  await block(3, 2);
  assert.deepEqual(await list(3), [users[0], users[3], users[1]]);
  // Taken off the stage: an empty list (nobody may see them any more).
  await as(0, 'select end_cohost($1)', [id]);
  assert.deepEqual(await list(3), []);
  assert.match(await failure(asUser(db, null, (tx) => tx.query('select live_stage_allowlist($1)', [id]), 'anon')), /permission denied/);
});

test('An ended live whose room was never closed (a step that failed) is closed and watched by the minute check', async () => {
  const id = await goLive(0, [1, 2]);
  await db.query('update lives set ended_at = now() where id = $1', [id]);
  // Pretend the end's own steps were lost.
  await db.query("delete from private.live_jobs where live_id = $1 and kind = 'end'", [id]);
  await db.query('delete from private.live_watch_rooms where live_id = $1', [id]);
  await db.query('update live_viewers set left_at = null where live_id = $1', [id]);
  await clearJobs();
  await sweep();
  assert.ok((await waiting()).includes('end:-'));
  assert.equal(await count('private.live_watch_rooms where live_id = $1', [id]), 1);
  assert.equal(await count('live_viewers where live_id = $1 and left_at is null', [id]), 0);
  // One step of the end failing never undoes the others: the room is still closed and watched.
  const second = await goLive(5, [6]);
  const keep = (await one("select pg_get_functiondef('private.live_log(uuid,text,uuid,uuid,jsonb)'::regprocedure) as d")).d;
  await db.exec(`create or replace function private.live_log(live uuid, what text, by_whom uuid, about uuid, extra jsonb default null)
    returns void language plpgsql security definer set search_path = '' as $$ begin raise exception 'broken on purpose'; end; $$;`);
  try {
    await as(5, 'select end_live($1, 0)', [second]);
  } finally {
    await db.exec(keep);
  }
  assert.ok((await liveRow(second)).ended_at);
  assert.ok((await waiting()).includes('end:-'));
  assert.equal(await count('private.live_watch_rooms where live_id = $1', [second]), 1);
  assert.equal(await count('live_viewers where live_id = $1 and left_at is null', [second]), 0);
});

// ---------------------------------------------------------------------------
// 15. Older one-tap friendships of under-18s
// ---------------------------------------------------------------------------
test('Older one-tap adds of an under-18 are listed once and left out of that under-18\'s lives and notifications', async () => {
  // 0 an under-18 host. 1 an adult who added 0 in one tap (before launch safety). 2 an adult whose request 0
  // accepted. 3 an under-18 who added 0 in one tap (two under-18s: not listed).
  for (const [i, years] of [[0, 16], [1, 30], [2, 30], [3, 15]]) await born(i, years);
  await friend(db, users[1], users[0]);
  await db.query("insert into friendships(requester_id,addressee_id,status,created_at) values($1,$2,'pending',now() - interval '1 hour')", [users[2], users[0]]);
  await db.query("update friendships set status = 'accepted', accepted_at = now() where requester_id = $1", [users[2]]);
  await friend(db, users[3], users[0]);
  // The list is filled when the table is first made.
  await db.exec('drop table private.live_unconfirmed_friends');
  await db.exec(await migrationSql(MIGRATION));
  assert.deepEqual((await db.query('select teen, other from private.live_unconfirmed_friends')).rows, [{ teen: users[0], other: users[1] }]);
  await rules(0);
  await db.query("insert into push_tokens(token,user_id,platform,can_live) values('one',$1,'ios',true),('two',$2,'ios',true)", [users[1], users[2]]);
  const id = await start(0);
  await onAir(0, id);
  assert.equal(await access(id, 1), 'not_allowed');
  assert.deepEqual(await join(1, id), { ok: false, reason: 'not_allowed' });
  assert.equal(await access(id, 2), 'viewer');
  assert.equal(await access(id, 3), 'viewer');
  assert.deepEqual((await pushes()).flat().map((m) => m.to), ['two']);
  // An adult host's lives are not affected: 1 can still be watched by 0.
  await ready(1);
  await db.query('update lives set ended_at = now() where id = $1', [id]);
  const adultLive = await start(1);
  assert.equal(await access(adultLive, 0), 'viewer');
  // The owner gives one back by deleting its row; running the file again doesn't bring it back.
  await db.query('delete from private.live_unconfirmed_friends');
  await db.exec(await migrationSql(MIGRATION));
  assert.equal(await count('private.live_unconfirmed_friends'), 0);
  assert.equal(await access(id, 1), 'ended');
});

// ---------------------------------------------------------------------------
// 16. The owner's secrets check
// ---------------------------------------------------------------------------
test('live_selftest queues an audit of a made-up room and wakes live-admin; it is for the owner only', async () => {
  await db.query('select private.live_selftest()');
  const picked = await claim();
  assert.deepEqual(picked.map((p) => [p.action, p.room, p.identity]), [['audit', 'live_selftest', null]]);
  assert.equal((await adminPosts()).length, 1);
  assert.deepEqual((await server('select live_audit($1,$2,$3) as r', ['live_selftest', [], []])).rows[0].r, { remove: [], delete_room: false });
  assert.match(await failure(as(0, 'select private.live_selftest()')), /permission denied/);
  for (const fn of ['live_join(uuid,uuid)', 'live_jobs_claim(integer)', 'live_audit(text,text[],text[])', 'live_admin_key_ok(text)']) {
    assert.match(await failure(as(0, `select public.${fn.replace(/\(.*\)/, '')}(${fn.includes('uuid,uuid') ? 'null::uuid, null::uuid' : fn.includes('integer') ? '1' : fn.includes('text[]') ? "'x', '{}'::text[], '{}'::text[]" : "'x'"})`)), /permission denied/, fn);
  }
  const secret = (await one("select secret from vault.secrets where name = 'live_admin_key'")).secret;
  assert.equal((await server('select live_admin_key_ok($1) as ok', [secret])).rows[0].ok, true);
  assert.equal((await server("select live_admin_key_ok('wrong') as ok")).rows[0].ok, false);
  assert.equal((await server("select live_admin_key_ok('') as ok")).rows[0].ok, false);
});
