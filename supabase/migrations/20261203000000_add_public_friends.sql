-- =====================================================================
-- Adding a public account makes you friends straight away
--
-- * Tap "Add" on someone whose account is public → you're friends at once (they get "X added you as a
--   friend"). No request to accept.
-- * Private accounts still get a friend request they can accept or decline.
-- * Hit ups are separate and unchanged (adults only, see 20261202).
-- =====================================================================

create or replace function public.send_friend_request(target uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  existing public.friendships%rowtype;
  they_are_private boolean;
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
  select p.is_private into they_are_private from public.profiles p where p.id = target;
  if they_are_private is null then
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

  if they_are_private then
    insert into public.friendships (requester_id, addressee_id) values (me, target);
    return 'pending';
  end if;
  -- Public account: friends right away.
  insert into public.friendships (requester_id, addressee_id, status, accepted_at) values (me, target, 'accepted', now());
  return 'accepted';
end;
$$;

-- Pushes: a request, an accepted request, or (new) someone adding you straight away.
create or replace function private.push_friendship()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if current_setting('peekaboo.quiet_push', true) = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' and new.status = 'pending' then
    perform private.send_push(new.addressee_id, 'friend_requests', 'New friend request 👋',
      private.push_name(new.requester_id) || ' wants to be friends', jsonb_build_object('type', 'friends'));
  elsif tg_op = 'INSERT' and new.status = 'accepted' then
    perform private.send_push(new.addressee_id, 'friend_requests', 'You have a new friend 🎉',
      private.push_name(new.requester_id) || ' added you as a friend', jsonb_build_object('type', 'friends'));
  elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status = 'accepted' then
    perform private.send_push(new.requester_id, 'friend_requests', 'You have a new friend 🎉',
      private.push_name(new.addressee_id) || ' accepted your friend request', jsonb_build_object('type', 'friends'));
  end if;
  return new;
end;
$$;

-- Someone's friends list, for the Friends number on their profile. You can see it when it's your own, when
-- their account is public, or when you're friends. Blocked (either way) or a private stranger → nothing.
create or replace function public.friends_of(person uuid)
returns setof public.profiles language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  they_are_private boolean;
begin
  if me is null then
    return;
  end if;
  select p.is_private into they_are_private from public.profiles p where p.id = person;
  if they_are_private is null then
    return;
  end if;
  if person <> me then
    if private.is_blocked(me, person) then
      return;
    end if;
    if they_are_private and not private.are_friends(me, person) then
      return;
    end if;
  end if;
  return query
    select p.* from public.friendships f
    join public.profiles p on p.id = case when f.requester_id = person then f.addressee_id else f.requester_id end
    where f.status = 'accepted' and person in (f.requester_id, f.addressee_id)
      and not private.is_blocked(me, p.id)
    order by coalesce(nullif(p.display_name, ''), p.username);
end;
$$;
revoke execute on function public.friends_of(uuid) from public, anon;
grant execute on function public.friends_of(uuid) to authenticated;
