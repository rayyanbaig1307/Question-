import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createLocalDatabase, FIRST_FIX_MIGRATION, seedUsers } from './local-db.mjs';

// The owner's account id named in the report alerts migration.
const OWNER = 'd3614487-2fa7-477c-8b64-be66ce1f5f3f';
const reportAlerts = new URL('../../supabase/migrations/20261207000000_report_alerts.sql', import.meta.url);

test('A brand-new empty database takes every migration with no accounts made first', async () => {
  // createLocalDatabase makes no accounts before or between migrations.
  const db = await createLocalDatabase();
  try {
    assert.equal((await db.query('select count(*)::int as n from auth.users')).rows[0].n, 0);
    assert.equal((await db.query('select count(*)::int as n from public.profiles')).rows[0].n, 0);
    // Nobody gets report alerts until someone is added on purpose.
    assert.equal((await db.query('select count(*)::int as n from private.report_alert_people')).rows[0].n, 0);
  } finally { await db.close(); }
});

test('The report alerts migration still adds the owner when that account exists', async () => {
  // This is what a database that already has the owner sees (like the live one did).
  const db = await createLocalDatabase();
  try {
    await db.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)', [
      OWNER, 'owner-fixture@example.invalid', { username: 'qa_owner_fixture', display_name: 'Owner fixture' },
    ]);
    const sql = await readFile(reportAlerts, 'utf8');
    await db.exec(sql);
    await db.exec(sql); // Running it twice must not fail or add the owner twice.
    const rows = (await db.query('select user_id from private.report_alert_people')).rows;
    assert.deepEqual(rows.map(r => r.user_id), [OWNER]);
  } finally { await db.close(); }
});

test('includeFixes:false leaves out the QA hardening migration and every fix after it', async () => {
  const original = await createLocalDatabase({ includeFixes: false });
  const fixed = await createLocalDatabase();
  try {
    const files = (await readdir(new URL('../../supabase/migrations/', import.meta.url))).filter(n => n.endsWith('.sql')).sort();
    const fixes = files.filter(n => n >= FIRST_FIX_MIGRATION);
    assert.ok(fixes.includes('20261213102659_qa_round2_security_hardening.sql'));
    assert.deepEqual(fixed.appliedMigrations, files);
    assert.deepEqual(original.appliedMigrations, files.filter(n => !fixes.includes(n)));
    const has = db => db.query("select count(*)::int as n from pg_proc where proname='claim_media_cleanup'").then(r => r.rows[0].n);
    assert.equal(await has(original), 0);
    assert.equal(await has(fixed), 1);
    // The original database still works for ordinary sign ups.
    assert.equal((await seedUsers(original, 2)).length, 2);
  } finally { await original.close(); await fixed.close(); }
});
