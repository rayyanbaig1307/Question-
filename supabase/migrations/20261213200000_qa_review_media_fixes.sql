-- =====================================================================
-- QA review fixes: keeps, reports, report evidence and file cleanup.
-- Runs after 20261213102659_qa_round2_security_hardening.sql and builds on it.
--
-- In plain words:
-- 1. A "keep" (a photo you saved for yourself) can only point at files in YOUR
--    own folder. Before, someone could point a keep at another person's photo
--    and stop that person from ever deleting it.
-- 2. A report only saves a copy of the files ("evidence") when the report row
--    is really saved. A skipped insert can no longer pin someone's files.
-- 3. You can only report something you can actually see. The person being
--    reported is taken from the post / story / message itself, not from the app.
-- 4. Evidence rules:
--    a. Reporting a comment keeps nothing of the post above it.
--    b. When you set a report to 'dismissed', its evidence is let go.
--       'reviewed' keeps it.
--    c. The owner can let go of one report's evidence from the SQL editor:
--         select public.release_report_evidence('<report id>');
--       Use it, for example, when illegal media must really be removed.
--       After that the file is deleted by the daily cleanup (or delete it
--       yourself in Storage).
--    d. When someone deletes one of their own files in the app, it disappears
--       for them and everyone else straight away, but the bytes are really
--       deleted by the next daily cleanup. This is the same for every file,
--       reported or not. A file a report still needs is kept (hidden) until
--       no report needs it any more; then the daily cleanup deletes it.
-- 5. Nobody can find out whether they were reported by watching what happens
--    to their own files: when they delete them, or when the daily cleanup
--    removes old peeks, stories and Guess Who posts. Private helper functions
--    can no longer be called by app users.
-- 6. The "can I delete this chat file?" check no longer fills a table with
--    made-up file names.
-- 7. New indexes so these checks stay fast as the app grows.
-- 8. Editing an old row no longer fails just because one of its files was
--    already cleaned up; file names are checked only when they change.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. Keeps: every file of a keep must be in the keep owner's own folder.
--    A trigger (not a NOT VALID check) so old rows can still be updated
--    in other ways. It only looks at the file columns when they change.
-- ---------------------------------------------------------------------
create or replace function private.keep_files_are_own()
returns trigger language plpgsql set search_path = '' as $$
declare path_value text;
begin
  if tg_op = 'UPDATE'
    and new.user_id is not distinct from old.user_id
    and new.media_path is not distinct from old.media_path
    and new.poster_path is not distinct from old.poster_path
    and new.overlay_path is not distinct from old.overlay_path then
    return new;
  end if;
  foreach path_value in array array[new.media_path, new.poster_path, new.overlay_path] loop
    if path_value is not null and split_part(path_value, '/', 1) is distinct from new.user_id::text then
      raise exception 'A keep can only use files from your own folder' using errcode = '42501';
    end if;
  end loop;
  return new;
end;
$$;
create trigger keeps_files_are_own before insert or update of user_id, media_path, poster_path, overlay_path
  on public.keeps for each row execute function private.keep_files_are_own();

-- ---------------------------------------------------------------------
-- 7. Indexes for every file column the cleanup checks look up, and for
--    finding the reports about one piece of content.
-- ---------------------------------------------------------------------
create index if not exists posts_media_path_idx on public.posts (media_path);
create index if not exists posts_poster_path_idx on public.posts (poster_path) where poster_path is not null;
create index if not exists posts_overlay_path_idx on public.posts (overlay_path) where overlay_path is not null;
create index if not exists posts_blur_path_idx on public.posts (blur_path) where blur_path is not null;
create index if not exists keeps_media_path_idx on public.keeps (media_path);
create index if not exists keeps_poster_path_idx on public.keeps (poster_path) where poster_path is not null;
create index if not exists keeps_overlay_path_idx on public.keeps (overlay_path) where overlay_path is not null;
create index if not exists group_messages_media_path_idx on public.group_messages (media_path) where media_path is not null;
create index if not exists group_messages_poster_path_idx on public.group_messages (poster_path) where poster_path is not null;
create index if not exists group_messages_overlay_path_idx on public.group_messages (overlay_path) where overlay_path is not null;
create index if not exists stories_poster_path_idx on public.stories (poster_path) where poster_path is not null;
create index if not exists stories_overlay_path_idx on public.stories (overlay_path) where overlay_path is not null;
create index if not exists mystery_posts_media_path_idx on public.mystery_posts (media_path);
create index if not exists mystery_posts_poster_path_idx on public.mystery_posts (poster_path) where poster_path is not null;
create index if not exists mystery_posts_overlay_path_idx on public.mystery_posts (overlay_path) where overlay_path is not null;
create index if not exists messages_poster_path_idx on public.messages (poster_path) where poster_path is not null;
create index if not exists messages_overlay_path_idx on public.messages (overlay_path) where overlay_path is not null;
create index if not exists reports_content_id_idx on public.reports (content_id) where content_id is not null;

