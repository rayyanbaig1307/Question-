-- =====================================================================
-- Peek Match – step 2: the dating profile
--
-- * 3 to 6 photos, a first name, gender, a rough area, 3 prompts with answers, and who
--   you'd like to see (genders, age range, how far away).
-- * Everything belongs to your Peek Match membership, so leaving deletes it all.
-- * Only people in Peek Match can ever be shown a dating profile, and only through the
--   matching functions (next steps) – never your normal account, friends or posts.
-- * Location is stored rounded to about 1 km and is never shown: others only get a rough
--   distance like "5 km away".
-- * Photos live in "dating/<your dating id>/…", a folder with no link to your account.
-- =====================================================================

create table public.dating_profiles (
  user_id uuid primary key references public.dating_members (user_id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 30),
  gender text not null check (gender in ('woman', 'man', 'nonbinary')),
  area text not null check (char_length(btrim(area)) between 1 and 40),     -- e.g. "East London"
  lat numeric(5, 2) not null check (lat between -90 and 90),                -- rounded: about 1 km
  lng numeric(5, 2) not null check (lng between -180 and 180),
  show_genders text[] not null default array['woman', 'man', 'nonbinary']
    check (cardinality(show_genders) between 1 and 3 and show_genders <@ array['woman', 'man', 'nonbinary']),
  age_min smallint not null default 18 check (age_min between 18 and 99),
  age_max smallint not null default 99 check (age_max between 18 and 99 and age_max >= age_min),
  max_km smallint not null default 50 check (max_km between 1 and 500),
  updated_at timestamptz not null default now()
);
alter table public.dating_profiles enable row level security;

create table public.dating_photos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.dating_members (user_id) on delete cascade,
  path text not null unique,
  position smallint not null default 0,
  created_at timestamptz not null default now()
);
create index dating_photos_user_idx on public.dating_photos (user_id, position);
alter table public.dating_photos enable row level security;

create table public.dating_prompts (
  user_id uuid not null references public.dating_members (user_id) on delete cascade,
  position smallint not null check (position between 0 and 2),
  prompt text not null check (char_length(prompt) between 1 and 80),
  answer text not null check (char_length(btrim(answer)) between 1 and 200),
  primary key (user_id, position)
);
alter table public.dating_prompts enable row level security;

-- Your own Peek Match id (for your photo folder).
create or replace function private.my_dating_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select dating_id from public.dating_members where user_id = auth.uid();
$$;

-- How many dating photos someone has (used for the limit of 6).
create or replace function private.dating_photo_count(person uuid)
returns bigint language sql stable security definer set search_path = '' as $$
  select count(*) from public.dating_photos where user_id = person;
$$;

-- You can only see and change your own dating profile directly – and only while you're in Peek Match.
create policy "You can see your own dating profile"
  on public.dating_profiles for select to authenticated
  using (user_id = (select auth.uid()));
create policy "You can create your dating profile"
  on public.dating_profiles for insert to authenticated
  with check (user_id = (select auth.uid()) and private.in_peek_match((select auth.uid())));
create policy "You can change your dating profile"
  on public.dating_profiles for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and private.in_peek_match((select auth.uid())));

create policy "You can see your own dating photos"
  on public.dating_photos for select to authenticated
  using (user_id = (select auth.uid()));
create policy "You can add up to 6 dating photos"
  on public.dating_photos for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and private.in_peek_match((select auth.uid()))
    and path like 'dating/' || private.my_dating_id()::text || '/%'
    and private.uploaded_by_me(path)
    and private.dating_photo_count((select auth.uid())) < 6
  );
create policy "You can reorder your dating photos"
  on public.dating_photos for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy "You can remove your dating photos"
  on public.dating_photos for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "You can see your own prompts"
  on public.dating_prompts for select to authenticated
  using (user_id = (select auth.uid()));
create policy "You can answer prompts"
  on public.dating_prompts for insert to authenticated
  with check (user_id = (select auth.uid()) and private.in_peek_match((select auth.uid())));
create policy "You can change your prompt answers"
  on public.dating_prompts for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy "You can remove your prompt answers"
  on public.dating_prompts for delete to authenticated
  using (user_id = (select auth.uid()));

-- Dating photo files: you upload into your own dating folder, and can delete what you uploaded.
create policy "You can upload your dating photos"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = 'dating'
    and (storage.foldername(name))[2] = private.my_dating_id()::text
    and private.in_peek_match((select auth.uid()))
  );
create policy "You can delete your dating photos"
  on storage.objects for delete to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = 'dating' and owner_id = (select auth.uid())::text);

-- Is your dating profile ready to be shown? (3+ photos, 3 prompts, all the basics.)
create or replace function private.dating_profile_complete(person uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.dating_profiles p where p.user_id = person)
     and (select count(*) from public.dating_photos ph where ph.user_id = person) >= 3
     and (select count(*) from public.dating_prompts pr where pr.user_id = person) = 3;
$$;

-- Can `viewer` see this dating photo? Both of you must be in Peek Match, and their profile must be
-- showing. (Later steps add blocks and matches to this.)
create or replace function private.can_see_dating_photo(object_name text, viewer uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from public.dating_photos ph
      join public.dating_members m on m.user_id = ph.user_id
     where ph.path = object_name
       and not m.hidden
       and private.in_peek_match(viewer)
       and private.in_peek_match(ph.user_id)
  );
$$;

-- Media rules: same as before, plus Peek Match photos.
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
  elsif kind = 'voice' then
    -- voice notes: the person they were sent to (they stay in the chat, like texts)
    return not private.is_blocked(owner, me)
      and exists (select 1 from public.messages m where m.media_path = object_name and m.recipient_id = me);
  end if;
  return false;
end;
$$;
