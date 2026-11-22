// Messages and stickers in the public chat (supabase/migrations/20270102000000_public_chat_text.sql).
// Runs all migrations in a local, in-memory PostgreSQL (PGlite) with invented users.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { asUser, createLocalDatabase, seedUsers } from './local-db.mjs';

const MIGRATION = new URL('../../supabase/migrations/20270102000000_public_chat_text.sql', import.meta.url);
const { cases, messages } = JSON.parse(readFileSync('tests/support/public-text-cases.json', 'utf8'));

let db;
let users;
before(async () => { db = await createLocalDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('truncate auth.users cascade; truncate storage.objects, net.sent, private.public_chat_report_copies restart identity;');
  users = await seedUsers(db, 6);
});

const rpc = (i, sql, args = []) => asUser(db, users[i], (tx) => tx.query(sql, args));
const outcome = (run) => run.then(() => 'ok', (error) => `${error.code}: ${error.message}${error.hint ? ` [${error.hint}]` : ''}`);
const born = (i, years) => db.query(
  "insert into age_checks(user_id,birthday,blocked) values($1, (current_date - make_interval(years => $2))::date, $2 < 18)", [users[i], years]);
const say = (i, body) => rpc(i, 'insert into public_messages(body) values($1) returning *', [body]);
const stick = (i, sticker) => rpc(i, "insert into public_messages(kind,sticker) values('sticker',$1) returning *", [sticker]);
const photo = (i) => rpc(i, 'insert into public_photos(media_path) values($1) returning *', [`${users[i]}/public/${randomUUID()}.jpg`]);
const seen = async (i) => (await rpc(i, 'select id from public_messages order by created_at')).rows.map((r) => r.id);
// Jump over slow mode: make this person's messages, photos and the private list of when they posted (which slow
// mode counts) look a minute older.
const wait = async (i) => {
  await db.query("update public_messages set created_at = created_at - interval '1 minute' where sender_id = $1", [users[i]]);
  await db.query("update public_photos set created_at = created_at - interval '1 minute' where sender_id = $1", [users[i]]);
  await db.query("update private.public_chat_sends set sent_at = sent_at - interval '1 minute' where sender_id = $1", [users[i]]);
};
const sends = async (i, kind) => (await db.query('select count(*)::int as n from private.public_chat_sends where sender_id = $1 and kind = $2', [users[i], kind])).rows[0].n;
const setName = (i, column, value) => db.query(`update profiles set ${column} = $2 where id = $1`, [users[i], value]);
const givePlus = (i, days) => db.query("insert into plus_members(user_id,expires_at) values($1, now() + make_interval(days => $2)) on conflict (user_id) do update set expires_at = excluded.expires_at", [users[i], days]);
const report = (i, id, reason = 'spam', details = null) => rpc(i,
  "insert into reports(reporter_id,content_type,content_id,reason,details) values($1,'public_message',$2,$3,$4)", [users[i], id, reason, details]);

test('Only people 18 and over: no birthday and under 18 can\'t see or send; the server fills in who and when', async () => {
  await born(0, 25); await born(1, 19); await born(2, 16); // users[3] has no birthday
  const hi = (await say(0, 'hey everyone 👋')).rows[0];
  assert.equal(hi.sender_id, users[0]);
  assert.equal(hi.kind, 'text');
  assert.equal(hi.hidden, false);
  assert.deepEqual(await seen(1), [hi.id]);
  assert.deepEqual(await seen(2), []);
  assert.deepEqual(await seen(3), []);
  assert.match(await outcome(say(2, 'hi')), /only for people 18 and over \[public_chat_adults\]/);
  assert.match(await outcome(say(3, 'hi')), /only for people 18 and over/);
  assert.match(await outcome(stick(2, 'googly-eyes')), /only for people 18 and over/);
  // You can't send as someone else, back-date, pre-hide or change a message afterwards.
  assert.match(await outcome(rpc(1, 'insert into public_messages(sender_id,body) values($1,$2)', [users[0], 'x'])), /permission denied/);
  assert.match(await outcome(rpc(1, 'insert into public_messages(body,hidden) values($1,true)', ['x'])), /permission denied/);
  assert.match(await outcome(rpc(1, "insert into public_messages(body,created_at) values('x', now() - interval '1 day')")), /permission denied/);
  assert.match(await outcome(rpc(0, "update public_messages set body = 'changed' where id = $1", [hi.id])), /permission denied/);
  // Visitors who aren't logged in get nothing.
  assert.match(await outcome(asUser(db, null, (tx) => tx.query('select * from public_messages'), 'anon')), /permission denied/);
});