-- ---------------------------------------------------------------------
-- 4d. Files waiting for the daily cleanup.
--     * Every file an app user deletes (reported or not).
--     * Old peeks, stories and Guess Who files the daily cleanup would have
--       deleted, but a report still needs.
--     A file in this list looks deleted to everyone in the app. The daily
--     cleanup deletes it once nothing and no report needs it any more.
-- ---------------------------------------------------------------------
create table private.media_deferred_deletions (
  object_name text primary key,
  requested_at timestamptz not null default now()
);
alter table private.media_deferred_deletions enable row level security;
revoke all on table private.media_deferred_deletions from public, anon, authenticated;
grant all on table private.media_deferred_deletions to service_role;

-- ---------------------------------------------------------------------
-- Cleanup checks, split in two so app users never learn about reports:
-- * "in use"  = something in the app still shows or needs the file
--               (this never looks at reports);
-- * "evidence" = a report still needs the file.
-- Each lookup is a plain "column = value" test so it can use an index.
-- ---------------------------------------------------------------------
create or replace function private.media_path_in_use(path_value text, retention_days integer)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.posts p
      where p.media_path = path_value or p.poster_path = path_value or p.overlay_path = path_value or p.blur_path = path_value)
    -- A keep only counts for files in the keep owner's own folder.
    or exists (select 1 from public.keeps k
      where (k.media_path = path_value or k.poster_path = path_value or k.overlay_path = path_value)
        and split_part(path_value, '/', 1) = k.user_id::text)
    or exists (select 1 from public.group_messages g
      where g.media_path = path_value or g.poster_path = path_value or g.overlay_path = path_value)
    or exists (select 1 from public.stories s
      where (s.media_path = path_value or s.poster_path = path_value or s.overlay_path = path_value)
        and s.expires_at >= now() - interval '7 days')
    or exists (select 1 from public.mystery_posts g
      where (g.media_path = path_value or g.poster_path = path_value or g.overlay_path = path_value)
        and g.expires_at >= now() - interval '7 days')
    or exists (select 1 from public.messages m
      where (m.media_path = path_value or m.poster_path = path_value or m.overlay_path = path_value)
        and (m.kind <> 'snap' or m.opened_at is null or m.opened_at >= now() - make_interval(days => retention_days)
          or m.saved_at is not null));
$$;

create or replace function private.media_held_as_evidence(path_value text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.report_media_evidence e where e.object_name = path_value);
$$;

create or replace function private.media_deletion_deferred(path_value text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.media_deferred_deletions d where d.object_name = path_value);
$$;

-- Same name and meaning as before (not in use and not needed by a report).
create or replace function private.media_cleanup_safe(path_value text, retention_days integer)
returns boolean language sql stable security definer set search_path = '' as $$
  select not private.media_path_in_use(path_value, retention_days) and not private.media_held_as_evidence(path_value);
$$;

-- May the daily cleanup delete this file now?
create or replace function private.media_cleanup_eligible(path_value text)
returns boolean language sql stable security definer set search_path = '' as $$
  select not private.media_held_as_evidence(path_value) and (
    -- Its owner already deleted it while a report needed it.
    (private.media_deletion_deferred(path_value) and not private.media_path_in_use(path_value, 1))
    -- Old disappearing media: expired stories / Guess Who, opened peeks nobody saved.
    or (not private.media_path_in_use(path_value, 7) and (
      exists (select 1 from public.stories s
        where (s.media_path = path_value or s.poster_path = path_value or s.overlay_path = path_value)
          and s.expires_at < now() - interval '7 days')
      or exists (select 1 from public.mystery_posts g
        where (g.media_path = path_value or g.poster_path = path_value or g.overlay_path = path_value)
          and g.expires_at < now() - interval '7 days')
      or exists (select 1 from public.messages m
        where (m.media_path = path_value or m.poster_path = path_value or m.overlay_path = path_value)
          and m.kind = 'snap' and m.opened_at < now() - interval '7 days' and m.saved_at is null)
    ))
  );
