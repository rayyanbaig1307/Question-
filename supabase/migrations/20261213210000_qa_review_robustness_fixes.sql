-- =====================================================================
-- QA review fixes, part 2: keep the hardening migration working for busy
-- accounts and for old rows.
-- Runs after 20261213102659_qa_round2_security_hardening.sql and
-- 20261213200000_qa_review_media_fixes.sql, and builds on the newest version
-- of every function it changes.
--
-- In plain words:
-- 1. File locks. While a file is being cleaned up, reported or used again, the
--    database briefly "locks" the file's name so two of these things cannot
--    happen at the same time. Before, every file got its own lock in
--    PostgreSQL's small shared lock table, kept until the end of the change.
--    Deleting a busy account (for example 25,000 old peeks) needed more locks
--    than that table has room for ("out of shared memory"), so that account
--    could never be deleted.
--    Now each file name has its own small row in private.media_path_locks, and
--    a change locks that row instead. Row locks are written on the row itself,
--    not in the shared lock table, so one change can lock any number of files.
--    * Adding something that uses a file (an upload, a post, a message, a
--      keep, a report) locks the file's row on its own ("keepers").
--    * Removing things (deleting content, deleting files, the daily cleanup)
--      shares the row with other removers ("removers"). So two deletes never
--      wait for each other, but a keeper and a remover of the SAME file still
--      take turns, exactly like before.
--    * Every file has its own row, so people using different files never wait
--      for each other.
-- 2. Message rules. The hardening migration added rules for chat messages
--    (a voice note needs its recording, a screenshot notice needs its text,
--    sound bars must be 0-100, a group text is at most 2,000 letters, a group
--    photo/video/proof needs the right media type) as "NOT VALID" table
--    checks. PostgreSQL still runs such a check on EVERY later change of an
--    old row, so an old bad row broke unrelated things: opening a chat could
--    not mark it read, deleting a message an old row replied to failed, and
--    deleting the account failed. Now the same rules are checked by a trigger
--    only on new rows and when one of the checked fields really changes. New
--    bad rows are refused with the same error code and rule name as before.
-- 3. Three missing indexes, so deleting many messages at once (a busy account)
--    takes seconds, not minutes.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. File locks
-- ---------------------------------------------------------------------

-- One row per file name. Nothing is stored in it; a change locks a file by
-- locking its row. Only the trusted functions below use it.
create table if not exists private.media_path_locks (
  object_name text primary key
);
revoke all on table private.media_path_locks from public, anon, authenticated;

-- Rows for every file that already exists or is already used, so deletes of
-- old content find their row ready.
insert into private.media_path_locks(object_name)
  select o.name from storage.objects o where o.bucket_id = 'media' and o.name is not null
  on conflict do nothing;
insert into private.media_path_locks(object_name)
  select c.object_name from private.media_cleanup_claims c on conflict do nothing;
insert into private.media_path_locks(object_name)
  select d.object_name from private.media_deferred_deletions d on conflict do nothing;
insert into private.media_path_locks(object_name)
  select e.object_name from private.report_media_evidence e where e.object_name is not null on conflict do nothing;
do $$
declare
  target text;
begin
  foreach target in array array['posts', 'stories', 'mystery_posts', 'messages', 'keeps', 'group_messages'] loop
    execute format($sql$
      insert into private.media_path_locks(object_name)
        select distinct p from public.%I t
          cross join lateral unnest(array[to_jsonb(t)->>'media_path', to_jsonb(t)->>'poster_path',
            to_jsonb(t)->>'overlay_path', to_jsonb(t)->>'blur_path']) p
        where p is not null
      on conflict do nothing$sql$, target);
  end loop;
end;
$$;

