-- =====================================================================
-- The public chat 📸 (the owner's choice, 18 Nov 2026): one room for everyone on Peekaboo who is 18 or over.
-- Photos only – no text, no videos. Safe to run more than once.
--
-- The safety rules, all checked here on the server (an old or changed app can't skip them):
--   * 18 and over only. People under 18, and people who haven't saved a birthday, can't see it, can't post
--     in it and can't open its photos. (The same birthday rule hit ups use: private.age_group.)
--   * Slow mode: one photo every 30 seconds, and at most 40 a day, per person.
--   * Anyone in the room can report a photo (the owner gets the usual "New report" alert, and the photo's
--     file is kept as evidence like any other report). 3 different people reporting it hides it for everyone
--     except the person who posted it and the owner.
--   * Blocked people don't see each other's photos.
--   * You can delete your own photos.
--   * No notifications: a busy public room must not buzz everyone's phone.
--
-- NOT built yet: the AI scanner for nudity and the like (the owner: "we'll create the scanner after").
-- Until it exists the room only has reports + the 3-report hide, so keep it off the App Store channel.
-- =====================================================================
begin;
set local lock_timeout = '15s';

-- ---------------------------------------------------------------------
-- 1. The photos
-- ---------------------------------------------------------------------
create table if not exists public.public_photos (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles (id) on delete cascade,
  media_path text not null,
  created_at timestamptz not null default now(),
  -- Hidden after 3 reports (or by the owner in the Table Editor).
  hidden boolean not null default false
);
alter table public.public_photos drop constraint if exists public_photos_own_file;
alter table public.public_photos add constraint public_photos_own_file
  check (media_path like sender_id::text || '/public/%' and char_length(media_path) <= 300);
create unique index if not exists public_photos_media_path_key on public.public_photos (media_path);
create index if not exists public_photos_newest_idx on public.public_photos (created_at desc);
create index if not exists public_photos_sender_idx on public.public_photos (sender_id, created_at desc);

alter table public.public_photos enable row level security;
revoke all on public.public_photos from anon, authenticated;
grant select, delete on public.public_photos to authenticated;
-- People only say which photo; who sent it, when, and "hidden" are filled in by the server.
grant insert (media_path) on public.public_photos to authenticated;

-- Is this person allowed in the room? (18+, from the birthday they saved.)
create or replace function private.in_public_chat(person uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select person is not null and coalesce(private.age_group(person) = 'adult', false);
$$;
-- The privacy rules below call it as the logged-in person. (The "private" schema can't be reached from the app.)
revoke all on function private.in_public_chat(uuid) from public, anon;
grant execute on function private.in_public_chat(uuid) to authenticated;

drop policy if exists "Adults can see the public chat" on public.public_photos;
create policy "Adults can see the public chat" on public.public_photos for select to authenticated
  using (
    private.in_public_chat((select auth.uid()))
    and (sender_id = (select auth.uid())
      or (not hidden and not private.is_blocked(sender_id, (select auth.uid()))))
  );
drop policy if exists "Adults can post in the public chat" on public.public_photos;
create policy "Adults can post in the public chat" on public.public_photos for insert to authenticated
  with check (sender_id = (select auth.uid()) and private.in_public_chat((select auth.uid())));
drop policy if exists "You can delete your own public photos" on public.public_photos;
create policy "You can delete your own public photos" on public.public_photos for delete to authenticated
  using (sender_id = (select auth.uid()));

-- Runs before a photo is saved: fills in who and when, and checks 18+ and slow mode.
create or replace function private.prepare_public_photo()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
begin
  -- The owner and the server (no logged-in person) aren't checked.
  if me is null then
    return new;
  end if;
  new.sender_id := me;
  new.created_at := now();
  new.hidden := false;
  if not private.in_public_chat(me) then
    raise exception 'The public chat is only for people 18 and over'
      using errcode = '42501', hint = 'public_chat_adults';
  end if;
  -- One at a time per person, so two quick taps can't both get past slow mode.
  perform pg_advisory_xact_lock(hashtextextended('public-photo:' || me::text, 0));
  if exists (select 1 from public.public_photos f
              where f.sender_id = me and f.created_at > now() - interval '30 seconds') then
    raise exception 'Slow mode is on – you can post again in a few seconds 🐢'
      using errcode = '23514', hint = 'public_chat_slow';
  end if;
  if (select count(*) from public.public_photos f
       where f.sender_id = me and f.created_at > now() - interval '24 hours') >= 40 then
    raise exception 'That''s a lot of photos for one day – come back tomorrow 🙏'
      using errcode = '23514', hint = 'public_chat_daily';
  end if;
  return new;
end;
$$;
revoke all on function private.prepare_public_photo() from public, anon, authenticated;

drop trigger if exists public_photos_prepare on public.public_photos;
create trigger public_photos_prepare before insert on public.public_photos
  for each row execute function private.prepare_public_photo();
-- The same file safety as every other table with photos (see the media clean-up migrations).
drop trigger if exists guard_cleanup_reference on public.public_photos;
create trigger guard_cleanup_reference before insert or update on public.public_photos
  for each row execute function private.guard_cleanup_media_reference();
drop trigger if exists guard_deferred_reference on public.public_photos;
create trigger guard_deferred_reference before insert or update on public.public_photos
  for each row execute function private.guard_deferred_media_reference();
drop trigger if exists lock_deleted_content_media on public.public_photos;
create trigger lock_deleted_content_media before delete on public.public_photos
  for each row execute function private.lock_deleted_content_media();

-- What the app asks first: 'ok', 'no_birthday' (add your birthday to join) or 'under_18' (no room for you).
create or replace function public.public_chat_status()
returns text language sql stable security definer set search_path = '' as $$
  select case
    when (select auth.uid()) is null then 'under_18'
    when private.age_group((select auth.uid())) is null then 'no_birthday'
    when private.age_group((select auth.uid())) = 'adult' then 'ok'
    else 'under_18'
  end;
$$;
revoke all on function public.public_chat_status() from public, anon;
grant execute on function public.public_chat_status() to authenticated;

-- New photos show up live.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'public_photos') then
    alter publication supabase_realtime add table public.public_photos;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. The files: a "public" folder in each person's own space
-- ---------------------------------------------------------------------
alter policy "You can upload your own photos" on storage.objects
  with check (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (storage.foldername(name))[2] = any (array['posts', 'stories', 'snaps', 'blurs', 'voice', 'keeps', 'group', 'public'])
  );

-- Who may open a public chat photo: adults, when the photo is in the room, not hidden and not from someone
-- blocked. Kept in its own small function so private.can_read_media only needs one new line.
create or replace function private.can_read_public_photo(object_name text, owner uuid, me uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.in_public_chat(me) and not private.is_blocked(owner, me) and exists (
    select 1 from public.public_photos f
     where f.sender_id = owner and f.media_path = object_name and not f.hidden
  );
$$;
revoke all on function private.can_read_public_photo(text, uuid, uuid) from public, anon, authenticated;

-- A public chat photo's file counts as "in use" while its row is there (so it isn't cleaned up).
create or replace function private.public_photo_in_use(path_value text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.public_photos f where f.media_path = path_value);
$$;
revoke all on function private.public_photo_in_use(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Reports: a new kind, and 3 different reporters hide the photo
-- ---------------------------------------------------------------------
alter table public.reports drop constraint if exists reports_content_type_check;
alter table public.reports add constraint reports_content_type_check
  check (content_type in ('user', 'post', 'story', 'message', 'comment', 'dare_idea', 'group_message', 'public_photo'));

create or replace function private.hide_reported_public_photo()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.content_type = 'public_photo' and (
    select count(distinct r.reporter_id) from public.reports r
     where r.content_type = 'public_photo' and r.content_id = new.content_id
  ) >= 3 then
    update public.public_photos set hidden = true where id = new.content_id and not hidden;
  end if;
  return new;
end;
$$;
revoke all on function private.hide_reported_public_photo() from public, anon, authenticated;
drop trigger if exists reports_hide_public_photo on public.reports;
create trigger reports_hide_public_photo after insert on public.reports
  for each row execute function private.hide_reported_public_photo();

-- ---------------------------------------------------------------------
-- 4. Four existing functions each get one new line for the public chat
-- ---------------------------------------------------------------------
-- These functions are long and have been changed by several migrations. Instead of copying them here (and
-- risking an old copy), this reads each one as it is now, adds the public chat line at a known spot, and saves
-- it back. If the spot isn't there, the whole migration stops and nothing is changed. Running it again does
-- nothing (it sees its own line).
do $patch$
declare
  item record;
  body text;
begin
  for item in
    select * from (values
      ('private.can_read_media(text)'::regprocedure, 'can_read_public_photo',
       $a$elsif kind = 'group' then$a$,
       $b$elsif kind = 'public' then
    return private.can_read_public_photo(object_name, owner, me);
  elsif kind = 'group' then$b$),
      ('private.media_path_in_use(text,integer)'::regprocedure, 'public_photo_in_use',
       $a$select exists (select 1 from public.posts p$a$,
       $b$select private.public_photo_in_use(path_value) or exists (select 1 from public.posts p$b$),
      ('private.report_evidence_paths(text,uuid,uuid)'::regprocedure, 'public_photos',
       $a$from public.group_messages g where kind_value = 'group_message' and g.id = id_value$a$,
       $b$from public.group_messages g where kind_value = 'group_message' and g.id = id_value
  union select f.media_path from public.public_photos f where kind_value = 'public_photo' and f.id = id_value$b$),
      ('private.prepare_report()'::regprocedure, 'public_photos',
       $a$elsif new.content_type = 'group_message' then$a$,
       $b$elsif new.content_type = 'public_photo' then
    -- A public chat photo: anyone in the room (18+) who isn't blocked by its sender can report it.
    select f.sender_id, (me is null or (private.in_public_chat(me) and not private.is_blocked(f.sender_id, me))) into author, visible
      from public.public_photos f where f.id = new.content_id;
  elsif new.content_type = 'group_message' then$b$)
    ) as t(fn, marker, anchor, replacement)
  loop
    body := pg_get_functiondef(item.fn);
    if position(item.marker in body) > 0 then
      continue;
    end if;
    if position(item.anchor in body) = 0 then
      raise exception 'public chat: could not find the spot to change in %', item.fn;
    end if;
    execute replace(body, item.anchor, item.replacement);
  end loop;
end;
$patch$;

commit;
