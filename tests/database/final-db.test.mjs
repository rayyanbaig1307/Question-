// Review package F-DB: the last database fixes before release.
// Every check runs the migrations in a local, in-memory PostgreSQL (PGlite).
// Nothing here talks to a live project.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { asUser, createLocalDatabase, friend, initializeDatabase, seedUsers } from './local-db.mjs';

let db;
let users;
before(async () => { db = await createLocalDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('truncate auth.users cascade; truncate storage.objects, net.sent restart identity; truncate private.media_cleanup_claims, private.media_deferred_deletions;');
  users = await seedUsers(db);
});

const rpc = (i, sql, args = []) => asUser(db, users[i], (tx) => tx.query(sql, args));
const server = (sql, args = []) => asUser(db, null, (tx) => tx.query(sql, args), 'service_role');
const failure = (run) => run.then(() => 'ok', (error) => error.message);

// ---------------------------------------------------------------------------
// 1. A hidden dare idea does not give away who wrote it.
// ---------------------------------------------------------------------------
const directReport = (i, idea) => rpc(i,
  "insert into reports(reporter_id,reported_user_id,content_type,content_id,reason) values($1,$2,'dare_idea',$3,'spam') returning reported_user_id",
  [users[i], users[i], idea]);
async function hiddenIdea() {
  const idea = (await rpc(0, "insert into dare_ideas(user_id,text) values($1,'Wear a silly hat all day') returning id", [users[0]])).rows[0].id;
  for (const i of [1, 2, 3]) await rpc(i, "select report_dare_idea($1,'spam')", [idea]);
  assert.equal((await db.query('select hidden from dare_ideas where id=$1', [idea])).rows[0].hidden, true);
  return idea;
}

