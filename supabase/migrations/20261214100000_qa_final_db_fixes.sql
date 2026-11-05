-- =====================================================================
-- QA final database fixes.
-- Runs after every earlier QA fix migration and builds on the newest
-- version of each function it changes (20261213210000 for the reports and
-- the daily cleanup), keeping all their fixes, including the file locks
-- (private.lock_media_paths).
--
-- In plain words:
-- 1. Hidden dare ideas. After three reports a dare idea is hidden from
--    everyone except the person who wrote it. Before, anyone could still
--    "report" a hidden idea straight into the reports table and get back the
--    name of the person who wrote it. Now an app user can only report an idea
--    they can see. For an idea that is hidden from them, or does not exist,
--    they get the same answer: "This can't be reported - it is gone or you
--    can't see it". Reporting from the app (report_dare_idea) works as before.
-- 2. A faster daily cleanup. The daily cleanup looks at every old peek, story
--    and Guess Who post ever made. Before, it ran its slow checks on every one
--    of them, even when the file was already deleted long ago, so it got a
--    little slower every day (about 8 seconds for 12,000 old peeks). Now it
--    first keeps only the files that still exist, and checks only those.
--    The list of files it deletes or keeps is exactly the same as before.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. Reports: a hidden dare idea is "gone" for everyone but its writer.
--    Same as the 20261213210000 version, except for the dare idea part.
-- ---------------------------------------------------------------------
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
    -- Same rule as the "Ideas are public unless hidden" privacy rule: you can
    -- see an idea that is not hidden, and your own ideas.
    select d.user_id, (me is null or not d.hidden or d.user_id = me) into author, visible
      from public.dare_ideas d where d.id = new.content_id;
    if me is not null and (author is null or not coalesce(visible, false)) then
      raise exception 'This can''t be reported - it is gone or you can''t see it';
    end if;
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

-- ---------------------------------------------------------------------
-- 2. The daily cleanup only checks files that still exist.
--    "materialized" makes the database first build the short list of files
--    that still exist, and only then run the slow checks on that list.
-- ---------------------------------------------------------------------

-- Files the daily cleanup may delete now (same answer as the
-- 20261213200000 version: old disappearing media and files waiting since
-- their owner deleted them, that nothing and no report needs any more).
create or replace function public.media_cleanup_candidates(max_files integer default 500)
returns table(name text) language sql stable security definer set search_path = '' as $$
  with still_stored as materialized (
    select distinct dead.path from (
      select e.path from private.expired_media_paths() as e(path)
      union all
      select w.object_name from private.media_deferred_deletions w
    ) dead
    where dead.path is not null
      and exists (select 1 from storage.objects o where o.bucket_id = 'media' and o.name = dead.path)
  )
  select s.path from still_stored s
  where private.media_cleanup_eligible(s.path)
  order by s.path limit least(1000, greatest(coalesce(max_files, 0), 0));
$$;

-- Old disappearing media (still stored) that only a report still needs and
-- that is not already waiting for the cleanup. Step 1 of claim_media_cleanup.
create or replace function private.media_cleanup_held_paths()
returns setof text language sql stable security definer set search_path = '' as $$
  with still_stored as materialized (
    select distinct e.path from private.expired_media_paths() as e(path)
    where e.path is not null
      and exists (select 1 from storage.objects o where o.bucket_id = 'media' and o.name = e.path)
  )
  select s.path from still_stored s
  where not private.media_deletion_deferred(s.path)
    and private.media_held_as_evidence(s.path)
  order by s.path;
$$;
revoke execute on function private.media_cleanup_held_paths() from public, anon, authenticated;

-- The daily cleanup (service role). Same steps as the 20261213210000
-- version; step 1 now uses the faster list above.
create or replace function public.claim_media_cleanup(max_files integer default 500)
returns table(name text) language plpgsql security definer set search_path = '' as $$
declare
  item record;
  held text[];
  dead text[];
begin
  -- Old disappearing media that only a report still needs.
  select coalesce(array_agg(h.path order by h.path), '{}') into held
    from private.media_cleanup_held_paths() as h(path);
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
-- Only the daily cleanup (service role) may run these. ("create or replace"
-- keeps the earlier rules; they are repeated here so this file says it too.)
revoke execute on function public.claim_media_cleanup(integer) from public, anon, authenticated;
grant execute on function public.claim_media_cleanup(integer) to service_role;
revoke execute on function public.media_cleanup_candidates(integer) from public, anon, authenticated;
revoke execute on function private.prepare_report() from public, anon, authenticated;

commit;