$$;

-- Files of old disappearing media: stories and Guess Who posts that ended
-- over 7 days ago, and peeks opened over 7 days ago that nobody saved.
create or replace function private.expired_media_paths()
returns setof text language sql stable security definer set search_path = '' as $$
  select unnest(array[s.media_path, s.poster_path, s.overlay_path]) from public.stories s
    where s.expires_at < now() - interval '7 days'
  union all
  select unnest(array[g.media_path, g.poster_path, g.overlay_path]) from public.mystery_posts g
    where g.expires_at < now() - interval '7 days'
  union all
  select unnest(array[m.media_path, m.poster_path, m.overlay_path]) from public.messages m
    where m.kind = 'snap' and m.opened_at < now() - interval '7 days' and m.saved_at is null;
$$;

-- The daily cleanup's list now also includes files waiting from step 4d.
create or replace function public.media_cleanup_candidates(max_files integer default 500)
returns table(name text) language sql stable security definer set search_path = '' as $$
  with dead as (
    select e.path from private.expired_media_paths() as e(path)
    union all
    select d.object_name from private.media_deferred_deletions d
  )
  select distinct d.path from dead d join storage.objects o on o.bucket_id = 'media' and o.name = d.path
  where d.path is not null and private.media_cleanup_eligible(d.path)
  order by d.path limit least(1000, greatest(coalesce(max_files, 0), 0));
$$;

-- The daily cleanup (supabase/functions/cleanup-media, service role only).
-- Step 1: old disappearing media that only a report still needs is NOT
--   deleted, but from now on it looks deleted to everyone in the app, exactly
--   like the files this run really deletes. So its owner cannot tell that it
--   was reported. (It is deleted later, once no report needs it.)
-- Step 2: claim the files that may be deleted now and hand them back; the
--   Edge Function then deletes them through Storage.
create or replace function public.claim_media_cleanup(max_files integer default 500)
returns table(name text) language plpgsql security definer set search_path = '' as $$
declare item record;
begin
  for item in
    select distinct e.path from private.expired_media_paths() as e(path)
      join storage.objects o on o.bucket_id = 'media' and o.name = e.path
    where e.path is not null
      and not private.media_deletion_deferred(e.path)
      and private.media_held_as_evidence(e.path)
    order by e.path
  loop
    perform pg_advisory_xact_lock(hashtextextended('media-cleanup:' || item.path, 0));
    if private.media_held_as_evidence(item.path) and not private.media_path_in_use(item.path, 7) then
      insert into private.media_cleanup_claims(object_name, reason) values (item.path, 'daily')
        on conflict (object_name) do update set reason = 'daily', claimed_at = now();
      insert into private.media_deferred_deletions(object_name) values (item.path)
        on conflict (object_name) do nothing;
    end if;
  end loop;
  for item in select c.name as path from public.media_cleanup_candidates(max_files) c order by c.name loop
    perform pg_advisory_xact_lock(hashtextextended('media-cleanup:' || item.path, 0));
    if private.media_cleanup_eligible(item.path) then
      insert into private.media_cleanup_claims(object_name, reason) values (item.path, 'daily')
        on conflict (object_name) do update set reason = 'daily', claimed_at = now();
      name := item.path;
      return next;
    end if;
  end loop;
end;
$$;
revoke execute on function public.claim_media_cleanup(integer) from public, anon, authenticated;
grant execute on function public.claim_media_cleanup(integer) to service_role;

