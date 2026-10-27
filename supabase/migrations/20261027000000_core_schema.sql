-- =====================================================================
-- Peekaboo – core database (version 1)
--
-- This one file creates everything the core app needs:
--   profiles, friends, blocks, reports, posts, likes, comments,
--   stories, chat messages/snaps, friend map locations,
--   photo storage buckets, and the privacy rules (RLS) for all of it.
--
-- Safe to run on a brand-new Supabase project (SQL Editor -> Run).
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. A "private" schema for helper functions.
--    It is NOT exposed through the API, so the app can't call these
--    directly; they are only used inside the privacy rules below.
-- ---------------------------------------------------------------------
create schema if not exists private;
grant usage on schema private to authenticated;


-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------

-- One row per user. Created automatically when someone signs up.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique,
  display_name text not null default '',
  bio text not null default '',
  avatar_path text,                                   -- file in the "avatars" bucket
  is_private boolean not null default false,          -- private account: only friends see posts
  location_sharing boolean not null default false,    -- friend map; OFF by default (ghost mode)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_username_format check (username ~ '^[a-z0-9_.]{3,20}$'),
  constraint profiles_display_name_length check (char_length(display_name) <= 40),
  constraint profiles_bio_length check (char_length(bio) <= 160)
);

-- Friend requests and friendships. One row per pair of people.
create table public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles (id) on delete cascade,
  addressee_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  constraint friendships_not_self check (requester_id <> addressee_id)
);
create unique index friendships_pair_key
  on public.friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));
create index friendships_requester_idx on public.friendships (requester_id);
create index friendships_addressee_idx on public.friendships (addressee_id);

-- Who blocked whom.
create table public.blocks (
  blocker_id uuid not null references public.profiles (id) on delete cascade,
  blocked_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint blocks_not_self check (blocker_id <> blocked_id)
);
create index blocks_blocked_idx on public.blocks (blocked_id);

-- Reports. You (the app owner) read these in the Supabase dashboard.
create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  reported_user_id uuid references public.profiles (id) on delete cascade,
  content_type text not null check (content_type in ('user', 'post', 'story', 'message', 'comment')),
  content_id uuid,
  reason text not null check (char_length(reason) <= 100),
  details text check (char_length(details) <= 1000),
  status text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
  created_at timestamptz not null default now()
);
create index reports_reporter_idx on public.reports (reporter_id);
create index reports_reported_user_idx on public.reports (reported_user_id);

-- Permanent posts (the Instagram-style photo grid + feed).
create table public.posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  media_path text not null,                           -- file in the "media" bucket
  caption text not null default '' check (char_length(caption) <= 300),
  created_at timestamptz not null default now()
);
create index posts_user_created_idx on public.posts (user_id, created_at desc);

create table public.likes (
  post_id uuid not null references public.posts (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
create index likes_user_idx on public.likes (user_id);

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);
create index comments_post_created_idx on public.comments (post_id, created_at);
create index comments_user_idx on public.comments (user_id);

-- Stories: disappear 24 hours after posting.
create table public.stories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  media_path text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);
create index stories_user_expires_idx on public.stories (user_id, expires_at desc);
create index stories_media_path_idx on public.stories (media_path);

create table public.story_views (
  story_id uuid not null references public.stories (id) on delete cascade,
  viewer_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (story_id, viewer_id)
);
create index story_views_viewer_idx on public.story_views (viewer_id);

-- Chat: text messages and snaps (photos that disappear after opening).
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('text', 'snap')),
  body text check (char_length(body) <= 2000),
  media_path text,
  created_at timestamptz not null default now(),
  opened_at timestamptz,                              -- when the other person read/opened it
  constraint messages_not_self check (sender_id <> recipient_id),
  constraint messages_content check (
    (kind = 'text' and body is not null and char_length(body) > 0)
    or (kind = 'snap' and media_path is not null)
  )
);
create index messages_pair_created_idx on public.messages (sender_id, recipient_id, created_at desc);
create index messages_recipient_created_idx on public.messages (recipient_id, created_at desc);
create index messages_media_path_idx on public.messages (media_path) where media_path is not null;

-- Friend map. Only exists while a user has location sharing turned on.
create table public.locations (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  updated_at timestamptz not null default now()
);


-- ---------------------------------------------------------------------
-- 2. Helper functions used by the privacy rules
-- ---------------------------------------------------------------------

-- Is either person blocking the other?
create or replace function private.is_blocked(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.blocks
    where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a)
  );
$$;

-- Did `blocker` block `target`?
create or replace function private.has_blocked(blocker uuid, target uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.blocks where blocker_id = blocker and blocked_id = target);
$$;

create or replace function private.are_friends(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.friendships
    where status = 'accepted'
      and ((requester_id = a and addressee_id = b) or (requester_id = b and addressee_id = a))
  );
