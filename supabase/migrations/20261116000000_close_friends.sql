-- =====================================================================
-- Close friends
--
-- * Pick close friends in Settings (only you ever see your list).
-- * When posting a story or a post, choose "Everyone" or "Close friends ⭐".
-- * Close-friends stories and posts – and their photos/videos – are only for the
--   people on your list. (Their story rings show green.)
-- =====================================================================

create table public.close_friends (
  owner uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  friend uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner, friend),
  check (owner <> friend)
);
alter table public.close_friends enable row level security;

create policy "You can see your own close friends list"
  on public.close_friends for select to authenticated
  using (owner = (select auth.uid()));
create policy "You can add your friends to your close friends"
  on public.close_friends for insert to authenticated
  with check (owner = (select auth.uid()) and private.are_friends(owner, friend));
create policy "You can take people off your close friends"
  on public.close_friends for delete to authenticated
  using (owner = (select auth.uid()));

alter table public.posts
  add column if not exists audience text not null default 'everyone' check (audience in ('everyone', 'close_friends'));
alter table public.stories
  add column if not exists audience text not null default 'everyone' check (audience in ('everyone', 'close_friends'));

-- Is the current user allowed to see something `poster` shared with `who` ('everyone' or 'close_friends')?
create or replace function private.in_audience(poster uuid, who text)
returns boolean language sql stable security definer set search_path = '' as $$
  select who = 'everyone'
      or poster = auth.uid()
      or exists (select 1 from public.close_friends c where c.owner = poster and c.friend = auth.uid());
$$;

alter policy "Posts are visible to allowed viewers" on public.posts
  using (private.can_see_posts(user_id) and private.in_audience(user_id, audience));

alter policy "Friends can see stories that have not expired" on public.stories
  using (expires_at > now() and private.can_see_stories(user_id) and private.in_audience(user_id, audience));

-- Likes, comments and story views follow the same rule.
create or replace function private.can_see_post(target_post uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select private.can_see_posts(p.user_id) and private.in_audience(p.user_id, p.audience)
       from public.posts p where p.id = target_post),
    false
  );
$$;

create or replace function private.can_see_story(target_story uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select s.expires_at > now() and private.can_see_stories(s.user_id) and private.in_audience(s.user_id, s.audience)
       from public.stories s where s.id = target_story),
    false
  );
$$;

-- Media rules: same as before, plus close-friends posts and stories.
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
  if owner_text = 'mystery' then
    return private.uploaded_by_me(object_name) or exists (
      select 1 from public.mystery_posts g
       where object_name in (g.media_path, g.poster_path, g.overlay_path)
         and private.can_see_mystery(g.user_id, g.expires_at, me)
    );
  end if;
  if owner_text = 'dating' then
    return private.uploaded_by_me(object_name) or private.can_see_dating_photo(object_name, me);
  end if;
  if owner_text = me::text then
    return true;                                      -- your own files
  end if;
  if owner_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  owner := owner_text::uuid;

  if kind = 'posts' then
    -- close-friends posts only for their close friends;
    -- a drop post's files only after you've posted your own drop that day ("give a peek to get a peek"),
    -- and only once every group you share with them has posted that day's drop
    return private.can_see_posts(owner)
      and not exists (
        select 1 from public.posts p
        where object_name in (p.media_path, p.poster_path, p.overlay_path)
          and not private.in_audience(p.user_id, p.audience)
      )
      and not exists (
        select 1 from public.posts p
        where object_name in (p.media_path, p.poster_path, p.overlay_path) and p.drop_day is not null
          and (
            not exists (select 1 from public.posts mine where mine.user_id = me and mine.drop_day = p.drop_day)
            or private.group_holds_drop(me, p.user_id, p.drop_day)
          )
      );
  elsif kind = 'blurs' then
    return private.can_see_posts(owner);
  elsif kind = 'stories' then
    return private.can_see_stories(owner)
      and exists (
        select 1 from public.stories s
        where object_name in (s.media_path, s.poster_path, s.overlay_path) and s.expires_at > now()
          and private.in_audience(s.user_id, s.audience)
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
  elsif kind = 'voice' then
    -- voice notes: the person they were sent to (they stay in the chat, like texts)
    return not private.is_blocked(owner, me)
      and exists (select 1 from public.messages m where m.media_path = object_name and m.recipient_id = me);
  end if;
  return false;
end;
$$;
