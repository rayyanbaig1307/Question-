-- =====================================================================
-- Daily Dare
-- A post can be someone's answer to "today's dare". The app shows the
-- same dare to everyone; a new one starts every day at 10:00 UTC
-- (6am in New York, 3am in Los Angeles, 11am in London).
-- =====================================================================

-- Which day's dare this post was for (empty for normal posts).
alter table public.posts add column dare_day date;

-- Quickly find all posts for one day's dare, newest first.
create index posts_dare_day_idx on public.posts (dare_day, created_at desc)
  where dare_day is not null;

-- Dare posts always count for *today's* dare (no sneaking into an old one),
-- and a post can't be moved to another day's dare later.
create or replace function private.set_dare_day()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.dare_day is not null then
      new.dare_day := ((now() at time zone 'utc') - interval '10 hours')::date;
    end if;
  else
    new.dare_day := old.dare_day;
  end if;
  return new;
end;
$$;

create trigger posts_set_dare_day
  before insert or update on public.posts
  for each row execute function private.set_dare_day();
