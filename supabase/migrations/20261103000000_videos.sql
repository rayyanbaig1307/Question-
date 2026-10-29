-- =====================================================================
-- Videos (up to 10 seconds) in posts, stories, chat peeks and drops.
-- Each video can come with:
--   * poster_path  – a still picture from the video (for grids, previews, blurred drops)
--   * overlay_path – the text and stickers you added, as a see-through picture shown on top
-- =====================================================================

alter table public.posts
  add column if not exists media_type text not null default 'photo' check (media_type in ('photo', 'video')),
  add column if not exists poster_path text,
  add column if not exists overlay_path text;

alter table public.stories
  add column if not exists media_type text not null default 'photo' check (media_type in ('photo', 'video')),
  add column if not exists poster_path text,
  add column if not exists overlay_path text;

alter table public.messages
  add column if not exists media_type text not null default 'photo' check (media_type in ('photo', 'video')),
  add column if not exists poster_path text,
  add column if not exists overlay_path text;

-- The photo store now also takes short videos (up to 30 MB – a 10-second video is usually 3–5 MB).
update storage.buckets
   set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime'],
       file_size_limit = 31457280
 where id = 'media';

-- The extra files must live in your own folders, like the main file.
alter policy "You can create your own posts" on public.posts
  with check (
    user_id = (select auth.uid())
    and media_path like (select auth.uid())::text || '/posts/%'
    and (blur_path is null or blur_path like (select auth.uid())::text || '/blurs/%')
    and (poster_path is null or poster_path like (select auth.uid())::text || '/posts/%')
    and (overlay_path is null or overlay_path like (select auth.uid())::text || '/posts/%')
  );

alter policy "You can post your own stories" on public.stories
  with check (
    user_id = (select auth.uid())
    and media_path like (select auth.uid())::text || '/stories/%'
    and (poster_path is null or poster_path like (select auth.uid())::text || '/stories/%')
    and (overlay_path is null or overlay_path like (select auth.uid())::text || '/stories/%')
  );

alter policy "You can message your friends" on public.messages
  with check (
    sender_id = (select auth.uid())
    and opened_at is null
    and private.are_friends(sender_id, recipient_id)
    and not private.is_blocked(sender_id, recipient_id)
    and (media_path is null or media_path like (select auth.uid())::text || '/snaps/%')
    and (poster_path is null or poster_path like (select auth.uid())::text || '/snaps/%')
    and (overlay_path is null or overlay_path like (select auth.uid())::text || '/snaps/%')
  );

-- Who may download a file from the private "media" bucket? Same rules as before; the video's still picture
-- and its text/sticker layer follow exactly the same rules as the video itself.
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
    -- a drop post's files only after you've posted your own drop that day ("give a peek to get a peek")
    return private.can_see_posts(owner)
      and not exists (
        select 1 from public.posts p
        where object_name in (p.media_path, p.poster_path, p.overlay_path) and p.drop_day is not null
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
        where object_name in (s.media_path, s.poster_path, s.overlay_path) and s.expires_at > now()
      );
  elsif kind = 'snaps' then
    -- only the person it was sent to: before opening, while saved, or while the replay is unused
    return not private.is_blocked(owner, me)
      and exists (
        select 1 from public.messages m
        where object_name in (m.media_path, m.poster_path, m.overlay_path) and m.recipient_id = me
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
