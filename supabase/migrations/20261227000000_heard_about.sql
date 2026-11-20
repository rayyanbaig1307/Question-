-- =====================================================================
-- "How did you hear about Peekaboo?" (the owner, 20 Nov 2026). One question for new accounts, right after
-- sign-up. Safe to run more than once.
--
-- * One answer per person, private: only the owner reads them (Supabase → Table Editor → heard_about). People
--   can't read anyone's answer through the app, not even their own.
-- * "Skip" is saved as 'skipped', so the question never comes back on another phone.
-- * Only new accounts are asked: made in the last 3 days, with no answer yet. Existing people are never asked.
--
-- See the totals (SQL Editor):
--   select source, count(*) from public.heard_about group by source order by count(*) desc;
-- =====================================================================
begin;
set local lock_timeout = '15s';

create table if not exists public.heard_about (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  source text not null check (source in (
    'tiktok', 'instagram', 'snapchat', 'youtube', 'friend', 'app_store', 'google', 'other', 'skipped'
  )),
  -- Only for 'other': a few words in their own words.
  detail text check (detail is null or char_length(detail) <= 100),
  created_at timestamptz not null default now()
);
alter table public.heard_about enable row level security;
revoke all on public.heard_about from anon, authenticated;

-- Should the app ask you? Only a new account (3 days old or less) that hasn't answered or skipped.
create or replace function public.needs_heard_about()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
     where p.id = (select auth.uid())
       and p.created_at > now() - interval '3 days'
       and not exists (select 1 from public.heard_about h where h.user_id = p.id)
  );
$$;
revoke all on function public.needs_heard_about() from public, anon;
grant execute on function public.needs_heard_about() to authenticated;

-- Saves your answer (the first one counts; asking again changes nothing).
create or replace function public.save_heard_about(answer text, other_text text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  words text := nullif(btrim(coalesce(other_text, '')), '');
begin
  if me is null then
    raise exception 'Please log in again';
  end if;
  if answer not in ('tiktok', 'instagram', 'snapchat', 'youtube', 'friend', 'app_store', 'google', 'other', 'skipped') then
    raise exception 'Pick one of the answers';
  end if;
  insert into public.heard_about (user_id, source, detail)
  values (me, answer, case when answer = 'other' then left(words, 100) end)
  on conflict (user_id) do nothing;
end;
$$;
revoke all on function public.save_heard_about(text, text) from public, anon;
grant execute on function public.save_heard_about(text, text) to authenticated;

commit;