$$;

-- Can the current user see this person's permanent posts?
-- Yes if: it's you, OR (nobody blocked anybody AND (you're friends OR their account is public)).
create or replace function private.can_see_posts(owner uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select
    owner = auth.uid()
    or (
      not private.is_blocked(owner, auth.uid())
      and (
        private.are_friends(owner, auth.uid())
        or exists (select 1 from public.profiles p where p.id = owner and not p.is_private)
      )
    );
$$;

create or replace function private.can_see_post(target_post uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select private.can_see_posts(p.user_id) from public.posts p where p.id = target_post),
    false
  );
$$;

create or replace function private.post_owner(target_post uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select user_id from public.posts where id = target_post;
$$;

-- Stories are friends-only.
create or replace function private.can_see_stories(owner uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select
    owner = auth.uid()
    or (private.are_friends(owner, auth.uid()) and not private.is_blocked(owner, auth.uid()));
$$;

create or replace function private.can_see_story(target_story uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select s.expires_at > now() and private.can_see_stories(s.user_id)
       from public.stories s where s.id = target_story),
    false
  );
$$;

create or replace function private.story_owner(target_story uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select user_id from public.stories where id = target_story;
$$;

create or replace function private.is_sharing_location(target uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select location_sharing from public.profiles where id = target), false);
$$;

-- Who may download a photo from the private "media" bucket?
-- Files are stored as  <owner id>/<posts|stories|snaps>/<random id>.jpg
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
    return private.can_see_posts(owner);
  elsif kind = 'stories' then
    return private.can_see_stories(owner)
      and exists (
        select 1 from public.stories s
        where s.media_path = object_name and s.expires_at > now()
      );
  elsif kind = 'snaps' then
    -- only the person it was sent to, and only until they open it
    return not private.is_blocked(owner, me)
      and exists (
        select 1 from public.messages m
        where m.media_path = object_name and m.recipient_id = me and m.opened_at is null
      );
  end if;
  return false;
end;
$$;


-- ---------------------------------------------------------------------
-- 3. Automatic stuff (triggers)
-- ---------------------------------------------------------------------

-- Create a profile row whenever someone signs up.
-- The app sends the chosen username + display name with the sign-up.
create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  base text;
  candidate text;
  attempts int := 0;
begin
  base := lower(coalesce(new.raw_user_meta_data ->> 'username', ''));
  base := regexp_replace(base, '[^a-z0-9_.]', '', 'g');
  if char_length(base) < 3 then
    base := 'user' || substr(replace(new.id::text, '-', ''), 1, 6);
  end if;
  base := left(base, 20);
  candidate := base;

  -- If the username got taken in the meantime, add some numbers.
  while exists (select 1 from public.profiles where username = candidate) loop
    attempts := attempts + 1;
    if attempts > 20 then
      candidate := 'user' || substr(replace(new.id::text, '-', ''), 1, 12);
      exit;
    end if;
    candidate := left(base, 16) || (floor(random() * 9000) + 1000)::int::text;
  end loop;

  insert into public.profiles (id, username, display_name)
  values (
    new.id,
    candidate,
    left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), candidate), 40)
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

create or replace function private.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function private.touch_updated_at();

-- Turning on ghost mode (sharing off) instantly removes your spot on the map.
create or replace function private.clear_location_when_ghost()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.location_sharing = false and old.location_sharing = true then
    delete from public.locations where user_id = new.id;
  end if;
  return new;
end;
$$;

create trigger profiles_clear_location_when_ghost
  after update of location_sharing on public.profiles
  for each row execute function private.clear_location_when_ghost();

-- Stories always last exactly 24 hours, no matter what the app sends.
create or replace function private.set_story_expiry()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.created_at := now();
  new.expires_at := now() + interval '24 hours';
  return new;
end;
$$;

create trigger stories_set_expiry
  before insert on public.stories
  for each row execute function private.set_story_expiry();


-- ---------------------------------------------------------------------
-- 4. Privacy rules (Row Level Security)
--    With RLS on, nobody can read or change a row unless a rule says so.
-- ---------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.friendships enable row level security;
alter table public.blocks enable row level security;
alter table public.reports enable row level security;
alter table public.posts enable row level security;
alter table public.likes enable row level security;
alter table public.comments enable row level security;
alter table public.stories enable row level security;
alter table public.story_views enable row level security;
alter table public.messages enable row level security;
alter table public.locations enable row level security;

-- PROFILES: everyone logged in can see basic profiles, except people who blocked you.
create policy "Profiles are visible unless the owner blocked you"
  on public.profiles for select to authenticated
  using (not private.has_blocked(id, (select auth.uid())));

create policy "You can edit your own profile"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (
    id = (select auth.uid())
    and (avatar_path is null or avatar_path like (select auth.uid())::text || '/%')
  );

