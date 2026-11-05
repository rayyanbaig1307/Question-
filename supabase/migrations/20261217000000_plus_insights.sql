-- =====================================================================
-- Peekaboo+ ⭐ insights: who viewed your profile, who rewatched your story, and who screenshotted your
-- story or post.
--
-- How it works, in plain words:
-- * The app tells the server "I opened this profile / watched this story / took a screenshot" through
--   the record_… functions below. Each one checks the rules first (logged in, not yourself, nobody has
--   blocked anybody, you can really see that story or post). Nobody can write the tables directly.
-- * The tables live in the "private" part of the database, which the app can't read. The app only gets
--   what the my_… / …_insights functions hand out.
-- * Counts are free for everyone. WHO it was is only handed out when you have Peekaboo+
--   (private.is_plus, from 20261215000000_peekaboo_plus.sql), so it can't be unlocked by changing the app.
-- * "Show me in Profile views" (on unless you turn it off): when it's off, your visits aren't saved and
--   you can't see your own visitors either (fair trade).
-- * Anyone whose story or post is screenshotted gets a push "📸 Someone screenshotted your …" (free).
--
-- Safe to run more than once.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Your insight settings ("Show me in Profile views").
-- ---------------------------------------------------------------------
create table if not exists public.insight_prefs (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  show_in_profile_views boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.insight_prefs enable row level security;
-- You can read only your own row. Changes go through set_show_in_profile_views below.
revoke all on table public.insight_prefs from public, anon, authenticated;
grant select on table public.insight_prefs to authenticated;
grant all on table public.insight_prefs to service_role;

drop policy if exists "You can see your own insight settings" on public.insight_prefs;
create policy "You can see your own insight settings"
  on public.insight_prefs for select to authenticated
  using (user_id = (select auth.uid()));

-- On (true) unless the person turned it off.
create or replace function private.shows_in_profile_views(person uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select p.show_in_profile_views from public.insight_prefs p where p.user_id = person), true);
$$;
revoke all on function private.shows_in_profile_views(uuid) from public, anon, authenticated;

