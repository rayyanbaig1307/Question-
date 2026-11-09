// A full, local rehearsal of the next database release, on a throw-away copy.
//
// In plain words, it does what the owner will do on release day, but on a
// made-up database on this computer:
//   1. Build a database like the LIVE one today (every migration before the QA
//      fixes) with made-up people.
//   2. Save the kinds of old rows the live app allowed and the new migrations
//      care about (each with a known id): a forfeit paid twice, broken chat
//      messages, a "keep" pointing at someone else's photo, reports, bad words
//      in public text (and the same words in private chat).
//   3. Run tests/database/deployment-preflight.sql (read from disk now, one
//      query at a time, read-only) and check that each query lists exactly the
//      old rows we saved - nothing missing and nothing extra. If a query for
//      one of those problems is missing from the file, or a [HARD BLOCKER]
//      query is there that this rehearsal does not know, that is a FAIL.
//   4. Apply the new migrations one file at a time, each in its own
//      transaction, like a real deploy. While the double forfeit payment is
//      still there, the first fix migration must stop with a clear error and
//      leave the database exactly as it was. Then the owner's fix (delete the
//      extra payment by hand) is done and every migration must apply.
//   5. Check the old rows still work after the release and the one-time steps
//      of the migrations did what their comments say.
//   6. Run the preflight again on the finished database (twice) and on a brand
//      new empty database: it must never error.
//
// Safety: a real PostgreSQL 16 server is started from node_modules, ONLY on
// 127.0.0.1, in a new folder under .qa/, and stopped at the end. It never talks
// to the live project. PostgreSQL will not run as root; run it as an ordinary
// user, for example:
//   su claude -s /bin/bash -c 'cd /home/user/Question- && node tests/database/preflight-rehearsal.mjs'
// Prints PASS / FAIL lines and "N passed; M failed"; exits with 1 on any FAIL.
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  initializeDatabase, seedUsers, asUser, friend,
  applyMigrationFile, remainingMigrations, FIRST_FIX_MIGRATION,
} from './local-db.mjs';
import { postgresBin, exe, assertNotRoot } from '../support/native-tools.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
// QA_PREFLIGHT_SQL may name another copy of the file (used to check that this rehearsal notices a wrong query).
const PREFLIGHT = process.env.QA_PREFLIGHT_SQL ? resolve(process.env.QA_PREFLIGHT_SQL) : new URL('./deployment-preflight.sql', import.meta.url);
const HARDENING = FIRST_FIX_MIGRATION;
const MEDIA_FIXES = '20261213200000_qa_review_media_fixes.sql';
const ROBUSTNESS = '20261213210000_qa_review_robustness_fixes.sql';
const USERNAME_LIMITS = '20261213220000_username_auth_limits.sql';
const WORD_FILTER = '20261214000000_public_word_filter.sql';
const GROUP_VOTES = '20261216000000_group_dare_votes.sql';
// Every name the fix migrations create that must not exist before (made without
// "if not exists" or "or replace", and not removed first). The preflight's
// "names must still be free" query lists exactly the ones that exist.
// (private.media_path_locks is made with "if not exists", so it is not one of them.)
const MEDIA_TABLES = ['posts', 'stories', 'mystery_posts', 'messages', 'keeps', 'group_messages'];
// The hardening migration's seven NOT VALID message checks (20261213210000 removes them again).
const HARDENING_CHECKS = [
  ...['messages_voice_content_required', 'messages_screenshot_content_required', 'messages_waveform_values'].map((c) => `check|${c} on public.messages`),
  ...['group_messages_voice_required', 'group_messages_waveform_valid', 'group_messages_body_size', 'group_messages_media_kind'].map((c) => `check|${c} on public.group_messages`),
];
const HARDENING_NAMES = [
  'column|public.reports.anonymous_content',
  'index|public.posts_one_payment_per_forfeit', 'index|private.report_media_evidence_path',
  'table|private.media_cleanup_claims', 'table|private.account_media_deletions', 'table|private.report_media_evidence',
  ...[['mystery_posts_set_expiry', 'mystery_posts'], ['posts_prepare_timestamp', 'posts'], ['reports_prepare', 'reports'],
    ['messages_prepare_state', 'messages'], ['dare_ideas_prepare', 'dare_ideas'], ['hit_ups_enforce_quota', 'hit_ups'],
    ['peek_group_members_enforce_size', 'peek_group_members'], ['nudges_enforce_cooldown', 'nudges'],
    ['group_messages_prepare', 'group_messages']].map(([t, on]) => `trigger|${t} on public.${on}`),
  ...MEDIA_TABLES.map((t) => `trigger|guard_cleanup_reference on public.${t}`),
  ...MEDIA_TABLES.map((t) => `trigger|lock_deleted_content_media on public.${t}`),
  'trigger|objects_guard_claimed_cleanup on storage.objects', 'trigger|objects_guard_cleaned_path on storage.objects',
  'storage rule|An existing profile is required for uploads on storage.objects',
  'storage rule|An existing profile is required to replace uploads on storage.objects',
  ...HARDENING_CHECKS,
];
const LATER_NAMES = [
  'table|private.media_deferred_deletions',
  'trigger|keeps_files_are_own on public.keeps',
  ...MEDIA_TABLES.map((t) => `trigger|guard_deferred_reference on public.${t}`),
  'trigger|reports_capture_evidence on public.reports', 'trigger|reports_release_dismissed_evidence on public.reports',
  'trigger|zz_messages_content_rules on public.messages', 'trigger|zz_group_messages_content_rules on public.group_messages',
  'storage rule|Files waiting for the daily cleanup look deleted on storage.objects',
];
// What exists once every migration ran.
const FINAL_NAMES = [...HARDENING_NAMES.filter((n) => !HARDENING_CHECKS.includes(n)), ...LATER_NAMES];

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const notes = [];
const pass = (label, detail) => { passed++; console.log(`PASS ${label}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`); };
const fail = (label, error) => { failed++; console.log(`FAIL ${label}: ${error?.message ?? error}`); };
const note = (text) => { notes.push(text); console.log(`NOTE ${text}`); };
async function check(label, fn) {
  try { pass(label, await fn()); } catch (error) { fail(label, error); }
}
// A step everything after it needs. If it fails, the rehearsal stops.
async function must(label, fn, { show = false } = {}) {
  try { const value = await fn(); pass(label, show ? value : undefined); return value; } catch (error) { fail(label, error); throw new StopRehearsal(label); }
}
class StopRehearsal extends Error {}

function assert(ok, message) { if (!ok) throw new Error(message); }
// Seeded ids -> their names in this file (for example "m.waveTooHigh"), so a failure says WHICH row.
const labels = new Map();
function nameIds(value, path = 'seed') {
  if (typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)) { if (!labels.has(value)) labels.set(value, path); return; }
  if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) nameIds(v, Array.isArray(value) ? `${path}[${k}]` : `${path}.${k}`);
}
const named = (list) => list.map((x) => String(x).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (id) => (labels.has(id) ? `${labels.get(id)}(${id})` : id)));
function sameSet(actual, expected, what) {
  const a = [...new Set(actual)].sort();
  const e = [...new Set(expected)].sort();
  const missing = e.filter((x) => !a.includes(x));
  const extra = a.filter((x) => !e.includes(x));
  if (missing.length || extra.length || actual.length !== a.length) {
    throw new Error(`${what}: missing ${JSON.stringify(named(missing))}, extra ${JSON.stringify(named(extra))}`
      + (actual.length !== a.length ? `, listed twice: ${actual.length - a.length}` : ''));
  }
  return a.length;
}
// Runs fn and returns the error it throws (or fails when nothing is thrown).
async function refusal(fn, what) {
  const error = await Promise.resolve().then(fn).then(() => null, (e) => e);
  if (!error) throw new Error(`${what} was allowed but must be refused`);
  return error;
}

