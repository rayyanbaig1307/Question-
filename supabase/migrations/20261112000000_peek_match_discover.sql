-- =====================================================================
-- Peek Match – step 3: finding people
--
-- * One profile at a time. You like one specific photo or prompt (with an optional
--   comment), or skip. Either way they don't come round again.
-- * You only see people who fit what you're looking for AND who'd want to see you
--   (gender, age range and distance work both ways).
-- * Distance is only ever given roughly: "less than 2 km", 5, 10, then steps of 5 km.
-- * Block and report on every profile. Blocking someone in Peek Match – or in the
--   normal app – means you never see each other in Peek Match.
-- * Other daters only ever get your dating id, never your normal account id.
-- =====================================================================

-- Blocks are kept even if one of you leaves Peek Match (so they can't just rejoin to get round it).
create table public.dating_blocks (
  blocker uuid not null references public.profiles (id) on delete cascade,
  blocked uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker, blocked)
);
alter table public.dating_blocks enable row level security;
-- (Only used through the functions below.)

create table public.dating_likes (
  from_user uuid not null references public.dating_members (user_id) on delete cascade,
  to_user uuid not null references public.dating_members (user_id) on delete cascade,
  kind text not null check (kind in ('like', 'skip')),
  photo_id uuid references public.dating_photos (id) on delete set null,   -- the photo they liked…
  prompt_position smallint check (prompt_position between 0 and 2),       -- …or the prompt
  comment text check (char_length(comment) <= 200),
  created_at timestamptz not null default now(),
  primary key (from_user, to_user),
  check (from_user <> to_user)
);
create index dating_likes_to_idx on public.dating_likes (to_user, kind);
alter table public.dating_likes enable row level security;
-- (Only used through the functions below.)

