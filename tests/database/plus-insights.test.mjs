// Peekaboo+ insights (20261217000000_plus_insights.sql): profile views, story rewatches, screenshots.
// Every check runs all migrations in a local, in-memory PostgreSQL (PGlite). Invented users only.
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
  users = await seedUsers(db, 6);
});

const as = (i, sql, args = []) => asUser(db, users[i], (tx) => tx.query(sql, args));
const one = async (i, sql, args = []) => (await as(i, sql, args)).rows[0];
const outcome = (run) => run.then(() => 'ok', (error) => `error: ${error.message}`);
const givePlus = (i) => db.query("insert into plus_members(user_id, expires_at) values ($1, now() + interval '30 days')", [users[i]]);
const pushes = async () => (await db.query('select body from net.sent')).rows.flatMap((r) => r.body);
const ageViews = (interval) => db.query(`update private.profile_views set viewed_at = viewed_at - interval '${interval}'`);

async function story(i) {
  const path = `${users[i]}/stories/${randomUUID()}.jpg`;
  await as(i, "insert into storage.objects(bucket_id,name) values('media',$1)", [path]);
  return (await one(i, 'insert into stories(user_id,media_path) values($1,$2) returning id', [users[i], path])).id;
}
async function post(i) {
  const path = `${users[i]}/posts/${randomUUID()}.jpg`;
  await as(i, "insert into storage.objects(bucket_id,name) values('media',$1)", [path]);
  return (await one(i, 'insert into posts(user_id,media_path) values($1,$2) returning id', [users[i], path])).id;
}

test('A profile visit is saved at most once an hour, never for yourself and never across a block', async () => {
  const visit = async (i, j) => (await one(i, 'select record_profile_view($1) as ok', [users[j]])).ok;
  assert.equal(await visit(1, 0), true);
  assert.equal(await visit(1, 0), false, 'a second visit in the same hour is not saved');
  assert.equal(await visit(0, 0), false, 'your own profile is never saved');
  await db.query('insert into blocks(blocker_id, blocked_id) values ($1, $2)', [users[0], users[2]]);
  assert.equal(await visit(2, 0), false, 'blocked: not saved');
  await ageViews('61 minutes');
  assert.equal(await visit(1, 0), true, 'after an hour it counts again');
  assert.equal((await db.query('select count(*)::int as n from private.profile_views')).rows[0].n, 2);
});

test('Free users get counts only; Plus users get who; blocks and the privacy switch hide people', async () => {
  for (const i of [1, 2, 3]) await one(i, 'select record_profile_view($1)', [users[0]]);
  await ageViews('2 hours');
  await one(1, 'select record_profile_view($1)', [users[0]]);

  const free = (await one(0, 'select my_profile_views() as v')).v;
  assert.equal(free.plus, false);
  assert.equal(free.people, 3);
  assert.equal(free.visits, 4);
  assert.deepEqual(free.viewers, [], 'a free user never gets names from the API');

  await givePlus(0);
  const paid = (await one(0, 'select my_profile_views() as v')).v;
  assert.equal(paid.plus, true);
  assert.equal(paid.viewers[0].viewer_id, users[1], 'newest first');
  assert.equal(paid.viewers[0].visits, 2);
  assert.deepEqual(new Set(paid.viewers.map((v) => v.viewer_id)), new Set([users[1], users[2], users[3]]));

  // Someone who turns "Show me in Profile views" off disappears from the list, and isn't saved any more.
  await one(2, 'select set_show_in_profile_views(false)');
  assert.equal((await one(2, 'select record_profile_view($1) as ok', [users[4]])).ok, false);
  // A block hides that person too.
  await db.query('insert into blocks(blocker_id, blocked_id) values ($1, $2)', [users[3], users[0]]);
  const later = (await one(0, 'select my_profile_views() as v')).v;
  assert.deepEqual(later.viewers.map((v) => v.viewer_id), [users[1]]);
  assert.equal(later.people, 1);

  // With the switch off you can't see your own viewers either (fair trade).
  await one(0, 'select set_show_in_profile_views(false)');
  const off = (await one(0, 'select my_profile_views() as v')).v;
  assert.equal(off.sharing, false);
  assert.deepEqual(off.viewers, []);
  assert.equal((await one(0, 'select show_in_profile_views from insight_prefs where user_id=$1', [users[0]])).show_in_profile_views, false);
  // You only ever see your own setting.
  assert.equal((await as(1, 'select * from insight_prefs')).rows.length, 0);
});

test('Visits older than 30 days are not shown', async () => {
  await givePlus(0);
  await one(1, 'select record_profile_view($1)', [users[0]]);
  await ageViews('31 days');
  const v = (await one(0, 'select my_profile_views() as v')).v;
  assert.equal(v.people, 0);
  assert.deepEqual(v.viewers, []);
});