-- FRIENDSHIPS: you see and can remove your own. Sending/accepting goes through functions (section 5).
create policy "You can see your own friendships and requests"
  on public.friendships for select to authenticated
  using ((select auth.uid()) in (requester_id, addressee_id));

create policy "You can cancel, decline or unfriend"
  on public.friendships for delete to authenticated
  using ((select auth.uid()) in (requester_id, addressee_id));

-- BLOCKS: you see and remove your own blocks. Blocking goes through block_user().
create policy "You can see who you blocked"
  on public.blocks for select to authenticated
  using (blocker_id = (select auth.uid()));

create policy "You can unblock"
  on public.blocks for delete to authenticated
  using (blocker_id = (select auth.uid()));

-- REPORTS: you can file reports and see the ones you filed.
create policy "You can report"
  on public.reports for insert to authenticated
  with check (reporter_id = (select auth.uid()));

create policy "You can see your own reports"
  on public.reports for select to authenticated
  using (reporter_id = (select auth.uid()));

-- POSTS
create policy "Posts are visible to allowed viewers"
  on public.posts for select to authenticated
  using (private.can_see_posts(user_id));

create policy "You can create your own posts"
  on public.posts for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and media_path like (select auth.uid())::text || '/posts/%'
  );

create policy "You can edit your own posts"
  on public.posts for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "You can delete your own posts"
  on public.posts for delete to authenticated
  using (user_id = (select auth.uid()));

-- LIKES
create policy "Likes are visible on posts you can see"
  on public.likes for select to authenticated
  using (private.can_see_post(post_id));

create policy "You can like posts you can see"
  on public.likes for insert to authenticated
  with check (user_id = (select auth.uid()) and private.can_see_post(post_id));

create policy "You can unlike"
  on public.likes for delete to authenticated
  using (user_id = (select auth.uid()));

-- COMMENTS
create policy "Comments are visible on posts you can see"
  on public.comments for select to authenticated
  using (private.can_see_post(post_id));

create policy "You can comment on posts you can see"
  on public.comments for insert to authenticated
  with check (user_id = (select auth.uid()) and private.can_see_post(post_id));

create policy "You can delete your comments, or any comment on your post"
  on public.comments for delete to authenticated
  using (user_id = (select auth.uid()) or private.post_owner(post_id) = (select auth.uid()));

-- STORIES: friends only, and only for 24 hours.
create policy "Friends can see stories that have not expired"
  on public.stories for select to authenticated
  using (expires_at > now() and private.can_see_stories(user_id));

create policy "You can post your own stories"
  on public.stories for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and media_path like (select auth.uid())::text || '/stories/%'
  );

create policy "You can delete your own stories"
  on public.stories for delete to authenticated
  using (user_id = (select auth.uid()));

-- STORY VIEWS
create policy "You see your views, and who viewed your stories"
  on public.story_views for select to authenticated
  using (viewer_id = (select auth.uid()) or private.story_owner(story_id) = (select auth.uid()));

create policy "You can mark a story as seen"
  on public.story_views for insert to authenticated
  with check (viewer_id = (select auth.uid()) and private.can_see_story(story_id));

-- MESSAGES: only the two people in the chat, and only between friends.
create policy "You can see messages you sent or received"
  on public.messages for select to authenticated
  using ((select auth.uid()) in (sender_id, recipient_id));

create policy "You can message your friends"
  on public.messages for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and opened_at is null
    and private.are_friends(sender_id, recipient_id)
    and not private.is_blocked(sender_id, recipient_id)
    and (media_path is null or media_path like (select auth.uid())::text || '/snaps/%')
  );

create policy "You can delete messages you sent"
  on public.messages for delete to authenticated
  using (sender_id = (select auth.uid()));

-- LOCATIONS: only friends, and only while sharing is on.
create policy "Friends can see your location only while you share it"
  on public.locations for select to authenticated
  using (
    user_id = (select auth.uid())
    or (
      private.is_sharing_location(user_id)
      and private.are_friends(user_id, (select auth.uid()))
      and not private.is_blocked(user_id, (select auth.uid()))
    )
  );

create policy "You can save your location while sharing is on"
  on public.locations for insert to authenticated
  with check (user_id = (select auth.uid()) and private.is_sharing_location(user_id));

create policy "You can update your location while sharing is on"
  on public.locations for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and private.is_sharing_location(user_id));

create policy "You can remove your location"
  on public.locations for delete to authenticated
  using (user_id = (select auth.uid()));


-- ---------------------------------------------------------------------
-- 5. Functions the app calls (RPC)
-- ---------------------------------------------------------------------

-- Used on the sign-up screen (before you are logged in).
create or replace function public.username_available(name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.profiles where username = lower(trim(name)));
$$;
grant execute on function public.username_available(text) to anon, authenticated;

