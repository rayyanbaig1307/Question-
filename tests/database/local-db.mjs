import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';

// This is a real, in-memory PostgreSQL instance. Only the Supabase platform
// schemas are small local stand-ins. No network request or live project is used.
export async function createLocalDatabase({ includeFixes = true } = {}) {
  const db = await PGlite.create();
  return initializeDatabase(db,{includeFixes});
}

export async function initializeDatabase(db,{includeFixes=true}={}) {
  await db.exec(`
    do $$ begin
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
      if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
      if not exists(select 1 from pg_roles where rolname='supabase_auth_admin') then create role supabase_auth_admin nologin; end if;
    end; $$;
    create schema auth;
    create schema storage;
    create schema realtime;
    create schema extensions;
    create schema net;
    create schema vault;
    create schema cron;
    create table vault.secrets(id uuid primary key default gen_random_uuid(),name text unique,secret text);
    create view vault.decrypted_secrets as select id,name,secret as decrypted_secret from vault.secrets;
    create function vault.create_secret(secret text,name text,description text) returns uuid language plpgsql as $$
      declare created uuid; begin insert into vault.secrets(name,secret) values(name,secret) returning id into created;return created;end;$$;
    create table cron.job(jobid bigint generated always as identity primary key,jobname text unique,schedule text,command text);
    create function cron.schedule(jobname text,schedule text,command text) returns bigint language plpgsql as $$
      declare created bigint; begin insert into cron.job(jobname,schedule,command) values(jobname,schedule,command) returning jobid into created;return created;end;$$;
    create function cron.unschedule(jobid bigint) returns boolean language sql as $$ delete from cron.job j where j.jobid=$1 returning true;$$;
    create function cron.unschedule(jobname text) returns boolean language sql as $$ delete from cron.job j where j.jobname=$1 returning true;$$;
    create table auth.users (
      id uuid primary key default gen_random_uuid(),
      email text,
      raw_user_meta_data jsonb not null default '{}'::jsonb,
      raw_app_meta_data jsonb not null default '{}'::jsonb
    );
    create function auth.uid() returns uuid language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
        nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid;
    $$;
    create function auth.role() returns text language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.role', true),''),
        nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role');
    $$;
    create table storage.buckets (
      id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]
    );
    create table storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text references storage.buckets(id),
      name text not null,
      owner_id text default auth.uid()::text,
      metadata jsonb,
      unique(bucket_id, name)
    );
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language sql immutable as $$
      select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1)-1];
    $$;
    create table realtime.messages (id bigint, extension text);
    alter table realtime.messages enable row level security;
    create function realtime.topic() returns text language sql stable as $$
      select current_setting('realtime.topic', true);
    $$;
    create table net.sent (id bigint generated always as identity, url text, body jsonb, headers jsonb);
    create function net.http_post(url text, body jsonb, headers jsonb) returns bigint
      language plpgsql as $$ declare result bigint; begin
        if current_setting('test.push_failure', true) = 'on' then raise exception 'simulated push failure'; end if;
        insert into net.sent(url,body,headers) values (url,body,headers) returning id into result;
        return result;
      end; $$;
    create publication supabase_realtime;
    grant usage on schema public, auth, storage, realtime, net to anon, authenticated, service_role;
    grant all on all tables in schema storage, realtime, net to anon, authenticated, service_role;
    grant all on all sequences in schema net to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  `);
  const folder = new URL('../../supabase/migrations/', import.meta.url);
  const migrations = (await readdir(folder)).filter(name => name.endsWith('.sql')).sort();
  for (const name of migrations) {
    if (!includeFixes && name.includes('qa_round2_security_hardening')) continue;
    // The historic moderator migration assumes this account already exists.
    // Seed a synthetic LOCAL row with its id; no account is fetched remotely.
    if(name==='20261207000000_report_alerts.sql')await db.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)',[
      'd3614487-2fa7-477c-8b64-be66ce1f5f3f','qa-moderator@example.invalid',{username:'qa_moderator',display_name:'Local moderator fixture'}
    ]);
    let sql = await readFile(new URL(name, folder), 'utf8');
    // pg_net is an external HTTP worker, replaced above by a local capture table.
    sql = sql.replace(/create extension if not exists pg_net with schema extensions;/gi, '');
    sql = sql.replace(/create extension if not exists pg_cron;/gi, '');
    try { await db.exec(sql); }
    catch (error) { await db.close(); throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
  }
  return db;
}

export function userId(index) {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
}

export async function seedUsers(db, count = 16) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const id = userId(i);
    await db.query('insert into auth.users(id,email,raw_user_meta_data) values ($1,$2,$3)', [
      id, `qa${i}@example.invalid`, { username: `qa_user_${i}`, display_name: `QA ${i}` },
    ]);
    ids.push(id);
  }
  return ids;
}

export async function asUser(db, user, run, role = 'authenticated') {
  if (!['authenticated', 'anon', 'service_role','supabase_auth_admin'].includes(role)) throw new Error('Unsupported test role');
  return db.transaction(async tx => {
    await tx.exec(`set local role ${role}`);
    await tx.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', $2, true)", [user ?? '', role]);
    return run(tx);
  });
}

export async function friend(db, a, b) {
  await db.query("insert into public.friendships(requester_id,addressee_id,status,accepted_at) values ($1,$2,'accepted',now()) on conflict do nothing", [a,b]);
}