// ---------------------------------------------------------------------------
// The preflight file: split into single statements (comments removed; quotes,
// double quotes and $$ blocks are respected).
// ---------------------------------------------------------------------------
export function splitStatements(text) {
  return splitPreflight(text).map((s) => s.sql);
}
// The same, but each statement also gets its label from the comments just above
// it: 'HARD BLOCKER', 'INFO' or null. The last label above the statement wins
// (the file's opening notes mention both labels before the first query).
export function splitPreflight(text) {
  const out = [];
  let current = '';
  let tag = null;
  const remember = (comment) => {
    if (current.trim()) return; // a comment inside a query does not label it
    const found = [...comment.matchAll(/\[(HARD BLOCKER|INFO)\]/g)];
    if (found.length) tag = found[found.length - 1][1];
  };
  const finish = () => { if (current.trim()) out.push({ sql: current.trim(), tag }); current = ''; tag = null; };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '-' && next === '-') { const end = text.indexOf('\n', i); const stop = end < 0 ? text.length : end; remember(text.slice(i, stop)); i = stop; continue; }
    if (c === '/' && next === '*') { const end = text.indexOf('*/', i + 2); const stop = end < 0 ? text.length : end + 2; remember(text.slice(i, stop)); i = stop; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < text.length) { if (text[j] === c) { if (text[j + 1] === c) { j += 2; continue; } break; } j++; }
      current += text.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '$') {
      const dollar = /^\$[A-Za-z_]*\$/.exec(text.slice(i));
      if (dollar) {
        const end = text.indexOf(dollar[0], i + dollar[0].length);
        const stop = end < 0 ? text.length : end + dollar[0].length;
        current += text.slice(i, stop); i = stop; continue;
      }
    }
    if (c === ';') { finish(); i++; continue; }
    current += c; i++;
  }
  finish();
  return out;
}