test('Messages are 1 to 300 characters, tidied by the server; a sticker is only a name', async () => {
  await born(0, 25);
  const tidy = (await say(0, '  hi   there\n\n\nyou  ')).rows[0];
  assert.equal(tidy.body, 'hi there you');
  await wait(0);
  assert.match(await outcome(say(0, '   \n\t ')), /1 to 300 characters\. \[public_chat_size\]/);
  assert.match(await outcome(say(0, 'a'.repeat(301))), /1 to 300 characters/);
  assert.match(await outcome(say(0, 'a'.repeat(5000))), /1 to 300 characters/);
  // 300 emoji are 300 characters (the server counts characters, not bytes).
  assert.equal(await outcome(say(0, '😂'.repeat(300))), 'ok');
  await wait(0);
  // Spaces don't count: 300 letters with lots of spaces around them is fine.
  assert.equal(await outcome(say(0, `   ${'b'.repeat(300)}   `)), 'ok');
  await wait(0);
  assert.match(await outcome(rpc(0, "insert into public_messages(kind,sticker,body) values('sticker','googly-eyes','visit my site')")), /public_messages_shape/);
  assert.match(await outcome(rpc(0, "insert into public_messages(kind,body,sticker) values('text','hi','googly-eyes')")), /public_messages_shape/);
  assert.match(await outcome(stick(0, 'Not A Sticker!')), /public_messages_shape/);
  assert.match(await outcome(rpc(0, "insert into public_messages(kind,body) values('photo','hi')")), /public_messages_shape/);
  const sticker = (await stick(0, 'word-slay')).rows[0];
  assert.equal(sticker.kind, 'sticker');
  assert.equal(sticker.body, null);
});

test('Whole messages: the same tidying and the same answers as the app (shared cases)', async () => {
  await born(0, 25);
  const hints = { size: 'public_chat_size', marks: 'public_chat_marks', word: 'public_chat_word', link: 'public_chat_link', phone: 'public_chat_phone' };
  for (const [typed, problem, saved] of messages) {
    const label = JSON.stringify(typed.slice(0, 40));
    assert.equal((await db.query('select private.public_message_problem($1) as p', [typed])).rows[0].p, problem, label);
    const result = await say(0, typed).then((r) => r.rows[0], (error) => error);
    if (problem === null) {
      assert.equal(result.body, saved, label);
      assert.equal((await db.query('select private.public_text_tidy($1) as t', [typed])).rows[0].t, saved, label);
      await wait(0);
    } else {
      assert.equal(result.hint, hints[problem], `${label}: ${result.message}`);
    }
  }
  // A right-to-left character can't turn reversed text back into a link on screen: it is never saved.
  const saved = (await db.query("select count(*)::int as n from public_messages where body ~ '[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C\u2028\u2029]'")).rows[0].n;
  assert.equal(saved, 0);
});

