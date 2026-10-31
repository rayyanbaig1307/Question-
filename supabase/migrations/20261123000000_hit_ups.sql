-- =====================================================================
-- Hit ups 👋 (replaces Peek Match)
--
-- * A "Hit up" button on anyone's profile, with an optional short message (up to 150 letters).
-- * They get a push and see it at the top of Chat. "Hit back" → you're friends and the chat opens with
--   your message in it. "Ignore" → it goes away, and you're never told.
-- * Until they hit back you can't send anything else. If they hit you up too, you're connected at once.
-- Safety:
-- * Teens (13–17) and adults (18+) can't hit each other up – it uses the birthday (no birthday, no hit ups).
-- * 10 hit ups a day. One hit up per person.
-- * Everyone chooses who can hit them up: everyone, friends of friends, or nobody.
-- * Blocked either way → no hit ups. Report and block work on every hit up.
-- =====================================================================

-- Your birthday (asked once, only you see it, can't be changed). The same rule as before, under a new name.
create or replace function public.set_birthday(day date)
returns text language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'Please log in again';
  end if;
  if exists (select 1 from public.age_checks where user_id = me) then
    raise exception 'Your birthday is already saved';
  end if;
  if day is null or day > current_date or day < current_date - interval '120 years' then
    raise exception 'That birthday doesn''t look right';
  end if;
  insert into public.age_checks (user_id, birthday, blocked)
  values (me, day, day > (current_date - interval '18 years')::date);
  return 'ok';
end;
$$;
revoke execute on function public.set_birthday(date) from public, anon;
grant execute on function public.set_birthday(date) to authenticated;

-- 'adult' (18+) or 'teen' (under 18) from the saved birthday – null when there's no birthday.
create or replace function private.age_group(person uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case when a.birthday <= (current_date - interval '18 years')::date then 'adult' else 'teen' end
    from public.age_checks a where a.user_id = person;
$$;

-- Who can hit you up.
alter table public.profiles
  add column if not exists hit_ups_from text not null default 'everyone'
  check (hit_ups_from in ('everyone', 'friends_of_friends', 'nobody'));

create table public.hit_ups (
  id uuid primary key default gen_random_uuid(),
  from_user uuid not null references public.profiles (id) on delete cascade,
  to_user uuid not null references public.profiles (id) on delete cascade,
  message text check (char_length(message) <= 150),
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  -- Set when the person ignores it. Hidden from the sender (see the column rights below): to them it just
  -- stays "sent", so they're never told.
  ignored_at timestamptz,
  unique (from_user, to_user),
  check (from_user <> to_user)
);
alter table public.hit_ups enable row level security;
create index hit_ups_to_idx on public.hit_ups (to_user, status, created_at desc);
create index hit_ups_from_idx on public.hit_ups (from_user, created_at desc);

create policy "You can see your hit ups (not ones you ignored)"
  on public.hit_ups for select to authenticated
  using (from_user = (select auth.uid()) or (to_user = (select auth.uid()) and ignored_at is null));
-- Nobody can read ignored_at / responded_at through the app, so a sender can't tell "ignored" from "not yet".
revoke select on public.hit_ups from anon, authenticated;
grant select (id, from_user, to_user, message, status, created_at) on public.hit_ups to authenticated;
-- (Hit ups are only written through hit_up / respond_hit_up below, which do the checks.)

-- Do these two people have a friend in common?
create or replace function private.have_mutual_friend(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  with friends_of_a as (
    select case when f.requester_id = a then f.addressee_id else f.requester_id end as id
      from public.friendships f where f.status = 'accepted' and a in (f.requester_id, f.addressee_id)
  ), friends_of_b as (
    select case when f.requester_id = b then f.addressee_id else f.requester_id end as id
      from public.friendships f where f.status = 'accepted' and b in (f.requester_id, f.addressee_id)
  )
  select exists (select 1 from friends_of_a join friends_of_b using (id));
$$;

-- Why `me` can't hit `target` up, or null if they can. Different reasons on purpose look the same to the
-- person asking ('unavailable'), so nobody can find out someone's age or settings from it.
create or replace function private.hit_up_problem(me uuid, target uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  setting text;
  my_group text := private.age_group(me);
begin
  if target = me then
    return 'self';
  end if;
  if my_group is null then
    return 'no_birthday';
  end if;
  select p.hit_ups_from into setting from public.profiles p where p.id = target;
  if setting is null or private.is_blocked(me, target) then
    return 'unavailable';
  end if;
  if private.are_friends(me, target) then
    return 'friends';
  end if;
  if setting = 'nobody' or (setting = 'friends_of_friends' and not private.have_mutual_friend(me, target)) then
    return 'unavailable';
  end if;
  if private.age_group(target) is distinct from my_group then
    return 'unavailable';
  end if;
  return null;
end;
$$;

-- Hit backs make their own notifications, so the usual "new friend" / "new message" ones stay quiet then.
create or replace function private.push_new_message()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if current_setting('peekaboo.quiet_push', true) = 'on' then
    return new;
  end if;
  perform private.send_push(
    new.recipient_id,
    'messages',
    private.push_name(new.sender_id),
    case new.kind
      when 'text' then left(new.body, 140)
      when 'snap' then 'Sent you a peek 👀'
      when 'screenshot' then case new.body when 'peek' then 'Took a screenshot of your peek 📸' else 'Took a screenshot of the chat 📸' end
      when 'voice' then 'Sent you a voice note 🎤'
      when 'reaction' then 'Reacted ' || new.body || ' to your story'
      else 'New message'
    end,
    jsonb_build_object('type', 'message', 'from', new.sender_id)
  );
  return new;
end;
$$;

create or replace function private.push_friendship()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if current_setting('peekaboo.quiet_push', true) = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' and new.status = 'pending' then
    perform private.send_push(new.addressee_id, 'friend_requests', 'New friend request 👋',
      private.push_name(new.requester_id) || ' wants to be friends', jsonb_build_object('type', 'friends'));
  elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status = 'accepted' then
    perform private.send_push(new.requester_id, 'friend_requests', 'You have a new friend 🎉',
      private.push_name(new.addressee_id) || ' accepted your friend request', jsonb_build_object('type', 'friends'));
  end if;
  return new;
end;
$$;

-- A hit up was hit back: friends now, and the hit-up message is the first message in their chat.
create or replace function private.connect_hit_up(hit uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  h public.hit_ups%rowtype;
begin
  select * into h from public.hit_ups where id = hit;
  perform set_config('peekaboo.quiet_push', 'on', true);
  update public.hit_ups set status = 'accepted', responded_at = now() where id = h.id;
  -- A friend request one of them already sent becomes a friendship; otherwise start one.
  update public.friendships
     set status = 'accepted', accepted_at = now()
   where status = 'pending'
     and ((requester_id = h.from_user and addressee_id = h.to_user) or (requester_id = h.to_user and addressee_id = h.from_user));
  if not private.are_friends(h.from_user, h.to_user) then
    insert into public.friendships (requester_id, addressee_id, status, accepted_at)
    values (h.from_user, h.to_user, 'accepted', now())
    on conflict do nothing;
  end if;
  insert into public.messages (sender_id, recipient_id, kind, body, created_at, opened_at)
  values (h.from_user, h.to_user, 'text', coalesce(nullif(btrim(h.message), ''), '👋'), h.created_at, now());
  perform set_config('peekaboo.quiet_push', 'off', true);
end;
$$;

-- Hit someone up. Returns 'sent', or 'connected' when they had already hit you up (that counts as hitting back).
create or replace function public.hit_up(target uuid, note text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  problem text;
  theirs uuid;
  clean text := nullif(btrim(note), '');
begin
  if me is null then
    raise exception 'Please log in again';
  end if;
  if char_length(clean) > 150 then
    raise exception 'Keep it to 150 letters';
  end if;

  -- They already hit you up: this is a hit back (their own setting doesn't matter – they reached out).
  select id into theirs from public.hit_ups where from_user = target and to_user = me and status = 'pending';
  if theirs is not null and not private.is_blocked(me, target) and not private.are_friends(me, target) then
    perform private.connect_hit_up(theirs);
    if clean is not null then
      perform set_config('peekaboo.quiet_push', 'on', true);
      insert into public.messages (sender_id, recipient_id, kind, body) values (me, target, 'text', clean);
      perform set_config('peekaboo.quiet_push', 'off', true);
    end if;
    perform private.send_push(target, 'friend_requests', '👋 ' || private.push_name(me) || ' hit you back!',
      'You can chat now – say hi', jsonb_build_object('type', 'message', 'from', me));
    return 'connected';
  end if;

  problem := private.hit_up_problem(me, target);
  if problem = 'self' then
    raise exception 'That''s you 😄';
  elsif problem = 'no_birthday' then
    raise exception 'Add your birthday first (Settings → Birthday) – hit ups are only between people your age';
  elsif problem = 'friends' then
    raise exception 'You''re already friends – just send a message';
  elsif problem is not null then
    raise exception 'Hit ups aren''t available for this person';
  end if;

  if exists (select 1 from public.hit_ups where from_user = me and to_user = target) then
    raise exception 'You already hit them up – it''s up to them now';
  end if;
  if (select count(*) from public.hit_ups where from_user = me and created_at > now() - interval '24 hours') >= 10 then
    raise exception 'You''ve used your 10 hit ups for today – try again tomorrow';
  end if;

  insert into public.hit_ups (from_user, to_user, message) values (me, target, clean);
  perform private.send_push(target, 'friend_requests', '👋 ' || private.push_name(me) || ' hit you up',
    coalesce(left(clean, 140), 'Tap to see who it is'), jsonb_build_object('type', 'hitups'));
  return 'sent';
end;
$$;
revoke execute on function public.hit_up(uuid, text) from public, anon;
grant execute on function public.hit_up(uuid, text) to authenticated;

-- What the Hit up button on someone's profile should show:
-- 'can' · 'sent' (waiting on them) · 'theirs' (they hit you up – hit back) · 'friends' · 'self' ·
-- 'no_birthday' (add yours first) · 'unavailable' (no button).
create or replace function public.hit_up_status(target uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  problem text;
begin
  if me is null then
    return 'unavailable';
  end if;
  if target <> me and not private.is_blocked(me, target) and not private.are_friends(me, target) then
    if exists (select 1 from public.hit_ups where from_user = target and to_user = me and status = 'pending') then
      return 'theirs';
    end if;
    if exists (select 1 from public.hit_ups where from_user = me and to_user = target and status = 'pending') then
      return 'sent';
    end if;
  end if;
  problem := private.hit_up_problem(me, target);
  return coalesce(problem, 'can');
end;
$$;
revoke execute on function public.hit_up_status(uuid) from public, anon;
grant execute on function public.hit_up_status(uuid) to authenticated;

-- Hit back (accept = true) or ignore (accept = false) a hit up you got.
create or replace function public.respond_hit_up(hit uuid, accept boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  h public.hit_ups%rowtype;
begin
  select * into h from public.hit_ups where id = hit and to_user = me and status = 'pending' and ignored_at is null;
  if h.id is null then
    raise exception 'This hit up is gone';
  end if;
  if not accept then
    update public.hit_ups set ignored_at = now(), responded_at = now() where id = h.id;
    return;
  end if;
  if private.is_blocked(me, h.from_user) then
    raise exception 'This hit up is gone';
  end if;
  perform private.connect_hit_up(h.id);
  perform private.send_push(h.from_user, 'friend_requests', '👋 ' || private.push_name(me) || ' hit you back!',
    'You can chat now – say hi', jsonb_build_object('type', 'message', 'from', me));
end;
$$;
revoke execute on function public.respond_hit_up(uuid, boolean) from public, anon;
grant execute on function public.respond_hit_up(uuid, boolean) to authenticated;

-- Media rules: same as before, without the old dating photos.
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
