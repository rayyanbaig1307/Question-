-- =====================================================================
-- Username login and sign-up limits (QA review: throttling).
--
-- The username-auth server helper reserves a "try" before it checks a password or makes an account, so many
-- requests sent at the same moment cannot all slip through. This migration adds what it needs to count only
-- the tries that really matter:
--   * every reserved try can carry a request id (reservation), and
--   * refund_username_auth_attempt gives back all tries of one request, in one step. The helper calls it
--     after a correct login, after a sign-up that made no account, and after an outage.
-- It also cleans up old rows from every name and address (a few at a time), so the table cannot keep growing.
-- Only the server (service_role) can call these functions.
-- =====================================================================

alter table public.username_auth_log add column if not exists reservation uuid;
-- Finds the rows of one request quickly (for refunds).
create index if not exists username_auth_log_reservation on public.username_auth_log (reservation)
  where reservation is not null;
-- Finds old rows quickly (for the clean-up).
create index if not exists username_auth_log_created on public.username_auth_log (created_at);

-- The new version takes an optional request id as a fifth value. The old four-value call still works (the
-- request id is then empty), so the old server helper keeps working until the new one is deployed.
drop function if exists public.reserve_username_auth_attempt(text, text, integer, integer);
create or replace function public.reserve_username_auth_attempt(
  attempt_kind text, attempt_key text, max_attempts integer, window_minutes integer, attempt_id uuid default null
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  -- The site-wide cap on new accounts can be above 100, so the top limit is higher than before.
  if attempt_kind is null or attempt_kind not in ('signup','fail')
     or attempt_key is null or char_length(attempt_key) not between 1 and 256
     or max_attempts is null or max_attempts not between 1 and 100000
     or window_minutes is null or window_minutes not between 1 and 1440 then
    raise exception 'Invalid throttle arguments';
  end if;
  -- One request at a time per counter, so the count and the new row always match.
  perform pg_advisory_xact_lock(hashtextextended('username-auth:' || attempt_kind || ':' || attempt_key, 0));
  -- Clean up a few rows older than a day, from any name or address. No limit looks back further than a day.
  -- Rows another request is already removing are skipped, so requests never wait for each other here.
  delete from public.username_auth_log
  where id in (
    select id from public.username_auth_log
    where created_at < now() - interval '24 hours'
    order by created_at
    limit 200
    for update skip locked
  );
  if (select count(*) from public.username_auth_log
      where kind = attempt_kind and key = attempt_key
        and created_at > now() - make_interval(mins => window_minutes)) >= max_attempts then
    return false;
  end if;
  insert into public.username_auth_log(kind, key, reservation) values (attempt_kind, attempt_key, attempt_id);
  return true;
end;
$$;
revoke execute on function public.reserve_username_auth_attempt(text, text, integer, integer, uuid) from public, anon, authenticated;
grant execute on function public.reserve_username_auth_attempt(text, text, integer, integer, uuid) to service_role;

-- Gives back every try one request reserved (one delete, so it is all or nothing).
-- Returns how many tries were given back. An empty or unknown request id gives back nothing.
create or replace function public.refund_username_auth_attempt(attempt_id uuid)
returns integer language sql security definer set search_path = '' as $$
  with given_back as (
    delete from public.username_auth_log where reservation = attempt_id returning 1
  )
  select count(*)::integer from given_back;
$$;
revoke execute on function public.refund_username_auth_attempt(uuid) from public, anon, authenticated;
grant execute on function public.refund_username_auth_attempt(uuid) to service_role;
