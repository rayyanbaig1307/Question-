-- =====================================================================
-- Dare chains ("I dare YOU")
--
-- * After you post today's dare you can dare up to 3 friends. They get a push and have 24 hours.
-- * Posting that day's dare marks the dare you were given as done.
-- * A dare that runs out of time stays as "expired" – the next step (forfeits) builds on it.
-- =====================================================================

create table public.dare_nominations (
  id uuid primary key default gen_random_uuid(),
  dare_day date not null,
  from_user uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  to_user uuid not null references public.profiles (id) on delete cascade,
  post_id uuid references public.posts (id) on delete set null,        -- the dare post it came with
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  done_post_id uuid references public.posts (id) on delete set null,   -- the post that completed it
  done_at timestamptz,
  unique (dare_day, from_user, to_user),
  check (from_user <> to_user)
);
alter table public.dare_nominations enable row level security;
create index dare_nominations_to_user_idx on public.dare_nominations (to_user, dare_day);
create index dare_nominations_from_user_idx on public.dare_nominations (from_user, dare_day);

create policy "You can see dares you gave or got"
  on public.dare_nominations for select to authenticated
  using (from_user = (select auth.uid()) or to_user = (select auth.uid()));

-- Today's dare day, the same rule as posts.dare_day (new dare at 10:00 UTC).
create or replace function private.current_dare_day()
returns date language sql stable set search_path = '' as $$
  select ((now() at time zone 'utc') - interval '10 hours')::date;
$$;

-- Dare up to 3 friends with today's dare. Only after you've posted your own dare today.
-- Returns how many were dared (friends who already did today's dare, or were already dared by you, are skipped).
create or replace function public.dare_friends(targets uuid[], source_post uuid default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  today date := private.current_dare_day();
  my_name text;
  target uuid;
  given integer := 0;
  already integer;
begin
  if me is null then
    raise exception 'Please log in again';
  end if;
  if not exists (select 1 from public.posts p where p.user_id = me and p.dare_day = today) then
    raise exception 'Do today''s dare first, then dare your friends';
  end if;
  select count(*) into already from public.dare_nominations n where n.from_user = me and n.dare_day = today;
  select coalesce(display_name, username) into my_name from public.profiles where id = me;

  foreach target in array targets loop
    exit when already + given >= 3;
    if target = me or not private.are_friends(me, target) or private.is_blocked(me, target) then
      continue;
    end if;
    if exists (select 1 from public.dare_nominations n where n.from_user = me and n.to_user = target and n.dare_day = today) then
      continue;
    end if;
    if exists (select 1 from public.posts p where p.user_id = target and p.dare_day = today) then
      continue;                                           -- they've already done it
    end if;
    insert into public.dare_nominations (dare_day, from_user, to_user, post_id)
    values (today, me, target, source_post);
    given := given + 1;
    perform private.send_push(
      target, 'drops',
      '🎯 You''ve been dared!',
      my_name || ' dared you to do today''s dare. You have 24 hours ⏳',
      jsonb_build_object('type', 'dare')
    );
  end loop;
  return given;
end;
$$;
revoke execute on function public.dare_friends(uuid[], uuid) from public, anon;
grant execute on function public.dare_friends(uuid[], uuid) to authenticated;

-- Posting the day's dare completes every dare you were given for that day.
create or replace function private.complete_dare_nominations()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.dare_day is not null then
    update public.dare_nominations n
       set done_at = now(), done_post_id = new.id
     where n.to_user = new.user_id and n.dare_day = new.dare_day and n.done_at is null;
  end if;
  return new;
end;
$$;

create trigger posts_complete_dare_nominations
  after insert on public.posts
  for each row execute function private.complete_dare_nominations();
