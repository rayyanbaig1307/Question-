-- ---------------------------------------------------------------------
-- Old photos and videos are cleaned up once nobody can see them any more, so storage doesn't fill up.
-- Once a day the cleanup-media Edge Function deletes the files of:
--   * stories that ended more than 7 days ago,
--   * Guess Who posts that ended more than 7 days ago,
--   * peeks that were opened more than 7 days ago and that nobody saved.
-- The app already hides these (see private.can_read_media); this just frees the space. The rows stay, so a
-- chat still shows "You sent a peek".
-- Never deleted: profile/feed posts, Keeps, voice notes, saved peeks, anything still live, and anything that
-- was reported (the owner may need it as evidence). The 7 days leave time to deal with reports.
-- Only these three kinds are ever touched, so files from any other or future feature are safe.
-- ---------------------------------------------------------------------

create extension if not exists pg_cron;

-- The files that can go (at most `max_files` per run).
create or replace function public.media_cleanup_candidates(max_files integer default 500)
returns table (name text)
language sql stable security definer set search_path = '' as $$
  with reported as (
    select content_id from public.reports where content_id is not null
  ),
  dead as (
    select unnest(array[s.media_path, s.poster_path, s.overlay_path]) as path
      from public.stories s
     where s.expires_at < now() - interval '7 days' and s.id not in (select content_id from reported)
    union all
    select unnest(array[g.media_path, g.poster_path, g.overlay_path])
      from public.mystery_posts g
     where g.expires_at < now() - interval '7 days' and g.id not in (select content_id from reported)
    union all
    select unnest(array[m.media_path, m.poster_path, m.overlay_path])
      from public.messages m
     where m.kind = 'snap' and m.opened_at < now() - interval '7 days' and m.saved_at is null
       and m.id not in (select content_id from reported)
  ),
  -- Anything still in use somewhere else keeps its file (the same file can be shared, e.g. a story that's
  -- also a post, or a Keep).
  live as (
    select unnest(array[p.media_path, p.poster_path, p.overlay_path, p.blur_path]) as path from public.posts p
    union all
    select unnest(array[k.media_path, k.poster_path, k.overlay_path]) from public.keeps k
    union all
    select unnest(array[s.media_path, s.poster_path, s.overlay_path]) from public.stories s
     where s.expires_at >= now() - interval '7 days' or s.id in (select content_id from reported)
    union all
    select unnest(array[g.media_path, g.poster_path, g.overlay_path]) from public.mystery_posts g
     where g.expires_at >= now() - interval '7 days' or g.id in (select content_id from reported)
    union all
    select unnest(array[m.media_path, m.poster_path, m.overlay_path]) from public.messages m
     where m.kind <> 'snap' or m.opened_at is null or m.opened_at >= now() - interval '7 days'
        or m.saved_at is not null or m.id in (select content_id from reported)
  )
  select distinct d.path
    from dead d
    join storage.objects o on o.bucket_id = 'media' and o.name = d.path
   where d.path is not null
     and not exists (select 1 from live l where l.path = d.path)
   limit greatest(max_files, 0);
$$;
revoke execute on function public.media_cleanup_candidates(integer) from public, anon, authenticated;
grant execute on function public.media_cleanup_candidates(integer) to service_role;

-- A random password, kept in the Vault, that the daily job sends so only it can start the cleanup.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'media_cleanup_key') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
      'media_cleanup_key',
      'Lets the daily pg_cron job call the cleanup-media Edge Function'
    );
  end if;
end;
$$;

create or replace function public.media_cleanup_key_ok(given text)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(given, '') <> ''
     and exists (select 1 from vault.decrypted_secrets where name = 'media_cleanup_key' and decrypted_secret = given);
$$;
revoke execute on function public.media_cleanup_key_ok(text) from public, anon, authenticated;
grant execute on function public.media_cleanup_key_ok(text) to service_role;

-- Every day at 04:17 UTC (night-time in North America).
select cron.unschedule('peekaboo-media-cleanup') where exists (select 1 from cron.job where jobname = 'peekaboo-media-cleanup');
select cron.schedule('peekaboo-media-cleanup', '17 4 * * *', $job$
  select net.http_post(
    url := 'https://vclexbnnykjpmxoyakcp.supabase.co/functions/v1/cleanup-media',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cleanup-key', (select decrypted_secret from vault.decrypted_secrets where name = 'media_cleanup_key')
    ),
    body := '{}'::jsonb
  );
$job$);