test('A direct report of a hidden dare idea does not show who wrote it', async () => {
  const idea = await hiddenIdea();
  const before = (await db.query('select count(*)::int as n from reports')).rows[0].n;
  // The idea is hidden: an app user cannot see it, so cannot report it (or learn its author).
  const hidden = await failure(directReport(4, idea));
  const missing = await failure(directReport(4, randomUUID()));
  assert.match(hidden, /gone or you can't see it/);
  // Same answer as for an idea that does not exist at all.
  assert.equal(hidden, missing);
  assert.equal((await db.query('select count(*)::int as n from reports')).rows[0].n, before);
});

test('Dare idea reports the app sends still work, and still hide an idea after three reports', async () => {
  const idea = (await rpc(0, "insert into dare_ideas(user_id,text) values($1,'Sing in the shower loudly') returning id", [users[0]])).rows[0].id;
  // A visible idea can still be reported directly; the author comes from the idea itself.
  assert.deepEqual((await directReport(5, idea)).rows, [{ reported_user_id: users[0] }]);
  // The app's way (src/lib/communityDares.ts reportIdea).
  for (const i of [1, 2]) await rpc(i, "select report_dare_idea($1,'spam')", [idea]);
  assert.equal((await db.query('select hidden from dare_ideas where id=$1', [idea])).rows[0].hidden, true);
  assert.equal((await db.query("select count(*)::int as n from reports where content_type='dare_idea' and content_id=$1", [idea])).rows[0].n, 3);
  // Reporting twice is still fine (nothing new is saved).
  await rpc(1, "select report_dare_idea($1,'spam')", [idea]);
  // Someone else reporting it after it was hidden gets the "gone" answer, and nothing is saved.
  assert.match(await failure(rpc(6, "select report_dare_idea($1,'spam')", [idea])), /gone/);
  assert.equal((await db.query("select count(*)::int as n from reports where content_type='dare_idea' and content_id=$1", [idea])).rows[0].n, 3);
  // The author can still see (and report) their own hidden idea.
  assert.deepEqual((await directReport(0, idea)).rows, [{ reported_user_id: users[0] }]);
  // Trusted code (owner / service role) is not limited by what an app user can see.
  const saved = await server("insert into reports(reporter_id,reported_user_id,content_type,content_id,reason) values($1,$1,'dare_idea',$2,'spam') returning reported_user_id", [users[7], idea]);
  assert.deepEqual(saved.rows, [{ reported_user_id: users[0] }]);
});

// ---------------------------------------------------------------------------
// 2. The daily cleanup only checks files that still exist.
// ---------------------------------------------------------------------------

// The daily cleanup lists exactly as they were worked out before this fix
// (20261213200000 and 20261213210000). The new versions must give the same answer.
const OLD_CANDIDATES = `
  with dead as (
    select e.path from private.expired_media_paths() as e(path)
    union all
    select d.object_name from private.media_deferred_deletions d
  )
  select distinct d.path as name from dead d join storage.objects o on o.bucket_id = 'media' and o.name = d.path
  where d.path is not null and private.media_cleanup_eligible(d.path)
  order by d.path limit least(1000, greatest(coalesce($1::integer, 0), 0))`;
const OLD_HELD = `
  select distinct e.path as name from private.expired_media_paths() as e(path)
    join storage.objects o on o.bucket_id = 'media' and o.name = e.path
  where e.path is not null
    and not private.media_deletion_deferred(e.path)
    and private.media_held_as_evidence(e.path)
  order by 1`;
const names = (result) => result.rows.map((r) => r.name);
const file = async (path, bucket = 'media') => {
  await db.query('insert into storage.objects(bucket_id,name) values($1,$2)', [bucket, path]);
  return path;
};
const ago = (days) => `now() - interval '${days} days'`;

// Old and new data of every kind the cleanup looks at.
async function mixedFixture() {
  await db.query("insert into storage.buckets(id,name,public) values('other','other',false) on conflict do nothing");
  await friend(db, users[0], users[1]);
  await friend(db, users[0], users[2]);
  const u = users[0];
  const p = (folder, label) => `${u}/${folder}/${label}.jpg`;
  const story = async (media, extra = {}, days = 8) => {
    const id = (await db.query('insert into stories(user_id,media_path,poster_path,overlay_path) values($1,$2,$3,$4) returning id',
      [u, media, extra.poster ?? null, extra.overlay ?? null])).rows[0].id;
    await db.query(`update stories set expires_at=${ago(days)} where id=$1`, [id]);
    return id;
  };
  const snap = async (media, opened, saved = false, poster = null) => {
    const id = (await db.query("insert into messages(sender_id,recipient_id,kind,media_path,poster_path,media_type) values($1,$2,'snap',$3,$4,'photo') returning id",
      [u, users[1], media, poster])).rows[0].id;
    if (opened !== null) await db.query(`update messages set opened_at=${ago(opened)}, saved_at=${saved ? 'now()' : 'null'} where id=$1`, [id]);
    return id;
  };
  const guess = async (media, days) => {
    const id = (await db.query('insert into mystery_posts(user_id,media_path) values($1,$2) returning id', [u, media])).rows[0].id;
    await db.query(`update mystery_posts set expires_at=${ago(days)} where id=$1`, [id]);
    return id;
  };
  // Expired stories: with files, with poster/overlay, with files already gone.
  await story(await file(p('stories', 's-live')), { poster: await file(p('stories', 's-poster')), overlay: p('stories', 's-overlay-gone') });
  await story(p('stories', 's-gone'));
  // An expired story whose picture a post still uses (in use: not a candidate).
  const shared = await file(p('posts', 'shared'));
  await story(shared);
  await db.query('insert into posts(user_id,media_path) values($1,$2)', [u, shared]);
  // An expired story whose picture a keep in the owner's folder still uses.
  const kept = await file(p('stories', 's-kept'));
  await story(kept);
  await db.query("insert into keeps(user_id,media_path,media_type) values($1,$2,'photo')", [u, kept]);
  // A story that ended only 2 days ago (not old enough).
  await story(await file(p('stories', 's-recent')), {}, 2);
  // A reported old story (kept for the report).
  const reportedStory = await story(await file(p('stories', 's-reported')), {}, 1);
  await asUser(db, users[1], (tx) => tx.query("insert into reports(reporter_id,reported_user_id,content_type,content_id,reason) values($1,$2,'story',$3,'spam')", [users[1], u, reportedStory]));
  await db.query(`update stories set expires_at=${ago(9)} where id=$1`, [reportedStory]);
  // Peeks: opened long ago, opened recently, saved, never opened, file gone, two rows with one file.
  await snap(await file(p('snaps', 'old')), 8, false, await file(p('snaps', 'old-poster')));
  await snap(await file(p('snaps', 'recent')), 2);
  await snap(await file(p('snaps', 'saved')), 8, true);
  await snap(await file(p('snaps', 'unopened')), null);
  await snap(p('snaps', 'old-gone'), 8);
  const twice = await file(p('snaps', 'twice'));
  await snap(twice, 9);
  await snap(twice, 10);
  // A file with the same name in another bucket only (not the media bucket).
  await snap(await file(p('snaps', 'other-bucket'), 'other'), 8);
  // A peek still used by a group chat message (in use).
  const grp = (await asUser(db, u, (tx) => tx.query("select create_peek_group('QA cleanup',$1::uuid[],current_date) as id", [[users[1]]]))).rows[0].id;
  const groupFile = await file(p('group', 'shared'));
  await snap(groupFile, 8);
  await db.query("insert into group_messages(group_id,sender_id,kind,media_path,media_type) values($1,$2,'photo',$3,'photo')", [grp, u, groupFile]);
  // Guess Who posts: old with file, old without file, recent.
  p.oldGuess = await file(`mystery/${randomUUID()}.jpg`);
  await guess(p.oldGuess, 8);
  await guess(`mystery/${randomUUID()}.jpg`, 8);
  await guess(await file(`mystery/${randomUUID()}.jpg`), 1);
  // Files an app user deleted (waiting for the cleanup): one free, one gone, one still in use, one reported.
  await db.query('insert into private.media_deferred_deletions(object_name) values ($1),($2),($3)',
    [await file(p('posts', 'deferred-free')), p('posts', 'deferred-gone'), shared]);
  const reportedPost = (await db.query('insert into posts(user_id,media_path) values($1,$2) returning id', [u, await file(p('posts', 'deferred-reported'))])).rows[0].id;
  await asUser(db, users[2], (tx) => tx.query("insert into reports(reporter_id,reported_user_id,content_type,content_id,reason) values($1,$2,'post',$3,'spam')", [users[2], u, reportedPost]));
  await db.query('delete from posts where id=$1', [reportedPost]);
  await db.query('insert into private.media_deferred_deletions(object_name) values ($1)', [p('posts', 'deferred-reported')]);
  // An old reported story file already waiting (deferred): not listed again as "held".
  const reportedTwice = await story(await file(p('stories', 's-reported-deferred')), {}, 1);
  await asUser(db, users[1], (tx) => tx.query("insert into reports(reporter_id,reported_user_id,content_type,content_id,reason) values($1,$2,'story',$3,'spam')", [users[1], u, reportedTwice]));
  await db.query(`update stories set expires_at=${ago(9)} where id=$1`, [reportedTwice]);
  await db.query('insert into private.media_deferred_deletions(object_name) values ($1)', [p('stories', 's-reported-deferred')]);
  return p;
}

test('The daily cleanup lists the same files as before on a mixed set of old and new content', async () => {
  const p = await mixedFixture();
  for (const max of [null, -5, 0, 1, 3, 500, 5000]) {
    const old = names(await db.query(OLD_CANDIDATES, [max]));
    const now = names(await db.query('select name from public.media_cleanup_candidates($1)', [max]));
    assert.deepEqual(now, old, `max_files=${max}`);
  }
  // The fixture really covers both sides: these files are listed, every other one is not
  // (still in use, too new, saved, kept for a report, in another bucket, or already gone).
  const all = names(await db.query('select name from public.media_cleanup_candidates(1000)'));
  assert.deepEqual(new Set(all), new Set([p('posts', 'deferred-free'), p('snaps', 'old'), p('snaps', 'old-poster'),
    p('snaps', 'twice'), p('stories', 's-live'), p('stories', 's-poster'), p.oldGuess]));
  // "Held for a report" (step 1 of claim_media_cleanup) is also unchanged.
  const held = names(await db.query('select h as name from private.media_cleanup_held_paths() h'));
  assert.deepEqual(held, names(await db.query(OLD_HELD)));
  assert.deepEqual(held, [p('stories', 's-reported')]);
});

test('The daily cleanup only checks files that still exist, not every old peek ever sent', async () => {
  await friend(db, users[0], users[1]);
  // 400 peeks opened long ago whose files the cleanup already removed, and 3 whose files are still there.
  await db.query(`insert into messages(sender_id,recipient_id,kind,media_path,media_type)
    select $1::uuid,$2::uuid,'snap',$1::text||'/snaps/history-'||g||'.jpg','photo' from generate_series(1,400) g`, [users[0], users[1]]);
  const live = [];
  for (let n = 0; n < 3; n++) {
    const path = await file(`${users[0]}/snaps/live-${n}.jpg`);
    await db.query("insert into messages(sender_id,recipient_id,kind,media_path,media_type) values($1,$2,'snap',$3,'photo')", [users[0], users[1], path]);
    live.push(path);
  }
  await db.query(`update messages set opened_at=${ago(8)} where sender_id=$1`, [users[0]]);
  // Count how often the slow per-file checks run, by wrapping them for this one test.
  const counted = await db.transaction(async (tx) => {
    for (const fn of ['media_cleanup_eligible', 'media_held_as_evidence']) {
      await tx.exec(`alter function private.${fn}(text) rename to ${fn}_counted;
        create function private.${fn}(path_value text) returns boolean language plpgsql stable security definer set search_path = '' as $$
        begin
          perform set_config('qa.${fn}', (coalesce(nullif(current_setting('qa.${fn}', true), ''), '0')::integer + 1)::text, true);
          return private.${fn}_counted(path_value);
        end $$;`);
    }
    const listed = names(await tx.query('select name from public.media_cleanup_candidates(1000)'));
    const eligibleChecks = Number((await tx.query("select current_setting('qa.media_cleanup_eligible', true) as n")).rows[0].n || 0);
    await tx.query("select set_config('qa.media_cleanup_eligible','0',true), set_config('qa.media_held_as_evidence','0',true)");
    await tx.exec('set local role service_role');
    const claimed = names(await tx.query('select name from public.claim_media_cleanup(1000)'));
    await tx.exec('reset role');
    const claimChecks = (await tx.query("select current_setting('qa.media_cleanup_eligible', true) as e, current_setting('qa.media_held_as_evidence', true) as h")).rows[0];
    await tx.rollback();
    return { listed, claimed, eligibleChecks, claimEligible: Number(claimChecks.e || 0), claimHeld: Number(claimChecks.h || 0) };
  });
  assert.deepEqual(counted.listed, live);
  assert.deepEqual(counted.claimed, live);
  // Only the 3 files that still exist are checked (the old way checked all 403 paths).
  assert.ok(counted.eligibleChecks <= live.length, JSON.stringify(counted));
  assert.ok(counted.claimEligible <= 2 * live.length, JSON.stringify(counted));
  assert.ok(counted.claimHeld <= 3 * live.length, JSON.stringify(counted));
});

test('The new cleanup helper cannot be run by app users or visitors', async () => {
  for (const role of ['authenticated', 'anon']) {
    const ok = (await db.query("select has_function_privilege($1, 'private.media_cleanup_held_paths()', 'EXECUTE') as ok", [role])).rows[0].ok;
    assert.equal(ok, false, role);
  }
  await assert.rejects(() => rpc(0, 'select * from private.media_cleanup_held_paths()'), /permission denied/);
});

// ---------------------------------------------------------------------------
// 3. The local database copies the hosted project's function defaults.
// ---------------------------------------------------------------------------
test('The local database gives new public functions to app roles the way a hosted project does', async () => {
  const acl = (await db.query(`select defaclacl::text as acl from pg_default_acl
    where defaclnamespace='public'::regnamespace and defaclobjtype='f'`)).rows.map((r) => r.acl).join(' ');
  for (const role of ['anon', 'authenticated', 'service_role']) assert.match(acl, new RegExp(`${role}=X`), role);
});

// ---------------------------------------------------------------------------
// 4. tests/database/deployment-preflight.sql stays read-only and works before the fixes.
// ---------------------------------------------------------------------------
const PREFLIGHT = new URL('./deployment-preflight.sql', import.meta.url);
const MIGRATIONS = new URL('../../supabase/migrations/', import.meta.url);
async function preflightQueries() {
  const text = await readFile(PREFLIGHT, 'utf8');
  // Each query ends with ";" at the end of a line. Its comment lines come just before it.
  return text.split(/;\s*$/m).map((chunk) => {
    const lines = chunk.split('\n');
    const comment = lines.filter((l) => l.trim().startsWith('--')).join('\n');
    const sql = lines.filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    return { comment, sql };
  }).filter((q) => q.sql);
}
const readOnly = (database, sql) => database.transaction(async (tx) => {
  await tx.exec('set transaction read only');
  return (await tx.query(sql)).rows;
});
async function runPreflight(database, { wordFilter }) {
  const out = {};
  for (const q of await preflightQueries()) {
    // The label closest to the query (the file's header also explains the labels).
    const label = [...q.comment.matchAll(/\[(?:HARD BLOCKER|INFO)\] ([^\n]+)/g)].at(-1)?.[1] ?? q.sql.slice(0, 40);
    if (!wordFilter && /blocked_word/.test(q.sql)) continue;
    out[label.trim()] = await readOnly(database, q.sql);
  }
  return out;
}
async function migrationText(name) {
  let sql = await readFile(new URL(name, MIGRATIONS), 'utf8');
  sql = sql.replace(/create extension if not exists pg_net with schema extensions;/gi, '');
  return sql.replace(/create extension if not exists pg_cron;/gi, '');
}
const HARDENING = '20261213102659_qa_round2_security_hardening.sql';
const MEDIA_FIXES = '20261213200000_qa_review_media_fixes.sql';
const pick = (results, word) => {
  const key = Object.keys(results).find((k) => k.toLowerCase().includes(word));
  assert.ok(key, `no preflight query about "${word}" in ${Object.keys(results).join(' | ')}`);
  return results[key];
};

// Every name a fix migration (20261213102659 and later) makes that must NOT exist
// beforehand, worked out from the migration files themselves. A name made with
// "if not exists" (or "or replace"), or removed earlier with "drop ...", does not
// stop a migration, so it is left out. Returns which file each name would stop,
// and which of those names exist after each file (some are removed again later).
async function namesFixMigrationsNeedFree() {
  const files = (await readdir(MIGRATIONS)).filter((n) => n.endsWith('.sql') && n >= HARDENING).sort();
  const stops = new Map();
  const removedBefore = new Set();
  const there = new Set();
  const after = {};
  const on = (schema, table) => `${schema}.${table}`.toLowerCase();
  for (const file of files) {
    const text = (await readFile(new URL(file, MIGRATIONS), 'utf8')).replace(/--[^\n]*/g, '');
    const found = [];
    const made = (m, key, free = true) => found.push({ at: m.index, key, made: true, free });
    const gone = (m, key) => found.push({ at: m.index, key, made: false });
    for (const m of text.matchAll(/\bcreate\s+table\s+(if\s+not\s+exists\s+)?(\w+)\.(\w+)/gi)) made(m, `table|${on(m[2], m[3])}`, !m[1]);
    for (const m of text.matchAll(/\bcreate\s+(?:unique\s+)?index\s+(if\s+not\s+exists\s+)?(\w+)\s+on\s+(\w+)\.\w+/gi)) made(m, `index|${on(m[3], m[2])}`, !m[1]);
    for (const m of text.matchAll(/\balter\s+table\s+(\w+)\.(\w+)\s+add\s+column\s+(if\s+not\s+exists\s+)?(\w+)/gi)) made(m, `column|${on(m[1], m[2])}.${m[4]}`, !m[3]);
    for (const m of text.matchAll(/\balter\s+table\s+(\w+)\.(\w+)\s+add\s+constraint\s+(\w+)/gi)) made(m, `check|${m[3]} on ${on(m[1], m[2])}`);
    for (const m of text.matchAll(/\balter\s+table\s+(\w+)\.(\w+)\s+drop\s+constraint\s+(?:if\s+exists\s+)?(\w+)/gi)) gone(m, `check|${m[3]} on ${on(m[1], m[2])}`);
    for (const m of text.matchAll(/\bcreate\s+policy\s+"([^"]+)"\s+on\s+(\w+)\.(\w+)/gi)) made(m, `storage rule|${m[1]} on ${on(m[2], m[3])}`);
    for (const m of text.matchAll(/\bdrop\s+policy\s+(?:if\s+exists\s+)?"([^"]+)"\s+on\s+(\w+)\.(\w+)/gi)) gone(m, `storage rule|${m[1]} on ${on(m[2], m[3])}`);
    for (const m of text.matchAll(/\bdrop\s+trigger\s+(?:if\s+exists\s+)?(\w+)\s+on\s+(\w+)\.(\w+)/gi)) gone(m, `trigger|${m[1]} on ${on(m[2], m[3])}`);
    for (const m of text.matchAll(/\bdrop\s+(table|index)\s+(?:if\s+exists\s+)?(\w+)\.(\w+)/gi)) gone(m, `${m[1].toLowerCase()}|${on(m[2], m[3])}`);
    for (const m of text.matchAll(/\bcreate\s+(or\s+replace\s+)?trigger\s+(\w+)[\s\S]*?\bon\s+(\w+)\.(%I|\w+)/gi)) {
      // A trigger made in a loop ("on public.%I") is made on every table of the list just above it.
      const tables = m[4] !== '%I' ? [m[4]]
        : [...text.slice(0, m.index).matchAll(/array\s*\[([^\]]*)\]/gi)].at(-1)[1].match(/'\w+'/g).map((t) => t.slice(1, -1));
      for (const t of tables) made(m, `trigger|${m[2]} on ${on(m[3], t)}`, !m[1]);
    }
    for (const step of found.sort((a, b) => a.at - b.at)) {
      if (!step.made) { removedBefore.add(step.key); there.delete(step.key); continue; }
      if (step.free && !removedBefore.has(step.key) && !stops.has(step.key)) stops.set(step.key, file);
      there.add(step.key);
    }
    after[file] = [...there].filter((key) => stops.has(key)).sort();
  }
  return { stops, after, last: files.at(-1) };
}
const listedNames = (rows) => rows.map((r) => `${r.kind}|${r.name}`).sort();