-- "May I delete this chat file of mine?" The answer never depends on reports.
-- It only claims (blocks re-use of) files that really exist.
create or replace function public.can_cleanup_snap(object_name text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or split_part(object_name, '/', 1) <> auth.uid()::text
    or split_part(object_name, '/', 2) not in ('snaps', 'voice', 'group') then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('media-cleanup:' || object_name, 0));
  if private.media_path_in_use(object_name, 1) then return false; end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'media' and o.name = object_name) then return true; end if;
  insert into private.media_cleanup_claims(object_name, reason) values (object_name, 'client')
    on conflict on constraint media_cleanup_claims_pkey do update set reason = 'client', claimed_at = now();
  return true;
end;
$$;

-- Runs before Storage deletes a file's record (Storage only deletes the bytes
-- of records it really deleted, and sends those records back to the caller).
-- * App users: a file still in use cannot be deleted (same message whether or
--   not it was reported). Any other file is never deleted on the spot: the
--   delete "succeeds", Storage gets no record back (so it deletes no bytes and
--   tells the caller "nothing removed"), the path is remembered in
--   private.media_deferred_deletions and the file looks deleted in the app.
--   This happens for EVERY file, reported or not, so the answer never shows a
--   report. The daily cleanup really deletes it (or keeps it for a report).
-- * Owner / service role / daily cleanup: refused with a clear message while a
--   report still needs the file (let it go with public.release_report_evidence).
create or replace function private.guard_claimed_media_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  claim_reason text;
  app_user boolean := coalesce(nullif(current_setting('role', true), 'none'), '') in ('authenticated', 'anon')
    or coalesce(auth.role(), '') in ('authenticated', 'anon');
begin
  if old.bucket_id <> 'media' then return old; end if;
  perform pg_advisory_xact_lock(hashtextextended('media-cleanup:' || old.name, 0));
  -- Explicit, verified account deletion removes all of the person's own files.
  if exists (select 1 from private.account_media_deletions d where d.expires_at > now()
      and (d.user_id::text = old.owner_id or d.user_id::text = split_part(old.name, '/', 1))) then
    insert into private.media_cleanup_claims(object_name, reason) values (old.name, 'client') on conflict (object_name) do nothing;
    delete from private.media_deferred_deletions d where d.object_name = old.name;
    return old;
  end if;
  select c.reason into claim_reason from private.media_cleanup_claims c where c.object_name = old.name;
  if app_user then
    if private.media_path_in_use(old.name, 1) then
      raise exception 'Cleanup cancelled because media is still in use';
    end if;
    -- Never look at reports here: the same thing happens to every file.
    insert into private.media_cleanup_claims(object_name, reason) values (old.name, 'client') on conflict (object_name) do nothing;
    insert into private.media_deferred_deletions(object_name) values (old.name) on conflict (object_name) do nothing;
    return null;
  elsif claim_reason = 'daily' then
    if not private.media_cleanup_eligible(old.name) then
      raise exception 'Cleanup cancelled because media is still in use or kept for a report';
    end if;
  elsif not private.media_cleanup_safe(old.name, 1) then
    raise exception 'Cleanup cancelled because media is still in use or kept for a report (see public.release_report_evidence)';
  end if;
  insert into private.media_cleanup_claims(object_name, reason) values (old.name, coalesce(claim_reason, 'client'))
    on conflict (object_name) do nothing;
  delete from private.media_deferred_deletions d where d.object_name = old.name;
  return old;
end;
$$;

-- A file waiting from step 4d looks deleted in the app: nobody can list,
-- download or sign it, and a second delete finds nothing.
-- (Links that were signed BEFORE the delete keep working until the daily
-- cleanup really deletes the bytes, because Storage serves signed links
-- without these rules. See the notes at the end of this file.)
-- (The rule only looks at the file's own name. It must not look the file up in
-- storage.objects: Storage saves a new upload with "insert ... returning", and
-- this rule is checked before the new row is in the table.)
create policy "Files waiting for the daily cleanup look deleted" on storage.objects
  as restrictive for select to authenticated
  using (bucket_id <> 'media' or not private.media_deletion_deferred(name));

-- A file's path is checked when a row starts using it, not on every later
-- edit of the row. Before, editing anything on an old row (for example an old
-- opened peek whose file the daily cleanup already removed) failed with
-- "That media has expired".
create or replace function private.guard_cleanup_media_reference()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  path_value text;
  old_paths text[] := '{}';
