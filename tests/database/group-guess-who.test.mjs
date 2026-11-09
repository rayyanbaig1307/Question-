// Guess Who in a group chat (supabase/migrations/20261222000000_group_guess_who.sql).
// Every check runs the real migrations in a local, in-memory PostgreSQL (PGlite) with invented people.
// Nothing here talks to a live project.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { applyMigrationFile, asUser, createLocalDatabase, friend, seedUsers } from './local-db.mjs';

const MIGRATION = '20261222000000_group_guess_who.sql';
const LINE = '🕵️ Guess Who – who sent it?';
const PUSH = '🕵️ Someone posted a Guess Who – who was it?';

let db;
let users;
before(async () => { db = await createLocalDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('truncate auth.users cascade; truncate storage.objects, net.sent restart identity;');
  users = await seedUsers(db, 8);
});

const rpc = (i, sql, args = []) => asUser(db, users[i], (tx) => tx.query(sql, args));
const failure = (run) => run.then(() => 'ok', (error) => error.message);
const sorted = (list) => [...list].sort();
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const count = async (sql, args = []) => (await one(`select count(*)::int as n from ${sql}`, args)).n;

// A group made by users[0] with the given others (all of them users[0]'s friends).
async function makeGroup(members = [1, 2, 3], name = 'Squad') {
  for (const i of members) await friend(db, users[0], users[i]);
  return (await rpc(0, 'select create_peek_group($1,$2::uuid[],current_date) as id', [name, members.map((i) => users[i])])).rows[0].id;
}
// A photo uploaded to the shared "mystery" folder (no name in the path).
async function upload(i) {
  const path = `mystery/${randomUUID()}.jpg`;
  await rpc(i, "insert into storage.objects(bucket_id,name) values('media',$1)", [path]);
  return path;
}
// Post a Guess Who the way the app does (straight into mystery_posts, as the poster).
async function postGuess(grp, i, extra = {}) {
  const row = { user_id: users[i], group_id: grp, media_path: await upload(i), ...extra };
  const keys = Object.keys(row);
  return (await rpc(i, `insert into mystery_posts(${keys}) values(${keys.map((_, n) => `$${n + 1}`)}) returning *`, Object.values(row))).rows[0];
}
const feed = async (i, grp) => (await rpc(i, 'select * from group_mystery_feed($1)', [grp])).rows;
const guess = async (i, post, who) => (await rpc(i, 'select guess_mystery($1,$2) as poster', [post, who])).rows[0].poster;
const canRead = async (i, path) => (await rpc(i, 'select private.can_read_media($1) as ok', [path])).rows[0].ok;
const opens = async (i, path) => (await rpc(i, 'select count(*)::int as n from storage.objects where name = $1', [path])).rows[0].n === 1;
const summary = async (i, grp) => (await rpc(i, 'select * from my_group_chats()')).rows.find((r) => r.group_id === grp);
const leave = (i, grp) => rpc(i, 'delete from peek_group_members where group_id = $1 and user_id = $2', [grp, users[i]]);
async function addLater(grp, i) {
  await friend(db, users[0], users[i]);
  await rpc(0, 'select add_to_peek_group($1,$2::uuid[],current_date)', [grp, [users[i]]]);
}
async function pushTo(i) {
  const token = `ExponentPushToken[qa-group-guess-${i}]`;
  await db.query("insert into push_tokens(token,user_id,platform) values($1,$2,'ios') on conflict (token) do update set user_id = excluded.user_id", [token, users[i]]);
  return token;
}
const pushesTo = async (token) => (await db.query(
  "select body->0->>'title' as title, body->0->>'body' as body, body->0->'data' as data from net.sent where body->0->>'to' = $1 order by id", [token])).rows;
// The local database's clock counts whole milliseconds: wait a moment so that "later" really is later.
const waitAMoment = () => new Promise((resolve) => setTimeout(resolve, 5));
const can = async (role, fn) => (await one("select has_function_privilege($1, $2, 'EXECUTE') as ok", [role, fn])).ok;

