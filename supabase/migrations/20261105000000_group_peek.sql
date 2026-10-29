-- =====================================================================
-- Group Peek
--
-- * Make a group with some of your friends (up to 12 people).
-- * Everyone's Peekaboo drop for a day stays hidden from the rest of the group
--   until the whole group has posted that day's drop ("Waiting on Sam 👀").
--   A group only counts from the day each person joined it.
-- * Nudge someone who hasn't posted yet: they get a notification.
-- =====================================================================

create table public.peek_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 40),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.peek_groups enable row level security;

create table public.peek_group_members (
  group_id uuid not null references public.peek_groups (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  added_by uuid references public.profiles (id) on delete set null,
  joined_day date not null,                       -- the day (in the adder's time zone) they joined
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index peek_group_members_user_idx on public.peek_group_members (user_id);
alter table public.peek_group_members enable row level security;

-- Nudges are only written by public.nudge_group_member (used to stop nudge spam).
create table public.nudges (
  id bigint generated always as identity primary key,
  group_id uuid not null references public.peek_groups (id) on delete cascade,
  from_id uuid not null references public.profiles (id) on delete cascade,
  to_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index nudges_pair_idx on public.nudges (from_id, to_id, created_at desc);
alter table public.nudges enable row level security;

create or replace function private.is_group_member(grp uuid, person uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.peek_group_members where group_id = grp and user_id = person);
$$;

create policy "Members can see their groups"
  on public.peek_groups for select to authenticated
  using (private.is_group_member(id, (select auth.uid())));

create policy "The person who made a group can delete it"
  on public.peek_groups for delete to authenticated
  using (created_by = (select auth.uid()));

create policy "Members can see who is in their groups"
  on public.peek_group_members for select to authenticated
  using (private.is_group_member(group_id, (select auth.uid())));

-- (A group nobody is in any more is invisible to everyone.)
create policy "You can leave a group, and its maker can remove people"
  on public.peek_group_members for delete to authenticated
  using (
    user_id = (select auth.uid())
    or exists (select 1 from public.peek_groups g where g.id = group_id and g.created_by = (select auth.uid()))
  );

-- The phone sends its own date; it must be within a day of the server's (time zones).
create or replace function private.check_today(today date)
returns date language plpgsql stable set search_path = '' as $$
begin
  if today is null or today not between current_date - 1 and current_date + 1 then
    raise exception 'Your phone''s date looks wrong';
  end if;
  return today;
end;
$$;

-- Add some of your friends to a group you're in (checks they really are your friends).
create or replace function private.add_group_members(grp uuid, adder uuid, people uuid[], today date)
returns void language plpgsql security definer set search_path = '' as $$
declare
  person uuid;
  fresh uuid[];
begin
  fresh := array(
    select distinct p from unnest(coalesce(people, '{}'::uuid[])) p
    where p is not null and p <> adder and not private.is_group_member(grp, p)
  );
  if cardinality(fresh) = 0 then
    return;
  end if;
  if (select count(*) from public.peek_group_members where group_id = grp) + cardinality(fresh) > 12 then
    raise exception 'A group can have up to 12 people';
  end if;
  foreach person in array fresh loop
    if not private.are_friends(adder, person) or private.is_blocked(adder, person) then
      raise exception 'You can only add your friends to a group';
    end if;
  end loop;
  insert into public.peek_group_members (group_id, user_id, added_by, joined_day)
  select grp, p, adder, today from unnest(fresh) p;
end;
$$;

create or replace function public.create_peek_group(group_name text, members uuid[], today date)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  new_id uuid;
begin
  if me is null then
    raise exception 'Please log in again';
  end if;
  perform private.check_today(today);
  if not exists (select 1 from unnest(coalesce(members, '{}'::uuid[])) p where p is not null and p <> me) then
    raise exception 'Pick at least one friend for your group';
  end if;
  insert into public.peek_groups (name, created_by) values (btrim(group_name), me) returning id into new_id;
  insert into public.peek_group_members (group_id, user_id, added_by, joined_day) values (new_id, me, me, today);
  perform private.add_group_members(new_id, me, members, today);
  return new_id;
end;
$$;
revoke execute on function public.create_peek_group(text, uuid[], date) from public, anon;
grant execute on function public.create_peek_group(text, uuid[], date) to authenticated;

create or replace function public.add_to_peek_group(grp uuid, members uuid[], today date)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_today(today);
  if not private.is_group_member(grp, auth.uid()) then
    raise exception 'You''re not in this group';
  end if;
  perform private.add_group_members(grp, auth.uid(), members, today);
end;
$$;
revoke execute on function public.add_to_peek_group(uuid, uuid[], date) from public, anon;
grant execute on function public.add_to_peek_group(uuid, uuid[], date) to authenticated;

create or replace function public.rename_peek_group(grp uuid, group_name text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_group_member(grp, auth.uid()) then
    raise exception 'You''re not in this group';
  end if;
  update public.peek_groups set name = btrim(group_name) where id = grp;
end;
$$;
revoke execute on function public.rename_peek_group(uuid, text) from public, anon;
grant execute on function public.rename_peek_group(uuid, text) to authenticated;

-- Who in your groups has posted the drop for `day` (all your groups, or just one).
-- Only says whether they posted – the photos themselves follow the usual rules.
create or replace function public.peek_group_status(day date, only_group uuid default null)
returns table (group_id uuid, user_id uuid, joined_day date, posted boolean, post_id uuid, posted_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select m.group_id, m.user_id, m.joined_day, d.id is not null, d.id, d.created_at
    from public.peek_group_members m
    left join public.posts d on d.user_id = m.user_id and d.drop_day = day
   where private.is_group_member(m.group_id, auth.uid())
     and (only_group is null or m.group_id = only_group)
   order by m.joined_at;
$$;
revoke execute on function public.peek_group_status(date, uuid) from public, anon;
grant execute on function public.peek_group_status(date, uuid) to authenticated;

-- Is `poster`'s drop for `day` held back from `viewer` by a group they're both in, where someone
-- (who was in the group that day) still hasn't posted that day's drop?
create or replace function private.group_holds_drop(viewer uuid, poster uuid, day date)
returns boolean language sql stable security definer set search_path = '' as $$
  select viewer is distinct from poster and exists (
    select 1
      from public.peek_group_members a
      join public.peek_group_members b on b.group_id = a.group_id and b.user_id = poster
     where a.user_id = viewer
       and a.joined_day <= day and b.joined_day <= day
       and exists (
         select 1 from public.peek_group_members m
          where m.group_id = a.group_id
            and m.joined_day <= day
            and not exists (select 1 from public.posts d where d.user_id = m.user_id and d.drop_day = day)
       )
  );
$$;

-- Lets the app ask for `group_hold` along with a post, to show "Waiting on your group".
create or replace function public.group_hold(post public.posts)
returns boolean language sql stable set search_path = '' as $$
  select post.drop_day is not null and private.group_holds_drop(auth.uid(), post.user_id, post.drop_day);
$$;
revoke execute on function public.group_hold(public.posts) from public, anon;
grant execute on function public.group_hold(public.posts) to authenticated;

-- Nudges and "added to a group" notifications use the drops switch in Settings.
create or replace function private.send_push(target uuid, kind text, title text, body text, data jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  allowed boolean;
  batch jsonb;
begin
  if target is null then
    return;
  end if;
  select case kind
           when 'messages' then p.messages
           when 'friend_requests' then p.friend_requests
           when 'likes' then p.likes
           when 'comments' then p.comments
           when 'drops' then p.drops
           else true
         end
    into allowed
    from public.notification_prefs p
   where p.user_id = target;
  if allowed is false then
    return;                                           -- they turned this type off
  end if;
  select jsonb_agg(jsonb_build_object(
           'to', t.token, 'title', title, 'body', body, 'data', data, 'sound', 'default', 'channelId', 'default'))
    into batch
    from public.push_tokens t
   where t.user_id = target;
  if batch is null then
    return;                                           -- no phones registered
  end if;
  perform net.http_post(
    url := 'https://exp.host/--/api/v2/push/send',
    body := batch,
    headers := '{"Content-Type": "application/json", "Accept": "application/json"}'::jsonb
  );
end;
$$;

-- Nudge someone in your group who hasn't posted today's drop (once every 15 minutes at most).
create or replace function public.nudge_group_member(grp uuid, target uuid, day date)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  group_name text;
begin
  perform private.check_today(day);
  if me = target then
    raise exception 'You can''t nudge yourself 😄';
  end if;
  if not private.is_group_member(grp, me) or not private.is_group_member(grp, target) then
    raise exception 'They''re not in this group';
  end if;
  if exists (select 1 from public.posts where user_id = target and drop_day = day) then
    raise exception 'They already posted 🎉';
  end if;
  if exists (
    select 1 from public.nudges
     where group_id = grp and from_id = me and to_id = target and created_at > now() - interval '15 minutes'
  ) then
    raise exception 'You just nudged them – give them a minute 😅';
  end if;
  insert into public.nudges (group_id, from_id, to_id) values (grp, me, target);
  select name into group_name from public.peek_groups where id = grp;
  perform private.send_push(
    target,
    'drops',
    private.push_name(me) || ' nudged you 👀',
    group_name || ' is waiting on your Peekaboo drop!',
    jsonb_build_object('type', 'group', 'group', grp)
  );
end;
$$;
revoke execute on function public.nudge_group_member(uuid, uuid, date) from public, anon;
grant execute on function public.nudge_group_member(uuid, uuid, date) to authenticated;

-- "Sam added you to Besties 👯"
create or replace function private.push_group_added()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.added_by is not null and new.added_by <> new.user_id then
    perform private.send_push(
      new.user_id,
      'drops',
      private.push_name(new.added_by) || ' added you to a group 👯',
      (select name from public.peek_groups where id = new.group_id) || ' – your drops stay hidden until everyone posts!',
      jsonb_build_object('type', 'group', 'group', new.group_id)
    );
  end if;
  return null;
end;
$$;

create trigger peek_group_members_push
  after insert on public.peek_group_members
  for each row execute function private.push_group_added();

-- Media rules: same as before, plus a drop's files stay locked while a shared group is still waiting.
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
