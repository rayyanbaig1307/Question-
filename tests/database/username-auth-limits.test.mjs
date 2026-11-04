// Username login and sign-up limits (QA review: throttling). Runs every migration in a local,
// in-memory PostgreSQL (PGlite). Nothing here talks to a live project.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { asUser, createLocalDatabase } from './local-db.mjs';

let db;
before(async () => { db = await createLocalDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => { await db.exec('truncate public.username_auth_log restart identity;'); });

const asServer = (sql, args = []) => asUser(db, null, (tx) => tx.query(sql, args), 'service_role');
const reserve = async (kind, key, max, minutes, id = null) =>
  (await asServer('select public.reserve_username_auth_attempt($1,$2,$3,$4,$5) as ok', [kind, key, max, minutes, id])).rows[0].ok;
const refund = async (id) => (await asServer('select public.refund_username_auth_attempt($1) as n', [id])).rows[0].n;
const rows = async (key) => (await db.query('select count(*)::int as n from public.username_auth_log where key=$1', [key])).rows[0].n;

const RESERVE = 'public.reserve_username_auth_attempt(text,text,integer,integer,uuid)';
const REFUND = 'public.refund_username_auth_attempt(uuid)';

test('Only the server can reserve or give back a username login try', async () => {
  for (const fn of [RESERVE, REFUND]) {
    for (const role of ['public', 'anon', 'authenticated']) {
      const allowed = role === 'public'
        // "public" is not a real role: check that no ordinary grant is left on the function itself.
        ? (await db.query("select coalesce(bool_or(a.grantee=0),false) as f from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid=$1::regprocedure and a.privilege_type='EXECUTE'", [fn])).rows[0].f
        : (await db.query("select has_function_privilege($1,$2,'execute') as f", [role, fn])).rows[0].f;
      assert.equal(allowed, false, `${role} must not run ${fn}`);
    }
    assert.equal((await db.query("select has_function_privilege('service_role',$1,'execute') as f", [fn])).rows[0].f, true);
  }
  await assert.rejects(() => asUser(db, null, (tx) => tx.query('select public.refund_username_auth_attempt($1)', [randomUUID()]), 'anon'), /permission denied/i);
  await assert.rejects(() => asUser(db, null, (tx) => tx.query("select public.reserve_username_auth_attempt('fail','x',8,15)"), 'authenticated'), /permission denied/i);
});

test('The old four-value call still works, so the old server helper keeps working during the update', async () => {
  let allowed = 0;
  for (let i = 0; i < 12; i++) allowed += Number((await asServer("select public.reserve_username_auth_attempt('fail','old-call',8,15) as ok")).rows[0].ok);
  assert.equal(allowed, 8);
});

test('A refund gives back exactly the tries of that one request', async () => {
  const mine = randomUUID();
  const theirs = randomUUID();
  assert.equal(await reserve('fail', 'pair:alice@198.51.100.1', 8, 15, mine), true);
  assert.equal(await reserve('fail', 'user:alice', 40, 15, mine), true);
  assert.equal(await reserve('fail', 'pair:alice@198.51.100.1', 8, 15, theirs), true);
  assert.equal(await refund(mine), 2);
  assert.equal(await rows('pair:alice@198.51.100.1'), 1);
  assert.equal(await rows('user:alice'), 0);
  // Giving back the same request twice, or an unknown request, changes nothing.
  assert.equal(await refund(mine), 0);
  assert.equal(await refund(randomUUID()), 0);
  assert.equal(await refund(null), 0);
  assert.equal(await rows('pair:alice@198.51.100.1'), 1);
});

test('Correct logins that are given back never use up the wrong-password allowance', async () => {
  for (let i = 0; i < 30; i++) {
    const id = randomUUID();
    assert.equal(await reserve('fail', 'pair:bob@203.0.113.9', 8, 15, id), true, `correct login ${i + 1} was refused`);
    await refund(id);
  }
  let wrong = 0;
  for (let i = 0; i < 12; i++) wrong += Number(await reserve('fail', 'pair:bob@203.0.113.9', 8, 15, randomUUID()));
  assert.equal(wrong, 8);
});

test('A site-wide cap above 100 is allowed (for the hourly cap on new accounts)', async () => {
  assert.equal(await reserve('signup', 'all', 500, 60, randomUUID()), true);
  await assert.rejects(() => reserve('signup', 'all', 100_001, 60, randomUUID()), /Invalid throttle arguments/);
});

test('Old rows from every name and address are cleaned up, a bounded number at a time', async () => {
  await db.query("insert into public.username_auth_log(kind,key,created_at) select 'fail','spray'||g, now()-interval '30 days' from generate_series(1,450) g");
  await db.query("insert into public.username_auth_log(kind,key,created_at) values ('fail','recent',now()-interval '23 hours')");
  await reserve('fail', 'someone-else', 8, 15, randomUUID());
  const old = async () => (await db.query("select count(*)::int as n from public.username_auth_log where created_at < now()-interval '24 hours'")).rows[0].n;
  const first = await old();
  // Each try removes some old rows (not all at once, so one try stays quick).
  assert.ok(first < 450 && first > 0, `expected a bounded clean-up, ${first} old rows left`);
  for (let i = 0; i < 10 && (await old()) > 0; i++) await reserve('signup', `198.51.100.${i}`, 5, 60, randomUUID());
  assert.equal(await old(), 0);
  // Rows from the last 24 hours are kept: they still count.
  assert.equal(await rows('recent'), 1);
});

test('The clean-up and the refund can find rows without reading the whole table', async () => {
  const indexes = (await db.query("select indexdef from pg_indexes where schemaname='public' and tablename='username_auth_log'")).rows.map((r) => r.indexdef);
  assert.ok(indexes.some((d) => /\(created_at\)/.test(d)), `no index on created_at: ${indexes.join(' | ')}`);
  assert.ok(indexes.some((d) => /\(reservation\)/.test(d)), `no index on reservation: ${indexes.join(' | ')}`);
});
