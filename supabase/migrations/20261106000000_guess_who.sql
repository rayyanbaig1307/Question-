-- =====================================================================
-- Guess Who
--
-- * Post a photo or video anonymously to your friends (it lasts 24 hours).
-- * Each friend gets 4 names to pick from (the real poster + 3 of their other friends),
--   guesses once, and then finds out who it was.
-- * The real poster is always stored (user_id) – but only the database sees it. The app
--   only ever gets it through the functions below, after you've guessed (or if it's yours).
-- * The files live in a "mystery" folder without anyone's name in the path.
-- * Report and block work without telling you who it is.
-- =====================================================================

create table public.mystery_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  media_path text not null,
  media_type text not null default 'photo' check (media_type in ('photo', 'video')),
  poster_path text,
  overlay_path text,
  caption text not null default '' check (char_length(caption) <= 200),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours'
);
create index mystery_posts_user_idx on public.mystery_posts (user_id, created_at desc);
alter table public.mystery_posts enable row level security;

create table public.mystery_guesses (
  post_id uuid not null references public.mystery_posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  guess uuid,
  correct boolean not null,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
alter table public.mystery_guesses enable row level security;
-- (No policies: guesses are only made and read through the functions below.)

-- Did the current user upload this file themselves?
create or replace function private.uploaded_by_me(object_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select object_name is null or exists (
    select 1 from storage.objects o
     where o.bucket_id = 'media' and o.name = object_name and o.owner_id = (select auth.uid())::text
  );
$$;

-- You only see your own rows directly; friends get them through mystery_feed().
create policy "You can see your own Guess Who posts"
  on public.mystery_posts for select to authenticated
  using (user_id = (select auth.uid()));

create policy "You can post a Guess Who with your own files"
  on public.mystery_posts for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and media_path like 'mystery/%' and private.uploaded_by_me(media_path)
    and (poster_path is null or (poster_path like 'mystery/%' and private.uploaded_by_me(poster_path)))
    and (overlay_path is null or (overlay_path like 'mystery/%' and private.uploaded_by_me(overlay_path)))
  );

create policy "You can delete your own Guess Who posts"
  on public.mystery_posts for delete to authenticated
  using (user_id = (select auth.uid()));

-- Files go in "mystery/…" (no name in the path). You can only delete the ones you uploaded.
create policy "You can upload Guess Who files"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = 'mystery');

create policy "You can delete your own Guess Who files"
  on storage.objects for delete to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = 'mystery' and owner_id = (select auth.uid())::text);

