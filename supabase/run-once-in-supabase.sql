-- =====================================================================
-- Peekaboo: database changes to run ONCE in Supabase (SQL Editor → New query → paste → Run).
-- Safe to run again if you're not sure it worked.
-- Contains: (1) screenshot notices can't be unsent, (2) delete account,
--           (3) Peekaboo Drop + Peek to see.
-- (Same as the files in supabase/migrations, made re-runnable.)
-- =====================================================================

-- (1) Screenshot notices can't be unsent -------------------------------
drop policy if exists "You can delete messages you sent" on public.messages;
create policy "You can delete messages you sent"
  on public.messages for delete to authenticated
  using (sender_id = (select auth.uid()) and kind <> 'screenshot');

-- (2) Delete account ------------------------------------------------------
create or replace function public.delete_my_account()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Not logged in';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;
revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- (3) Peekaboo Drop + Peek to see -----------------------------------------

alter table public.posts
  add column if not exists drop_day date,
  add column if not exists drop_late_seconds integer,
  add column if not exists drop_offset_minutes smallint,
  add column if not exists blur_path text;

-- One drop per person per day.
create unique index if not exists posts_one_drop_per_day on public.posts (user_id, drop_day) where drop_day is not null;

-- Minute of the day (600 = 10:00 … 1319 = 21:59) when that day's drop happens.
-- (The day number is scrambled with a standard "hash" recipe so the times look random from day to day.)
create or replace function private.drop_minute(day date)
returns integer language plpgsql immutable set search_path = '' as $$
declare
  h bigint := day - date '1970-01-01';
begin
  h := h # (h >> 16);
  h := ((h::numeric * 2246822507) % 4294967296)::bigint;
  h := h # (h >> 13);
  h := ((h::numeric * 3266489909) % 4294967296)::bigint;
  h := h # (h >> 16);
  return 600 + (h % 720)::integer;
end;
$$;

-- Fill in drop_day and drop_late_seconds when a drop is posted (and never let them change later).
create or replace function private.set_drop_fields()
returns trigger language plpgsql set search_path = '' as $$
declare
  local_now timestamp;
  drop_at timestamp;
begin
  if tg_op = 'UPDATE' then
    new.drop_day := old.drop_day;
    new.drop_late_seconds := old.drop_late_seconds;
    new.drop_offset_minutes := old.drop_offset_minutes;
    new.blur_path := old.blur_path;
    return new;
  end if;
  if new.drop_offset_minutes is null then
    new.drop_day := null;
    new.drop_late_seconds := null;
    return new;
  end if;
  if new.drop_offset_minutes not between -720 and 840 then
    raise exception 'That time zone doesn''t look right';
  end if;
  local_now := (now() at time zone 'utc') + make_interval(mins => new.drop_offset_minutes);
  new.drop_day := local_now::date;
  drop_at := new.drop_day + make_interval(mins => private.drop_minute(new.drop_day));
  if local_now < drop_at then
    raise exception 'Today''s Peekaboo drop hasn''t happened yet';
  end if;
  new.drop_late_seconds := floor(extract(epoch from (local_now - drop_at)))::integer;
  return new;
end;
$$;

drop trigger if exists posts_set_drop_fields on public.posts;
create trigger posts_set_drop_fields
  before insert or update on public.posts
  for each row execute function private.set_drop_fields();

-- Posts may also carry a blurry preview, stored in your own "blurs" folder.
drop policy if exists "You can create your own posts" on public.posts;
create policy "You can create your own posts"
  on public.posts for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and media_path like (select auth.uid())::text || '/posts/%'
    and (blur_path is null or blur_path like (select auth.uid())::text || '/blurs/%')
  );

drop policy if exists "You can upload your own photos" on storage.objects;
create policy "You can upload your own photos"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (storage.foldername(name))[2] in ('posts', 'stories', 'snaps', 'blurs')
  );

-- Who may download a photo from the private "media" bucket? Same as before, plus:
-- * a drop post's photo only after you've posted your own drop that day ("give a peek to get a peek");
-- * blurry previews for anyone who can see that person's posts.
create or replace function private.can_read_media(object_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  owner_text text := split_part(object_name, '/', 1);
  kind text := split_part(object_name, '/', 2);
  owner uuid;
begin
  if me is null then
    return false;
  end if;
  if owner_text = me::text then
    return true;                                      -- your own files
  end if;
  if owner_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  owner := owner_text::uuid;

  if kind = 'posts' then
    return private.can_see_posts(owner)
      and not exists (
        select 1 from public.posts p
        where p.media_path = object_name and p.drop_day is not null
          and not exists (
            select 1 from public.posts mine where mine.user_id = me and mine.drop_day = p.drop_day
          )
      );
  elsif kind = 'blurs' then
    return private.can_see_posts(owner);
  elsif kind = 'stories' then
    return private.can_see_stories(owner)
      and exists (
        select 1 from public.stories s
        where s.media_path = object_name and s.expires_at > now()
      );
  elsif kind = 'snaps' then
    -- only the person it was sent to: before opening, while saved, or while the replay is unused
    return not private.is_blocked(owner, me)
      and exists (
        select 1 from public.messages m
        where m.media_path = object_name and m.recipient_id = me
          and (
            m.opened_at is null
            or m.saved_at is not null
            or (m.replayed_at is null and m.opened_at > now() - interval '24 hours')
          )
      );
  end if;
  return false;
end;
$$;