// ---------------------------------------------------------------------------
// 1. Posting
// ---------------------------------------------------------------------------
test('Only people in the group can post, the group needs 3 people, photos only, and the server writes down who was in it', async () => {
  const grp = await makeGroup([1, 2]);
  // The app can't choose the people: the server writes down everyone in the group right now.
  const post = await postGuess(grp, 1, { group_candidates: [users[5]] });
  assert.deepEqual(sorted(post.group_candidates), sorted([users[0], users[1], users[2]]));
  assert.match(post.media_path, /^mystery\/[0-9a-f-]{36}\.jpg$/);
  // Someone outside the group, or a group that doesn't exist.
  assert.equal(await failure(postGuess(grp, 5)), 'Only people in this group can post a Guess Who here');
  assert.equal(await failure(postGuess(randomUUID(), 1)), 'This group is gone');
  // Two people: the other one would know who it was.
  await friend(db, users[3], users[4]);
  const pair = (await rpc(3, "select create_peek_group('Pair',$1::uuid[],current_date) as id", [[users[4]]])).rows[0].id;
  assert.equal(await failure(postGuess(pair, 3)), 'Guess Who needs at least 3 people in the group');
  // Photos only: no video, no still picture, no extra layer.
  const photosOnly = 'Guess Who in groups is photos only for now';
  assert.equal(await failure(postGuess(grp, 2, { media_type: 'video' })), photosOnly);
  assert.equal(await failure(postGuess(grp, 2, { poster_path: await upload(2) })), photosOnly);
  assert.equal(await failure(postGuess(grp, 2, { overlay_path: await upload(2) })), photosOnly);
  // Nothing was saved by the refused posts.
  assert.equal(await count('mystery_posts where group_id is not null'), 1);
  // A friends' Guess Who (no group) works as before and never carries a list of people.
  const plain = await postGuess(null, 1, { group_candidates: [users[0], users[2], users[3]] });
  assert.equal(plain.group_id, null);
  assert.equal(plain.group_candidates, null);
  // Nobody can move a Guess Who to another group or change its people later. App users can't change rows at all,
  // and even the owner's SQL editor gets them put back.
  assert.deepEqual((await rpc(1, 'update mystery_posts set group_id = null, group_candidates = null where id = $1 returning id', [post.id])).rows, []);
  await db.query("update mystery_posts set group_id = $2, group_candidates = '{}' where id = $1", [post.id, pair]);
  await db.query('update mystery_posts set group_id = $2 where id = $1', [plain.id, grp]);
  const kept = await one('select group_id, group_candidates from mystery_posts where id = $1', [post.id]);
  assert.equal(kept.group_id, grp);
  assert.deepEqual(sorted(kept.group_candidates), sorted([users[0], users[1], users[2]]));
  assert.equal((await one('select group_id from mystery_posts where id = $1', [plain.id])).group_id, null);
});

test('At most 3 group Guess Whos per person per group in 24 hours', async () => {
  const grp = await makeGroup([1, 2, 3]);
  const other = await makeGroup([1, 2], 'Other');
  const first = await postGuess(grp, 1);
  await postGuess(grp, 1);
  await postGuess(grp, 1);
  const limit = 'You can post 3 Guess Whos in this group a day';
  assert.equal(await failure(postGuess(grp, 1)), limit);
  // Someone else in the group, and the same person in another group or on the Guess Who page, still can.
  await postGuess(grp, 2);
  await postGuess(other, 1);
  await postGuess(null, 1);
  // 24 hours after the first one, there is room for one more.
  await db.query("update mystery_posts set created_at = now() - interval '25 hours' where id = $1", [first.id]);
  await postGuess(grp, 1);
  assert.equal(await failure(postGuess(grp, 1)), limit);
});

// ---------------------------------------------------------------------------
// 2. Nobody learns who posted it
// ---------------------------------------------------------------------------
test('Nobody but the poster can read a group Guess Who, its people or its guesses straight from the tables', async () => {
  const grp = await makeGroup([1, 2, 3]);
  const post = await postGuess(grp, 1);
  await guess(2, post.id, users[3]);
  for (const i of [0, 2, 3, 5]) {
    assert.deepEqual((await rpc(i, 'select * from mystery_posts')).rows, [], `user ${i}`);
    assert.deepEqual((await rpc(i, 'select * from mystery_guesses')).rows, [], `user ${i}`);
  }
  // The poster reads only their own row.
  assert.deepEqual((await rpc(1, 'select id from mystery_posts')).rows.map((r) => r.id), [post.id]);
  assert.deepEqual((await asUser(db, null, (tx) => tx.query('select * from mystery_posts'), 'anon')).rows, []);
});

test('The group chat list of Guess Whos: no poster and no counts until you guess, everyone else in the group to pick from', async () => {
  const grp = await makeGroup([1, 2, 3]);
  const post = await postGuess(grp, 2);
  const everyone = (await one(
    "select array(select c from unnest(g.group_candidates) c order by md5(g.id::text || ':' || c::text)) as list from mystery_posts g where g.id = $1",
    [post.id])).list;
  const [row] = await feed(1, grp);
  assert.deepEqual(
    { id: row.id, media_path: row.media_path, media_type: row.media_type, mine: row.mine, poster: row.poster, my_guess: row.my_guess,
      guess_count: row.guess_count, right_count: row.right_count, others_count: row.others_count },
    { id: post.id, media_path: post.media_path, media_type: 'photo', mine: false, poster: null, my_guess: null,
      guess_count: null, right_count: null, others_count: 3 });
  // Everyone in the group except you (the poster too), in a mixed-up order that is the same for everyone.
  assert.deepEqual(row.options, everyone.filter((id) => id !== users[1]));
  assert.deepEqual(sorted(row.options), sorted([users[0], users[2], users[3]]));
  assert.deepEqual((await feed(3, grp))[0].options, everyone.filter((id) => id !== users[3]));
  assert.deepEqual((await one('select private.mystery_options($1,$2) as o', [post.id, users[1]])).o, row.options);
  // The poster: their own, with the counts and no names to pick.
  const [mine] = await feed(2, grp);
  assert.deepEqual({ mine: mine.mine, options: mine.options, poster: mine.poster, guess_count: mine.guess_count, right_count: mine.right_count, others_count: mine.others_count },
    { mine: true, options: null, poster: users[2], guess_count: 0, right_count: 0, others_count: 3 });
  // A wrong guess: now you see who it was, your guess and the counts.
  assert.equal(await guess(1, post.id, users[0]), users[2]);
  const counts = (r) => ({ poster: r.poster, my_guess: r.my_guess, guess_count: r.guess_count, right_count: r.right_count });
  assert.deepEqual(counts((await feed(1, grp))[0]), { poster: users[2], my_guess: users[0], guess_count: 1, right_count: 0 });
  assert.equal(await guess(3, post.id, users[2]), users[2]);
  assert.deepEqual(counts((await feed(3, grp))[0]), { poster: users[2], my_guess: users[2], guess_count: 2, right_count: 1 });
  assert.deepEqual(counts((await feed(2, grp))[0]), { poster: users[2], my_guess: null, guess_count: 2, right_count: 1 });
  // Someone who hasn't guessed still sees nothing more.
  assert.deepEqual(counts((await feed(0, grp))[0]), { poster: null, my_guess: null, guess_count: null, right_count: null });
  // Not in the group: nothing. Not logged in: asked to log in. Visitors can't call it at all.
  assert.deepEqual(await feed(5, grp), []);
  assert.equal(await failure(asUser(db, null, (tx) => tx.query('select * from group_mystery_feed($1)', [grp]))), 'Please log in again');
  await assert.rejects(() => asUser(db, null, (tx) => tx.query('select * from group_mystery_feed($1)', [grp]), 'anon'), /permission denied/);
});