test('Slurs are blocked (swearing is allowed), and so are links and phone numbers', async () => {
  await born(0, 25);
  assert.match(await outcome(say(0, 'you n1gg3r')), /^23514: That word isn't allowed on Peekaboo\. \[public_chat_word\]$/);
  assert.equal(await outcome(say(0, 'this is fucking great')), 'ok');
  await wait(0);
  assert.match(await outcome(say(0, 'go to example.com')), /^23514: Links aren't allowed in the public chat\. \[public_chat_link\]$/);
  assert.match(await outcome(say(0, 'text me 555 123 4567')), /^23514: Phone numbers aren't allowed in the public chat\. \[public_chat_phone\]$/);
  // The same cases as the app (tests/unit/public-text.test.mjs).
  for (const [text, expected] of cases) {
    assert.equal((await db.query('select private.public_text_problem($1) as p', [text])).rows[0].p, expected, text);
    const result = await outcome(say(0, text));
    if (expected === null) assert.equal(result, 'ok', text);
    else assert.match(result, expected === 'link' ? /Links aren't allowed/ : /Phone numbers aren't allowed/, text);
    await wait(0);
  }
});

test('Peekaboo+ stickers need Peekaboo+ right now; free stickers are for everyone in the room', async () => {
  await born(0, 25); await born(1, 25);
  assert.equal(await outcome(stick(0, 'googly-eyes')), 'ok');
  await wait(0);
  assert.match(await outcome(stick(0, 'plus-slay')), /part of Peekaboo\+ ⭐ \[plus_required\]/);
  await givePlus(1, 30);
  assert.equal(await outcome(stick(1, 'plus-slay')), 'ok');
  await wait(1);
  await givePlus(1, -1);
  assert.match(await outcome(stick(1, 'plus-slay')), /Peekaboo\+/);
});

test('Slow mode: one message or sticker every 5 seconds, 300 a day; photos have their own', async () => {
  await born(0, 25);
  assert.equal(await outcome(say(0, 'one')), 'ok');
  assert.match(await outcome(say(0, 'two')), /^23514: Slow mode is on – one message every 5 seconds 🐢 \[public_chat_slow\]$/);
  assert.match(await outcome(stick(0, 'word-lol')), /Slow mode/);
  // A photo right after a message is fine, and a message right after a photo.
  assert.equal(await outcome(photo(0)), 'ok');
  await db.query("update private.public_chat_sends set sent_at = sent_at - interval '6 seconds' where sender_id = $1 and kind = 'message'", [users[0]]);
  assert.equal(await outcome(say(0, 'two')), 'ok');
  // 300 in 24 hours (2 sent above, 298 earlier today).
  assert.equal(await sends(0, 'message'), 2);
  assert.equal(await sends(0, 'photo'), 1);
  await db.query(`insert into private.public_chat_sends(sender_id, kind, sent_at)
    select $1, 'message', now() - interval '1 hour' - make_interval(secs => n) from generate_series(1, 298) n`, [users[0]]);
  await wait(0);
  assert.match(await outcome(say(0, 'too much')), /^23514: That's a lot of messages for one day – come back tomorrow 🙏 \[public_chat_daily\]$/);
  await db.query("update private.public_chat_sends set sent_at = sent_at - interval '1 day' where sender_id = $1", [users[0]]);
  assert.equal(await outcome(say(0, 'a new day')), 'ok');
  // Sends older than a day are forgotten as you post.
  assert.equal(await sends(0, 'message'), 1);
});

test('Deleting what you posted doesn\'t get you round slow mode or the daily limit (messages and photos)', async () => {
  await born(0, 25);
  const one = (await say(0, 'one')).rows[0];
  await rpc(0, 'delete from public_messages where id = $1', [one.id]);
  assert.match(await outcome(say(0, 'two')), /Slow mode is on – one message every 5 seconds/);
  // Five quick "post and delete" in a row: only the first one gets through.
  await wait(0);
  let through = 0;
  for (let n = 0; n < 5; n++) {
    const sent = await say(0, `spam ${n}`).then((r) => r.rows[0], () => null);
    if (sent) { through += 1; await rpc(0, 'delete from public_messages where id = $1', [sent.id]); }
  }
  assert.equal(through, 1);
  // 300 today, all deleted: still 300 today.
  await wait(0);
  await db.query(`insert into private.public_chat_sends(sender_id, kind, sent_at)
    select $1, 'message', now() - interval '1 hour' - make_interval(secs => n) from generate_series(1, 299) n`, [users[0]]);
  await rpc(0, 'delete from public_messages where sender_id = $1', [users[0]]);
  assert.match(await outcome(say(0, 'more')), /\[public_chat_daily\]/);
  // Photos: post, delete, post again straight away → slow mode.
  const first = (await photo(0)).rows[0];
  await rpc(0, 'delete from public_photos where id = $1', [first.id]);
  assert.match(await outcome(photo(0)), /Slow mode is on – you can post again in a few seconds 🐢 \[public_chat_slow\]/);
  // Nobody can read or change the list from the app.
  assert.match(await outcome(rpc(1, 'select * from private.public_chat_sends')), /permission denied/);
  assert.match(await outcome(rpc(0, 'delete from private.public_chat_sends')), /permission denied/);
});

test('No link or phone number in your name or username while you post (messages, stickers and photos)', async () => {
  await born(0, 25); await born(1, 25);
  const nameWords = /^23514: Your name or username looks like a link or a phone number\. Change it in Edit profile to post in the public chat\. \[public_chat_name\]$/;
  await setName(0, 'display_name', 'add me t.me/promo123 📲');
  assert.match(await outcome(say(0, 'hi 👋')), nameWords);
  assert.match(await outcome(stick(0, 'googly-eyes')), nameWords);
  assert.match(await outcome(photo(0)), nameWords);
  await setName(0, 'display_name', 'Jess 07911 123456');
  assert.match(await outcome(say(0, 'hi 👋')), nameWords);
  await setName(0, 'display_name', 'Jess 🌸');
  await setName(0, 'username', 'promo123.com');
  assert.match(await outcome(say(0, 'hi 👋')), nameWords);
  await setName(0, 'username', 'jess.smith');
  assert.equal(await outcome(say(0, 'hi 👋')), 'ok');
  // A refused post doesn't count towards slow mode.
  await setName(1, 'display_name', 'site dot com');
  assert.match(await outcome(say(1, 'hello')), nameWords);
  await setName(1, 'display_name', 'Sam');
  assert.equal(await outcome(say(1, 'hello')), 'ok');
});

test('Blocks work both ways; you delete your own messages, not others\'', async () => {
  for (const i of [0, 1, 2]) await born(i, 30);
  const hi = (await say(0, 'hi')).rows[0];
  await db.query('insert into blocks(blocker_id,blocked_id) values($1,$2)', [users[1], users[0]]);
  assert.deepEqual(await seen(1), []);
  const back = (await say(1, 'can you see me?')).rows[0];
  assert.ok(!(await seen(0)).includes(back.id), 'the person they blocked doesn\'t see them either');
  assert.deepEqual(await seen(2), [hi.id, back.id]);
  await rpc(2, 'delete from public_messages where id = $1', [hi.id]);
  assert.deepEqual(await seen(2), [hi.id, back.id]);
  await rpc(0, 'delete from public_messages where id = $1', [hi.id]);
  assert.deepEqual(await seen(2), [back.id]);
});

test('Reports: the words are kept with the report, 3 different people hide it, the owner gets the push', async () => {
  for (const i of [0, 1, 2, 3, 4]) await born(i, 30);
  await born(5, 15);
  await db.query('insert into private.report_alert_people(user_id) values($1)', [users[4]]);
  await db.query("insert into push_tokens(token,user_id,platform) values('owner-phone',$1,'ios')", [users[4]]);
  const bad = (await say(0, 'you are all losers')).rows[0];
  assert.match(await outcome(report(5, bad.id)), /can't be reported/);
  assert.equal(await outcome(report(1, bad.id, 'bullying', 'they keep doing this')), 'ok');
  const saved = (await db.query("select reported_user_id, details from reports where content_type = 'public_message'")).rows;
  assert.deepEqual(saved, [{ reported_user_id: users[0], details: 'Message: "you are all losers"\nthey keep doing this' }]);
  // The reporter sees their own report (with the words they reported), nobody else does.
  assert.equal((await rpc(1, 'select count(*)::int as n from reports')).rows[0].n, 1);
  assert.equal((await rpc(0, 'select count(*)::int as n from reports')).rows[0].n, 0);
  const pushes = (await db.query('select body from net.sent')).rows.map((r) => r.body[0]);
  assert.ok(pushes.some((p) => p.title === '🚩 New report' && /public_message for bullying/.test(p.body)), JSON.stringify(pushes));

  assert.equal(await outcome(report(2, bad.id)), 'ok');
  assert.deepEqual(await seen(3), [bad.id]);
  // The same person again: quietly skipped – no second report, no second push.
  const pushCount = async () => (await db.query('select count(*)::int as n from net.sent')).rows[0].n;
  const pushesBefore = await pushCount();
  for (let n = 0; n < 5; n++) assert.equal(await outcome(report(2, bad.id)), 'ok');
  assert.equal(await pushCount(), pushesBefore);
  assert.equal((await db.query("select count(*)::int as n from reports where reporter_id = $1 and content_type = 'public_message'", [users[2]])).rows[0].n, 1);
  assert.deepEqual(await seen(3), [bad.id]);
  assert.equal(await outcome(report(3, bad.id)), 'ok');
  assert.deepEqual(await seen(3), [], 'hidden for everyone else');
  assert.deepEqual(await seen(0), [bad.id], 'its sender still sees it');
  assert.equal((await rpc(0, 'select hidden from public_messages')).rows[0].hidden, true);

  // Deleted afterwards: the report keeps the words.
  await rpc(0, 'delete from public_messages where id = $1', [bad.id]);
  assert.equal((await db.query("select count(*)::int as n from reports where details like 'Message: \"you are all losers\"%'")).rows[0].n, 3);
  // A sticker report says which sticker. Blocked by the sender: can't report (they can't see it).
  await wait(0);
  const sticker = (await stick(0, 'word-slay')).rows[0];
  assert.equal(await outcome(report(1, sticker.id)), 'ok');
  assert.equal((await db.query('select details from reports where content_id = $1', [sticker.id])).rows[0].details, 'Sticker: word-slay');
  await db.query('insert into blocks(blocker_id,blocked_id) values($1,$2)', [users[0], users[2]]);
  assert.match(await outcome(report(2, sticker.id)), /can't be reported/);
});

test('Deleting an account deletes its messages and the reports about them, but a private copy of each report stays 90 days', async () => {
  await born(0, 25); await born(1, 25); await born(2, 25);
  await setName(0, 'display_name', 'Creepy Carl');
  const hi = (await say(0, 'meet me behind the school, I know where you live')).rows[0];
  await report(1, hi.id, 'violence', 'scary');
  const id = (await db.query("select id from reports where content_type = 'public_message'")).rows[0].id;
  await wait(0);
  const pic = (await photo(0)).rows[0];
  await rpc(2, "insert into reports(reporter_id,content_type,content_id,reason) values($1,'public_photo',$2,'nudity')", [users[2], pic.id]);
  await db.query('delete from auth.users where id = $1', [users[0]]);
  assert.equal((await db.query('select count(*)::int as n from public_messages')).rows[0].n, 0);
  assert.equal((await db.query("select count(*)::int as n from reports where content_type in ('public_message', 'public_photo')")).rows[0].n, 0);
  const copies = (await db.query(`select report_id, content_type, reported_user_id, reported_username, reported_name, reason, details,
    keep_until > now() + interval '89 days' as kept_90_days from private.public_chat_report_copies order by content_type`)).rows;
  assert.deepEqual(copies.map((c) => [c.content_type, c.reported_user_id, c.reported_name, c.reason, c.kept_90_days]), [
    ['public_message', users[0], 'Creepy Carl', 'violence', true],
    ['public_photo', users[0], 'Creepy Carl', 'nudity', true],
  ]);
  assert.equal(copies[0].report_id, id, 'the same id as in the owner\'s push');
  assert.equal(copies[0].details, 'Message: "meet me behind the school, I know where you live"\nscary');
  assert.ok(copies[0].reported_username);
  // The app can't see the copies; the nightly tidy-up removes them after 90 days, and sends after a day.
  assert.match(await outcome(rpc(1, 'select * from private.public_chat_report_copies')), /permission denied/);
  await db.query("update private.public_chat_report_copies set keep_until = now() - interval '1 second' where content_type = 'public_photo'");
  await db.query("insert into private.public_chat_sends(sender_id, kind, sent_at) values ($1, 'message', now() - interval '25 hours'), ($1, 'message', now())", [users[1]]);
  await db.query('select private.public_chat_tidy()');
  assert.deepEqual((await db.query('select content_type from private.public_chat_report_copies')).rows.map((r) => r.content_type), ['public_message']);
  assert.equal(await sends(1, 'message'), 1);
  const job = (await db.query("select schedule, command from cron.job where jobname = 'peekaboo-public-chat-tidy'")).rows;
  assert.deepEqual(job, [{ schedule: '23 5 * * *', command: 'select private.public_chat_tidy()' }]);
});

test('Older apps see the public chat exactly as before: photos only, same reads, writes and reports', async () => {
  for (const i of [0, 1, 2, 3, 4]) await born(i, 30);
  await say(0, 'a message');
  const p = (await photo(1)).rows[0];
  // The query older apps run: every row is a photo, and the messages aren't in it.
  const rows = (await rpc(2, `select f.*, (select jsonb_build_object('id', a.id, 'username', a.username) from profiles a
    where a.id = f.sender_id) as author from public_photos f order by created_at desc limit 60`)).rows;
  assert.deepEqual(rows.map((r) => r.id), [p.id]);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['author', 'created_at', 'hidden', 'id', 'media_path', 'sender_id']);
  assert.equal((await db.query("select conname from pg_constraint where conname = 'public_photos_sender_id_fkey'")).rows.length, 1);
  // Photo slow mode still 30 seconds, and a photo report still hides after 3.
  assert.match(await outcome(photo(1)), /Slow mode is on – you can post again/);
  for (const i of [2, 3, 4, 4, 4]) {
    await rpc(i, "insert into reports(reporter_id,content_type,content_id,reason) values($1,'public_photo',$2,'nudity')", [users[i], p.id]);
  }
  assert.equal((await db.query('select hidden from public_photos where id = $1', [p.id])).rows[0].hidden, true);
  // Reporting the same photo again does nothing (no second push for the owner).
  assert.equal((await db.query("select count(*)::int as n from reports where content_type = 'public_photo'")).rows[0].n, 3);
  assert.equal((await db.query('select details from reports where content_id = $1 limit 1', [p.id])).rows[0].details, null);
  // Both tables send live changes.
  const live = (await db.query(`select tablename from pg_publication_tables where pubname = 'supabase_realtime'
    and tablename in ('public_photos', 'public_messages') order by 1`)).rows.map((r) => r.tablename);
  assert.deepEqual(live, ['public_messages', 'public_photos']);
});

test('The migration keeps the earlier report lines, its helpers are private, and a second run changes nothing', async () => {
  const definition = async () => (await db.query("select pg_get_functiondef('private.prepare_report()'::regprocedure) as d")).rows[0].d;
  const before = await definition();
  assert.match(before, /new\.content_type = 'public_photo'/);
  assert.match(before, /live_report_author/);
  assert.equal(before.split('public_message_report_details').length - 1, 1);
  const kinds = (await db.query("select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'reports_content_type_check'")).rows[0].d;
  for (const kind of ['user', 'post', 'story', 'message', 'comment', 'dare_idea', 'group_message', 'public_photo', 'live', 'live_comment', 'public_message']) {
    assert.match(kinds, new RegExp(`'${kind}'`), kind);
  }
  for (const fn of ['private.public_text_problem(text)', 'private.public_text_lists()', 'private.prepare_public_message()',
    'private.public_message_report_details(uuid,text)', 'private.hide_reported_public_message()', 'private.public_text_tidy(text)',
    'private.public_message_problem(text)', 'private.public_chat_slow_mode(uuid,text)', 'private.check_public_chat_name(uuid)',
    'private.prepare_public_photo()', 'private.skip_repeat_public_chat_report()', 'private.keep_public_chat_report()',
    'private.public_chat_tidy()']) {
    for (const role of ['anon', 'authenticated']) {
      assert.equal((await db.query('select has_function_privilege($1, $2::regprocedure, \'EXECUTE\') as ok', [role, fn])).rows[0].ok, false, `${role} ${fn}`);
    }
  }
  assert.equal((await db.query("select indexdef from pg_indexes where indexname = 'reports_public_message_once'")).rows.length, 1);
  const sendsBefore = (await db.query('select count(*)::int as n from private.public_chat_sends')).rows[0].n;
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  assert.equal(await definition(), before);
  assert.equal((await db.query('select count(*)::int as n from private.public_chat_sends')).rows[0].n, sendsBefore);
  assert.equal((await db.query("select count(*)::int as n from cron.job where jobname = 'peekaboo-public-chat-tidy'")).rows[0].n, 1);
});