test('The preflight file only reads, and marks each query as a hard blocker or for information', async () => {
  const queries = await preflightQueries();
  const lastLabel = (q) => [...q.comment.matchAll(/\[(HARD BLOCKER|INFO)\]/g)].at(-1)?.[1];
  for (const q of queries) {
    assert.match(q.sql, /^(select|with)\b/i, q.sql.slice(0, 80));
    assert.ok(lastLabel(q), `unlabelled query: ${q.sql.slice(0, 80)}`);
  }
  // Duplicate forfeit payments stop the hardening migration: a hard blocker. Old rows are only for information.
  assert.equal(lastLabel(queries.find((q) => /forfeit_id/.test(q.sql))), 'HARD BLOCKER');
  for (const table of ['public.messages', 'public.group_messages', 'public.keeps']) {
    assert.equal(lastLabel(queries.find((q) => q.sql.includes(`from ${table}`))), 'INFO', table);
  }
  const text = await readFile(PREFLIGHT, 'utf8');
  assert.doesNotMatch(text, /NOT VALID constraints reject/i, 'the message rules are triggers now, not NOT VALID checks');
});

test('The preflight queries run read-only on a database the fixes have not touched, and find what they should', async () => {
  const old = await initializeDatabase(await PGlite.create(), { includeFixes: false });
  try {
    const people = await seedUsers(old, 5);
    // An old keep that points at someone else's file, and two payments for one forfeit.
    await old.query("insert into keeps(user_id,media_path,media_type,poster_path) values($1,$2,'photo',$3)",
      [people[0], `${people[0]}/keeps/mine.jpg`, `${people[1]}/posts/theirs.jpg`]);
    await old.query("insert into keeps(user_id,media_path,media_type) values($1,$2,'photo')", [people[0], `${people[0]}/keeps/fine.jpg`]);
    await old.exec('set session_replication_role = replica');
    const forfeit = randomUUID();
    for (let n = 0; n < 2; n++) await old.query('insert into posts(user_id,media_path,forfeit_id) values($1,$2,$3)', [people[2], `${people[2]}/posts/f${n}.jpg`, forfeit]);
    await old.exec('set session_replication_role = origin');
    // Old reports: the old rule let anyone report anything, even what they could not see.
    // people[3] has a private account; people[4] is their friend; people[2] is a stranger to them.
    const [, , stranger, owner, pal] = people;
    await friend(old, owner, pal);
    await old.query('update profiles set is_private=true where id=$1', [owner]);
    const postOf = async (who, name) => (await old.query('insert into posts(user_id,media_path) values($1,$2) returning id', [who, `${who}/posts/${name}.jpg`])).rows[0].id;
    const privatePost = await postOf(owner, 'private');
    const publicPost = await postOf(people[1], 'public');
    const snap = (await old.query("insert into messages(sender_id,recipient_id,kind,media_path) values($1,$2,'snap',$3) returning id", [owner, pal, `${owner}/snaps/s.jpg`])).rows[0].id;
    const reportBy = async (who, type, id, status = 'open') => (await old.query(
      'insert into reports(reporter_id,content_type,content_id,reason,status) values($1,$2,$3,$4,$5) returning id', [who, type, id, 'spam', status])).rows[0].id;
    const unseen = [await reportBy(stranger, 'post', privatePost), await reportBy(stranger, 'message', snap, 'reviewed')];
    await reportBy(pal, 'post', privatePost); // a friend could see it
    await reportBy(stranger, 'post', publicPost); // a public account: anyone could see it
    await reportBy(stranger, 'post', privatePost, 'dismissed'); // dismissed reports keep no files
    await reportBy(stranger, 'user', owner); // a report about a person keeps no files
    const results = await runPreflight(old, { wordFilter: false });
    assert.deepEqual(pick(results, 'forfeit').map((r) => r.forfeit_id), [forfeit]);
    assert.deepEqual(pick(results, 'keep').map((r) => r.poster_path), [`${people[1]}/posts/theirs.jpg`]);
    assert.deepEqual(pick(results, 'names'), []);
    const cannotSee = pick(results, 'cannot see');
    assert.deepEqual(cannotSee.map((r) => r.id).sort(), [...unseen].sort());
    assert.deepEqual(cannotSee.find((r) => r.id === unseen[0]).files, [`${owner}/posts/private.jpg`]);
    // The hardening migration has not run, so there is no evidence to release yet.
    assert.deepEqual(pick(results, 'evidence'), []);
  } finally { await old.close(); }
});