test('Story rewatches are counted, and only a Plus owner sees who', async () => {
  await friend(db, users[0], users[1]);
  await friend(db, users[0], users[2]);
  const s = await story(0);
  await one(1, 'select record_story_view($1)', [s]);
  await one(2, 'select record_story_view($1)', [s]);
  // Two quick calls count once; a later re-open counts again.
  await one(1, 'select record_story_view($1)', [s]);
  await db.query("update private.story_rewatches set last_viewed_at = now() - interval '1 minute'");
  await one(1, 'select record_story_view($1)', [s]);
  assert.equal((await db.query('select views from private.story_rewatches where viewer_id=$1', [users[1]])).rows[0].views, 2);
  // The free "Seen by" list still has one row per person.
  assert.equal((await as(0, 'select * from story_views where story_id=$1', [s])).rows.length, 2);

  // A stranger can't count a view of a story they can't see, and the owner's own views don't count.
  await one(3, 'select record_story_view($1)', [s]);
  await one(0, 'select record_story_view($1)', [s]);
  assert.equal((await db.query('select count(*)::int as n from private.story_rewatches')).rows[0].n, 2);

  const free = (await one(0, 'select story_insights($1) as v', [s])).v;
  assert.equal(free.rewatchers, 1);
  assert.deepEqual(free.people, []);
  await givePlus(0);
  const paid = (await one(0, 'select story_insights($1) as v', [s])).v;
  assert.deepEqual(paid.people, [{ viewer_id: users[1], views: 2, screenshots: 0 }]);
  // Someone else can't read the owner's insights.
  assert.match(await outcome(as(1, 'select story_insights($1)', [s])), /Only the person who posted/);
});

test('Screenshots: the owner gets a push without a name; who took it is Plus-only', async () => {
  await friend(db, users[0], users[1]);
  const s = await story(0);
  const p = await post(0);
  await one(1, "select record_screenshot('story', $1)", [s]);
  await one(1, "select record_screenshot('story', $1)", [s]);
  await one(1, "select record_screenshot('post', $1)", [p]);
  await one(0, "select record_screenshot('post', $1)", [p]); // your own post: nothing
  await one(2, "select record_screenshot('story', $1)", [s]); // not a friend: can't see it, nothing
  await one(1, "select record_screenshot('nonsense', $1)", [p]);

  await db.query("insert into push_tokens(token, user_id, platform) values ('ExponentPushToken[qa]', $1, 'ios')", [users[0]]);
  const p2 = await post(0);
  await one(1, "select record_screenshot('post', $1)", [p2]);
  await one(1, "select record_screenshot('post', $1)", [p2]); // the second one within 30 minutes: no new push
  const sent = await pushes();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, '📸 Someone screenshotted your post');
  assert.doesNotMatch(JSON.stringify(sent[0]), /QA 1|qa_user_1/, 'the push never says who');
  assert.deepEqual(sent[0].data, { type: 'post', post: p2 });

  const freeStory = (await one(0, 'select story_insights($1) as v', [s])).v;
  assert.equal(freeStory.screenshotters, 1);
  assert.deepEqual(freeStory.people, []);
  const freePost = (await one(0, 'select post_screenshots($1) as v', [p2])).v;
  assert.equal(freePost.screenshots, 2);
  assert.equal(freePost.people, 1);
  assert.deepEqual(freePost.takers, []);

  await givePlus(0);
  const paidStory = (await one(0, 'select story_insights($1) as v', [s])).v;
  assert.deepEqual(paidStory.people, [{ viewer_id: users[1], views: 0, screenshots: 2 }]);
  const paidPost = (await one(0, 'select post_screenshots($1) as v', [p])).v;
  assert.equal(paidPost.takers[0].taker_id, users[1]);
  assert.match(await outcome(as(1, 'select post_screenshots($1)', [p])), /Only the person who posted/);
});

test('App users cannot read or write the insight tables directly', async () => {
  for (const table of ['private.profile_views', 'private.story_rewatches', 'private.content_screenshots']) {
    assert.match(await outcome(as(1, `select * from ${table}`)), /permission denied/, table);
  }
  assert.match(await outcome(as(1, 'insert into insight_prefs(user_id, show_in_profile_views) values ($1, false)', [users[1]])), /permission denied/);
  assert.match(await outcome(asUser(db, null, (tx) => tx.query('select my_profile_views()'), 'anon')), /permission denied/);
});

test('Deleting an account removes its insight rows', async () => {
  await friend(db, users[0], users[1]);
  const s = await story(0);
  await one(1, 'select record_profile_view($1)', [users[0]]);
  await one(1, 'select record_story_view($1)', [s]);
  await one(1, "select record_screenshot('story', $1)", [s]);
  await db.query('delete from auth.users where id=$1', [users[1]]);
  for (const table of ['private.profile_views', 'private.story_rewatches', 'private.content_screenshots']) {
    assert.equal((await db.query(`select count(*)::int as n from ${table}`)).rows[0].n, 0, table);
  }
});
