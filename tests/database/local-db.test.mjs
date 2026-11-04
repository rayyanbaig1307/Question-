// Checks the small test helper that applies ONE migration file in its own
// transaction (applyMigrationFile in local-db.mjs). The release rehearsal uses
// it with a real PostgreSQL connection; its comment says the in-memory test
// database (PGlite) works too, so this proves that.
// Everything runs in a local, in-memory PostgreSQL. Nothing talks to a live project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrationFile, initializeDatabase, FIRST_FIX_MIGRATION } from './local-db.mjs';

const MEDIA_FIXES = '20261213200000_qa_review_media_fixes.sql';
const exists = async (db, name) => (await db.query('select to_regclass($1) as r', [name])).rows[0].r !== null;
const trigger = async (db, name, table) => (await db.query(
  'select count(*)::int as n from pg_trigger where tgname=$1 and tgrelid=to_regclass($2)', [name, table])).rows[0].n;

test('applyMigrationFile applies a whole migration file on PGlite', async () => {
  const db = await initializeDatabase(await PGlite.create(), { includeFixes: false });
  try {
    assert.equal(await exists(db, 'private.report_media_evidence'), false);
    await applyMigrationFile(db, FIRST_FIX_MIGRATION);
    // Made near the start and near the end of that file.
    assert.equal(await exists(db, 'public.posts_one_payment_per_forfeit'), true);
    assert.equal(await exists(db, 'private.report_media_evidence'), true);
    // It was saved for good: a rollback now (if a transaction were still open) changes nothing.
    await db.query('rollback');
    assert.equal(await exists(db, 'private.report_media_evidence'), true);
  } finally { await db.close(); }
});

test('applyMigrationFile on PGlite keeps nothing of a file that fails', async () => {
  const db = await initializeDatabase(await PGlite.create(), { includeFixes: false });
  try {
    await applyMigrationFile(db, FIRST_FIX_MIGRATION);
    // A name the next file creates, made by hand first: that file must stop.
    await db.exec('create table private.media_deferred_deletions(object_name text primary key)');
    await assert.rejects(applyMigrationFile(db, MEDIA_FIXES), /media_deferred_deletions.*already exists/);
    // That file makes this trigger BEFORE the line that fails. It must be gone again.
    assert.equal(await trigger(db, 'keeps_files_are_own', 'public.keeps'), 0);
    // And the database is usable afterwards.
    await db.exec('drop table private.media_deferred_deletions');
    await applyMigrationFile(db, MEDIA_FIXES);
    assert.equal(await trigger(db, 'keeps_files_are_own', 'public.keeps'), 1);
  } finally { await db.close(); }
});