// What each preflight query is about, worked out from the SQL itself (the file
// can change; new kinds of queries are reported, not guessed).
function kindOf(sql) {
  if (/blocked_word/i.test(sql)) return 'words';
  // Before the others: the names query also names tables such as private.report_media_evidence.
  if (/pg_trigger/i.test(sql)) return 'names';
  if (/forfeit_id/i.test(sql)) return 'forfeits';
  if (/report_media_evidence/i.test(sql)) return 'evidence';
  if (/public\.keeps\b/i.test(sql)) return 'keeps';
  if (/public\.reports\b/i.test(sql)) return 'reports';
  if (/public\.group_messages\b/i.test(sql)) return 'group';
  if (/public\.messages\b/i.test(sql)) return 'messages';
  return 'unknown';
}
const KIND_NAMES = {
  words: 'blocked words in public text', forfeits: 'duplicate forfeit payments', keeps: 'keeps using other people\'s files',
  evidence: 'report evidence let go once', names: 'names the new migrations create',
  reports: 'old reports by someone who cannot see the content', group: 'malformed group messages', messages: 'malformed 1:1 messages', unknown: 'unrecognised query',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The row ids one result lists, in a form that can be compared with what we saved.
function keysOf(kind, rows) {
  if (kind === 'words') return rows.map((r) => `${r.source}|${r.row_id}|${r.field}`);
  if (kind === 'forfeits') return rows.flatMap((r) => [`forfeit ${r.forfeit_id}`, ...(r.post_ids ?? []).map((id) => `post ${id}`)]);
  if (kind === 'names') return rows.map((r) => `${r.kind}|${r.name}`);
  if (kind === 'evidence') return rows.map((r) => `${r.report_id}|${r.object_name}`);
  if (kind === 'keeps' || kind === 'reports' || kind === 'group' || kind === 'messages') {
    return rows.map((r) => r.id ?? Object.values(r).find((v) => typeof v === 'string' && UUID.test(v)));
  }
  return rows.map((r) => JSON.stringify(r));
}

// Runs every preflight statement in its own READ ONLY transaction (so it can
// never change anything) and checks it against `expected` (kind -> keys, or
// {error: /regex/} when the query cannot run yet).
// Every kind named in `expected` MUST have a query in the file: a missing query
// is a failure, not a note (the file is edited by hand, and a deleted query
// would otherwise let the seeded problem rows go unnoticed). A [HARD BLOCKER]
// query this rehearsal does not recognise is a failure too, because nobody
// would have checked that it lists the right rows. An unrecognised [INFO]
// query must at least run; it is shown as a NOTE.
async function runPreflight(pool, phase, expected) {
  const statements = splitPreflight(await readFile(PREFLIGHT, 'utf8'));
  await check(`${phase}: the preflight file has queries`, async () => {
    assert(statements.length >= 3, `only ${statements.length} statements`);
    return { statements: statements.length };
  });
  const seen = {};
  for (const [n, { sql, tag }] of statements.entries()) {
    const kind = kindOf(sql);
    seen[kind] = (seen[kind] ?? 0) + 1;
    const label = `${phase}: preflight query ${n + 1} (${KIND_NAMES[kind]}${tag ? `, ${tag}` : ''})`;
    const client = await pool.connect();
    let result;
    let error;
    try {
      await client.query('begin transaction read only');
      result = await client.query(sql);
    } catch (e) { error = e; } finally {
      await client.query('rollback').catch(() => {});
      client.release();
    }
    const want = expected[kind];
    if (want === undefined || kind === 'unknown') {
      const listed = () => JSON.stringify(keysOf(kind, result.rows)).slice(0, 600);
      if (error) fail(label, error);
      else if (tag === 'HARD BLOCKER') fail(label, `this rehearsal does not know this hard-blocker query, so nobody checked which rows it lists (it listed ${result.rows.length}: ${listed()}). Teach kindOf() and the seed about it. SQL starts: ${sql.slice(0, 160).replace(/\s+/g, ' ')}`);
      else note(`${label} is not checked by this rehearsal yet; it listed ${result.rows.length} row(s): ${listed()}`);
      continue;
    }
    if (want.error) {
      await check(`${label} cannot run yet (${want.why})`, async () => {
        assert(error, `it ran and listed ${result?.rows.length} rows`);
        assert(want.error.test(error.message), `unexpected error: ${error.message}`);
        return { error: error.message };
      });
      continue;
    }
    await check(`${label} lists exactly the seeded rows`, async () => {
      if (error) throw error;
      return { rows: result.rows.length, matched: sameSet(keysOf(kind, result.rows), want, 'rows') };
    });
  }
  await check(`${phase}: the preflight has a query for every problem this rehearsal seeds`, async () => {
    const missing = Object.keys(expected).filter((kind) => !seen[kind]);
    assert(missing.length === 0, `no query for ${missing.map((kind) => `${KIND_NAMES[kind]} (${kind})`).join(', ')}, so the rows seeded for it are not listed by anything`);
    return { kinds: Object.keys(expected).length };
  });
}

// ---------------------------------------------------------------------------
// A snapshot of the whole schema and of every table's rows, to prove a failed
// migration changed nothing.
// ---------------------------------------------------------------------------
async function fingerprint(db) {
  const schema = (await db.query(`
    select md5(string_agg(line, E'\\n' order by line)) as hash, count(*)::int as items from (
      select 'fn ' || p.oid::regprocedure::text || ' ' || md5(pg_get_functiondef(p.oid)) || ' ' || coalesce(p.proacl::text, '') as line
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'private', 'storage', 'auth') and p.prokind in ('f', 'p')
      union all
      select 'col ' || table_schema || '.' || table_name || '.' || column_name || ' ' || data_type || ' '
             || coalesce(column_default, '') || ' ' || is_nullable
        from information_schema.columns where table_schema in ('public', 'private', 'storage')
      union all
      select 'con ' || conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) || ' ' || convalidated::text
        from pg_constraint where connamespace in ('public'::regnamespace, 'private'::regnamespace, 'storage'::regnamespace)
      union all
      select 'trg ' || tgrelid::regclass::text || ' ' || tgname || ' ' || tgenabled::text || ' ' || pg_get_triggerdef(oid)
        from pg_trigger where not tgisinternal
      union all
      select 'pol ' || schemaname || '.' || tablename || ' ' || policyname || ' ' || permissive || ' ' || cmd || ' '
             || coalesce(qual, '') || ' ' || coalesce(with_check, '')
        from pg_policies
      union all
      select 'rel ' || c.oid::regclass::text || ' ' || c.relkind::text || ' ' || coalesce(c.relacl::text, '') || ' ' || c.relrowsecurity::text
        from pg_class c where c.relnamespace in ('public'::regnamespace, 'private'::regnamespace, 'storage'::regnamespace)
    ) x`)).rows[0];
  const tables = (await db.query(`select table_schema || '.' || table_name as t from information_schema.tables
    where table_schema in ('public', 'private', 'storage', 'auth') and table_type = 'BASE TABLE' order by 1`)).rows.map((r) => r.t);
  const data = {};
  for (const t of tables) {
    const [schemaName, tableName] = t.split('.');
    const q = `select count(*)::int as n, md5(coalesce(string_agg(x::text, E'\\n' order by x::text), '')) as h from "${schemaName}"."${tableName}" x`;
    data[t] = (await db.query(q)).rows[0];
  }
  return { schema, data };
}
function diffFingerprints(before, after) {
  const changes = [];
  if (before.schema.hash !== after.schema.hash) changes.push(`schema (${before.schema.items} -> ${after.schema.items} items)`);
  for (const t of new Set([...Object.keys(before.data), ...Object.keys(after.data)])) {
    const a = before.data[t];
    const b = after.data[t];
    if (!a || !b || a.h !== b.h) changes.push(`${t} (${a?.n ?? 'missing'} -> ${b?.n ?? 'missing'} rows)`);
  }
  return changes;
}

// ---------------------------------------------------------------------------
// The local PostgreSQL 16 server
// ---------------------------------------------------------------------------
assertNotRoot();
const native = postgresBin(repo);
const root = resolve(process.env.QA_NATIVE_ROOT ?? resolve(repo, '.qa'), `preflight-rehearsal-${Date.now()}`);
await mkdir(root, { recursive: true });
const port = await new Promise((res, rej) => {
  const s = createServer(); s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const run = (program, args) => new Promise((res, rej) => {
  const p = spawn(resolve(native, program), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (x) => { out += x; }); p.stderr.on('data', (x) => { out += x; });
  p.once('error', rej);
  p.once('close', (code) => (code === 0 ? res(out) : rej(new Error(`${program} failed ${code}: ${out}`))));
});
const config = { host: '127.0.0.1', port, user: 'postgres', database: 'postgres', connectionTimeoutMillis: 10000 };
// The same small interface the in-memory test database has, on a real server.
function wrap(pool) {
  return {
    pool,
    query: (...args) => pool.query(...args),
    exec: (sql) => pool.query(sql),
    close: async () => {},
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const value = await fn({ query: (...a) => client.query(...a), exec: (q) => client.query(q) });
        await client.query('commit');
        return value;
      } catch (error) { await client.query('rollback').catch(() => {}); throw error; } finally { client.release(); }
    },
  };
}

let server;
const pools = [];
let admin;
try {
  await run(exe('initdb'), ['-D', resolve(root, 'cluster'), '-U', 'postgres', '--auth=trust', '--locale=C', '--encoding=UTF8', '--no-instructions']);
  let log = '';
  server = spawn(resolve(native, exe('postgres')), ['-D', resolve(root, 'cluster'), '-h', '127.0.0.1', '-p', String(port),
    '-c', 'fsync=off', '-c', 'max_connections=50', '-k', resolve(root)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (x) => { log += x; }); server.stderr.on('data', (x) => { log += x; });
  for (let i = 0; i < 100 && !admin; i++) {
    const client = new pg.Client(config);
    try { await client.connect(); admin = client; } catch { await client.end().catch(() => {}); await new Promise((r) => setTimeout(r, 100)); }
  }
  if (!admin) throw new Error(`Local PostgreSQL did not start: ${log}`);
  console.log((await admin.query('select version() as v')).rows[0].v);
  const open = async (name) => {
    await admin.query(`create database ${name}`);
    const pool = new pg.Pool({ ...config, database: name, max: 8 });
    pools.push(pool);
    return wrap(pool);
  };

  // =========================================================================
  // 1. A database like the live one today, with made-up people
  // =========================================================================
  const db = await open('rehearsal');
  await must('1. Live-like database: every migration before the QA fixes', async () => {
    await initializeDatabase(db, { includeFixes: false });
    assert(!db.appliedMigrations.some((n) => n >= HARDENING), 'a fix migration was applied');
  });
  const users = await must('1. Made-up people', () => seedUsers(db, 12));
  const [A, B, C, F, S, K, W, P, N, G, X, Z] = users;
  // A: sends the broken chat messages (deleted at the end). B: has photos and is reported.
  // C: in the group chat. F: B's friend who reports. S: a stranger. K: makes the bad keep.
  // W: public text with bad words. P/N: the forfeit. G: Guess Who. Z: anyone.
  // X: text that must NOT be listed: clean look-alikes, and swearing in a display name (allowed; only usernames can't).
  for (const [a, b] of [[A, B], [A, C], [B, C], [B, F], [F, W], [N, P]]) await friend(db, a, b);

  const as = (who, sql, args = []) => asUser(db, who, (tx) => tx.query(sql, args));
  const one = async (who, sql, args = []) => (await as(who, sql, args)).rows[0];
  const sys = async (sql, args = []) => (await db.query(sql, args)).rows;
  const file = (owner, name) => db.query("insert into storage.objects(bucket_id,name,owner_id) values('media',$1,$2)", [name, owner]);
  const dm = async (from, to, fields) => {
    const keys = Object.keys(fields);
    return (await one(from, `insert into public.messages(sender_id,recipient_id,${keys}) values($1,$2,${keys.map((_, n) => `$${n + 3}`)}) returning id`,
      [from, to, ...Object.values(fields)])).id;
  };
  const gm = async (from, group, fields) => {
    const keys = Object.keys(fields);
    return (await one(from, `insert into public.group_messages(group_id,sender_id,${keys}) values($1,$2,${keys.map((_, n) => `$${n + 3}`)}) returning id`,
      [group, from, ...Object.values(fields)])).id;
  };

  // =========================================================================
  // 2. Old rows the live app allowed (saved through the app's own rules
  //    where the app had a way in)
  // =========================================================================
  const seed = await must('2. Old rows the live app allowed', async () => {
    const s = { m: {}, g: {}, ok: {}, words: {}, reports: {} };

    // --- A forfeit paid twice: two posts in ONE insert both passed the old check.
    const nomination = (await sys(`insert into public.dare_nominations(dare_day,from_user,to_user,expires_at)
      values(current_date-1,$1,$2,now()-interval '1 hour') returning id`, [N, P]))[0].id;
    s.forfeit = (await one(N, "select public.give_forfeit($1,'mustache') as id", [nomination])).id;
    for (const f of ['f1', 'f2']) await file(P, `${P}/posts/${f}.jpg`);
    const paid = (await as(P, 'insert into public.posts(user_id,media_path,forfeit_id) values($1,$2,$4),($1,$3,$4) returning id',
      [P, `${P}/posts/f1.jpg`, `${P}/posts/f2.jpg`, s.forfeit])).rows.map((r) => r.id);
    assert(paid.length === 2, 'the old app should have saved both payments');
    s.payments = paid;

    // --- Broken 1:1 messages (a CHECK lets "unknown" through, so these saved).
    // (A voice note with a file but no length was always refused, so none can exist.)
    for (const f of ['v2', 'v3', 'v4', 'ok']) await file(A, `${A}/voice/${f}.m4a`);
    s.ok.normalFromB = await dm(B, A, { kind: 'text', body: 'hi A' });
    s.m.voiceNoRecording = await dm(A, B, { kind: 'voice', audio_ms: 1000, reply_to: s.ok.normalFromB });
    s.m.screenshotNoText = await dm(A, B, { kind: 'screenshot' });
    s.m.waveTooHigh = await dm(A, B, { kind: 'voice', media_path: `${A}/voice/v2.m4a`, audio_ms: 1000, waveform: [10, 101] });
    s.m.waveEmptyBar = await dm(A, B, { kind: 'voice', media_path: `${A}/voice/v3.m4a`, audio_ms: 1000, waveform: [10, null] });
    s.m.waveNegative = await dm(A, B, { kind: 'voice', media_path: `${A}/voice/v4.m4a`, audio_ms: 1000, waveform: [-1] });
    s.m.fromC = await dm(C, B, { kind: 'voice', audio_ms: 500 });
    // Good rows that must NOT be listed.
    s.ok.voice = await dm(A, B, { kind: 'voice', media_path: `${A}/voice/ok.m4a`, audio_ms: 900, waveform: [1, 50, 100] });
    s.ok.screenshot = await dm(A, B, { kind: 'screenshot', body: 'chat' });
    s.ok.unread = await dm(A, B, { kind: 'text', body: 'are you there?' });

    // --- Broken group messages.
    s.group = (await one(A, "select public.create_peek_group('Weekend crew',$1::uuid[],current_date) as id", [[B, C]])).id;
    for (const f of ['g2.m4a', 'g3.m4a', 'g4.m4a', 'gok.m4a']) await file(A, `${A}/voice/${f}`);
    for (const f of ['p1.jpg', 'p2.jpg', 'ph1.jpg', 'ph2.jpg', 'vid1.mp4', 'okp.jpg']) await file(A, `${A}/group/${f}`);
    s.ok.groupParent = await gm(B, s.group, { body: 'parent text' });
    s.ok.groupDare = await gm(B, s.group, { kind: 'dare', body: 'Do ten jumps' });
    s.g.voiceNoRecording = await gm(A, s.group, { kind: 'voice', audio_ms: 1000, reply_to: s.ok.groupParent });
    s.g.voiceTooLong = await gm(A, s.group, { kind: 'voice', media_path: `${A}/voice/g2.m4a`, audio_ms: 200000 });
    s.g.textTooLong = await gm(A, s.group, { kind: 'text', body: ' '.repeat(10) + 'x'.repeat(1995) });
    s.g.proofTooLong = await gm(A, s.group, { kind: 'proof', dare_id: s.ok.groupDare, media_path: `${A}/group/p1.jpg`, media_type: 'photo', body: 'y'.repeat(2500) });
    s.g.waveTooMany = await gm(A, s.group, { kind: 'voice', media_path: `${A}/voice/g3.m4a`, audio_ms: 1000, waveform: Array(65).fill(5) });
    s.g.waveTooHigh = await gm(A, s.group, { kind: 'voice', media_path: `${A}/voice/g4.m4a`, audio_ms: 1000, waveform: [101] });
    s.g.photoNoType = await gm(A, s.group, { kind: 'photo', media_path: `${A}/group/ph1.jpg` });
    s.g.photoAsVideo = await gm(A, s.group, { kind: 'photo', media_path: `${A}/group/ph2.jpg`, media_type: 'video' });
    s.g.videoAsPhoto = await gm(A, s.group, { kind: 'video', media_path: `${A}/group/vid1.mp4`, media_type: 'photo' });
    s.g.proofNoType = await gm(A, s.group, { kind: 'proof', dare_id: s.ok.groupDare, media_path: `${A}/group/p2.jpg` });
    s.g.fromC = await gm(C, s.group, { kind: 'voice', audio_ms: 700 });
    s.ok.groupPhoto = await gm(A, s.group, { kind: 'photo', media_path: `${A}/group/okp.jpg`, media_type: 'photo' });
    s.ok.groupVoice = await gm(A, s.group, { kind: 'voice', media_path: `${A}/voice/gok.m4a`, audio_ms: 1000, waveform: [0, 100] });

    // --- Private chat with the same bad words (never filtered, never listed).
    s.private = {
      dm: await dm(B, C, { kind: 'text', body: 'you retard lol' }),
      dare: await dm(B, C, { kind: 'dare', body: 'Call someone a retard' }),
      group: await gm(B, s.group, { body: 'retard party tonight' }),
    };

    // --- A keep whose poster/overlay is B's file (the old rule only checked the main file).
    for (const f of [`${B}/posts/keep-victim.jpg`, `${B}/posts/keep-victim-overlay.png`]) await file(B, f);
    for (const f of [`${K}/keeps/k1.jpg`, `${K}/keeps/k2.jpg`]) await file(K, f);
    s.badKeep = (await one(K, `insert into public.keeps(user_id,media_path,media_type,poster_path,overlay_path)
      values($1,$2,'photo',$3,$4) returning id`, [K, `${K}/keeps/k1.jpg`, `${B}/posts/keep-victim.jpg`, `${B}/posts/keep-victim-overlay.png`])).id;
    s.okKeep = (await one(K, "insert into public.keeps(user_id,media_path,media_type) values($1,$2,'photo') returning id", [K, `${K}/keeps/k2.jpg`])).id;

    // --- Reports. B is private; F is B's friend; S is a stranger.
    await as(B, 'update public.profiles set is_private=true where id=$1', [B]);
    const post = async (owner, name) => {
      await file(owner, name);
      return (await one(owner, 'insert into public.posts(user_id,media_path) values($1,$2) returning id', [owner, name])).id;
    };
    await file(B, `${B}/posts/b1-poster.jpg`);
    s.b1 = (await one(B, 'insert into public.posts(user_id,media_path,poster_path) values($1,$2,$3) returning id',
      [B, `${B}/posts/b1.jpg`, `${B}/posts/b1-poster.jpg`])).id;
    await file(B, `${B}/posts/b1.jpg`);
    s.b2 = await post(B, `${B}/posts/b2.jpg`);
    s.b3 = await post(B, `${B}/posts/b3.jpg`);
    s.b4 = await post(B, `${B}/posts/b4.jpg`); // used by a post, never reported
    await file(B, `${B}/stories/s1.jpg`);
    s.story = (await one(B, 'insert into public.stories(user_id,media_path) values($1,$2) returning id', [B, `${B}/stories/s1.jpg`])).id;
    s.comment = (await one(B, "insert into public.comments(post_id,user_id,body) values($1,$2,'my comment') returning id", [s.b1, B])).id;
    const report = async (who, type, id, extra = {}) => (await one(who, `insert into public.reports(reporter_id,content_type,content_id,reason,details)
      values($1,$2,$3,'spam',$4) returning id`, [who, type, id, extra.details ?? null])).id;
    s.reports.open = await report(F, 'post', s.b1);
    s.reports.dismissed = await report(F, 'story', s.story);
    s.reports.reviewed = await report(C, 'post', s.b2);
    s.reports.comment = await report(F, 'comment', s.comment);
    s.reports.stranger = await report(S, 'post', s.b3); // S cannot see B's private post; the old rule did not check
    await sys("update public.reports set status='dismissed' where id=$1", [s.reports.dismissed]);
    await sys("update public.reports set status='reviewed' where id=$1", [s.reports.reviewed]);
    const strangerSees = (await one(S, 'select count(*)::int as n from public.posts where id=$1', [s.b3])).n;
    assert(strangerSees === 0, 'the stranger should not be able to see the post they reported');

    // --- Guess Who post with a slur in the caption, and an old anonymous report of it.
    s.mysteryFile = `mystery/${randomUUID()}.jpg`;
    await file(G, s.mysteryFile);
    s.mystery = (await one(G, "insert into public.mystery_posts(user_id,media_path,caption) values($1,$2,'guess who, faggot') returning id", [G, s.mysteryFile])).id;
    s.reports.anonymous = await report(F, 'post', s.mystery, { details: 'Guess Who (anonymous) post' });

    // --- Public text with bad words (no word filter in the database yet).
    await as(W, "update public.profiles set username='fuckface99', display_name='Big Retard', bio='proud retard' where id=$1", [W]);
    await as(X, "update public.profiles set display_name='Big Shit Dick Smith', bio='I love Scunthorpe' where id=$1", [X]);
    await file(W, `${W}/posts/w1.jpg`);
    s.wPost = (await one(W, "insert into public.posts(user_id,media_path,caption) values($1,$2,'look at this retard') returning id", [W, `${W}/posts/w1.jpg`])).id;
    await file(X, `${X}/posts/x1.jpg`);
    s.xPost = (await one(X, "insert into public.posts(user_id,media_path,caption) values($1,$2,'class assignment, so hard') returning id", [X, `${X}/posts/x1.jpg`])).id;
    s.badComment = (await one(F, "insert into public.comments(post_id,user_id,body) values($1,$2,'shut up, spic') returning id", [s.wPost, F])).id;
    s.okComment = (await one(F, "insert into public.comments(post_id,user_id,body) values($1,$2,'nice pic') returning id", [s.wPost, F])).id;
    s.badHitUp = (await sys("insert into public.hit_ups(from_user,to_user,message) values($1,$2,'hey retard') returning id", [W, S]))[0].id;
    s.okHitUp = (await sys("insert into public.hit_ups(from_user,to_user,message) values($1,$2,'hey there') returning id", [X, S]))[0].id;
    s.badIdea = (await one(W, "insert into public.dare_ideas(user_id,text) values($1,'Call your best friend a retard') returning id", [W])).id;
    s.okIdea = (await one(X, "insert into public.dare_ideas(user_id,text) values($1,'Wear a silly hat today') returning id", [X])).id;
    for (const voter of [F, B]) await as(voter, 'insert into public.dare_votes(idea_id,user_id) values($1,$2)', [s.okIdea, voter]);
    await sys('update public.dare_ideas set votes=7 where id=$1', [s.okIdea]); // a count that went wrong in a race
    s.badGroup = (await one(C, "select public.create_peek_group('tranny squad',$1::uuid[],current_date) as id", [[B]])).id;
    s.wordRows = [
      `profiles|${W}|username`, `profiles|${W}|display_name`, `profiles|${W}|bio`, `posts|${s.wPost}|caption`,
      `mystery_posts|${s.mystery}|caption`, `comments|${s.badComment}|body`, `hit_ups|${s.badHitUp}|message`,
      `dare_ideas|${s.badIdea}|text`, `peek_groups|${s.badGroup}|name`,
    ];
    nameIds(s);
    for (const [i, id] of users.entries()) labels.set(id, `user ${'ABCFSKWPNGXZ'[i]}`);
    return s;
  });

  const expectedBefore = {
    forfeits: [`forfeit ${seed.forfeit}`, ...seed.payments.map((id) => `post ${id}`)],
    names: [],
    messages: Object.values(seed.m),
    group: Object.values(seed.g),
    keeps: [seed.badKeep],
    evidence: [],
    words: { error: /blocked_word.*does not exist|schema "private" does not exist/, why: `it needs ${WORD_FILTER}` },
    // Open or reviewed reports about content the reporter cannot see: the stranger's report of
    // B's private post, and F's report of G's Guess Who post (F is not G's friend).
    reports: [seed.reports.stranger, seed.reports.anonymous],
  };

  // The broken rows exactly as saved, to prove the release leaves them alone.
  const messageSnapshot = async () => (await sys(`
    select id, kind, body, media_path, audio_ms, waveform, media_type from public.messages where id = any($1::uuid[])
    union all
    select id, kind, body, media_path, audio_ms, waveform::smallint[], media_type from public.group_messages where id = any($2::uuid[])
    order by 1`, [Object.values(seed.m), Object.values(seed.g)])).map((r) => JSON.stringify(r));
  const brokenBefore = await messageSnapshot();

  // =========================================================================
  // 3. The preflight on the live-like database
  // =========================================================================
  await runPreflight(db.pool, '3. Live-like database', expectedBefore);

  // What the preflight must list once the migrations are in (the double payment is fixed by then).
  const expectedAfter = {
    forfeits: [], names: FINAL_NAMES, messages: Object.values(seed.m), group: Object.values(seed.g), keeps: [seed.badKeep],
    evidence: [], words: seed.wordRows, reports: [seed.reports.stranger, seed.reports.anonymous],
  };

  // =========================================================================
  // 4. The release: one transaction per migration file
  // =========================================================================
  const fixes = await remainingMigrations();
  const session = new pg.Client({ ...config, database: 'rehearsal' });
  await session.connect();
  try {
    await check('4. The fix migrations are the ones this rehearsal knows', async () => {
      for (const name of [HARDENING, MEDIA_FIXES, ROBUSTNESS, USERNAME_LIMITS, WORD_FILTER, GROUP_VOTES]) assert(fixes.includes(name), `${name} is missing`);
      const extra = fixes.filter((n) => ![HARDENING, MEDIA_FIXES, ROBUSTNESS, USERNAME_LIMITS, WORD_FILTER, GROUP_VOTES].includes(n));
      if (extra.length) note(`also applying newer migrations (no extra checks for them here): ${extra.join(', ')}`);
      return { files: fixes.length };
    });

    // 4a. With the double payment still there, the hardening migration must stop.
    const before = await fingerprint(db);
    await must('4a. The hardening migration stops with a clear error while a forfeit is paid twice', async () => {
      const error = await refusal(() => applyMigrationFile(session, HARDENING), 'Applying the hardening migration');
      const cause = error.cause ?? error;
      assert(/posts_one_payment_per_forfeit/.test(error.message), `unclear error: ${error.message}`);
      assert(String(cause.detail ?? '').includes(seed.forfeit), `the error does not name the forfeit: ${cause.detail}`);
      return { error: error.message, detail: cause.detail };
    }, { show: true });
    await check('4a. ... and leaves the database exactly as it was (schema and every row)', async () => {
      const changes = diffFingerprints(before, await fingerprint(db));
      assert(changes.length === 0, `changed: ${changes.join('; ')}`);
      const index = (await sys("select to_regclass('public.posts_one_payment_per_forfeit') as i"))[0].i;
      const column = (await sys("select count(*)::int as n from information_schema.columns where table_name='reports' and column_name='anonymous_content'"))[0].n;
      const votes = (await sys('select votes from public.dare_ideas where id=$1', [seed.okIdea]))[0].votes;
      assert(index === null && column === 0 && votes === 7, 'a part of the migration was kept');
      return { schemaItems: before.schema.items, tables: Object.keys(before.data).length };
    });
    await check('4a. The live app keeps working on the unchanged database', async () => {
      const id = await dm(B, A, { kind: 'text', body: 'still works' });
      await as(B, 'delete from public.messages where id=$1', [id]);
    });

    // 4b. The owner's fix: keep the payment the forfeit points at, delete the other one by hand.
    await must('4b. The owner deletes the extra payment by hand', async () => {
      const kept = (await sys('select done_post_id from public.forfeits where id=$1', [seed.forfeit]))[0].done_post_id;
      assert(seed.payments.includes(kept), 'the forfeit should point at one of the two payments');
      const gone = await db.query('delete from public.posts where forfeit_id=$1 and id<>$2', [seed.forfeit, kept]);
      assert(gone.rowCount === 1, `deleted ${gone.rowCount} posts`);
      seed.keptPayment = kept;
      return { kept };
    });
    await runPreflight(db.pool, '4b. After the owner\'s fix', { ...expectedBefore, forfeits: [] });

    // 4c. Every migration, in filename order, with checks after the ones that do one-time work.
    const evidenceOf = async (report) => (await sys('select object_name from private.report_media_evidence where report_id=$1 order by 1', [report])).map((r) => r.object_name);
    const afterFile = {
      [HARDENING]: async () => {
        await check(`4c. ${HARDENING}: one payment per forfeit is now enforced`, async () => {
          const error = await refusal(() => db.query('insert into public.posts(user_id,media_path,forfeit_id) values($1,$2,$3)', [P, `${P}/posts/f3.jpg`, seed.forfeit]), 'A third payment');
          return { error: error.message };
        });
        await check(`4c. ${HARDENING}: the old anonymous Guess Who report is marked anonymous`, async () => {
          const row = (await sys('select anonymous_content from public.reports where id=$1', [seed.reports.anonymous]))[0];
          assert(row.anonymous_content === true, 'not marked');
        });
        await check(`4c. ${HARDENING}: dare vote counts were recounted`, async () => {
          const votes = (await sys('select votes from public.dare_ideas where id=$1', [seed.okIdea]))[0].votes;
          assert(votes === 2, `votes=${votes}`);
          return { votes };
        });
        await check(`4c. ${HARDENING}: every old report saved its evidence (comment reports kept the post's files)`, async () => {
          sameSet(await evidenceOf(seed.reports.open), [`${B}/posts/b1.jpg`, `${B}/posts/b1-poster.jpg`], 'open report');
          sameSet(await evidenceOf(seed.reports.comment), [`${B}/posts/b1.jpg`, `${B}/posts/b1-poster.jpg`], 'comment report');
          sameSet(await evidenceOf(seed.reports.dismissed), [`${B}/stories/s1.jpg`], 'dismissed report');
        });
        // A copy where only the hardening migration ran: the evidence query now lists
        // what 20261213200000 will let go of.
        const halfway = {
          ...expectedBefore, forfeits: [], names: HARDENING_NAMES,
          evidence: [`${seed.reports.comment}|${B}/posts/b1.jpg`, `${seed.reports.comment}|${B}/posts/b1-poster.jpg`,
            `${seed.reports.dismissed}|${B}/stories/s1.jpg`],
        };
        await runPreflight(db.pool, `4c. Right after ${HARDENING}`, halfway);
        // A name the next migration creates, made by hand first: the preflight must list it
        // and the next migration must stop without changing anything.
        await db.query('create table private.media_deferred_deletions(object_name text primary key)');
        await runPreflight(db.pool, '4c. With a hand-made private.media_deferred_deletions', {
          ...halfway, names: [...HARDENING_NAMES, 'table|private.media_deferred_deletions'],
        });
        const handMade = await fingerprint(db);
        await check(`4c. ... and ${MEDIA_FIXES} then stops without changing anything`, async () => {
          const error = await refusal(() => applyMigrationFile(session, MEDIA_FIXES), `Applying ${MEDIA_FIXES}`);
          assert(/media_deferred_deletions.*already exists/.test(error.message), error.message);
          const changes = diffFingerprints(handMade, await fingerprint(db));
          assert(changes.length === 0, `changed: ${changes.join('; ')}`);
          return { error: error.message };
        });
        await db.query('drop table private.media_deferred_deletions');
      },
      [MEDIA_FIXES]: async () => {
        await check(`4c. ${MEDIA_FIXES}: evidence of comment reports and dismissed reports was let go`, async () => {
          sameSet(await evidenceOf(seed.reports.comment), [], 'comment report');
          sameSet(await evidenceOf(seed.reports.dismissed), [], 'dismissed report');
        });
        await check(`4c. ${MEDIA_FIXES}: evidence of open and reviewed reports is kept`, async () => {
          sameSet(await evidenceOf(seed.reports.open), [`${B}/posts/b1.jpg`, `${B}/posts/b1-poster.jpg`], 'open report');
          sameSet(await evidenceOf(seed.reports.reviewed), [`${B}/posts/b2.jpg`], 'reviewed report');
          sameSet(await evidenceOf(seed.reports.anonymous), [seed.mysteryFile], 'anonymous report');
        });
        // An OLD report by someone who could not see the post still keeps its file (no
        // migration step changes old reports). The preflight lists it for the owner (see 5e).
        await check(`4c. ${MEDIA_FIXES}: the stranger's old report still keeps B's file`, async () => {
          sameSet(await evidenceOf(seed.reports.stranger), [`${B}/posts/b3.jpg`], 'stranger report');
        });
      },
      [ROBUSTNESS]: async () => {
        await check(`4c. ${ROBUSTNESS}: private.media_path_locks has a row for every existing file and every file name in use`, async () => {
          const missing = await sys(`
            with used as (
              select name as p from storage.objects where bucket_id = 'media'
              union select p from public.posts t cross join unnest(array[t.media_path,t.poster_path,t.overlay_path,t.blur_path]) p
              union select p from public.stories t cross join unnest(array[t.media_path,t.poster_path,t.overlay_path]) p
              union select p from public.mystery_posts t cross join unnest(array[t.media_path,t.poster_path,t.overlay_path]) p
              union select p from public.messages t cross join unnest(array[t.media_path,t.poster_path,t.overlay_path]) p
              union select p from public.keeps t cross join unnest(array[t.media_path,t.poster_path,t.overlay_path]) p
              union select p from public.group_messages t cross join unnest(array[t.media_path,t.poster_path,t.overlay_path]) p
              union select object_name from private.report_media_evidence)
            select p from used where p is not null and p not in (select object_name from private.media_path_locks)`);
          assert(missing.length === 0, `missing: ${missing.map((r) => r.p).join(', ')}`);
          return { locks: (await sys('select count(*)::int as n from private.media_path_locks'))[0].n };
        });
        await check(`4c. ${ROBUSTNESS}: no half-checked (NOT VALID) rules are left on chat messages`, async () => {
          const left = await sys(`select conname from pg_constraint where conrelid in ('public.messages'::regclass,'public.group_messages'::regclass) and not convalidated`);
          assert(left.length === 0, left.map((r) => r.conname).join(', '));
        });
      },
      [WORD_FILTER]: async () => {
        // The word-filter query only works from this moment on.
        await runPreflight(db.pool, `4c. Right after ${WORD_FILTER}`, expectedAfter);
      },
      [GROUP_VOTES]: async () => {
        // Group dare votes: the proofs already there were accepted under the old rule.
        await check(`4c. ${GROUP_VOTES}: every proof from before is marked as an old proof, with no votes; nothing else is`, async () => {
          const proofs = await sys("select id, proof_legit, proof_cap, proof_legacy from public.group_messages where kind = 'proof' order by id");
          assert(proofs.length === 2, `${proofs.length} proofs`);
          assert(proofs.every((r) => r.proof_legacy === true && r.proof_legit === 0 && r.proof_cap === 0), JSON.stringify(proofs));
          const others = (await sys("select count(*)::int as n from public.group_messages where kind <> 'proof' and (proof_legacy or proof_legit <> 0 or proof_cap <> 0)"))[0].n;
          assert(others === 0, `${others} other messages were changed`);
          // They already counted, so their doers get no "The group says legit" push later.
          const alerts = await sys("select a.proof_id, a.kind from private.group_proof_alerts a order by a.proof_id");
          assert(alerts.length === 2 && alerts.every((a, n) => a.kind === 'legit' && a.proof_id === proofs[n].id), JSON.stringify(alerts));
          return { oldProofs: proofs.length, legitAlertsMarked: alerts.length };
        });
        await check(`4c. ${GROUP_VOTES}: an old proof that breaks today's message rules can still be voted on`, async () => {
          const cast = (await one(C, 'select public.vote_group_proof($1,false,$2) as r', [seed.g.proofTooLong, C])).r;
          assert(cast.cap === 1 && cast.legit === 0, JSON.stringify(cast));
          const back = (await one(C, 'select public.vote_group_proof($1,null,$2) as r', [seed.g.proofTooLong, C])).r;
          // Someone voted on it, so it follows the normal rule from now on (no votes: not counting).
          assert(back.cap === 0 && back.legit === 0 && back.legacy === false, JSON.stringify(back));
          return { cast, back };
        });
      },
    };
    for (const name of fixes) {
      await must(`4c. Apply ${name} in its own transaction`, () => applyMigrationFile(session, name));
      if (afterFile[name]) await afterFile[name]();
    }
  } finally {
    await session.end().catch(() => {});
  }

  await runPreflight(db.pool, '4d. After every migration', expectedAfter);

  // =========================================================================
  // 5. Old rows after the release
  // =========================================================================
  // 5a. Broken chat messages.
  await check('5a. The old broken messages are all still there, unchanged', async () => {
    const now = await messageSnapshot();
    assert(JSON.stringify(now) === JSON.stringify(brokenBefore), 'they changed');
    return { rows: now.length };
  });
  await check('5a. Opening the chat marks every old message read', async () => {
    await as(B, 'select public.mark_chat_read($1)', [A]);
    const unread = (await sys('select count(*)::int as n from public.messages where sender_id=$1 and recipient_id=$2 and opened_at is null', [A, B]))[0].n;
    assert(unread === 0, `${unread} still unread`);
  });
  await check('5a. You can reply to an old broken message (1:1 and group)', async () => {
    const reply = await dm(B, A, { kind: 'text', body: 'replying to your voice note', reply_to: seed.m.voiceNoRecording });
    const greply = await gm(B, seed.group, { body: 'replying in the group', reply_to: seed.g.voiceNoRecording });
    const r1 = (await sys('select reply_to from public.messages where id=$1', [reply]))[0].reply_to;
    const r2 = (await sys('select reply_to from public.group_messages where id=$1', [greply]))[0].reply_to;
    assert(r1 === seed.m.voiceNoRecording && r2 === seed.g.voiceNoRecording, 'the reply lost its link');
  });
  await check('5a. The sender can delete an old broken message (1:1 and group)', async () => {
    const a = (await as(A, 'delete from public.messages where id=$1', [seed.m.waveTooHigh])).rowCount;
    const b = (await as(A, 'delete from public.group_messages where id=$1', [seed.g.photoAsVideo])).rowCount;
    assert(a === 1 && b === 1, `deleted ${a} and ${b}`);
  });
  await check('5a. Deleting a message an old broken message replied to works', async () => {
    const a = (await as(B, 'delete from public.messages where id=$1', [seed.ok.normalFromB])).rowCount;
    const b = (await as(B, 'delete from public.group_messages where id=$1', [seed.ok.groupParent])).rowCount;
    assert(a === 1 && b === 1, `deleted ${a} and ${b}`);
    const r1 = (await sys('select reply_to from public.messages where id=$1', [seed.m.voiceNoRecording]))[0].reply_to;
    const r2 = (await sys('select reply_to from public.group_messages where id=$1', [seed.g.voiceNoRecording]))[0].reply_to;
    assert(r1 === null && r2 === null, 'the old rows still point at the deleted message');
  });
  await check('5a. New broken messages are still refused', async () => {
    const e1 = await refusal(() => dm(A, B, { kind: 'voice', audio_ms: 1000 }), 'A voice note without a recording');
    const e2 = await refusal(() => gm(A, seed.group, { kind: 'photo', media_path: `${A}/group/okp.jpg`, media_type: 'video' }), 'A photo saved as a video');
    assert(e1.code === '23514' && e2.code === '23514', `${e1.message} / ${e2.message}`);
  });

  // 5b. Public text with bad words.
  const wordRefused = async (fn, what) => {
    const error = await refusal(fn, what);
    assert(error.code === '23514', `${what}: ${error.message}`);
    assert(/can't be in a username or name|isn't allowed on Peekaboo/.test(error.message), `${what}: ${error.message}`);
  };
  await check('5b. The old public rows with bad words are still there and can be read', async () => {
    const p = await one(F, 'select username, display_name, bio from public.profiles where id=$1', [W]);
    assert(p.username === 'fuckface99' && p.display_name === 'Big Retard' && p.bio === 'proud retard', JSON.stringify(p));
    assert((await one(F, 'select caption from public.posts where id=$1', [seed.wPost])).caption === 'look at this retard', 'post');
    assert((await one(G, 'select caption from public.mystery_posts where id=$1', [seed.mystery])).caption === 'guess who, faggot', 'guess who');
    assert((await one(F, 'select body from public.comments where id=$1', [seed.badComment])).body === 'shut up, spic', 'comment');
    assert((await one(W, 'select message from public.hit_ups where id=$1', [seed.badHitUp])).message === 'hey retard', 'hit up');
    assert((await one(Z, 'select text from public.dare_ideas where id=$1', [seed.badIdea])).text === 'Call your best friend a retard', 'dare idea');
    assert((await one(C, 'select name from public.peek_groups where id=$1', [seed.badGroup])).name === 'tranny squad', 'group');
  });
  await check('5b. Other changes to those old rows still work', async () => {
    await as(W, 'update public.profiles set is_private=true where id=$1', [W]);
    await as(W, "update public.posts set audience='close_friends' where id=$1", [seed.wPost]);
    await sys("update public.mystery_posts set expires_at=expires_at+interval '1 minute' where id=$1", [seed.mystery]);
    await sys('update public.hit_ups set ignored_at=now() where id=$1', [seed.badHitUp]);
    await sys('update public.dare_ideas set hidden=true where id=$1', [seed.badIdea]);
    await as(C, 'select public.pin_group_message($1,null)', [seed.badGroup]);
  });
  const wordChanges = [
    ['username', (v) => as(W, 'update public.profiles set username=$2 where id=$1', [W, v]), 'fuckboy_2', 'wally_w'],
    ['display name', (v) => as(W, 'update public.profiles set display_name=$2 where id=$1', [W, v]), 'Total Faggot', 'Wally'],
    ['bio', (v) => as(W, 'update public.profiles set bio=$2 where id=$1', [W, v]), 'total faggot', 'hello there'],
    ['post caption', (v) => as(W, 'update public.posts set caption=$2 where id=$1', [seed.wPost, v]), 'retards everywhere', 'look at this'],
    ['Guess Who caption', (v) => sys('update public.mystery_posts set caption=$2 where id=$1', [seed.mystery, v]), 'what a dyke', 'guess who'],
    ['comment', (v) => sys('update public.comments set body=$2 where id=$1', [seed.badComment, v]), 'you kike', 'shut up'],
    ['hit up', (v) => sys('update public.hit_ups set message=$2 where id=$1', [seed.badHitUp, v]), 'hey tranny', 'hey there'],
    ['dare idea', (v) => sys('update public.dare_ideas set text=$2 where id=$1', [seed.badIdea, v]), 'Call someone a chink today', 'Call your best friend today'],
    ['group name', (v) => as(C, 'select public.rename_peek_group($1,$2)', [seed.badGroup, v]), 'retard gang', 'Nice gang'],
  ];
  for (const [what, change, blocked, clean] of wordChanges) {
    await check(`5b. Old ${what}: a change to another bad word is refused`, () => wordRefused(() => change(blocked), what));
    await check(`5b. Old ${what}: a change to clean text works`, () => change(clean).then(() => undefined));
  }
  // The owner's choice: a display name may swear (only usernames can't). The finished-database preflight below
  // must not list it either.
  await check('5b. A display name with swearing saves; a username with swearing is still refused', async () => {
    await as(W, 'update public.profiles set display_name=$2 where id=$1', [W, 'Fuck Off']);
    const p = await one(F, 'select username, display_name from public.profiles where id=$1', [W]);
    assert(p.display_name === 'Fuck Off', JSON.stringify(p));
    const error = await refusal(() => as(W, 'update public.profiles set username=$2 where id=$1', [W, 'fuck_off']), 'username');
    assert(error.code === '23514' && /can't be in a username or name/.test(error.message), error.message);
  });

  // 5c. Private chat.
  await check('5c. Private chat with the same words is untouched', async () => {
    const rows = await sys(`select body from public.messages where id = any($1::uuid[]) union all
      select body from public.group_messages where id=$2`, [[seed.private.dm, seed.private.dare], seed.private.group]);
    sameSet(rows.map((r) => r.body), ['you retard lol', 'Call someone a retard', 'retard party tonight'], 'private chat');
  });
  await check('5c. New private chat messages (1:1 and group) with those words are allowed', async () => {
    await dm(B, C, { kind: 'text', body: 'still a retard' });
    await gm(B, seed.group, { body: 'retard party again' });
  });
  // Dare cards have their own safety rules since 20261224000000_dare_safety.sql: no slurs in a dare.
  await check('5c. A new dare card with those words is refused (dare safety)', async () => {
    const error = await refusal(() => dm(B, C, { kind: 'dare', body: 'Say retard to a friend' }), 'A dare with a slur');
    assert(error.code === '23514' && /no hate, bullying or slurs/.test(error.message), error.message);
  });

  // 5d. The bad keep.
  const victim = `${B}/posts/keep-victim.jpg`;
  await check('5d. The old keep is still there for its owner', async () => {
    const keep = await one(K, 'select poster_path, overlay_path from public.keeps where id=$1', [seed.badKeep]);
    assert(keep?.poster_path === victim, JSON.stringify(keep));
  });
  await check('5d. The old keep no longer pins the other person\'s file', async () => {
    const inUse = (await sys('select private.media_path_in_use($1,1) as a, private.media_path_in_use($2,1) as b',
      [victim, `${B}/posts/keep-victim-overlay.png`]))[0];
    assert(!inUse.a && !inUse.b, JSON.stringify(inUse));
  });
  await check('5d. The other person can delete that file in the app (it goes to the daily cleanup)', async () => {
    await as(B, "delete from storage.objects where bucket_id='media' and name=$1", [victim]);
    const waiting = (await sys('select count(*)::int as n from private.media_deferred_deletions where object_name=$1', [victim]))[0].n;
    assert(waiting === 1, 'the file is not waiting for the daily cleanup');
    const claimed = await asUser(db, null, (tx) => tx.query('select name from public.claim_media_cleanup(1000)'), 'service_role');
    assert(claimed.rows.some((r) => r.name === victim), 'the daily cleanup does not delete it');
  });
  await check('5d. ... while a file B\'s own post still uses cannot be deleted', async () => {
    const error = await refusal(() => as(B, "delete from storage.objects where bucket_id='media' and name=$1", [`${B}/posts/b4.jpg`]), 'Deleting a file in use');
    assert(/still in use/.test(error.message), error.message);
  });
  await check('5d. A keep can no longer be pointed at someone else\'s file', async () => {
    const error = await refusal(() => as(K, 'update public.keeps set poster_path=$2 where id=$1', [seed.okKeep, `${B}/posts/b2.jpg`]), 'A keep using B\'s file');
    assert(/own folder/.test(error.message), error.message);
  });

  // 5e. Reports after the release.
  await check('5e. The old anonymous Guess Who report is hidden from its reporter', async () => {
    const n = (await one(F, 'select count(*)::int as n from public.reports where id=$1', [seed.reports.anonymous])).n;
    assert(n === 0, 'the reporter can still see it');
  });
  await check('5e. A new report by someone who cannot see the post is refused (old ones stay; the preflight lists them)', async () => {
    const error = await refusal(() => as(S, "insert into public.reports(reporter_id,content_type,content_id,reason) values($1,'post',$2,'spam')", [S, seed.b3]), 'A stranger\'s report');
    assert(/can't be reported/.test(error.message), error.message);
  });
  await check('5e. The owner can let go of the files of an old report the preflight listed', async () => {
    const released = (await sys('select public.release_report_evidence($1) as n', [seed.reports.stranger]))[0].n;
    assert(released === 1, `let go of ${released} files`);
    const left = await sys('select object_name from private.report_media_evidence where report_id=$1', [seed.reports.stranger]);
    assert(left.length === 0, `still kept: ${left.map((r) => r.object_name).join(', ')}`);
    // The report itself stays (so the preflight still lists it).
    assert((await sys('select count(*)::int as n from public.reports where id=$1', [seed.reports.stranger]))[0].n === 1, 'the report is gone');
  });
  await check('5e. A file of an old dismissed report can be deleted by the daily cleanup now', async () => {
    await sys("update public.stories set expires_at=now()-interval '30 days' where id=$1", [seed.story]);
    const claimed = await asUser(db, null, (tx) => tx.query('select name from public.claim_media_cleanup(1000)'), 'service_role');
    assert(claimed.rows.some((r) => r.name === `${B}/stories/s1.jpg`), 'not offered to the cleanup');
  });

  // 5f. The live app's username helper (old 4-value call) still works until the new Edge Function is deployed.
  await check('5f. The live username-auth call (4 values) still works on the new database', async () => {
    const ok = await asUser(db, null, (tx) => tx.query("select public.reserve_username_auth_attempt('fail','rehearsal-key',5,15) as ok"), 'service_role');
    assert(ok.rows[0].ok === true, 'refused');
  });

  // 5g. Deleting the account that sent the broken messages (the same steps as the delete-account function).
  await check('5g. The account that sent the old broken messages can be deleted', async () => {
    await asUser(db, null, (tx) => tx.query('select public.begin_account_media_deletion($1)', [A]), 'service_role');
    await asUser(db, null, (tx) => tx.query("delete from storage.objects where bucket_id='media' and owner_id=$1", [A]), 'service_role');
    await sys('delete from auth.users where id=$1', [A]);
    const left = (await sys(`select (select count(*) from public.messages where sender_id=$1 or recipient_id=$1)
      + (select count(*) from public.group_messages where sender_id=$1)
      + (select count(*) from storage.objects where owner_id=$1::text) as n`, [A]))[0].n;
    assert(Number(left) === 0, `${left} rows left`);
  });

  // =========================================================================
  // 6. The preflight on a finished database (twice) and on a brand-new one
  // =========================================================================
  const expectedFinal = { ...expectedAfter, messages: [seed.m.fromC], group: [seed.g.fromC], words: [] };
  await runPreflight(db.pool, '6. Finished database, first run', expectedFinal);
  await runPreflight(db.pool, '6. Finished database, second run', expectedFinal);

  const fresh = await open('fresh');
  await must('6. Brand-new database: every migration from zero, nobody signed up', async () => {
    await initializeDatabase(fresh, { includeFixes: true });
    assert(fresh.appliedMigrations.includes(WORD_FILTER), 'the word filter migration was not applied');
  });
  await runPreflight(fresh.pool, '6. Brand-new database', { forfeits: [], names: FINAL_NAMES, messages: [], group: [], keeps: [], evidence: [], words: [], reports: [] });
} catch (error) {
  if (!(error instanceof StopRehearsal)) fail('The rehearsal stopped', error);
  else console.log(`The rehearsal stopped after: ${error.message}`);
} finally {
  await Promise.all(pools.map((p) => p.end().catch(() => {})));
  await admin?.end().catch(() => {});
  if (server) await run(exe('pg_ctl'), ['-D', resolve(root, 'cluster'), '-m', 'fast', '-w', 'stop']).catch(() => server.kill());
  if (!process.env.QA_KEEP_CLUSTER) await rm(root, { recursive: true, force: true }).catch(() => {});
}
if (notes.length) console.log(`${notes.length} note(s) above (NOTE lines are not failures).`);
console.log(`${passed} passed; ${failed} failed`);
if (failed) process.exitCode = 1;
