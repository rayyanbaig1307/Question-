// Review package DB-2: the hardening migration must keep working for heavy
// accounts and for old rows that were saved before the new rules existed.
// Every check runs the migrations in a local, in-memory PostgreSQL (PGlite).
// Nothing here talks to a live project.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { asUser, createLocalDatabase, friend, seedUsers, FIRST_FIX_MIGRATION } from './local-db.mjs';

// PostgreSQL keeps every lock a change holds in one small shared table. A
// change must use only a handful of entries there, however many files it
// touches (the tables and indexes it opens need some). A small server has room
// for about 64 entries per connection, shared by everyone.
const MAX_LOCK_ENTRIES = 400;

const one = async (db, sql, args = []) => (await db.query(sql, args)).rows[0];
const outcome = (run) => Promise.resolve().then(run).then(() => 'ok', (error) => `error: ${error.message}`);
// How many entries of the shared lock table this connection uses right now.
const lockEntries = async (tx) =>
  (await tx.query('select count(*)::int as n from pg_locks where pid=pg_backend_pid()')).rows[0].n;

// ---------------------------------------------------------------------------
// 1. Heavy accounts: one lock per file used to fill PostgreSQL's lock table
//    ("out of shared memory"), so a busy account could never be deleted.
// ---------------------------------------------------------------------------
let heavy;
let heavyUsers;
before(async () => {
  heavy = await createLocalDatabase();
  heavyUsers = await seedUsers(heavy, 4);
  await friend(heavy, heavyUsers[0], heavyUsers[1]);
  await friend(heavy, heavyUsers[0], heavyUsers[2]);
});
after(async () => { await heavy?.close(); });

// Many separate sends over months, each with its own new file name.
async function sendOpenedSnaps(db, from, to, count) {
  for (let done = 0; done < count; done += 500) {
    await db.query(`insert into public.messages(sender_id,recipient_id,kind,media_path,media_type,opened_at)
      select $1::uuid,$2::uuid,'snap',$1::text||'/snaps/'||gen_random_uuid()||'.jpg','photo',now()-interval '30 days'
        from generate_series(1,least(500,$3::int-$4::int))`, [from, to, count, done]);
  }
}

test('An account with 30,000 peeks and 2,000 posts can still be deleted', { timeout: 600_000 }, async () => {
  const [a, b] = heavyUsers;
  await sendOpenedSnaps(heavy, a, b, 30_000);
  // Posts with four files each (photo, poster, overlay, blurry preview).
  await heavy.query(`insert into public.posts(user_id,media_path,poster_path,overlay_path,blur_path)
    select $1::uuid,$1::text||'/posts/'||g||'.jpg',$1::text||'/posts/'||g||'-poster.jpg',
      $1::text||'/posts/'||g||'-overlay.png',$1::text||'/posts/'||g||'-blur.jpg' from generate_series(1,2000) g`, [a]);
  assert.equal((await one(heavy, 'select count(*)::int as n from public.messages where sender_id=$1', [a])).n, 30_000);

  const result = await outcome(() => heavy.transaction(async (tx) => {
    await tx.query('delete from auth.users where id=$1', [a]);
    const held = await lockEntries(tx);
    assert.ok(held <= MAX_LOCK_ENTRIES, `the account deletion used ${held} lock table entries`);
  }));
  assert.equal(result, 'ok');
  assert.equal((await one(heavy, 'select count(*)::int as n from public.messages where sender_id=$1 or recipient_id=$1', [a])).n, 0);
  assert.equal((await one(heavy, 'select count(*)::int as n from public.posts where user_id=$1', [a])).n, 0);
});