create or replace function public.set_show_in_profile_views(show boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'Please log in again';
  end if;
  if show is null then
    raise exception 'Pick on or off';
  end if;
  insert into public.insight_prefs (user_id, show_in_profile_views, updated_at)
  values (me, show, now())
  on conflict (user_id) do update set show_in_profile_views = excluded.show_in_profile_views, updated_at = now();
  return show;
end;
$$;
revoke all on function public.set_show_in_profile_views(boolean) from public, anon, authenticated;
grant execute on function public.set_show_in_profile_views(boolean) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Profile views: one row per visit (at most one per viewer per profile per hour).
-- ---------------------------------------------------------------------
create table if not exists private.profile_views (
  id bigint generated always as identity primary key,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  viewer_id uuid not null references public.profiles (id) on delete cascade,
  viewed_at timestamptz not null default now(),
  constraint profile_views_not_yourself check (profile_id <> viewer_id)
);
create index if not exists profile_views_profile_idx on private.profile_views (profile_id, viewed_at desc);
create index if not exists profile_views_viewer_idx on private.profile_views (viewer_id, profile_id, viewed_at desc);
alter table private.profile_views enable row level security;
revoke all on table private.profile_views from public, anon, authenticated;
grant all on table private.profile_views to service_role;

-- Called by the app when you open someone else's profile. Returns true when the visit was saved.
create or replace function public.record_profile_view(target uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
begin
  if me is null or target is null or target = me then
    return false;
  end if;
  if not exists (select 1 from public.profiles where id = target)
     or not exists (select 1 from public.profiles where id = me) then
    return false;
  end if;
  if private.is_blocked(me, target) or not private.shows_in_profile_views(me) then
    return false;
  end if;
  -- Two taps at the same moment still make only one visit.
  perform pg_advisory_xact_lock(hashtextextended('profile-view:' || me::text || ':' || target::text, 0));
  if exists (
    select 1 from private.profile_views v
    where v.viewer_id = me and v.profile_id = target and v.viewed_at > now() - interval '1 hour'
  ) then
    return false;
  end if;
  insert into private.profile_views (profile_id, viewer_id) values (target, me);
  -- Visits older than 30 days are never shown, so tidy them away.
  delete from private.profile_views v where v.profile_id = target and v.viewed_at < now() - interval '30 days';
  return true;
end;
$$;
revoke all on function public.record_profile_view(uuid) from public, anon, authenticated;
grant execute on function public.record_profile_view(uuid) to authenticated;

-- Who viewed your profile in the last 30 days.
-- Everyone gets the counts. Only Peekaboo+ members get the list of people (newest first).
-- Left out: people you blocked or who blocked you, and people who turned "Show me in Profile views" off.
create or replace function public.my_profile_views()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  has_plus boolean;
  people_count integer;
  visit_count integer;
  people jsonb := '[]'::jsonb;
begin
  if me is null then
    raise exception 'Please log in again';
  end if;
  has_plus := private.is_plus(me);
  if not private.shows_in_profile_views(me) then
    return jsonb_build_object('sharing', false, 'plus', has_plus, 'people', 0, 'visits', 0, 'viewers', '[]'::jsonb);
  end if;

  select count(distinct v.viewer_id)::int, count(*)::int into people_count, visit_count
  from private.profile_views v
  where v.profile_id = me
    and v.viewed_at > now() - interval '30 days'
    and not private.is_blocked(me, v.viewer_id)
    and private.shows_in_profile_views(v.viewer_id);

  if has_plus then
    select coalesce(jsonb_agg(jsonb_build_object('viewer_id', s.viewer_id, 'visits', s.visits, 'last_viewed_at', s.last_at)
                              order by s.last_at desc), '[]'::jsonb)
      into people
    from (
      select v.viewer_id, count(*)::int as visits, max(v.viewed_at) as last_at
      from private.profile_views v
      where v.profile_id = me
        and v.viewed_at > now() - interval '30 days'
        and not private.is_blocked(me, v.viewer_id)
        and private.shows_in_profile_views(v.viewer_id)
      group by v.viewer_id
      order by max(v.viewed_at) desc
      limit 500
    ) s;
  end if;

  return jsonb_build_object('sharing', true, 'plus', has_plus, 'people', people_count, 'visits', visit_count,
                            'viewers', people);
end;
$$;
revoke all on function public.my_profile_views() from public, anon, authenticated;
grant execute on function public.my_profile_views() to authenticated;

-- ---------------------------------------------------------------------
-- 3. Story rewatches: how many times each friend opened each of your stories.
--    (public.story_views still has one row per viewer – the free "Seen by" list.)
-- ---------------------------------------------------------------------
create table if not exists private.story_rewatches (
  story_id uuid not null references public.stories (id) on delete cascade,
  viewer_id uuid not null references public.profiles (id) on delete cascade,
  views integer not null default 1 check (views >= 1),
  last_viewed_at timestamptz not null default now(),
  primary key (story_id, viewer_id)
);
create index if not exists story_rewatches_viewer_idx on private.story_rewatches (viewer_id);
alter table private.story_rewatches enable row level security;
revoke all on table private.story_rewatches from public, anon, authenticated;
grant all on table private.story_rewatches to service_role;

-- Called by the app each time you open a friend's story. Marks it seen (like before) and counts the view.
-- Two calls within 10 seconds count once (so a double tap isn't a "rewatch").
create or replace function public.record_story_view(story uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  owner uuid;
begin
  if me is null or story is null then
    return;
  end if;
  owner := private.story_owner(story);
  if owner is null or owner = me or not private.can_see_story(story) then
    return;
  end if;
  insert into public.story_views (story_id, viewer_id) values (story, me)
  on conflict (story_id, viewer_id) do nothing;
  insert into private.story_rewatches as r (story_id, viewer_id) values (story, me)
  on conflict (story_id, viewer_id) do update
    set views = r.views + 1, last_viewed_at = now()
    where r.last_viewed_at < now() - interval '10 seconds';
end;
$$;
revoke all on function public.record_story_view(uuid) from public, anon, authenticated;
grant execute on function public.record_story_view(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Screenshots of your stories and posts (one row per person per story/post, with a count).
-- ---------------------------------------------------------------------
create table if not exists private.content_screenshots (
  id bigint generated always as identity primary key,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  taker_id uuid not null references public.profiles (id) on delete cascade,
  story_id uuid references public.stories (id) on delete cascade,
  post_id uuid references public.posts (id) on delete cascade,
  times integer not null default 1 check (times >= 1),
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  -- When the owner last got a push about this person and this story/post.
  pushed_at timestamptz,
  constraint content_screenshots_one_thing check (num_nonnulls(story_id, post_id) = 1),
  constraint content_screenshots_not_yourself check (owner_id <> taker_id)
);
create unique index if not exists content_screenshots_story_taker_idx
  on private.content_screenshots (story_id, taker_id) where story_id is not null;
create unique index if not exists content_screenshots_post_taker_idx
  on private.content_screenshots (post_id, taker_id) where post_id is not null;
create index if not exists content_screenshots_taker_idx on private.content_screenshots (taker_id);
create index if not exists content_screenshots_owner_idx on private.content_screenshots (owner_id);
alter table private.content_screenshots enable row level security;
revoke all on table private.content_screenshots from public, anon, authenticated;
grant all on table private.content_screenshots to service_role;

-- Called by the app when you take a screenshot while looking at someone else's story or post.
-- `kind` is 'story' or 'post'. The owner gets a push (at most one per person per story/post every
-- 30 minutes). The push never says who it was.
create or replace function public.record_screenshot(kind text, target uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  owner uuid;
  last_push timestamptz;
  row_id bigint;
begin
  if me is null or target is null then
    return;
  end if;
  if kind = 'story' then
    owner := private.story_owner(target);
    if owner is null or owner = me or not private.can_see_story(target) then
      return;
    end if;
    insert into private.content_screenshots as c (owner_id, taker_id, story_id) values (owner, me, target)
    on conflict (story_id, taker_id) where story_id is not null
    do update set times = c.times + 1, last_at = now()
    returning c.id, c.pushed_at into row_id, last_push;
  elsif kind = 'post' then
    owner := private.post_owner(target);
    if owner is null or owner = me or not private.can_see_post(target) then
      return;
    end if;
    insert into private.content_screenshots as c (owner_id, taker_id, post_id) values (owner, me, target)
    on conflict (post_id, taker_id) where post_id is not null
    do update set times = c.times + 1, last_at = now()
    returning c.id, c.pushed_at into row_id, last_push;
  else
    return;
  end if;

  if last_push is null or last_push < now() - interval '30 minutes' then
    update private.content_screenshots set pushed_at = now() where id = row_id;
    perform private.send_push(
      owner, 'screenshots',
      '📸 Someone screenshotted your ' || kind,
      case when private.is_plus(owner) then 'Tap to see who 👀' else 'See who with Peekaboo+ ⭐' end,
      case when kind = 'story'
        then jsonb_build_object('type', 'story', 'user', owner)
        else jsonb_build_object('type', 'post', 'post', target)
      end
    );
  end if;
end;
$$;
revoke all on function public.record_screenshot(text, uuid) from public, anon, authenticated;
grant execute on function public.record_screenshot(text, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Reading the insights (only the owner of the story or post).
-- ---------------------------------------------------------------------

-- For one of your stories: how many people rewatched it and how many screenshotted it (free), and with
-- Peekaboo+ who: [{viewer_id, views, screenshots}].
create or replace function public.story_insights(story uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  has_plus boolean;
  rewatch_count integer;
  shot_count integer;
  people jsonb := '[]'::jsonb;
begin
  if me is null then
    raise exception 'Please log in again';
  end if;
  if story is null or private.story_owner(story) is distinct from me then
    raise exception 'Only the person who posted this story can see this';
  end if;
  has_plus := private.is_plus(me);

  select count(*)::int into rewatch_count
  from private.story_rewatches r
  where r.story_id = story and r.views > 1 and not private.is_blocked(me, r.viewer_id);
  select count(*)::int into shot_count
  from private.content_screenshots c
  where c.story_id = story and not private.is_blocked(me, c.taker_id);

  if has_plus then
    select coalesce(jsonb_agg(jsonb_build_object('viewer_id', p.person, 'views', p.views, 'screenshots', p.shots)), '[]'::jsonb)
      into people
    from (
      select coalesce(r.viewer_id, c.taker_id) as person,
             coalesce(r.views, 0) as views,
             coalesce(c.times, 0) as shots
      from (select * from private.story_rewatches where story_id = story and views > 1) r
      full join (select * from private.content_screenshots where story_id = story) c on c.taker_id = r.viewer_id
    ) p
    where not private.is_blocked(me, p.person);
  end if;

  return jsonb_build_object('plus', has_plus, 'rewatchers', rewatch_count, 'screenshotters', shot_count,
                            'people', people);
end;
$$;
revoke all on function public.story_insights(uuid) from public, anon, authenticated;
grant execute on function public.story_insights(uuid) to authenticated;

-- For one of your posts: how many screenshots (free), and with Peekaboo+ who took them, newest first:
-- [{taker_id, times, last_at}].
create or replace function public.post_screenshots(post uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  has_plus boolean;
  people_count integer;
  shot_count integer;
  people jsonb := '[]'::jsonb;
begin
  if me is null then
    raise exception 'Please log in again';
  end if;
  if post is null or private.post_owner(post) is distinct from me then
    raise exception 'Only the person who posted this can see this';
  end if;
  has_plus := private.is_plus(me);

  select count(*)::int, coalesce(sum(c.times), 0)::int into people_count, shot_count
  from private.content_screenshots c
  where c.post_id = post and not private.is_blocked(me, c.taker_id);

  if has_plus then
    select coalesce(jsonb_agg(jsonb_build_object('taker_id', c.taker_id, 'times', c.times, 'last_at', c.last_at)
                              order by c.last_at desc), '[]'::jsonb)
      into people
    from private.content_screenshots c
    where c.post_id = post and not private.is_blocked(me, c.taker_id);
  end if;

  return jsonb_build_object('plus', has_plus, 'people', people_count, 'screenshots', shot_count, 'takers', people);
end;
$$;
revoke all on function public.post_screenshots(uuid) from public, anon, authenticated;
grant execute on function public.post_screenshots(uuid) to authenticated;
