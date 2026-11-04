import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import pg from 'pg';
import { initializeDatabase, seedUsers, friend } from '../database/local-db.mjs';
import { postgresBin, exe, assertNotRoot } from '../support/native-tools.mjs';

export async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolvePort(port)); });
  });
}

export async function startLocalRest({ includeFixes = true, syntheticUsers = 40 } = {}) {
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  assertNotRoot();
  const binary = postgresBin(repo);
  const localRest = resolve(repo, '.qa/tools/postgrest', exe('postgrest'));
  const postgrest = process.env.QA_POSTGREST_BINARY || (existsSync(localRest) ? localRest : resolve(repo, '../tools/postgrest/runtime', exe('postgrest')));
  const root = resolve(repo, '.qa', `rest-${Date.now()}-${randomBytes(3).toString('hex')}`);
  await mkdir(root, { recursive: true });
  const dbPort = await freePort();
  const restPort = await freePort();
  const secret = randomBytes(40).toString('hex');
  let postgres, rest, pool;
  const processes = [];
  const command = (exe, args) => new Promise((resolveCommand, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', value => output += value);
    child.stderr.on('data', value => output += value);
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolveCommand(output) : reject(new Error(`${exe}: ${output}`)));
  });
  const stop = async () => {
    rest?.kill();
    await pool?.end().catch(() => {});
    if (postgres) await command(resolve(binary, exe('pg_ctl')), ['-D', resolve(root, 'cluster'), '-m', 'fast', '-w', 'stop']).catch(() => postgres.kill());
    await Promise.all(processes.map(child => child.exitCode !== null ? Promise.resolve() : new Promise(resolveExit => { child.once('exit', resolveExit); setTimeout(resolveExit, 3000); })));
  };
  try {
    await command(resolve(binary, exe('initdb')), ['-D', resolve(root, 'cluster'), '-U', 'postgres', '--auth=trust', '--locale=C', '--encoding=UTF8', '--no-instructions']);
    postgres = spawn(resolve(binary, exe('postgres')), ['-D', resolve(root, 'cluster'), '-h', '127.0.0.1', '-p', String(dbPort), '-c', 'fsync=off', '-c', 'max_connections=100'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    processes.push(postgres);
    let logs = '';
    postgres.stdout.on('data', value => logs += value);
    postgres.stderr.on('data', value => logs += value);
    pool = new pg.Pool({ host: '127.0.0.1', port: dbPort, user: 'postgres', database: 'postgres', max: 32, connectionTimeoutMillis: 5000 });
    let ready = false;
    for (let n = 0; n < 100; n++) {
      try { await pool.query('select 1'); ready = true; break; }
      catch { await new Promise(resolveDelay => setTimeout(resolveDelay, 100)); }
    }
    if (!ready) throw new Error(`Local PostgreSQL did not start: ${logs}`);
    const db = {
      query: (...args) => pool.query(...args), exec: sql => pool.query(sql), close: async () => {},
      transaction: async action => {
        const client = await pool.connect();
        try {
          await client.query('begin');
          const result = await action({ query: (...args) => client.query(...args), exec: sql => client.query(sql) });
          await client.query('commit'); return result;
        } catch (error) { await client.query('rollback'); throw error; }
        finally { client.release(); }
      },
    };
    await initializeDatabase(db, { includeFixes });
    // PostgREST uses the real JWT claims JSON. The SQL-only runner also supports
    // the legacy per-claim settings so it can assume a synthetic user's role.
    await db.exec(`
      create or replace function auth.uid() returns uuid language sql stable as $$
        select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub',nullif(current_setting('request.jwt.claim.sub',true),''))::uuid;
      $$;
      create or replace function auth.role() returns text language sql stable as $$
        select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role',nullif(current_setting('request.jwt.claim.role',true),''));
      $$;
      create role qa_authenticator login noinherit nocreatedb nocreaterole nosuperuser;
      grant anon,authenticated to qa_authenticator;
      alter role authenticated set statement_timeout='5s';
    `);
    const users = await seedUsers(db, syntheticUsers);
    await friend(db, users[0], users[1]);
    const config = resolve(root, 'postgrest.conf');
    await writeFile(config, [
      `db-uri = "postgresql://qa_authenticator@127.0.0.1:${dbPort}/postgres"`,
      // Exposing Storage metadata is LOCAL TEST configuration only. It lets the
      // HTTP suite exercise its real SQL policies, not the hosted Storage API.
      'db-schemas = "public,storage"', 'db-anon-role = "anon"',
      `jwt-secret = "${secret}"`, 'server-host = "127.0.0.1"', `server-port = ${restPort}`,
      'db-pool = 16', 'db-channel-enabled = false', 'log-level = "error"',
    ].join('\n'));
    rest = spawn(postgrest, [config], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${binary}${delimiter}${process.env.PATH ?? ''}` } });
    processes.push(rest);
    let restError = null;
    rest.once('error', error => { restError = error; });
    rest.stdout.on('data', value => logs += value);
    rest.stderr.on('data', value => logs += value);
    const base = `http://127.0.0.1:${restPort}`;
    ready = false;
    for (let n = 0; n < 100; n++) {
      if (restError) throw restError;
      if (rest.exitCode !== null) throw new Error(`Local PostgREST exited with ${rest.exitCode}: ${logs}`);
      try { const response = await fetch(`${base}/`, { signal: AbortSignal.timeout(2000) }); if (response.ok) { ready = true; break; } }
      catch { /* Server is still starting. */ }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    }
    if (!ready) throw new Error(`Local PostgREST did not start: ${logs}`);
    const token = (index, claims = {}, key = secret) => {
      const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
      const first = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ role: 'authenticated', sub: users[index], exp: Math.floor(Date.now()/1000)+3600, ...claims })}`;
      return `${first}.${createHmac('sha256', key).update(first).digest('base64url')}`;
    };
    const request = async (path, { user = 0, method = 'GET', body, jwt, headers = {} } = {}) => {
      const response = await fetch(`${base}/${path}`, {
        method, headers: {
          ...(user === null && jwt === undefined ? {} : { Authorization: `Bearer ${jwt ?? token(user ?? 0)}` }),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: response.status, data, headers: response.headers };
    };
    return { db, pool, users, base, token, request, stop, root };
  } catch (error) { await stop(); throw error; }
}