test('Bulk deletes (files, a big group chat, the daily cleanup) use only a few lock table entries', { timeout: 300_000 }, async () => {
  const [, b, c] = heavyUsers;
  // delete-account removes all of a person's files in one Storage call.
  await heavy.query(`insert into storage.objects(bucket_id,name,owner_id)
    select 'media',$1::text||'/snaps/'||gen_random_uuid()||'.jpg',$1::text from generate_series(1,3000)`, [b]);
  await asUser(heavy, null, (tx) => tx.query('select public.begin_account_media_deletion($1)', [b]), 'service_role');
  const files = await asUser(heavy, null, async (tx) => {
    const removed = (await tx.query("delete from storage.objects where bucket_id='media' and owner_id=$1", [b])).rowCount;
    return { removed, held: await lockEntries(tx) };
  }, 'service_role');
  assert.equal(files.removed, 3000);
  assert.ok(files.held <= MAX_LOCK_ENTRIES, `removing the files used ${files.held} lock table entries`);

  // Deleting a group removes every message in it.
  await friend(heavy, b, c);
  const grp = (await asUser(heavy, b, (tx) => tx.query("select public.create_peek_group('Big chat',$1::uuid[],current_date) as id", [[c]]))).rows[0].id;
  await heavy.query(`insert into public.group_messages(group_id,sender_id,kind,media_path,media_type)
    select $1::uuid,$2::uuid,'photo',$2::text||'/group/'||gen_random_uuid()||'.jpg','photo' from generate_series(1,3000)`, [grp, b]);
  const group = await heavy.transaction(async (tx) => {
    await tx.query('delete from public.peek_groups where id=$1', [grp]);
    return { left: (await tx.query('select count(*)::int as n from public.group_messages where group_id=$1', [grp])).rows[0].n, held: await lockEntries(tx) };
  });
  assert.equal(group.left, 0);
  assert.ok(group.held <= MAX_LOCK_ENTRIES, `deleting the group used ${group.held} lock table entries`);

  // The daily cleanup claims up to 1000 files at once.
  await heavy.query(`insert into public.stories(user_id,media_path)
    select $1::uuid,$1::text||'/stories/'||g||'.jpg' from generate_series(1,1000) g`, [c]);
  await heavy.query("update public.stories set expires_at=now()-interval '30 days' where user_id=$1", [c]);
  await heavy.query(`insert into storage.objects(bucket_id,name,owner_id)
    select 'media',$1::text||'/stories/'||g||'.jpg',$1::text from generate_series(1,1000) g`, [c]);
  const cleanup = await asUser(heavy, null, async (tx) => {
    const claimed = (await tx.query('select name from public.claim_media_cleanup(1000)')).rows.length;
    return { claimed, held: await lockEntries(tx) };
  }, 'service_role');
  assert.equal(cleanup.claimed, 1000);
  assert.ok(cleanup.held <= MAX_LOCK_ENTRIES, `the daily cleanup used ${cleanup.held} lock table entries`);
});

test('Each file name has its own lock: every step locks that one file, never an unrelated one', async () => {
  const [, , c, d] = heavyUsers;
  await friend(heavy, c, d);
  const path = `${c}/posts/own-lock.jpg`;
  // An unrelated file that fell into the same one of 1024 "slots" in the old
  // design. Sharing a slot made unrelated people wait for (and even deadlock
  // with) each other. Now it must never be touched.
  const slot = async (name) => (await one(heavy, 'select (hashtextextended($1,0) & 1023)::int as s', [name])).s;
  const target = await slot(path);
  let other;
  for (let i = 0; !other; i++) {
    const name = `${d}/posts/neighbour-${i}.jpg`;
    if (await slot(name) === target) other = name;
  }
  await asUser(heavy, d, (tx) => tx.query("insert into storage.objects(bucket_id,name) values('media',$1)", [other]));

  // Which of the two files this transaction has locked (or just added).
  const lockedHere = async (tx) => (await tx.query(`select l.object_name from private.media_path_locks l
    where l.object_name = any($1)
      and (pg_current_xact_id()::text::numeric % 4294967296)::text in (l.xmin::text, l.xmax::text)
    order by 1`, [[path, other]])).rows.map((r) => r.object_name);
  const step = (who, sql, args) => asUser(heavy, who, async (tx) => {
    const rows = (await tx.query(sql, args)).rows;
    // App users cannot read the lock table; look at it as the owner.
    await tx.query('reset role');
    const advisory = (await tx.query("select count(*)::int as n from pg_locks where locktype='advisory' and pid=pg_backend_pid()")).rows[0].n;
    return { rows, locked: await lockedHere(tx), advisory };
  });
  const seen = {};
  seen.upload = await step(c, "insert into storage.objects(bucket_id,name) values('media',$1)", [path]);
  seen.post = await step(c, 'insert into public.posts(user_id,media_path) values($1,$2) returning id', [c, path]);
  const postId = seen.post.rows[0].id;
  seen.report = await step(d, "insert into public.reports(reporter_id,reported_user_id,content_type,content_id,reason) values($1,$2,'post',$3,'spam')", [d, c, postId]);
  seen.deletePost = await step(c, 'delete from public.posts where id=$1', [postId]);
  seen.deleteFile = await step(c, "delete from storage.objects where bucket_id='media' and name=$1", [path]);

  for (const [name, result] of Object.entries(seen)) {
    assert.deepEqual(result.locked, [path], `${name} must lock exactly its own file`);
    assert.equal(result.advisory, 0, `${name} must not use shared lock slots`);
  }
});