-- Post and friend counts for a profile header.
create or replace function public.get_profile_stats(target uuid)
returns table (posts bigint, friends bigint)
language sql stable security definer set search_path = '' as $$
  select
    (select count(*) from public.posts where user_id = target),
    (select count(*) from public.friendships
       where status = 'accepted' and target in (requester_id, addressee_id));
$$;
revoke execute on function public.get_profile_stats(uuid) from public, anon;
grant execute on function public.get_profile_stats(uuid) to authenticated;

-- Send a friend request. If they already asked you, this accepts it instead.
-- Returns 'pending' or 'accepted'.
create or replace function public.send_friend_request(target uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  existing public.friendships%rowtype;
begin
  if me is null then
    raise exception 'Not logged in';
  end if;
  if target = me then
    raise exception 'You cannot add yourself';
  end if;
  if private.is_blocked(me, target) then
    raise exception 'You cannot add this user';
  end if;

  select * into existing from public.friendships
  where least(requester_id, addressee_id) = least(me, target)
    and greatest(requester_id, addressee_id) = greatest(me, target);

  if found then
    if existing.status = 'accepted' then
      return 'accepted';
    end if;
    if existing.addressee_id = me then
      update public.friendships set status = 'accepted', accepted_at = now() where id = existing.id;
      return 'accepted';
    end if;
    return 'pending';
  end if;

  insert into public.friendships (requester_id, addressee_id) values (me, target);
  return 'pending';
end;
$$;
revoke execute on function public.send_friend_request(uuid) from public, anon;
grant execute on function public.send_friend_request(uuid) to authenticated;

-- Accept (accept = true) or decline (accept = false) a request sent to you.
create or replace function public.respond_to_friend_request(request_id uuid, accept boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if accept then
    update public.friendships
       set status = 'accepted', accepted_at = now()
     where id = request_id and addressee_id = auth.uid() and status = 'pending';
  else
    delete from public.friendships
     where id = request_id and addressee_id = auth.uid() and status = 'pending';
  end if;
end;
$$;
revoke execute on function public.respond_to_friend_request(uuid, boolean) from public, anon;
grant execute on function public.respond_to_friend_request(uuid, boolean) to authenticated;

-- Block someone: also removes any friendship or request between you.
create or replace function public.block_user(target uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'Not logged in';
  end if;
  if target = me then
    raise exception 'You cannot block yourself';
  end if;
  insert into public.blocks (blocker_id, blocked_id) values (me, target)
  on conflict do nothing;
  delete from public.friendships
   where (requester_id = me and addressee_id = target) or (requester_id = target and addressee_id = me);
end;
$$;
revoke execute on function public.block_user(uuid) from public, anon;
grant execute on function public.block_user(uuid) to authenticated;

-- Open a snap sent to you. After this, the photo can't be loaded again.
create or replace function public.open_snap(message_id uuid)
returns void language sql security definer set search_path = '' as $$
  update public.messages
     set opened_at = now()
   where id = message_id and recipient_id = auth.uid() and kind = 'snap' and opened_at is null;
$$;
revoke execute on function public.open_snap(uuid) from public, anon;
grant execute on function public.open_snap(uuid) to authenticated;

-- Mark all text messages from a friend as read.
create or replace function public.mark_chat_read(friend uuid)
returns void language sql security definer set search_path = '' as $$
  update public.messages
     set opened_at = now()
   where sender_id = friend and recipient_id = auth.uid() and kind = 'text' and opened_at is null;
$$;
revoke execute on function public.mark_chat_read(uuid) from public, anon;
grant execute on function public.mark_chat_read(uuid) to authenticated;


-- ---------------------------------------------------------------------
-- 6. Realtime (live updates) for chat, friend requests and the map
-- ---------------------------------------------------------------------
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.friendships;
alter publication supabase_realtime add table public.locations;


-- ---------------------------------------------------------------------
-- 7. Photo storage
--    avatars: public (profile pictures)
--    media:   private (posts, stories, snaps) – the app gets short-lived links
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('avatars', 'avatars', true, 5242880, array['image/jpeg', 'image/png', 'image/webp']),
  ('media', 'media', false, 15728640, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "Anyone logged in can see avatars"
  on storage.objects for select to authenticated
  using (bucket_id = 'avatars');

create policy "You can upload your own avatar"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "You can replace your own avatar"
  on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "You can delete your own avatar"
  on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "You can upload your own photos"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (storage.foldername(name))[2] in ('posts', 'stories', 'snaps')
  );

create policy "You can see photos you are allowed to see"
  on storage.objects for select to authenticated
  using (bucket_id = 'media' and private.can_read_media(name));

create policy "You can delete your own photos"
  on storage.objects for delete to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);