test('A guess must be someone from the group (not yourself), only the first guess counts, and the poster can\'t guess', async () => {
  const grp = await makeGroup([1, 2, 3]);
  await friend(db, users[1], users[5]);   // a friend of the guesser who isn't in the group
  const post = await postGuess(grp, 2);
  for (const who of [users[5], randomUUID(), null, users[1]]) {
    assert.equal(await failure(guess(1, post.id, who)), 'Pick someone from the group', String(who));
  }
  assert.equal(await count('mystery_guesses'), 0);
  assert.match(await failure(guess(2, post.id, users[1])), /That one's yours/);
  assert.equal(await guess(1, post.id, users[3]), users[2]);
  assert.equal(await guess(1, post.id, users[2]), users[2]);   // a second guess changes nothing
  assert.deepEqual((await db.query('select user_id, guess, correct from mystery_guesses')).rows, [{ user_id: users[1], guess: users[3], correct: false }]);
  assert.equal(await failure(guess(5, post.id, users[2])), 'This Guess Who is gone');
  assert.equal(await failure(guess(1, randomUUID(), users[2])), 'This Guess Who is gone');
});

// ---------------------------------------------------------------------------
// 3. Who sees it
// ---------------------------------------------------------------------------
test('A block between you and anyone in the group hides all of that group\'s Guess Whos from you (blocking the poster looks the same)', async () => {
  const grp = await makeGroup([1, 2, 3, 4]);
  const post = await postGuess(grp, 1);
  const view = async (i) => {
    const chat = await summary(i, grp);
    return { cards: (await feed(i, grp)).length, file: await canRead(i, post.media_path), unread: chat.unread, line: chat.last_body };
  };
  const shown = { cards: 1, file: true, unread: 1, line: LINE };
  const hidden = { cards: 0, file: false, unread: 0, line: null };
  const refused = async (i) => {
    for (const sql of ['select guess_mystery($1,$2)', "select report_mystery($1,'spam')", 'select block_mystery_poster($1)', 'select mystery_hint($1)']) {
      const args = sql.includes('$2') ? [post.id, users[1]] : [post.id];
      assert.equal(await failure(rpc(i, sql, args)), 'This Guess Who is gone', `user ${i}: ${sql}`);
    }
  };
  await db.query("insert into plus_members(user_id,expires_at) values($1, now() + interval '30 days'),($2, now() + interval '30 days')", [users[3], users[4]]);
  for (const i of [0, 2, 3, 4]) assert.deepEqual(await view(i), shown, `user ${i}`);
  // users[3] blocks users[4] (neither posted it): it's gone for both of them...
  await rpc(3, 'select block_user($1)', [users[4]]);
  for (const i of [3, 4]) {
    assert.deepEqual(await view(i), hidden, `user ${i}`);
    await refused(i);
  }
  // ...and everyone else still sees it, with the same names to pick from as before.
  for (const i of [0, 2]) assert.deepEqual(await view(i), shown, `user ${i}`);
  assert.deepEqual(sorted((await feed(0, grp))[0].options), sorted([users[1], users[2], users[3], users[4]]));
  // Unblocking brings it back.
  await rpc(3, 'delete from blocks where blocker_id = $1 and blocked_id = $2', [users[3], users[4]]);
  for (const i of [3, 4]) assert.deepEqual(await view(i), shown, `user ${i}`);
  // users[3] blocks the poster instead: for users[3] it looks exactly the same as blocking someone else.
  await rpc(3, 'select block_user($1)', [users[1]]);
  assert.deepEqual(await view(3), hidden);
  await refused(3);
  for (const i of [0, 2, 4]) assert.deepEqual(await view(i), shown, `user ${i}`);
  // The poster still sees their own.
  assert.equal((await feed(1, grp)).length, 1);
  assert.equal(await count('mystery_guesses'), 0);
});

test('People added later see nothing; someone who leaves loses it; if the poster leaves, it stays for everyone else', async () => {
  const grp = await makeGroup([1, 2, 3]);
  const post = await postGuess(grp, 1);
  await waitAMoment();
  await addLater(grp, 4);
  assert.deepEqual(await feed(4, grp), []);
  assert.equal(await canRead(4, post.media_path), false);
  assert.equal(await failure(guess(4, post.id, users[1])), 'This Guess Who is gone');
  assert.equal(await failure(rpc(4, "select report_mystery($1,'spam')", [post.id])), 'This Guess Who is gone');
  assert.deepEqual({ unread: (await summary(4, grp)).unread, line: (await summary(4, grp)).last_body }, { unread: 0, line: null });
  // ...and they don't become one of the names to pick from.
  assert.ok(!(await feed(0, grp))[0].options.includes(users[4]));
  // users[3] leaves: gone for them.
  await leave(3, grp);
  assert.deepEqual(await feed(3, grp), []);
  assert.equal(await canRead(3, post.media_path), false);
  assert.equal(await failure(guess(3, post.id, users[1])), 'This Guess Who is gone');
  // The poster leaves: it stays for the others, and they are still one of the names (taking it away would
  // give them away).
  await leave(1, grp);
  assert.deepEqual(await feed(1, grp), [], 'the poster is no longer in the group chat');
  const [row] = await feed(2, grp);
  assert.equal(row.id, post.id);
  assert.deepEqual(sorted(row.options), sorted([users[0], users[1], users[3]]));
  assert.equal(await canRead(2, post.media_path), true);
  assert.equal(await guess(2, post.id, users[1]), users[1]);
  // The poster can still delete it.
  assert.equal((await rpc(1, 'delete from mystery_posts where id = $1 returning id', [post.id])).rows.length, 1);
  assert.deepEqual(await feed(2, grp), []);
});

test('With fewer than 2 names left to pick from, only the poster sees it (the last name would give it away)', async () => {
  const grp = await makeGroup([1, 2]);
  const post = await postGuess(grp, 1);
  assert.deepEqual(sorted((await feed(0, grp))[0].options), sorted([users[1], users[2]]));
  // users[2] deletes their account: users[0] would have only the poster left to pick.
  await db.query('delete from auth.users where id = $1', [users[2]]);
  assert.deepEqual(await feed(0, grp), []);
  assert.equal(await canRead(0, post.media_path), false);
  assert.equal(await failure(guess(0, post.id, users[1])), 'This Guess Who is gone');
  assert.equal((await summary(0, grp)).unread, 0);
  const [mine] = await feed(1, grp);
  assert.deepEqual({ id: mine.id, others_count: mine.others_count }, { id: post.id, others_count: 1 });
});

test('The Guess Who page never shows group Guess Whos (not to the poster, the group or the poster\'s other friends)', async () => {
  const grp = await makeGroup([1, 2, 3]);   // everyone in it is users[0]'s friend
  await friend(db, users[0], users[5]);     // a friend of the poster who isn't in the group
  const inGroup = await postGuess(grp, 0);
  const plain = await postGuess(null, 0);
  for (const i of [0, 1, 2, 5]) {
    assert.deepEqual((await rpc(i, 'select id from mystery_feed()')).rows.map((r) => r.id), [plain.id], `user ${i}`);
  }
  // The group chat shows only the group one.
  assert.deepEqual((await feed(1, grp)).map((r) => r.id), [inGroup.id]);
  // The friend outside the group can't open the group one's photo.
  assert.equal(await canRead(5, inGroup.media_path), false);
  assert.equal(await canRead(5, plain.media_path), true);
  assert.equal(await failure(guess(5, inGroup.id, users[0])), 'This Guess Who is gone');
});

// ---------------------------------------------------------------------------
// 4. Hints, blocking, reports
// ---------------------------------------------------------------------------
test('No hints for group Guess Whos; blocking the poster only after you guess; reports stay anonymous', async () => {
  const grp = await makeGroup([1, 2, 3]);
  const post = await postGuess(grp, 1);
  await db.query("insert into plus_members(user_id,expires_at) values($1, now() + interval '30 days')", [users[2]]);
  assert.equal(await failure(rpc(2, 'select mystery_hint($1)', [post.id])), 'No hint for this one, sorry 🙈');
  assert.equal(await count('mystery_hints'), 0);
  // Friends' Guess Who hints still work.
  await friend(db, users[2], users[5]);
  const plain = await postGuess(null, 5);
  assert.match((await rpc(2, 'select mystery_hint($1) as h', [plain.id])).rows[0].h, /^(Their|They)/);
  // Block whoever posted it: only once you've guessed (then you know who it was anyway).
  assert.equal(await failure(rpc(2, 'select block_mystery_poster($1)', [post.id])), 'Make your guess first, then you can block them');
  assert.equal(await count('blocks'), 0);
  await guess(2, post.id, users[0]);
  await rpc(2, 'select block_mystery_poster($1)', [post.id]);
  assert.deepEqual((await db.query('select blocker_id, blocked_id from blocks')).rows, [{ blocker_id: users[2], blocked_id: users[1] }]);
  // Report: saved against the real poster for the owner, but the reporter can't read it back.
  await rpc(3, "select report_mystery($1,'spam')", [post.id]);
  assert.deepEqual(await one("select reporter_id, reported_user_id, content_type, content_id, details, anonymous_content from reports where reporter_id = $1", [users[3]]),
    { reporter_id: users[3], reported_user_id: users[1], content_type: 'post', content_id: post.id, details: 'Guess Who (anonymous) post', anonymous_content: true });
  assert.deepEqual((await rpc(3, 'select * from reports')).rows, []);
  // The photo is kept as evidence.
  assert.deepEqual((await db.query('select e.object_name from private.report_media_evidence e join reports r on r.id = e.report_id where r.reporter_id = $1', [users[3]])).rows,
    [{ object_name: post.media_path }]);
  // Reporting it straight into the reports table (which would show the reporter who posted it) is refused.
  // People outside the group can't report it at all, even the poster's friends.
  const direct = (i) => failure(rpc(i, "insert into reports(reporter_id,content_type,content_id,reason) values($1,'post',$2,'spam')", [users[i], post.id]));
  assert.match(await direct(0), /row-level security/);
  await friend(db, users[1], users[5]);
  assert.equal(await direct(5), 'This can\'t be reported - it is gone or you can\'t see it');
  assert.equal(await failure(rpc(5, "select report_mystery($1,'spam')", [post.id])), 'This Guess Who is gone');
  assert.equal(await count('reports where reporter_id <> $1', [users[3]]), 0);
});

test('The photo: the poster and people who can see it can open it; outsiders, blocked people and later joiners can\'t', async () => {
  const grp = await makeGroup([1, 2, 3, 4]);
  const post = await postGuess(grp, 1);
  await waitAMoment();
  await addLater(grp, 5);
  await rpc(4, 'select block_user($1)', [users[3]]);   // a block between two people in the group
  const expected = { 0: true, 1: true, 2: true, 3: false, 4: false, 5: false, 6: false };
  for (const [i, ok] of Object.entries(expected)) {
    assert.equal(await canRead(Number(i), post.media_path), ok, `user ${i}`);
    assert.equal(await opens(Number(i), post.media_path), ok, `user ${i} (storage)`);
  }
  await assert.rejects(() => asUser(db, null, (tx) => tx.query('select private.can_read_media($1)', [post.media_path]), 'anon'), /permission denied/);
  // Once it has ended: only the poster (who uploaded it).
  await db.query("update mystery_posts set expires_at = now() - interval '1 minute' where id = $1", [post.id]);
  assert.equal(await canRead(0, post.media_path), false);
  assert.equal(await canRead(1, post.media_path), true);
});

// ---------------------------------------------------------------------------
// 5. Pushes and live updates
// ---------------------------------------------------------------------------
test('The push goes to everyone who can see it and never names anyone; not the poster, muted, blocked or outside people', async () => {
  const grp = await makeGroup([1, 2, 3, 4, 5]);
  const tokens = {};
  for (const i of [0, 1, 2, 3, 4, 5, 6]) tokens[i] = await pushTo(i);
  await rpc(3, 'select set_group_chat_muted($1, true)', [grp]);
  await rpc(4, 'select block_user($1)', [users[2]]);   // a block between two people who didn't post it
  await db.query('truncate net.sent restart identity');
  const post = await postGuess(grp, 1);
  const push = { title: '👯 Squad', body: PUSH, data: { type: 'group_chat', group: grp } };
  for (const i of [0, 5]) assert.deepEqual(await pushesTo(tokens[i]), [push], `user ${i}`);
  for (const i of [1, 2, 3, 4, 6]) assert.deepEqual(await pushesTo(tokens[i]), [], `user ${i}`);
  // Nothing that was sent names the poster.
  const sent = (await db.query('select body::text as b from net.sent')).rows.map((r) => r.b).join('\n');
  assert.doesNotMatch(sent, new RegExp(`QA 1|qa_user_1|${users[1]}`));
  // Guessing sends nothing.
  await guess(0, post.id, users[2]);
  assert.equal(await count('net.sent'), 2);
  // Message notifications turned off: no push either.
  await db.query('insert into notification_prefs(user_id, messages) values($1, false) on conflict (user_id) do update set messages = false', [users[0]]);
  await db.query('truncate net.sent restart identity');
  await postGuess(grp, 2);
  assert.deepEqual(await pushesTo(tokens[0]), []);
  assert.deepEqual((await pushesTo(tokens[1])).map((p) => p.body), [PUSH]);
});

test('Live updates: the group\'s ping changes when a Guess Who is posted or deleted (not on a guess); only people in the group can read it', async () => {
  const grp = await makeGroup([1, 2, 3]);
  const ping = async () => (await one('select changed_at from group_guess_pings where group_id = $1', [grp]))?.changed_at?.getTime() ?? null;
  assert.equal(await ping(), null);
  const post = await postGuess(grp, 1);
  const posted = await ping();
  assert.ok(posted);
  await waitAMoment();
  await guess(2, post.id, users[0]);
  assert.equal(await ping(), posted, 'a guess does not ping');
  // A friends' Guess Who doesn't ping any group.
  await postGuess(null, 1);
  assert.equal(await ping(), posted);
  assert.equal(await count('group_guess_pings'), 1);
  // Members read it (only the group and a time, never who); others can't; only the server writes it.
  assert.deepEqual(Object.keys((await rpc(2, 'select * from group_guess_pings')).rows[0]).sort(), ['changed_at', 'group_id']);
  for (const i of [0, 1, 2, 3]) assert.equal((await rpc(i, 'select group_id from group_guess_pings')).rows.length, 1, `user ${i}`);
  assert.deepEqual((await rpc(5, 'select * from group_guess_pings')).rows, []);
  await assert.rejects(() => asUser(db, null, (tx) => tx.query('select * from group_guess_pings'), 'anon'), /permission denied/);
  for (const sql of ['insert into group_guess_pings(group_id) values($1)', 'update group_guess_pings set changed_at = now() where group_id = $1',
    'delete from group_guess_pings where group_id = $1']) {
    await assert.rejects(() => rpc(1, sql, [grp]), /permission denied/, sql);
  }
  const live = (await db.query("select tablename from pg_publication_tables where pubname = 'supabase_realtime' and tablename in ('group_guess_pings', 'mystery_posts', 'mystery_guesses') order by 1")).rows.map((r) => r.tablename);
  assert.deepEqual(live, ['group_guess_pings']);
  // Deleting it pings again.
  await waitAMoment();
  await rpc(1, 'delete from mystery_posts where id = $1', [post.id]);
  assert.ok(await ping() > posted);
});

// ---------------------------------------------------------------------------
// 6. Read times and the Chat list
// ---------------------------------------------------------------------------
test('Opening the chat moves your read time only up to the newest group message, so it never shows when you opened it', async () => {
  const grp = await makeGroup([1, 2]);
  const readAt = async (i) => (await one('select chat_read_at from peek_group_members where group_id = $1 and user_id = $2', [grp, users[i]])).chat_read_at.getTime();
  const joined = await readAt(1);
  // No messages yet: nothing moves.
  await waitAMoment();
  await rpc(1, 'select mark_group_chat_read($1)', [grp]);
  assert.equal(await readAt(1), joined);
  await waitAMoment();
  const hello = (await rpc(0, "insert into group_messages(group_id,body) values($1,'hello') returning created_at", [grp])).rows[0].created_at.getTime();
  await waitAMoment();
  const post = await postGuess(grp, 1);
  await waitAMoment();
  // The poster goes back into the chat right after posting: their read time is the message's time, not now.
  await rpc(1, 'select mark_group_chat_read($1)', [grp]);
  assert.equal(await readAt(1), hello);
  assert.ok(await readAt(1) < post.created_at.getTime());
  assert.equal((await one(
    'select m.chat_read_at = (select max(g.created_at) from group_messages g where g.group_id = m.group_id) as same from peek_group_members m where m.group_id = $1 and m.user_id = $2',
    [grp, users[1]])).same, true);
  // "Seen" still works: the read time reaches the message.
  assert.ok(await readAt(1) >= hello);
  // The message is no longer unread for them.
  assert.equal((await summary(1, grp)).unread, 0);
  // Read times never go back.
  await db.query("update peek_group_members set chat_read_at = now() + interval '1 hour' where group_id = $1 and user_id = $2", [grp, users[2]]);
  const ahead = await readAt(2);
  await rpc(2, 'select mark_group_chat_read($1)', [grp]);
  assert.equal(await readAt(2), ahead);
  // Someone outside the group changes nothing.
  await rpc(5, 'select mark_group_chat_read($1)', [grp]);
  assert.equal(await count('peek_group_members where user_id = $1', [users[5]]), 0);
});

test('The Chat list: a Guess Who line with no sender, and Guess Whos you haven\'t guessed count as unread', async () => {
  const grp = await makeGroup([1, 2, 3]);
  await rpc(2, "insert into group_messages(group_id,body) values($1,'hello')", [grp]);
  await waitAMoment();
  const post = await postGuess(grp, 1);
  let s = await summary(0, grp);
  assert.deepEqual(Object.keys(s).sort(), ['group_id', 'last_at', 'last_body', 'last_sender', 'muted', 'unread']);
  assert.deepEqual({ unread: s.unread, last_body: s.last_body, last_sender: s.last_sender }, { unread: 2, last_body: LINE, last_sender: null });
  assert.equal(s.last_at.getTime(), post.created_at.getTime());
  // The poster sees the same line (no name), and their own Guess Who isn't unread for them.
  s = await summary(1, grp);
  assert.deepEqual({ unread: s.unread, last_body: s.last_body, last_sender: s.last_sender }, { unread: 1, last_body: LINE, last_sender: null });
  // Guessing takes it off unread; reading the chat takes the message off.
  await guess(0, post.id, users[3]);
  assert.equal((await summary(0, grp)).unread, 1);
  await rpc(0, 'select mark_group_chat_read($1)', [grp]);
  s = await summary(0, grp);
  assert.deepEqual({ unread: s.unread, last_body: s.last_body }, { unread: 0, last_body: LINE });
  // A newer message takes over the line, with its sender.
  await waitAMoment();
  await rpc(3, "insert into group_messages(group_id,body) values($1,'who was it?')", [grp]);
  s = await summary(0, grp);
  assert.deepEqual({ unread: s.unread, last_body: s.last_body, last_sender: s.last_sender }, { unread: 1, last_body: 'who was it?', last_sender: users[3] });
  // Once it has ended it no longer counts, and the line is back to the messages.
  await waitAMoment();
  const later = await postGuess(grp, 2);
  assert.deepEqual({ unread: (await summary(3, grp)).unread, line: (await summary(3, grp)).last_body }, { unread: 3, line: LINE });
  await db.query("update mystery_posts set expires_at = now() - interval '1 minute' where id in ($1, $2)", [post.id, later.id]);
  s = await summary(3, grp);
  assert.deepEqual({ unread: s.unread, last_body: s.last_body, last_sender: s.last_sender }, { unread: 1, last_body: 'who was it?', last_sender: users[3] });
  // Ended Guess Whos don't show for their poster either.
  assert.equal((await summary(2, grp)).last_body, 'who was it?');
});

// ---------------------------------------------------------------------------
// 7. 24 hours, deleting, cleanup, accounts
// ---------------------------------------------------------------------------
test('After 24 hours it is gone from the chat and the photo; the app can\'t make it last longer', async () => {
  const grp = await makeGroup([1, 2, 3]);
  const post = await postGuess(grp, 1, { expires_at: '2099-01-01T00:00:00Z', created_at: '2000-01-01T00:00:00Z' });
  assert.ok(Math.abs(post.expires_at.getTime() - post.created_at.getTime() - 24 * 3600 * 1000) < 1000);
  assert.ok(Math.abs(Date.now() - post.created_at.getTime()) < 60_000);
  await db.query("update mystery_posts set created_at = now() - interval '24 hours 1 minute', expires_at = now() - interval '1 minute' where id = $1", [post.id]);
  for (const i of [0, 1, 2]) assert.deepEqual(await feed(i, grp), [], `user ${i}`);
  assert.equal(await failure(guess(0, post.id, users[1])), 'This Guess Who is gone');
  assert.equal(await canRead(0, post.media_path), false);
  const s = await summary(0, grp);
  assert.deepEqual({ unread: s.unread, last_body: s.last_body, last_sender: s.last_sender }, { unread: 0, last_body: null, last_sender: null });
  // Like every Guess Who, it can still be reported by someone who could see it.
  await rpc(2, "select report_mystery($1,'spam')", [post.id]);
  assert.equal(await count('reports where content_id = $1', [post.id]), 1);
});

test('Deleting: the poster deletes it for everyone; deleting the group takes its Guess Whos with it and the daily cleanup gets the photos (a reported one is kept)', async () => {
  const grp = await makeGroup([1, 2, 3]);
  const kept = await postGuess(grp, 1);
  const reported = await postGuess(grp, 2);
  const own = await postGuess(grp, 3);
  await guess(0, kept.id, users[2]);
  await rpc(1, "select report_mystery($1,'spam')", [reported.id]);
  // Only the poster can delete it.
  assert.equal((await rpc(0, 'delete from mystery_posts where id = $1 returning id', [own.id])).rows.length, 0);
  assert.equal((await rpc(3, 'delete from mystery_posts where id = $1 returning id', [own.id])).rows.length, 1);
  assert.deepEqual(sorted((await feed(0, grp)).map((r) => r.id)), sorted([kept.id, reported.id]));
  // The group's maker deletes the group: its Guess Whos, their guesses and the ping go too, without an error.
  await rpc(0, 'delete from peek_groups where id = $1', [grp]);
  assert.equal(await count('mystery_posts where id = any($1)', [[kept.id, reported.id]]), 0);
  assert.equal(await count('mystery_guesses'), 0);
  assert.equal(await count('group_guess_pings'), 0);
  // The photos now wait for the daily cleanup and look deleted, even to the people who uploaded them.
  const paths = [kept.media_path, reported.media_path, own.media_path];
  assert.deepEqual(sorted((await db.query('select object_name from private.media_deferred_deletions where object_name = any($1)', [paths])).rows.map((r) => r.object_name)), sorted(paths));
  assert.equal(await opens(1, kept.media_path), false);
  assert.equal(await opens(3, own.media_path), false);
  // The daily cleanup takes the ones nobody needs, and keeps the reported one for the report.
  const claimed = (await asUser(db, null, (tx) => tx.query('select name from claim_media_cleanup(1000)'), 'service_role')).rows.map((r) => r.name);
  assert.ok(claimed.includes(kept.media_path), 'kept photo claimed');
  assert.ok(claimed.includes(own.media_path), 'deleted photo claimed');
  assert.ok(!claimed.includes(reported.media_path), 'the reported photo is kept');
  await asUser(db, null, (tx) => tx.query('delete from storage.objects where name = any($1)', [[kept.media_path, own.media_path]]), 'service_role');
  assert.equal(await count('storage.objects where name = any($1)', [paths]), 1);
});

test('Deleting a guesser\'s or the poster\'s account works; the poster\'s group Guess Whos go with them', async () => {
  const grp = await makeGroup([1, 2, 3, 4, 5]);
  const post = await postGuess(grp, 1);
  await guess(2, post.id, users[1]);
  // A guesser goes: their guess goes; the others still see it.
  await db.query('delete from auth.users where id = $1', [users[2]]);
  assert.equal(await count('mystery_guesses'), 0);
  assert.equal((await feed(0, grp)).length, 1);
  const before = (await one('select changed_at from group_guess_pings where group_id = $1', [grp])).changed_at.getTime();
  // The poster goes: their Guess Who goes, the group stays, and the group's ping moves.
  await waitAMoment();
  await db.query('delete from auth.users where id = $1', [users[1]]);
  assert.equal(await count('mystery_posts'), 0);
  assert.deepEqual(await feed(0, grp), []);
  assert.equal(await count('peek_groups where id = $1', [grp]), 1);
  assert.ok((await one('select changed_at from group_guess_pings where group_id = $1', [grp])).changed_at.getTime() > before);
  // The group's maker goes too: the group stays without a maker, and Guess Whos by others stay
  // (users[4] still has 2 names to pick from: users[3] and users[5]).
  const third = await postGuess(grp, 3);
  await db.query('delete from auth.users where id = $1', [users[0]]);
  const [row] = await feed(4, grp);
  assert.equal(row.id, third.id);
  assert.deepEqual(sorted(row.options), sorted([users[3], users[5]]));
});

// ---------------------------------------------------------------------------
// 8. Rights, and running the migration again
// ---------------------------------------------------------------------------
test('App users can call the new group feed, but none of the helpers', async () => {
  assert.equal(await can('authenticated', 'public.group_mystery_feed(uuid)'), true);
  assert.equal(await can('anon', 'public.group_mystery_feed(uuid)'), false);
  for (const fn of ['public.mark_group_chat_read(uuid)', 'public.my_group_chats()', 'public.mystery_feed()', 'public.guess_mystery(uuid,uuid)',
    'public.report_mystery(uuid,text)', 'public.block_mystery_poster(uuid)', 'public.mystery_hint(uuid)']) {
    assert.equal(await can('authenticated', fn), true, fn);
    assert.equal(await can('anon', fn), false, fn);
  }
  for (const fn of ['private.mystery_visible(uuid,uuid[],uuid,timestamptz,uuid)', 'private.group_mystery_options(uuid,uuid)', 'private.prepare_group_mystery()',
    'private.ping_group_guess(uuid)', 'private.ping_group_mystery()', 'private.push_group_mystery()', 'private.queue_group_mystery_files()',
    'private.mystery_options(uuid,uuid)', 'private.can_see_mystery(uuid,timestamptz,uuid)', 'private.prepare_report()']) {
    for (const role of ['authenticated', 'anon']) assert.equal(await can(role, fn), false, `${role} ${fn}`);
  }
  await assert.rejects(() => rpc(1, 'select private.group_mystery_options($1,$2)', [randomUUID(), users[1]]), /permission denied/);
});

test('Running the migration again changes nothing', async () => {
  const grp = await makeGroup([1, 2, 3]);
  const post = await postGuess(grp, 1);
  await guess(2, post.id, users[3]);
  const snapshot = async () => ({
    posts: (await db.query('select id, user_id, group_id, group_candidates, created_at, expires_at from mystery_posts order by id')).rows,
    guesses: (await db.query('select * from mystery_guesses order by post_id, user_id')).rows,
    pings: (await db.query('select * from group_guess_pings order by group_id')).rows,
    reads: (await db.query('select user_id, chat_read_at from peek_group_members order by user_id')).rows,
  });
  const before = await snapshot();
  await applyMigrationFile(db, MIGRATION);
  await applyMigrationFile(db, MIGRATION);
  assert.deepEqual(await snapshot(), before);
  // Every trigger, rule, link and index is there once.
  const triggers = (await db.query("select tgname, count(*)::int as n from pg_trigger where tgrelid = 'public.mystery_posts'::regclass and tgname like 'mystery_posts_group_%' group by 1 order by 1")).rows;
  assert.deepEqual(triggers, ['files', 'ping', 'prepare', 'push'].map((t) => ({ tgname: `mystery_posts_group_${t}`, n: 1 })));
  assert.equal(await count("pg_constraint where conrelid = 'public.mystery_posts'::regclass and contype = 'f' and pg_get_constraintdef(oid) like '%peek_groups%'"), 1);
  assert.equal(await count("pg_policies where tablename = 'group_guess_pings'"), 1);
  assert.equal(await count("pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'group_guess_pings'"), 1);
  assert.equal(await count("pg_indexes where indexname = 'mystery_posts_group_idx'"), 1);
  assert.equal(await can('authenticated', 'public.group_mystery_feed(uuid)'), true);
  assert.equal(await can('anon', 'public.group_mystery_feed(uuid)'), false);
  assert.equal(await can('authenticated', 'private.mystery_visible(uuid,uuid[],uuid,timestamptz,uuid)'), false);
  // Everything still works.
  assert.equal((await feed(2, grp))[0].poster, users[1]);
  assert.equal((await feed(3, grp))[0].poster, null);
  await pushTo(0);
  await postGuess(grp, 2);
  assert.equal((await feed(0, grp)).length, 2);
  assert.equal(await count("net.sent where body->0->>'body' = $1", [PUSH]), 1);
});
