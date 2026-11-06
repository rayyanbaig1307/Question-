-- =====================================================================
-- Launch safety: two child-safety rules before the App Store launch (6 Nov 2026). Safe to run more than once.
--
-- 1. 👶 Adding someone under 18 always sends a friend request.
--    Before: tapping "Add" on a PUBLIC account made you friends at once (20261203000000_add_public_friends.sql).
--    Friends can chat and see each other on the friend map, so a stranger could do that with a 13-year-old.
--    Now you're friends at once only when the person you add is 18 or over (from the birthday they saved,
--    the same rule hit ups use). If they're under 18, or haven't saved a birthday yet, they get a friend
--    request instead – even if their account is public – and nothing changes until they accept it.
--    Private accounts get a request, like before. Adults with a public account: friends at once, like before.
--    The app already shows "Requested" when the answer is 'pending', so the button and the toast just work.
--    Second lock: a check on the friendships table itself. Whenever a logged-in person makes a friendship
--    with someone under 18, that person must have said yes (they sent the request, or they accept it).
--    So no other way in – now or later – can skip their OK. Hit ups were already for adults only, group adds
--    only add people who are already your friends, and invites only share a link.
--    The owner (SQL Editor, Table Editor) and the server (no logged-in user) are not checked.
--
-- 2. 💡 Community dare ideas need the owner's OK before they become everyone's dare.
--    Before: the top idea with 3+ 🔥 votes ran as the daily dare by itself (20261120000000_community_dares.sql).
--    Now an idea also needs approved_at filled in (empty = not approved). Only approved ideas with 3+ votes
--    can be picked. An approval counts from the next new dare after it (dares change at 10:00 UTC every day,
--    6am in New York), so today's dare never changes in the middle of the day. With nothing approved, the
--    built-in dare list runs, as before. Dares that already ran stay exactly as they were.
--    People can't approve their own idea: a new idea always starts with approved_at empty, and app users
--    can't change ideas at all.
--
--    How to approve an idea (Supabase dashboard):
--      1. Table Editor → schema "public" → table "dare_ideas". Sort by "votes", biggest first.
--         Leave out rows where "hidden" is TRUE or "used_on" is filled in (those can't run).
--      2. Read the "text". Only approve it if it follows the Dare Safety Rules (nobody gets hurt, nothing
--         illegal, clothes stay on, friends are in on it) and you'd be happy for a 13-year-old to do it.
--      3. Click the idea's "approved_at" cell, put in the date and time now (for example
--         2026-11-06 09:00:00+00) and save. Done: it can run from the next new dare on.
--      To take an approval back (before it has run): set "approved_at" back to NULL.
--      Or in the SQL Editor:  update public.dare_ideas set approved_at = now() where id = '<the idea id>';
-- =====================================================================
begin;
set local lock_timeout = '15s';

