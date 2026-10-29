-- =====================================================================
-- Peek Match (dating) – step 1: the safety gate
--
-- * Peek Match is 18+ only and off by default. You turn it on yourself.
-- * First you type your birthday. Under 18 → you're blocked from Peek Match for good.
-- * Then an ID + selfie age check by Stripe Identity (done by the "peek-match" Edge
--   Function, which writes the result here). Only a verified adult can join.
-- * age_checks is kept if you leave Peek Match (so you don't pay for a new check, and so
--   a "too young" result can't be undone). Everything else about dating hangs off
--   dating_members and is deleted when you leave.
-- * Other daters never see your normal account id – only your separate dating_id.
-- =====================================================================

create table public.age_checks (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  birthday date not null,                         -- what you typed
  verified_birthday date,                         -- what your ID says (from the age check)
  blocked boolean not null default false,         -- under 18: never allowed into Peek Match
  check_session text,                             -- Stripe's id for your latest age check
  check_state text not null default 'not_started'
    check (check_state in ('not_started', 'pending', 'verified', 'failed')),
  check_error text,                               -- why the last check didn't work (if it didn't)
  verified_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.age_checks enable row level security;

create policy "You can see your own age check"
  on public.age_checks for select to authenticated
  using (user_id = (select auth.uid()));
-- (Written only by peek_match_set_birthday and the peek-match Edge Function.)

create table public.dating_members (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  dating_id uuid not null unique default gen_random_uuid(),   -- the only id other daters see
  hidden boolean not null default false,                       -- dating profile hidden from others
  joined_at timestamptz not null default now()
);
alter table public.dating_members enable row level security;

create policy "You can see your own Peek Match membership"
  on public.dating_members for select to authenticated
  using (user_id = (select auth.uid()));

-- Is this person a verified adult who's allowed into Peek Match?
create or replace function private.is_verified_adult(person uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.age_checks a
     where a.user_id = person
       and not a.blocked
       and a.check_state = 'verified'
       and a.verified_birthday is not null
       and a.verified_birthday <= (current_date - interval '18 years')::date
  );
$$;

-- Is this person in Peek Match right now (and still allowed to be)?
create or replace function private.in_peek_match(person uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_verified_adult(person)
     and exists (select 1 from public.dating_members m where m.user_id = person);
$$;

-- Step 1 of joining: your birthday. It can only be set once. Under 18 → blocked for good.
create or replace function public.peek_match_set_birthday(day date)
returns text language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'Please log in again';
  end if;
  if exists (select 1 from public.age_checks where user_id = me) then
    raise exception 'Your birthday is already saved';
  end if;
  if day is null or day > current_date or day < current_date - interval '120 years' then
    raise exception 'That birthday doesn''t look right';
  end if;
  insert into public.age_checks (user_id, birthday, blocked)
  values (me, day, day > (current_date - interval '18 years')::date);
  return case when day > (current_date - interval '18 years')::date then 'blocked' else 'ok' end;
end;
$$;
revoke execute on function public.peek_match_set_birthday(date) from public, anon;
grant execute on function public.peek_match_set_birthday(date) to authenticated;

-- Turn Peek Match on (only after the age check says you're an adult).
create or replace function public.peek_match_join()
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  id uuid;
begin
  if not private.is_verified_adult(me) then
    raise exception 'Peek Match is only for verified adults (18+)';
  end if;
  insert into public.dating_members (user_id) values (me) on conflict (user_id) do nothing;
  select m.dating_id into id from public.dating_members m where m.user_id = me;
  return id;
end;
$$;
revoke execute on function public.peek_match_join() from public, anon;
grant execute on function public.peek_match_join() to authenticated;

-- Hide your dating profile from everyone (or show it again). You stay in Peek Match.
create or replace function public.peek_match_set_hidden(hide boolean)
returns void language sql security definer set search_path = '' as $$
  update public.dating_members set hidden = hide where user_id = auth.uid();
$$;
revoke execute on function public.peek_match_set_hidden(boolean) from public, anon;
grant execute on function public.peek_match_set_hidden(boolean) to authenticated;
