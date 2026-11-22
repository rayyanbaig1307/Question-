// Main Character Mode 🌆: the folder for new characters and scenes (supabase/migrations/20261231000000_main_character.sql).
// The owner uploads pictures in the Supabase dashboard; the app only lists and downloads them. Anyone logged in can
// see them, nobody can upload, change or delete them from the app, and visitors who aren't logged in can't list
// them. Runs every migration in a local, in-memory PostgreSQL (PGlite) with invented people and invented file
// names. Nothing here talks to a live project.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { asUser, createLocalDatabase, migrationSql, seedUsers } from './local-db.mjs';

const MIGRATION = '20261231000000_main_character.sql';
const BUCKET = 'main-character';

let db;
let users;
before(async () => { db = await createLocalDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('truncate auth.users cascade; truncate storage.objects, net.sent restart identity;');
  users = await seedUsers(db, 3);
});

const as = (i, sql, args = []) => asUser(db, users[i], (tx) => tx.query(sql, args));
const asVisitor = (sql, args = []) => asUser(db, null, (tx) => tx.query(sql, args), 'anon');
const failure = (run) => run.then(() => 'ok', (error) => error.message);
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const count = async (sql, args = []) => (await one(`select count(*)::int as n from ${sql}`, args)).n;

// What the owner uploads in the dashboard (the dashboard isn't held back by the app's rules).
async function ownerUploads(...names) {
  for (const name of names) {
    await asUser(db, null, (tx) => tx.query(
      'insert into storage.objects(bucket_id, name, owner_id, metadata) values ($1, $2, null, $3)',
      [BUCKET, name, { eTag: '"0123456789abcdef0123456789abcdef"', size: 1234, mimetype: 'image/webp' }],
    ), 'service_role');
  }
}
// The files person i can list in the folder (Storage only lists what the person can "see" in storage.objects).
const listed = async (i) =>
  (await as(i, 'select name from storage.objects where bucket_id = $1 order by name', [BUCKET])).rows.map((r) => r.name);

test('The folder is public, takes files up to 1.5 MB, and only pictures and the small .json files', async () => {
  const bucket = await one('select * from storage.buckets where id = $1', [BUCKET]);
  assert.equal(bucket.name, BUCKET);
  assert.equal(bucket.public, true);
  assert.equal(Number(bucket.file_size_limit), 1_572_864);
  assert.deepEqual(bucket.allowed_mime_types, ['image/webp', 'image/png', 'image/jpeg', 'application/json']);
});

test('Anyone logged in can list and see the pictures; visitors who are not logged in can not', async () => {
  await ownerUploads('characters/made-up-hero.webp', 'characters/made-up-hero.json', 'backgrounds/made-up-town.jpg');
  const all = ['backgrounds/made-up-town.jpg', 'characters/made-up-hero.json', 'characters/made-up-hero.webp'];
  assert.deepEqual(await listed(0), all);
  assert.deepEqual(await listed(2), all);
  assert.equal((await asVisitor('select count(*)::int as n from storage.objects where bucket_id = $1', [BUCKET])).rows[0].n, 0);
});

test('Nobody can upload, change or delete pictures from the app – not even over a file that is already there', async () => {
  await ownerUploads('characters/made-up-hero.webp');
  assert.match(await failure(as(0, 'insert into storage.objects(bucket_id, name) values ($1, $2)', [BUCKET, 'characters/sneaky.webp'])),
    /row-level security/);
  assert.match(await failure(as(1, 'insert into storage.objects(bucket_id, name) values ($1, $2)', [BUCKET, 'backgrounds/sneaky.jpg'])),
    /row-level security/);
  assert.match(await failure(asVisitor('insert into storage.objects(bucket_id, name) values ($1, $2)', [BUCKET, 'characters/visitor.webp'])),
    /row-level security/);
  // A change or a delete quietly finds nothing to change: the file stays exactly as the owner uploaded it.
  const before = await one('select name, owner_id, metadata from storage.objects where bucket_id = $1', [BUCKET]);
  await as(0, "update storage.objects set name = 'characters/renamed.webp', metadata = '{}'::jsonb where bucket_id = $1", [BUCKET]);
  await as(1, 'delete from storage.objects where bucket_id = $1', [BUCKET]);
  await asVisitor('delete from storage.objects where bucket_id = $1', [BUCKET]);
  assert.deepEqual(await one('select name, owner_id, metadata from storage.objects where bucket_id = $1', [BUCKET]), before);
  assert.equal(await count('storage.objects where bucket_id = $1', [BUCKET]), 1);
  // The owner can still change and remove them (the dashboard).
  await asUser(db, null, (tx) => tx.query('delete from storage.objects where bucket_id = $1', [BUCKET]), 'service_role');
  assert.equal(await count('storage.objects where bucket_id = $1', [BUCKET]), 0);
});

test('The other folders work as before: your own avatar uploads, other people still can not see private photos', async () => {
  await as(0, "insert into storage.objects(bucket_id, name) values ('avatars', $1)", [`${users[0]}/me.jpg`]);
  assert.match(await failure(as(0, "insert into storage.objects(bucket_id, name) values ('avatars', $1)", [`${users[1]}/not-me.jpg`])),
    /row-level security/);
  await as(1, "insert into storage.objects(bucket_id, name) values ('media', $1)", [`${users[1]}/posts/private.jpg`]);
  assert.equal((await as(2, 'select count(*)::int as n from storage.objects where name = $1', [`${users[1]}/posts/private.jpg`])).rows[0].n, 0);
  assert.equal((await as(2, 'select count(*)::int as n from storage.objects where name = $1', [`${users[0]}/me.jpg`])).rows[0].n, 1);
});

test('Running the migration again is fine and puts the folder\'s limits back', async () => {
  await ownerUploads('characters/made-up-hero.webp');
  await db.query("update storage.buckets set public = false, file_size_limit = 99999999, allowed_mime_types = array['video/mp4'] where id = $1", [BUCKET]);
  const sql = await migrationSql(MIGRATION);
  await db.exec(sql);
  await db.exec(sql);
  const bucket = await one('select * from storage.buckets where id = $1', [BUCKET]);
  assert.equal(bucket.public, true);
  assert.equal(Number(bucket.file_size_limit), 1_572_864);
  assert.deepEqual(bucket.allowed_mime_types, ['image/webp', 'image/png', 'image/jpeg', 'application/json']);
  assert.equal(await count('storage.buckets where id = $1', [BUCKET]), 1);
  assert.equal(await count("pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'Anyone logged in can see the Main Character art'"), 1);
  // The pictures already there are kept, and still listed.
  assert.deepEqual(await listed(1), ['characters/made-up-hero.webp']);
  // It adds only the one "see" rule: nothing that lets the app upload, change or delete in this folder.
  const rules = (await db.query("select policyname, cmd from pg_policies where schemaname = 'storage' and (qual like '%main-character%' or with_check like '%main-character%')")).rows;
  assert.deepEqual(rules, [{ policyname: 'Anyone logged in can see the Main Character art', cmd: 'SELECT' }]);
});