test('The preflight lists exactly the evidence the media fix migration then releases', async () => {
  // A database where the hardening migration already ran, but the later fixes did not.
  const mid = await initializeDatabase(await PGlite.create(), { includeFixes: false });
  try {
    await mid.exec(await migrationText(HARDENING));
    const people = await seedUsers(mid, 3);
    await friend(mid, people[0], people[1]);
    const as = (i, sql, args = []) => asUser(mid, people[i], (tx) => tx.query(sql, args));
    const postWithFile = async (label) => {
      const path = `${people[0]}/posts/${label}.jpg`;
      await as(0, "insert into storage.objects(bucket_id,name) values('media',$1)", [path]);
      return (await as(0, 'insert into posts(user_id,media_path) values($1,$2) returning id', [people[0], path])).rows[0].id;
    };
    const reportOf = async (type, id) => (await as(1, "insert into reports(reporter_id,reported_user_id,content_type,content_id,reason) values($1,$2,$3,$4,'spam') returning id", [people[1], people[0], type, id])).rows[0].id;
    const commented = await postWithFile('commented');
    const comment = (await as(0, "insert into comments(user_id,post_id,body) values($1,$2,'a comment') returning id", [people[0], commented])).rows[0].id;
    const commentReport = await reportOf('comment', comment);
    const dismissed = await reportOf('post', await postWithFile('dismissed'));
    await mid.query("update reports set status='dismissed' where id=$1", [dismissed]);
    const open = await reportOf('post', await postWithFile('open'));
    const evidenceRows = async () => (await mid.query('select report_id::text, object_name from private.report_media_evidence order by 1, 2')).rows;
    const beforeFix = await evidenceRows();
    const results = await runPreflight(mid, { wordFilter: false });
    const listed = pick(results, 'evidence').map((r) => ({ report_id: r.report_id, object_name: r.object_name }));
    assert.deepEqual(new Set(listed.map((r) => r.report_id)), new Set([commentReport, dismissed]));
    // On a copy where the hardening migration already ran, its own names are taken
    // (and listed); the names the later files make are still free.
    const { after } = await namesFixMigrationsNeedFree();
    assert.deepEqual(listedNames(pick(results, 'names')), after[HARDENING]);
    // Now run the media fix migration: it releases exactly what the preflight listed.
    await mid.exec(await migrationText(MEDIA_FIXES));
    const afterFix = await evidenceRows();
    const released = beforeFix.filter((r) => !afterFix.some((a) => a.report_id === r.report_id && a.object_name === r.object_name));
    const key = (r) => `${r.report_id} ${r.object_name}`;
    assert.deepEqual(released.map(key).sort(), listed.map(key).sort());
    assert.ok(afterFix.some((r) => r.report_id === open), 'an open report keeps its evidence');
  } finally { await mid.close(); }
});