begin
  if tg_op = 'UPDATE' then
    old_paths := array_remove(array[to_jsonb(old)->>'media_path', to_jsonb(old)->>'poster_path',
      to_jsonb(old)->>'overlay_path', to_jsonb(old)->>'blur_path'], null);
  end if;
  for path_value in select distinct p from unnest(array[to_jsonb(new)->>'media_path', to_jsonb(new)->>'poster_path',
      to_jsonb(new)->>'overlay_path', to_jsonb(new)->>'blur_path']) p
    where p is not null and not (p = any(old_paths)) order by p loop
    perform pg_advisory_xact_lock(hashtextextended('media-cleanup:' || path_value, 0));
    if exists (select 1 from private.media_cleanup_claims c where c.object_name = path_value)
      and not exists (select 1 from storage.objects o where o.bucket_id = 'media' and o.name = path_value) then
      raise exception 'That media has expired - choose another photo or video';
    end if;
  end loop;
  return new;
end;
$$;

-- "Did I upload this file?" (used when posting a Guess Who) says no for a file
-- waiting from step 4d, just like for a file that is really gone.
create or replace function private.uploaded_by_me(object_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select object_name is null or exists (
    select 1 from storage.objects o
     where o.bucket_id = 'media' and o.name = object_name and o.owner_id = (select auth.uid())::text
       and not exists (select 1 from private.media_deferred_deletions d where d.object_name = o.name)
  );
$$;

-- A file waiting from step 4d cannot be used again in a new post, keep, etc.
-- (same message as for a file that is really gone).
create or replace function private.guard_deferred_media_reference()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  path_value text;
  old_paths text[] := '{}';
begin
  if tg_op = 'UPDATE' then
    old_paths := array_remove(array[to_jsonb(old)->>'media_path', to_jsonb(old)->>'poster_path',
      to_jsonb(old)->>'overlay_path', to_jsonb(old)->>'blur_path'], null);
  end if;
  for path_value in select distinct p from unnest(array[to_jsonb(new)->>'media_path', to_jsonb(new)->>'poster_path',
      to_jsonb(new)->>'overlay_path', to_jsonb(new)->>'blur_path']) p
    where p is not null and not (p = any(old_paths)) order by p loop
    if private.media_deletion_deferred(path_value) then
      raise exception 'That media has expired - choose another photo or video';
    end if;
  end loop;
  return new;
end;
$$;
do $$ declare target text; begin
  foreach target in array array['posts', 'stories', 'mystery_posts', 'messages', 'keeps', 'group_messages'] loop
    execute format('create trigger guard_deferred_reference before insert or update on public.%I for each row execute function private.guard_deferred_media_reference()', target);
  end loop;
end; $$;

-- ---------------------------------------------------------------------
-- 3. Reports: you can only report what you can see.
-- ---------------------------------------------------------------------

-- Which files of a piece of content are kept as evidence for this reporter.
-- A comment report keeps nothing of the post above it (comments have no files).
-- A drop post the reporter has not unlocked keeps only its blurry preview.
create or replace function private.report_evidence_paths(kind_value text, id_value uuid, reporter uuid)
returns setof text language sql stable security definer set search_path = '' as $$
  select unnest(case
      when p.drop_day is not null and p.user_id is distinct from reporter and (
        not exists (select 1 from public.posts mine where mine.user_id = reporter and mine.drop_day = p.drop_day)
        or private.group_holds_drop(reporter, p.user_id, p.drop_day))
      then array[p.blur_path]
      else array[p.media_path, p.poster_path, p.overlay_path, p.blur_path] end)
    from public.posts p where kind_value = 'post' and p.id = id_value
  union select unnest(array[g.media_path, g.poster_path, g.overlay_path]) from public.mystery_posts g where kind_value = 'post' and g.id = id_value
  union select unnest(array[s.media_path, s.poster_path, s.overlay_path]) from public.stories s where kind_value = 'story' and s.id = id_value
  union select unnest(array[m.media_path, m.poster_path, m.overlay_path]) from public.messages m where kind_value = 'message' and m.id = id_value
  union select unnest(array[g.media_path, g.poster_path, g.overlay_path]) from public.group_messages g where kind_value = 'group_message' and g.id = id_value;
$$;

-- The older helper keeps its name, without the parent post of a comment.
create or replace function private.report_media_paths(kind_value text, id_value uuid)
returns setof text language sql stable security definer set search_path = '' as $$
  select unnest(array[p.media_path, p.poster_path, p.overlay_path, p.blur_path]) from public.posts p where kind_value = 'post' and p.id = id_value
  union select unnest(array[g.media_path, g.poster_path, g.overlay_path]) from public.mystery_posts g where kind_value = 'post' and g.id = id_value
  union select unnest(array[s.media_path, s.poster_path, s.overlay_path]) from public.stories s where kind_value = 'story' and s.id = id_value
  union select unnest(array[m.media_path, m.poster_path, m.overlay_path]) from public.messages m where kind_value = 'message' and m.id = id_value
  union select unnest(array[g.media_path, g.poster_path, g.overlay_path]) from public.group_messages g where kind_value = 'group_message' and g.id = id_value;
$$;

-- Before a report is saved: check it, and fill in the facts from the server.
-- (Saving the evidence happens AFTER the insert, see capture_report_evidence.)
-- Reports made by trusted code without a logged-in user (SQL editor, service
-- role) skip the "can you see it" check.
create or replace function private.prepare_report()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  author uuid;
  visible boolean := false;
  path_value text;
begin
  new.status := 'open';
  new.created_at := now();
  -- Reporting a person (profile or hit up): the person is the content.
  if new.content_type = 'user' then
    new.content_id := coalesce(new.content_id, new.reported_user_id);
    new.reported_user_id := new.content_id;
    if new.content_id is null then raise exception 'Pick who you want to report'; end if;
    return new;
  end if;
  if new.content_type = 'dare_idea' then
    select d.user_id into author from public.dare_ideas d where d.id = new.content_id;
    if author is null then raise exception 'That idea is gone'; end if;
    new.reported_user_id := author;
    return new;
  end if;

  if new.content_type = 'post' then
    select p.user_id, (me is null or private.can_see_post(p.id)) into author, visible
      from public.posts p where p.id = new.content_id;
    if author is null then
      -- A Guess Who post: the poster stays hidden from the reporter.
      select g.user_id, (me is null or private.can_see_mystery(g.user_id, now() + interval '1 second', me)) into author, visible
        from public.mystery_posts g where g.id = new.content_id;
      if author is not null then new.anonymous_content := true; end if;
    end if;
  elsif new.content_type = 'story' then
    -- Expired stories can still be reported by someone who could see them.
    select s.user_id, (me is null or (private.can_see_stories(s.user_id) and private.in_audience(s.user_id, s.audience))) into author, visible
      from public.stories s where s.id = new.content_id;
  elsif new.content_type = 'message' then
    select m.sender_id, (me is null or me in (m.sender_id, m.recipient_id)) into author, visible
      from public.messages m where m.id = new.content_id;
  elsif new.content_type = 'comment' then
    select c.user_id, (me is null or private.can_see_post(c.post_id)) into author, visible
      from public.comments c where c.id = new.content_id;
  elsif new.content_type = 'group_message' then
    select g.sender_id, private.is_group_member(g.group_id, new.reporter_id) into author, visible
      from public.group_messages g where g.id = new.content_id;
    if author is null or not coalesce(visible, false) then raise exception 'That message is gone'; end if;
  end if;

  if author is null then
    if me is null then return new; end if;
    raise exception 'This can''t be reported - it is gone or you can''t see it';
  end if;
  if not coalesce(visible, false) then
    raise exception 'This can''t be reported - it is gone or you can''t see it';
  end if;
  new.reported_user_id := author;
  -- Hold the files so a delete by their owner waits until this report is saved.
  for path_value in select distinct p from private.report_evidence_paths(new.content_type, new.content_id, new.reporter_id) p
      where p is not null order by p loop
    perform pg_advisory_xact_lock(hashtextextended('media-cleanup:' || path_value, 0));
  end loop;
  return new;
end;
$$;

-- After a report is really saved (a skipped "on conflict do nothing" insert
-- never gets here): keep its files as evidence.
create or replace function private.capture_report_evidence()
returns trigger language plpgsql security definer set search_path = '' as $$
declare path_value text;
begin
  for path_value in select distinct p from private.report_evidence_paths(new.content_type, new.content_id, new.reporter_id) p
      where p is not null order by p loop
    perform pg_advisory_xact_lock(hashtextextended('media-cleanup:' || path_value, 0));
    insert into private.report_media_evidence(report_id, object_name) values (new.id, path_value) on conflict do nothing;
  end loop;
  return null;
end;
$$;
create trigger reports_capture_evidence after insert on public.reports
  for each row execute function private.capture_report_evidence();

-- ---------------------------------------------------------------------
-- 4b/4c. Letting go of evidence.
-- ---------------------------------------------------------------------
create or replace function private.release_dismissed_report_evidence()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from private.report_media_evidence e where e.report_id = new.id;
  return null;
end;
$$;
create trigger reports_release_dismissed_evidence after update of status on public.reports
  for each row when (new.status = 'dismissed' and old.status is distinct from 'dismissed')
  execute function private.release_dismissed_report_evidence();

-- For the owner, in the Supabase SQL editor:
--   select public.release_report_evidence('<report id>');
-- Lets go of the files one report was keeping (the report itself stays).
-- Returns how many files were let go. Files nobody else needs are then
-- deleted by the daily cleanup, or you can delete them in Storage yourself.
create or replace function public.release_report_evidence(report uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare released integer;
begin
  delete from private.report_media_evidence e where e.report_id = report;
  get diagnostics released = row_count;
  return released;
end;
$$;
revoke execute on function public.release_report_evidence(uuid) from public, anon, authenticated;
grant execute on function public.release_report_evidence(uuid) to service_role;

-- Apply the new rules to evidence saved before this migration:
-- comment reports keep nothing of the parent post, dismissed reports keep nothing.
delete from private.report_media_evidence e using public.reports r
  where r.id = e.report_id and (r.content_type = 'comment' or r.status = 'dismissed');

-- ---------------------------------------------------------------------
-- 5. Private helpers that app users never need to call themselves.
--    (Triggers and trusted functions still use them; a trigger does not need
--    the user to have EXECUTE.) Helpers the privacy rules use stay callable.
-- ---------------------------------------------------------------------
do $$
declare fn regprocedure;
begin
  for fn in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = any (array[
      -- cleanup, reports and evidence
      'media_cleanup_safe', 'media_cleanup_eligible', 'media_path_in_use', 'media_held_as_evidence',
      'expired_media_paths',
      'report_media_paths', 'report_evidence_paths', 'prepare_report',
      'capture_report_evidence', 'release_dismissed_report_evidence', 'guard_claimed_media_delete',
      'guard_cleaned_media_path', 'guard_cleanup_media_reference', 'guard_deferred_media_reference',
      'lock_deleted_content_media', 'keep_files_are_own', 'alert_new_report',
      -- push notifications
      'send_push', 'push_name', 'push_comment', 'push_comment_like', 'push_friendship', 'push_group_added',
      'push_group_message', 'push_like', 'push_new_message', 'push_reaction',
      -- groups, hit ups, dares and friends
      'add_group_members', 'connect_hit_up', 'hit_up_problem', 'have_mutual_friend', 'age_group',
      'dare_streak', 'can_see_mystery', 'enforce_group_size', 'enforce_hit_up_quota', 'enforce_nudge_cooldown',
      'complete_dare_nominations', 'count_dare_votes', 'pay_forfeit', 'prepare_dare_idea',
      'check_comment_reply', 'check_forfeit_post', 'check_group_proof', 'check_reply_to', 'check_today',
      'clear_location_when_ghost', 'clear_new_dare_state', 'group_message_preview',
      'handle_new_user', 'km_between', 'rough_km', 'prepare_group_message', 'prepare_message_state',
      'prepare_post_timestamp', 'set_dare_day', 'set_drop_fields', 'set_story_expiry', 'touch_updated_at'
    ])
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
  end loop;
end;
$$;
-- Kept callable: the privacy-rule helpers, the date helpers drop_minute and
-- current_dare_day (they only tell today's dare/drop time) and the word checks.
-- The storage rule above needs this one.
revoke execute on function private.media_deletion_deferred(text) from public, anon;
grant execute on function private.media_deletion_deferred(text) to authenticated;

commit;