-- ---------------------------------------------------------------------
-- 1a. Adding someone: friends at once only with an adult's public account
-- ---------------------------------------------------------------------
-- Same as 20261203000000_add_public_friends.sql, plus the under-18 rule. Returns 'pending' (a request they
-- must accept) or 'accepted' (you're friends now).
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
    -- They asked you first: adding them back says yes to their request.
    if existing.addressee_id = me then
      update public.friendships set status = 'accepted', accepted_at = now() where id = existing.id;
      return 'accepted';
    end if;
    return 'pending';
  end if;

  -- A private account, or someone under 18 (no birthday saved counts as under 18): a request they must
  -- accept. The app just shows "Requested" – it never says why, so nobody learns someone's age from it.
  if they_are_private or private.age_group(target) is distinct from 'adult' then
    insert into public.friendships (requester_id, addressee_id) values (me, target);
    return 'pending';
  end if;
  -- An adult with a public account: friends right away.
  insert into public.friendships (requester_id, addressee_id, status, accepted_at) values (me, target, 'accepted', now());
  return 'accepted';
end;
$$;
revoke execute on function public.send_friend_request(uuid) from public, anon;
grant execute on function public.send_friend_request(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 1b. Second lock: nobody becomes friends with an under-18 without their OK
-- ---------------------------------------------------------------------
-- Runs before a friendship is saved as 'accepted' (a new row, or a request changing to accepted).
-- * Accepting a request: the person who sent it already said yes, so only the person it was sent to has to.
--   If someone else accepts it for an under-18, it's refused.
-- * A new row that is accepted straight away: only the person doing it has said yes. If the other person is
--   under 18 (or has no birthday), the row is saved as a normal friend request instead. If someone made it
--   in the other person's name, it's refused.
-- * Nobody logged in (the owner in the dashboard, or the server): not checked.
create or replace function private.friendship_needs_their_ok()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
begin
  if me is null or new.status is distinct from 'accepted' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'accepted' then
    return new;                                         -- already friends: nothing new
  end if;

  if tg_op = 'UPDATE' then
    -- A request changing to accepted: the person it was sent to must be the one saying yes.
    if me <> new.addressee_id and private.age_group(new.addressee_id) is distinct from 'adult' then
      raise exception 'They need to accept your friend request first';
    end if;
    return new;
  end if;

  -- A new row that is accepted at once.
  if me = new.requester_id then
    if private.age_group(new.addressee_id) is distinct from 'adult' then
      new.status := 'pending';                          -- a normal friend request instead
      new.accepted_at := null;
    end if;
    return new;
  end if;
  if (me <> new.addressee_id and private.age_group(new.addressee_id) is distinct from 'adult')
     or private.age_group(new.requester_id) is distinct from 'adult' then
    raise exception 'They need to accept your friend request first';
  end if;
  return new;
end;
$$;
revoke execute on function private.friendship_needs_their_ok() from public, anon, authenticated;

drop trigger if exists friendships_need_their_ok on public.friendships;
create trigger friendships_need_their_ok before insert or update of status on public.friendships
  for each row execute function private.friendship_needs_their_ok();

-- ---------------------------------------------------------------------
-- 2a. The owner's OK on dare ideas
-- ---------------------------------------------------------------------
-- When the owner approved the idea. Empty (NULL) = not approved, so it can't become the daily dare.
alter table public.dare_ideas add column if not exists approved_at timestamptz;

-- A new idea never starts approved (the same trigger already resets votes, hidden, used_on and created_at,
-- 20261213102659_qa_round2_security_hardening.sql). App users have no rule that lets them change an idea,
-- so only the owner can fill approved_at in.
create or replace function private.prepare_dare_idea()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('dare-idea:' || new.user_id::text,0));
  if exists (select 1 from public.dare_ideas where user_id=new.user_id and created_at>now()-interval '24 hours') then
    raise exception 'You can suggest one dare a day';
  end if;
  new.votes:=0;
  new.hidden:=false;
  new.used_on:=null;
  new.approved_at:=null;
  new.created_at:=now();
  return new;
end;
$$;
revoke execute on function private.prepare_dare_idea() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2b. Today's community dare: only an approved idea can be picked
-- ---------------------------------------------------------------------
-- Same as 20261120000000_community_dares.sql, plus: the idea must be approved, and approved before today's
-- dare started (10:00 UTC). Returns nothing when no idea is ready – then the built-in dare runs.
-- Past days return what ran, approved or not.
create or replace function public.pick_daily_dare(for_day date)
returns table (day date, idea_id uuid, text text, username text, display_name text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  today date := private.current_dare_day();
  day_started timestamptz := (private.current_dare_day() + time '10:00') at time zone 'utc';
  chosen uuid;
begin
  if auth.uid() is null then
    raise exception 'Please log in again';
  end if;
  if for_day > today then
    return;                                           -- no peeking at tomorrow
  end if;
  if for_day = today and not exists (select 1 from public.daily_dares dd where dd.day = today) then
    select d.id into chosen
      from public.dare_ideas d
     where not d.hidden and d.used_on is null and d.votes >= 3
       and d.approved_at is not null and d.approved_at <= day_started
     order by d.votes desc, d.created_at asc
     limit 1;
    if chosen is not null then
      insert into public.daily_dares (day, idea_id) values (today, chosen) on conflict (day) do nothing;
      update public.dare_ideas set used_on = today where id = chosen and used_on is null
         and exists (select 1 from public.daily_dares dd where dd.day = today and dd.idea_id = chosen);
    end if;
  end if;
  return query
    select dd.day, dd.idea_id, d.text, p.username, p.display_name
      from public.daily_dares dd
      join public.dare_ideas d on d.id = dd.idea_id
      join public.profiles p on p.id = d.user_id
     where dd.day = for_day;
end;
$$;
revoke execute on function public.pick_daily_dare(date) from public, anon;
grant execute on function public.pick_daily_dare(date) to authenticated;

commit;