// ---------------------------------------------------------------------------
// 2. Old rows the earlier rules allowed (a CHECK lets NULL through). The new
//    rules must refuse new bad content, but must not break unrelated updates
//    of old rows: marking a chat read, a reply losing its parent, deleting an
//    account.
// ---------------------------------------------------------------------------

// Builds the database as the live app is now (before the QA fixes), saves old
// rows, then applies the QA fix migrations in order - like a real deploy.
async function deployOverOldRows(seed) {
  const db = await createLocalDatabase({ includeFixes: false });
  const old = await seed(db);
  const folder = new URL('../../supabase/migrations/', import.meta.url);
  const fixes = (await readdir(folder)).filter((name) => name.endsWith('.sql') && name >= FIRST_FIX_MIGRATION).sort();
  for (const name of fixes) {
    let sql = await readFile(new URL(name, folder), 'utf8');
    sql = sql.replace(/create extension if not exists pg_net with schema extensions;/gi, '');
    sql = sql.replace(/create extension if not exists pg_cron;/gi, '');
    try { await db.exec(sql); } catch (error) { await db.close(); throw new Error(`Migration ${name}: ${error.message}`); }
  }
  return { db, old };
}

test('Old malformed messages keep working after the deploy; new bad ones are still refused', { timeout: 300_000 }, async () => {
  const { db, old } = await deployOverOldRows(async (db) => {
    const [a, b, c] = await seedUsers(db, 4);
    await friend(db, a, b); await friend(db, a, c); await friend(db, b, c);
    const row = (sql, args) => one(db, sql, args);
    // A 1:1 voice message with no recording, and a normal unread text after it.
    const voice = await row("insert into public.messages(sender_id,recipient_id,kind,media_path,audio_ms) values($1,$2,'voice',null,1000) returning id", [a, b]);
    await db.query("insert into public.messages(sender_id,recipient_id,kind,body) values($1,$2,'text','normal unread text')", [a, b]);
    // A group dare proof with a 2,500-letter caption that replied to B's message.
    const grp = await row("insert into public.peek_groups(name,created_by) values('g',$1) returning id", [a]);
    for (const u of [a, b, c]) await db.query('insert into public.peek_group_members(group_id,user_id,added_by,joined_day) values($1,$2,$3,current_date)', [grp.id, u, a]);
    const parent = await row("insert into public.group_messages(group_id,sender_id,body) values($1,$2,'parent text') returning id", [grp.id, b]);
    const dare = await row("insert into public.group_messages(group_id,sender_id,kind,body) values($1,$2,'dare','do it') returning id", [grp.id, a]);
    const proof = await row(`insert into public.group_messages(group_id,sender_id,kind,dare_id,media_path,media_type,body,reply_to)
      values($1,$2,'proof',$3,$4,'photo',repeat('x',2500),$5) returning id`, [grp.id, a, dare.id, `${a}/group/p.jpg`, parent.id]);
    // A group voice note without a recording that replied to B's message too.
    const gvoice = await row(`insert into public.group_messages(group_id,sender_id,kind,audio_ms,reply_to)
      values($1,$2,'voice',1000,$3) returning id`, [grp.id, c, parent.id]);
    return { a, b, c, voice: voice.id, grp: grp.id, parent: parent.id, proof: proof.id, gvoice: gvoice.id };
  });
  try {
    const { a, b, c } = old;
    const as = (u, sql, args = []) => asUser(db, u, (tx) => tx.query(sql, args));

    // (1) Opening the chat marks every message from A as read, the old voice row too.
    assert.equal(await outcome(() => as(b, 'select public.mark_chat_read($1)', [a])), 'ok');
    assert.equal((await one(db, 'select count(*)::int as n from public.messages where recipient_id=$1 and opened_at is null', [b])).n, 0);
    // (2) B can delete their own group message that the old rows replied to.
    assert.equal(await outcome(() => as(b, 'delete from public.group_messages where id=$1', [old.parent])), 'ok');
    assert.equal((await one(db, 'select reply_to from public.group_messages where id=$1', [old.proof])).reply_to, null);
    // Saving the same values again is not a change either.
    assert.equal(await outcome(() => db.query('update public.group_messages set body=body, kind=kind where id=$1', [old.proof])), 'ok');
    // (3) Account deletion cascades through the old rows (C sent the bad group voice note).
    assert.equal(await outcome(() => db.query('delete from auth.users where id=$1', [c])), 'ok');

    // Changing the checked content of an old row is checked like new content.
    const refused = async (run, name) => {
      const error = await Promise.resolve().then(run).then(() => null, (e) => e);
      assert.ok(error, `${name} must be refused`);
      assert.equal(error.code, '23514', `${name}: ${error.message}`);
      assert.match(error.message, new RegExp(name));
    };
    await refused(() => db.query('update public.group_messages set body=repeat(\'y\',2600) where id=$1', [old.proof]), 'group_messages_body_size');
    await refused(() => db.query('update public.messages set audio_ms=2000 where id=$1', [old.voice]), 'messages_voice_content_required');
    // A fix that makes it valid is fine.
    assert.equal(await outcome(() => db.query("update public.messages set media_path=$2 where id=$1", [old.voice, `${a}/voice/fixed.m4a`])), 'ok');

    // New bad rows are still refused, with the same names and code as before.
    await refused(() => as(a, "insert into public.messages(sender_id,recipient_id,kind,audio_ms) values($1,$2,'voice',1000)", [a, b]), 'messages_voice_content_required');
    await refused(() => as(a, "insert into public.messages(sender_id,recipient_id,kind) values($1,$2,'screenshot')", [a, b]), 'messages_screenshot_content_required');
    await refused(() => as(a, "insert into public.messages(sender_id,recipient_id,kind,media_path,audio_ms,waveform) values($1,$2,'voice',$3,1000,$4)", [a, b, `${a}/voice/w.m4a`, [101]]), 'messages_waveform_values');
    const gm = (u, fields) => {
      const keys = Object.keys(fields);
      return as(u, `insert into public.group_messages(group_id,sender_id,${keys}) values($1,$2,${keys.map((_, n) => `$${n + 3}`)})`, [old.grp, u, ...Object.values(fields)]);
    };
    await refused(() => gm(a, { kind: 'voice', audio_ms: 1000 }), 'group_messages_voice_required');
    await refused(() => gm(a, { kind: 'voice', media_path: `${a}/voice/g.m4a`, audio_ms: 1000, waveform: [-1] }), 'group_messages_waveform_valid');
    await refused(() => gm(a, { kind: 'text', body: 'x'.repeat(2001) }), 'group_messages_body_size');
    await refused(() => gm(a, { kind: 'photo', media_path: `${a}/group/k.jpg`, media_type: 'video' }), 'group_messages_media_kind');
    // Good rows still save.
    assert.equal(await outcome(() => gm(a, { kind: 'voice', media_path: `${a}/voice/ok.m4a`, audio_ms: 1000, waveform: [1, 50, 100] })), 'ok');
    assert.equal(await outcome(() => as(a, "insert into public.messages(sender_id,recipient_id,kind,body) values($1,$2,'screenshot','chat')", [a, b])), 'ok');

    // The rules no longer exist as half-checked (NOT VALID) table checks.
    const unchecked = (await db.query(`select conname from pg_constraint
      where conrelid in ('public.messages'::regclass,'public.group_messages'::regclass) and not convalidated`)).rows.map((r) => r.conname);
    assert.deepEqual(unchecked, []);
  } finally {
    await db.close();
  }
});