-- Can `viewer` see this Guess Who post? (Their friend posted it, it hasn't expired, nobody blocked anybody.)
create or replace function private.can_see_mystery(poster uuid, expires timestamptz, viewer uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select poster = viewer
      or (expires > now() and private.are_friends(poster, viewer) and not private.is_blocked(poster, viewer));
$$;

-- Guess Who posts your friends made (and your own), newest first. For each one:
-- * someone else's: 4 names to pick from, your guess, and – only once you've guessed – who it really was;
-- * your own: how many guessed, and how many got it right.
create or replace function public.mystery_feed()
returns table (
  id uuid,
  media_path text,
  media_type text,
  poster_path text,
  overlay_path text,
  caption text,
  created_at timestamptz,
  expires_at timestamptz,
  mine boolean,
  options uuid[],
  my_guess uuid,
  poster uuid,
  guess_count integer,
  right_count integer
)
language sql stable security definer set search_path = '' as $$
  with me as (select auth.uid() as id),
  my_friends as (
    select case when f.requester_id = me.id then f.addressee_id else f.requester_id end as friend
      from public.friendships f, me
     where f.status = 'accepted' and me.id in (f.requester_id, f.addressee_id)
  )
  select
    g.id, g.media_path, g.media_type, g.poster_path, g.overlay_path, g.caption, g.created_at, g.expires_at,
    g.user_id = me.id,
    case when g.user_id = me.id then null else array(
      -- the real poster plus 3 of your other friends (always the same 3 for this post), in a mixed-up order
      select o.person from (
        select g.user_id as person
        union all
        (select mf.friend from my_friends mf
          where mf.friend <> g.user_id and not private.is_blocked(mf.friend, me.id)
          order by md5(g.id::text || mf.friend::text)
          limit 3)
      ) o
      order by md5(g.id::text || ':' || o.person::text)
    ) end,
    mg.guess,
    case when g.user_id = me.id or mg.post_id is not null then g.user_id end,
    case when g.user_id = me.id then (select count(*)::int from public.mystery_guesses x where x.post_id = g.id) end,
    case when g.user_id = me.id then (select count(*)::int from public.mystery_guesses x where x.post_id = g.id and x.correct) end
  from public.mystery_posts g
  cross join me
  left join public.mystery_guesses mg on mg.post_id = g.id and mg.user_id = me.id
  where g.expires_at > now()
    and private.can_see_mystery(g.user_id, g.expires_at, me.id)
  order by g.created_at desc
  limit 50;
$$;
revoke execute on function public.mystery_feed() from public, anon;
grant execute on function public.mystery_feed() to authenticated;

-- Make your guess (only your first guess counts). Returns who really posted it.
create or replace function public.guess_mystery(post uuid, guess uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  real_poster uuid;
  expires timestamptz;
begin
  select g.user_id, g.expires_at into real_poster, expires from public.mystery_posts g where g.id = post;
  if real_poster is null or not private.can_see_mystery(real_poster, expires, me) then
    raise exception 'This Guess Who is gone';
  end if;
  if real_poster = me then
    raise exception 'That one''s yours 😄';
  end if;
  insert into public.mystery_guesses (post_id, user_id, guess, correct)
  values (post, me, guess, guess = real_poster)
  on conflict (post_id, user_id) do nothing;
  return real_poster;
end;
$$;
revoke execute on function public.guess_mystery(uuid, uuid) from public, anon;
grant execute on function public.guess_mystery(uuid, uuid) to authenticated;

-- Report a Guess Who post. The report is saved against the real poster, without telling you who it is.
create or replace function public.report_mystery(post uuid, reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  real_poster uuid;
begin
  select g.user_id into real_poster from public.mystery_posts g
   where g.id = post and private.can_see_mystery(g.user_id, now() + interval '1 second', me);
  if real_poster is null then
    raise exception 'This Guess Who is gone';
  end if;
  insert into public.reports (reporter_id, reported_user_id, content_type, content_id, reason, details)
  values (me, real_poster, 'post', post, left(reason, 100), 'Guess Who (anonymous) post');
end;
$$;
revoke execute on function public.report_mystery(uuid, text) from public, anon;
grant execute on function public.report_mystery(uuid, text) to authenticated;

-- Block whoever posted a Guess Who (same as blocking them from their profile).
create or replace function public.block_mystery_poster(post uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  real_poster uuid;
begin
  select g.user_id into real_poster from public.mystery_posts g
   where g.id = post and private.can_see_mystery(g.user_id, now() + interval '1 second', auth.uid());
  if real_poster is null then
    raise exception 'This Guess Who is gone';
  end if;
  perform public.block_user(real_poster);
end;
$$;
revoke execute on function public.block_mystery_poster(uuid) from public, anon;
grant execute on function public.block_mystery_poster(uuid) to authenticated;

-- Media rules: same as before, plus Guess Who files for people who can see that post.
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
  if owner_text = me::text then
    return true;                                      -- your own files
  end if;
  if owner_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  owner := owner_text::uuid;

  if kind = 'posts' then
    -- a drop post's files only after you've posted your own drop that day ("give a peek to get a peek"),
    -- and only once every group you share with them has posted that day's drop
    return private.can_see_posts(owner)
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
