-- =====================================================================
-- Peek Match – step 5: "Add as friend"
--
-- * After matching, either of you can tap "Add as a Peekaboo friend". That sends a
--   normal friend request – so it only happens when you choose, and they have to say
--   yes (in the chat or in Friends) before you become friends.
-- * Until then, neither of you sees the other's normal Peekaboo account.
-- * Little notices appear in the match chat ("💌 I'd love to be Peekaboo friends!",
--   "You're now Peekaboo friends! 🎉"). They don't count towards the 5 messages.
-- =====================================================================

alter table public.dating_messages
  add column if not exists kind text not null default 'text' check (kind in ('text', 'friend_request', 'friends'));

-- Your matches: the other person's dating profile, how many messages each of you has sent (photos unblur at
-- 5 each – only real messages count), the last message, how many you haven't read, and where you are with
-- becoming Peekaboo friends ('none', 'sent', 'received' or 'friends'). Newest chats first.
create or replace function public.peek_match_matches(only_match uuid default null)
returns setof jsonb language sql stable security definer set search_path = '' as $$
  with me as (select auth.uid() as id, private.my_dating_id() as dating_id),
  mine as (
    select mt.id, mt.created_at, case when mt.user_a = me.id then mt.user_b else mt.user_a end as other
      from public.dating_matches mt, me
     where me.id in (mt.user_a, mt.user_b) and (only_match is null or mt.id = only_match)
       and private.in_match(mt.id, me.id)
  )
  select jsonb_build_object(
    'match_id', mine.id,
    'created_at', mine.created_at,
    'person', private.dating_card(me.id, mine.other),
    'my_count', (select count(*) from public.dating_messages d
                  where d.match_id = mine.id and d.sender = me.dating_id and d.kind = 'text'),
    'their_count', (select count(*) from public.dating_messages d
                     where d.match_id = mine.id and d.sender <> me.dating_id and d.kind = 'text'),
    'friendship', coalesce((select case when f.status = 'accepted' then 'friends'
                                        when f.requester_id = me.id then 'sent'
                                        else 'received' end
                              from public.friendships f
                             where least(f.requester_id, f.addressee_id) = least(me.id, mine.other)
                               and greatest(f.requester_id, f.addressee_id) = greatest(me.id, mine.other)), 'none'),
    'unread', (select count(*) from public.dating_messages d
                where d.match_id = mine.id and d.sender <> me.dating_id and d.read_at is null),
    'last', (select jsonb_build_object('body', d.body, 'mine', d.sender = me.dating_id, 'created_at', d.created_at)
               from public.dating_messages d where d.match_id = mine.id order by d.created_at desc limit 1)
  )
  from mine, me
  order by coalesce((select max(d.created_at) from public.dating_messages d where d.match_id = mine.id), mine.created_at) desc;
$$;
revoke execute on function public.peek_match_matches(uuid) from public, anon;
grant execute on function public.peek_match_matches(uuid) to authenticated;


-- Add your match as a Peekaboo friend. Returns 'requested' (waiting for them), 'friends' (they'd already
-- asked, so now you're friends) or 'already'.
create or replace function public.peek_match_add_friend(match uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  them uuid;
  before text;
  result text;
begin
  if not private.in_match(match, me) then
    raise exception 'This match has ended';
  end if;
  them := private.match_partner(match, me);
  select f.status into before from public.friendships f
   where least(f.requester_id, f.addressee_id) = least(me, them)
     and greatest(f.requester_id, f.addressee_id) = greatest(me, them);
  if before = 'accepted' then
    return 'already';
  end if;
  result := public.send_friend_request(them);          -- the normal friend request (or accepts theirs)
  if result = 'accepted' then
    insert into public.dating_messages (match_id, sender, body, kind)
    values (match, private.my_dating_id(), 'You''re now Peekaboo friends! 🎉', 'friends');
    return 'friends';
  end if;
  if not exists (select 1 from public.dating_messages d
                  where d.match_id = match and d.sender = private.my_dating_id() and d.kind = 'friend_request') then
    insert into public.dating_messages (match_id, sender, body, kind)
    values (match, private.my_dating_id(), '💌 I''d love to be Peekaboo friends!', 'friend_request');
  end if;
  return 'requested';
end;
$$;
revoke execute on function public.peek_match_add_friend(uuid) from public, anon;
grant execute on function public.peek_match_add_friend(uuid) to authenticated;

-- Once you're Peekaboo friends: their normal account id (to open their profile). Nothing before that.
create or replace function public.peek_match_friend_id(match uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select them.id
    from (select private.match_partner(match, auth.uid()) as id) them
   where private.in_match(match, auth.uid())
     and private.are_friends(auth.uid(), them.id);
$$;
revoke execute on function public.peek_match_friend_id(uuid) from public, anon;
grant execute on function public.peek_match_friend_id(uuid) to authenticated;