-- Has either person blocked the other – in Peek Match or in the normal app?
create or replace function private.dating_blocked(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_blocked(a, b)
      or exists (select 1 from public.dating_blocks
                  where (blocker = a and blocked = b) or (blocker = b and blocked = a));
$$;

create or replace function private.age_of(person uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select extract(year from age(current_date, verified_birthday))::integer
    from public.age_checks where user_id = person;
$$;

-- Straight-line distance in km between two rounded spots.
create or replace function private.km_between(lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric)
returns double precision language sql immutable set search_path = '' as $$
  select 2 * 6371 * asin(sqrt(
    power(sin(radians((lat2 - lat1)::double precision) / 2), 2)
    + cos(radians(lat1::double precision)) * cos(radians(lat2::double precision))
      * power(sin(radians((lng2 - lng1)::double precision) / 2), 2)
  ));
$$;

-- A rough distance to show: 2 ("less than 2 km"), 5, 10, then rounded up to the next 5 km.
create or replace function private.rough_km(km double precision)
returns integer language sql immutable set search_path = '' as $$
  select case when km < 2 then 2 when km < 5 then 5 when km < 10 then 10 else (ceil(km / 5) * 5)::integer end;
$$;

-- Do these two people fit what each other is looking for?
create or replace function private.dating_fits(me uuid, them uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from public.dating_profiles a, public.dating_profiles b
     where a.user_id = me and b.user_id = them
       and b.gender = any (a.show_genders) and a.gender = any (b.show_genders)
       and private.age_of(them) between a.age_min and a.age_max
       and private.age_of(me) between b.age_min and b.age_max
       and private.km_between(a.lat, a.lng, b.lat, b.lng) <= least(a.max_km, b.max_km)
  );
$$;

-- Can `viewer` be shown `person`'s dating profile at all right now?
create or replace function private.dating_visible(viewer uuid, person uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select viewer <> person
     and private.in_peek_match(viewer)
     and private.in_peek_match(person)
     and not exists (select 1 from public.dating_members m where m.user_id = person and m.hidden)
     and private.dating_profile_complete(person)
     and not private.dating_blocked(viewer, person);
$$;

-- What a dating profile looks like to someone else: dating id, first name, age, rough area and distance,
-- photos and prompts. Never the normal account, friends, posts, stories or exact location.
create or replace function private.dating_card(viewer uuid, person uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'dating_id', m.dating_id,
    'name', p.name,
    'age', private.age_of(person),
    'area', p.area,
    'km', private.rough_km(private.km_between(v.lat, v.lng, p.lat, p.lng)),
    'photos', coalesce((select jsonb_agg(jsonb_build_object('id', ph.id, 'path', ph.path) order by ph.position, ph.created_at)
                          from public.dating_photos ph where ph.user_id = person), '[]'::jsonb),
    'prompts', coalesce((select jsonb_agg(jsonb_build_object('position', pr.position, 'prompt', pr.prompt, 'answer', pr.answer)
                                          order by pr.position)
                           from public.dating_prompts pr where pr.user_id = person), '[]'::jsonb)
  )
  from public.dating_members m
  join public.dating_profiles p on p.user_id = m.user_id
  join public.dating_profiles v on v.user_id = viewer
  where m.user_id = person;
$$;

-- The next people to look at. People who already liked you come first; everyone else in a mixed-up order
-- that changes each day. You need a finished, showing profile yourself.
create or replace function public.peek_match_feed(how_many integer default 10)
returns setof jsonb language sql stable security definer set search_path = '' as $$
  select private.dating_card(auth.uid(), them.user_id)
    from public.dating_members them
   where private.dating_profile_complete(auth.uid())
     and not exists (select 1 from public.dating_members me where me.user_id = auth.uid() and me.hidden)
     and private.dating_visible(auth.uid(), them.user_id)
     and private.dating_fits(auth.uid(), them.user_id)
     and not exists (select 1 from public.dating_likes l where l.from_user = auth.uid() and l.to_user = them.user_id)
   order by
     exists (select 1 from public.dating_likes l where l.from_user = them.user_id and l.to_user = auth.uid() and l.kind = 'like') desc,
     md5(them.dating_id::text || current_date::text)
   limit least(greatest(how_many, 1), 20);
$$;
revoke execute on function public.peek_match_feed(integer) from public, anon;
grant execute on function public.peek_match_feed(integer) to authenticated;

create or replace function private.dating_user(target uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select user_id from public.dating_members where dating_id = target;
$$;

-- Like one photo or one prompt of someone (with an optional comment). Returns 'liked'.
-- (The next step turns a like back into a match.)
create or replace function public.peek_match_like(target uuid, liked_photo uuid default null, liked_prompt smallint default null, note text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  them uuid := private.dating_user(target);
begin
  if them is null or not private.dating_visible(me, them) or not private.dating_fits(me, them) then
    raise exception 'This person isn''t in Peek Match any more';
  end if;
  if (liked_photo is null) = (liked_prompt is null) then
    raise exception 'Like one photo or one prompt';
  end if;
  if liked_photo is not null and not exists (select 1 from public.dating_photos ph where ph.id = liked_photo and ph.user_id = them) then
    raise exception 'That photo is gone';
  end if;
  if liked_prompt is not null and not exists (select 1 from public.dating_prompts pr where pr.user_id = them and pr.position = liked_prompt) then
    raise exception 'That prompt is gone';
  end if;
  insert into public.dating_likes (from_user, to_user, kind, photo_id, prompt_position, comment)
  values (me, them, 'like', liked_photo, liked_prompt, nullif(btrim(left(note, 200)), ''))
  on conflict (from_user, to_user) do nothing;
  perform private.send_push(them, 'likes', 'Peek Match 💘', 'Someone liked your dating profile',
    jsonb_build_object('type', 'peek-match'));
  return 'liked';
end;
$$;
revoke execute on function public.peek_match_like(uuid, uuid, smallint, text) from public, anon;
grant execute on function public.peek_match_like(uuid, uuid, smallint, text) to authenticated;

create or replace function public.peek_match_skip(target uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  them uuid := private.dating_user(target);
begin
  if them is null or not private.in_peek_match(auth.uid()) then
    return;
  end if;
  insert into public.dating_likes (from_user, to_user, kind) values (auth.uid(), them, 'skip')
  on conflict (from_user, to_user) do nothing;
end;
$$;
revoke execute on function public.peek_match_skip(uuid) from public, anon;
grant execute on function public.peek_match_skip(uuid) to authenticated;

-- Block someone in Peek Match: you never see each other there again.
create or replace function public.peek_match_block(target uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  them uuid := private.dating_user(target);
begin
  if them is null or them = auth.uid() then
    return;
  end if;
  insert into public.dating_blocks (blocker, blocked) values (auth.uid(), them) on conflict do nothing;
end;
$$;
revoke execute on function public.peek_match_block(uuid) from public, anon;
grant execute on function public.peek_match_block(uuid) to authenticated;

-- Report a dating profile (or, with what = 'message', something they said in a match chat).
-- Saved in the reports table against their real account, marked as Peek Match.
create or replace function public.peek_match_report(target uuid, reason text, what text default 'profile')
returns void language plpgsql security definer set search_path = '' as $$
declare
  them uuid := private.dating_user(target);
begin
  if them is null then
    raise exception 'This person isn''t in Peek Match any more';
  end if;
  insert into public.reports (reporter_id, reported_user_id, content_type, content_id, reason, details)
  values (auth.uid(), them, 'user', them, left(reason, 100),
          case when what = 'message' then 'Peek Match chat' else 'Peek Match profile' end);
end;
$$;
revoke execute on function public.peek_match_report(uuid, text, text) from public, anon;
grant execute on function public.peek_match_report(uuid, text, text) to authenticated;

-- Dating photos: only for people who can see that profile (blocks count now).
create or replace function private.can_see_dating_photo(object_name text, viewer uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.dating_photos ph
     where ph.path = object_name and private.dating_visible(viewer, ph.user_id)
  );
$$;