test('The preflight "names must be free" query lists exactly the names that would stop a fix migration', async () => {
  const { stops, after, last } = await namesFixMigrationsNeedFree();
  // The list read from the migration files has what it should (so the check below means something).
  for (const key of ['table|private.report_media_evidence', 'index|public.posts_one_payment_per_forfeit',
    'column|public.reports.anonymous_content', 'check|messages_voice_content_required on public.messages',
    'trigger|reports_prepare on public.reports', 'trigger|objects_guard_claimed_cleanup on storage.objects',
    'trigger|lock_deleted_content_media on public.group_messages',
    'storage rule|An existing profile is required for uploads on storage.objects',
    'table|private.media_deferred_deletions', 'trigger|zz_messages_content_rules on public.messages']) {
    assert.ok(stops.has(key), `${key} not found in the migration files`);
  }
  assert.equal(stops.get('trigger|reports_prepare on public.reports'), HARDENING);
  assert.equal(stops.get('table|private.media_deferred_deletions'), MEDIA_FIXES);
  // Made with "if not exists", or removed first with "drop ...": these never stop a migration.
  for (const key of ['table|private.media_path_locks', 'trigger|word_filter on public.profiles',
    'check|reports_content_type_check on public.reports', 'check|peek_groups_name_size on public.peek_groups',
    'column|public.username_auth_log.reservation', 'index|public.posts_media_path_idx']) {
    assert.ok(!stops.has(key), `${key} should not be listed`);
  }
  // On the fully migrated test database the query lists exactly the names that
  // still exist there, each with the migration it would stop.
  const rows = pick(await runPreflight(db, { wordFilter: true }), 'names');
  assert.deepEqual(listedNames(rows), after[last]);
  for (const r of rows) assert.equal(r.migration, stops.get(`${r.kind}|${r.name}`), `${r.kind}|${r.name}`);
  const query = (await preflightQueries()).find((q) => /pg_trigger/.test(q.sql));
  assert.match(query.comment, /\[HARD BLOCKER\]/);
  assert.doesNotMatch(query.sql, /media_path_locks/, 'private.media_path_locks is made with "if not exists", so it never stops a migration');
});