-- Locks these file names until the end of the change.
-- removing = false: an upload/post/message/keep/report ("keeper"); it waits
--   for anyone else using the same file.
-- removing = true: a delete or the cleanup ("remover"); removers share a file
--   with each other and only wait for keepers of that same file.
-- Files are always locked in the same (alphabetical) order.
create or replace function private.lock_media_paths(paths text[], removing boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare
  wanted text[];
  got integer;
begin
  select coalesce(array_agg(distinct p order by p), '{}') into wanted
    from unnest(paths) p where p is not null;
  if cardinality(wanted) = 0 then return; end if;

  -- Make sure each file has its row. If someone else is adding the same row
  -- right now, this waits until they are done.
  insert into private.media_path_locks(object_name)
    select p from unnest(wanted) p order by p
    on conflict do nothing;

  -- Lock the rows, in name order.
  if removing then
    select count(*) into got from (
      select 1 from private.media_path_locks l where l.object_name = any(wanted)
        order by l.object_name for share) x;
  else
    select count(*) into got from (
      select 1 from private.media_path_locks l where l.object_name = any(wanted)
        order by l.object_name for update) x;
  end if;
  -- Rows are never removed, so this cannot happen; stop rather than go on unlocked.
  if got <> cardinality(wanted) then
    raise exception 'Could not lock the media files - please try again';
  end if;
end;
$$;

-- The daily cleanup (service role). Same steps as before; the files are now
-- locked together, in name order, before they are checked.
create or replace function public.claim_media_cleanup(max_files integer default 500)
returns table(name text) language plpgsql security definer set search_path = '' as $$
declare
  item record;
  held text[];
  dead text[];
begin
  -- Old disappearing media that only a report still needs.
  select coalesce(array_agg(x.path order by x.path), '{}') into held from (
    select distinct e.path from private.expired_media_paths() as e(path)
      join storage.objects o on o.bucket_id = 'media' and o.name = e.path
    where e.path is not null
      and not private.media_deletion_deferred(e.path)
      and private.media_held_as_evidence(e.path)) x;
  -- Files that may be deleted now.
  select coalesce(array_agg(c.name order by c.name), '{}') into dead from public.media_cleanup_candidates(max_files) c;
  perform private.lock_media_paths(held || dead, true);

  -- Step 1: it is not deleted, but from now on it looks deleted to everyone.
  for item in select unnest(held) as path loop
    if private.media_held_as_evidence(item.path) and not private.media_path_in_use(item.path, 7) then
      insert into private.media_cleanup_claims(object_name, reason) values (item.path, 'daily')
        on conflict (object_name) do update set reason = 'daily', claimed_at = now();
      insert into private.media_deferred_deletions(object_name) values (item.path)
        on conflict (object_name) do nothing;
    end if;
  end loop;
  -- Step 2: claim the files that may be deleted now and hand them back.
  for item in select unnest(dead) as path loop
    if private.media_cleanup_eligible(item.path) then
      insert into private.media_cleanup_claims(object_name, reason) values (item.path, 'daily')
        on conflict (object_name) do update set reason = 'daily', claimed_at = now();
      name := item.path;
      return next;
    end if;
  end loop;
end;
$$;

create or replace function public.can_cleanup_snap(object_name text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or split_part(object_name, '/', 1) <> auth.uid()::text
    or split_part(object_name, '/', 2) not in ('snaps', 'voice', 'group') then return false; end if;
  -- A file that does not exist has nothing to delete. Answer without taking a
  -- file lock, because a lock adds a row that is never removed: otherwise
  -- anyone could fill that table with made-up file names.
  if not exists (select 1 from storage.objects o where o.bucket_id = 'media' and o.name = object_name) then
    return not private.media_path_in_use(object_name, 1);
  end if;
  perform private.lock_media_paths(array[object_name], true);
  if private.media_path_in_use(object_name, 1) then return false; end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'media' and o.name = object_name) then return true; end if;
  insert into private.media_cleanup_claims(object_name, reason) values (object_name, 'client')
    on conflict on constraint media_cleanup_claims_pkey do update set reason = 'client', claimed_at = now();
  return true;
end;
$$;

create or replace function private.guard_claimed_media_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  claim_reason text;
  app_user boolean := coalesce(nullif(current_setting('role', true), 'none'), '') in ('authenticated', 'anon')
    or coalesce(auth.role(), '') in ('authenticated', 'anon');
begin
  if old.bucket_id <> 'media' then return old; end if;
  perform private.lock_media_paths(array[old.name], true);
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

-- An upload (or a change of a file's record) waits for a delete of the same name.
create or replace function private.guard_cleaned_media_path()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.bucket_id = 'media' then
    perform private.lock_media_paths(array[new.name], false);
    if exists (select 1 from private.media_cleanup_claims c where c.object_name = new.name) then
      if tg_op = 'INSERT' then raise exception 'That media path has expired - use a new file name'; end if;
      if new.name is distinct from old.name or new.bucket_id is distinct from old.bucket_id
        or to_jsonb(new)->>'version' is distinct from to_jsonb(old)->>'version' then
        raise exception 'That media path has expired - use a new file name';
      end if;
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.guard_cleanup_media_reference()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  path_value text;
  old_paths text[] := '{}';
  new_paths text[];
begin
  if tg_op = 'UPDATE' then
    old_paths := array_remove(array[to_jsonb(old)->>'media_path', to_jsonb(old)->>'poster_path',
      to_jsonb(old)->>'overlay_path', to_jsonb(old)->>'blur_path'], null);
  end if;
  select coalesce(array_agg(distinct p), '{}') into new_paths from unnest(array[to_jsonb(new)->>'media_path', to_jsonb(new)->>'poster_path',
      to_jsonb(new)->>'overlay_path', to_jsonb(new)->>'blur_path']) p
    where p is not null and not (p = any(old_paths));
  if cardinality(new_paths) = 0 then return new; end if;
  perform private.lock_media_paths(new_paths, false);
  foreach path_value in array new_paths loop
    if exists (select 1 from private.media_cleanup_claims c where c.object_name = path_value)
      and not exists (select 1 from storage.objects o where o.bucket_id = 'media' and o.name = path_value) then
      raise exception 'That media has expired - choose another photo or video';
    end if;
  end loop;
  return new;
end;
$$;

-- Deleting content waits for a report that is saving the same files.
create or replace function private.lock_deleted_content_media()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.lock_media_paths(array[to_jsonb(old)->>'media_path', to_jsonb(old)->>'poster_path',
    to_jsonb(old)->>'overlay_path', to_jsonb(old)->>'blur_path'], true);
  return old;
end;
$$;

-- Same as 20261213200000, with the shared file locks.
create or replace function private.prepare_report()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  author uuid;
  visible boolean := false;
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
  perform private.lock_media_paths(array(
    select p from private.report_evidence_paths(new.content_type, new.content_id, new.reporter_id) p), false);
  return new;
end;
$$;

create or replace function private.capture_report_evidence()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  paths text[];
begin
  select coalesce(array_agg(distinct p), '{}') into paths
    from private.report_evidence_paths(new.content_type, new.content_id, new.reporter_id) p where p is not null;
  perform private.lock_media_paths(paths, false);
  insert into private.report_media_evidence(report_id, object_name)
    select new.id, p from unnest(paths) p on conflict do nothing;
  return null;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Message rules: checked on new rows and on changed fields only
-- ---------------------------------------------------------------------
alter table public.messages drop constraint if exists messages_voice_content_required;
alter table public.messages drop constraint if exists messages_screenshot_content_required;
alter table public.messages drop constraint if exists messages_waveform_values;
alter table public.group_messages drop constraint if exists group_messages_voice_required;
alter table public.group_messages drop constraint if exists group_messages_waveform_valid;
alter table public.group_messages drop constraint if exists group_messages_body_size;
alter table public.group_messages drop constraint if exists group_messages_media_kind;

-- Each rule only runs when the row is new or one of ITS fields changed. A rule
-- fails exactly when the old table check failed (a check lets "unknown"
-- through, so this does too). The error has the same code (23514) and rule
-- name as the old check.
create or replace function private.check_message_content()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  fresh boolean := tg_op = 'INSERT';
begin
  if (fresh or new.kind is distinct from old.kind or new.media_path is distinct from old.media_path
      or new.audio_ms is distinct from old.audio_ms)
    and (new.kind <> 'voice' or (new.media_path is not null and new.media_path like '%/voice/%' and new.audio_ms is not null)) is false then
    raise exception 'new row for relation "messages" violates check constraint "messages_voice_content_required"'
      using errcode = '23514', constraint = 'messages_voice_content_required', schema = 'public', table = 'messages';
  end if;
  if (fresh or new.kind is distinct from old.kind or new.body is distinct from old.body
      or new.media_path is distinct from old.media_path)
    and (new.kind <> 'screenshot' or (new.body is not null and new.body in ('chat', 'peek') and new.media_path is null)) is false then
    raise exception 'new row for relation "messages" violates check constraint "messages_screenshot_content_required"'
      using errcode = '23514', constraint = 'messages_screenshot_content_required', schema = 'public', table = 'messages';
  end if;
  if (fresh or new.waveform is distinct from old.waveform)
    and private.valid_waveform(new.waveform) is false then
    raise exception 'new row for relation "messages" violates check constraint "messages_waveform_values"'
      using errcode = '23514', constraint = 'messages_waveform_values', schema = 'public', table = 'messages';
  end if;
  return new;
end;
$$;
-- "zz_" so it runs after the other before-triggers and sees the final row.
create trigger zz_messages_content_rules
  before insert or update of kind, media_path, audio_ms, body, waveform on public.messages
  for each row execute function private.check_message_content();

create or replace function private.check_group_message_content()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  fresh boolean := tg_op = 'INSERT';
begin
  if (fresh or new.kind is distinct from old.kind or new.media_path is distinct from old.media_path
      or new.audio_ms is distinct from old.audio_ms)
    and (new.kind <> 'voice' or (new.media_path is not null and new.media_path like '%/voice/%'
      and new.audio_ms is not null and new.audio_ms between 0 and 120000)) is false then
    raise exception 'new row for relation "group_messages" violates check constraint "group_messages_voice_required"'
      using errcode = '23514', constraint = 'group_messages_voice_required', schema = 'public', table = 'group_messages';
  end if;
  if (fresh or new.waveform is distinct from old.waveform)
    and private.valid_group_waveform(new.waveform) is false then
    raise exception 'new row for relation "group_messages" violates check constraint "group_messages_waveform_valid"'
      using errcode = '23514', constraint = 'group_messages_waveform_valid', schema = 'public', table = 'group_messages';
  end if;
  if (fresh or new.body is distinct from old.body)
    and (new.body is null or char_length(new.body) <= 2000) is false then
    raise exception 'new row for relation "group_messages" violates check constraint "group_messages_body_size"'
      using errcode = '23514', constraint = 'group_messages_body_size', schema = 'public', table = 'group_messages';
  end if;
  if (fresh or new.kind is distinct from old.kind or new.media_type is distinct from old.media_type)
    and ((new.kind <> 'photo' or (new.media_type is not null and new.media_type = 'photo'))
      and (new.kind <> 'video' or (new.media_type is not null and new.media_type = 'video'))
      and (new.kind <> 'proof' or (new.media_type is not null and new.media_type in ('photo', 'video')))) is false then
    raise exception 'new row for relation "group_messages" violates check constraint "group_messages_media_kind"'
      using errcode = '23514', constraint = 'group_messages_media_kind', schema = 'public', table = 'group_messages';
  end if;
  return new;
end;
$$;
create trigger zz_group_messages_content_rules
  before insert or update of kind, media_path, audio_ms, waveform, body, media_type on public.group_messages
  for each row execute function private.check_group_message_content();

-- ---------------------------------------------------------------------
-- 3. Faster deletes of many messages. When a message is deleted, the
--    database looks for replies to it (and "delete for me" marks). Without
--    these lists it read the whole messages table once per deleted message,
--    so deleting a busy account took minutes instead of seconds.
-- ---------------------------------------------------------------------
create index if not exists messages_reply_to_idx on public.messages (reply_to) where reply_to is not null;
create index if not exists group_messages_reply_to_idx on public.group_messages (reply_to) where reply_to is not null;
create index if not exists message_hides_message_id_idx on public.message_hides (message_id);

-- ---------------------------------------------------------------------
-- App users never call these helpers themselves (triggers and trusted
-- functions still use them).
-- ---------------------------------------------------------------------
revoke execute on function private.lock_media_paths(text[], boolean) from public, anon, authenticated;
revoke execute on function private.check_message_content() from public, anon, authenticated;
revoke execute on function private.check_group_message_content() from public, anon, authenticated;

commit;
