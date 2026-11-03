-- =====================================================================
-- Sign up / log in with just a username (no email).
-- The "username-auth" server helper (supabase/functions/username-auth) does the work; this table only keeps
-- count so nobody can make piles of accounts or guess passwords:
-- * at most 5 new username-only accounts per internet address per hour
-- * at most 8 wrong passwords per username every 15 minutes
-- Only the server helper can read or write it (no rules for app users).
-- =====================================================================

create table public.username_auth_log (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('signup', 'fail')),
  key text not null,
  created_at timestamptz not null default now()
);
alter table public.username_auth_log enable row level security;
revoke all on public.username_auth_log from anon, authenticated;
create index username_auth_log_lookup on public.username_auth_log (kind, key, created_at desc);
