-- =====================================================================
-- 🔗 Personal invite links
--
-- Everyone gets their own invite link with a short code in it (for example
-- https://peekaboo-4gz.pages.dev/invite?c=BCDF2GHJ3K). A friend who opens it in Peekaboo sees who invited them
-- and taps "Add <name>". Nothing ever happens by itself: the person who opened the link always has to tap.
--
-- The code
-- * 10 characters from 23456789BCDFGHJKLMNPQRSTVWXZ (no vowels, so no rude words, and no 0/O or 1/I that look
--   alike). That is about 300 million million codes, so nobody can guess one.
-- * Typing it is forgiving: small letters, spaces and dashes are fine ("bcdf-2ghj 3k" works).
-- * "Get a new link" makes a new code; the old one stops working at once. It also removes friend requests
--   that came in through your link in the last 7 days and that you haven't answered yet.
--
-- What tapping "Add" does (public.accept_invite) – the same rule as tapping "Add friend" today:
-- * The person who made the link is 18 or over and has a public account → you're friends straight away.
-- * They are under 18, haven't saved a birthday, or have a private account → they get a friend request
--   (the app just says "Friend request sent" – it never says why, so nobody learns anyone's age from it).
-- * You two were friends (or had a request) before and it was removed, or you used their link before →
--   only ever a friend request, never friends straight away.
-- * That was removed in the last 7 days (for example they just said no, or unfriended you) → nothing at
--   all happens (no request, no notification), but the app still says "Friend request sent".
-- * Already friends → "already". Your own link → "self". A request they sent you → you're friends now.
--   A request you already sent them → it just stays a request.
-- * The child-safety rule below stopped it → "busy" (the app says the link is busy; nothing was saved).
-- * An unknown or old code, a deleted or banned account, or a block either way all give the same answer:
--   "This invite link doesn't work any more" (so a block is never given away).
-- * The second lock from 20261220000000_launch_safety.sql still checks every friendship that is saved.
--
-- Limits (a deleted friendship never gives an invite back – every use is written down for good):
-- * You can use 20 invite links a day (counting uses that made a friend or a request, and tries that the
--   child-safety rule stopped).
-- * One person's link can be used 20 times a day. After that: "This invite link is busy – try again
--   tomorrow". When it reaches 20, its owner gets one notification that day: "Lots of people used your
--   invite link today – not you? Get a new link".
-- * Child safety: once 3 people under 18 (or with no birthday saved) have used one adult's link in 24 hours,
--   nobody else under 18 can use it for now. Nothing is saved that the adult could see or accept: no friend
--   request and no notification to them. The app just says "busy". The try is written down, and the people
--   who get report alerts (private.report_alert_people) get one notification about it that day.
--
-- Notifications only ever go to the person who made the link, never to the person who tapped it:
-- "You have a new friend 🎉 / <name> added you as a friend", "New friend request 👋 / <name> wants to be
-- friends", or "… accepted your friend request".
--
-- Banned accounts: a ban is set in Supabase → Authentication → Users → Ban user (auth.users.banned_until).
-- A banned person's link doesn't work, and a banned person can't use links ("Please log in again").
--
-- For the owner (Supabase → Table Editor → schema "private"):
-- * invite_accepts: every invite that made a friend or a request (who used whose link, when, and what
--   happened). outcome "held" = an under-18 that the child-safety rule above stopped.
-- * invite_alerts: the "busy" and child-safety notifications that went out.
--
-- Safe to run again: everything is "if not exists", "or replace" or removed first.
-- =====================================================================
begin;
set local lock_timeout = '15s';

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------
-- Each person's current invite code. You can read your own; only the server writes it.
create table if not exists public.invite_codes (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  code text not null unique check (code ~ '^[23456789BCDFGHJKLMNPQRSTVWXZ]{10}$'),
  created_at timestamptz not null default now()
);
alter table public.invite_codes enable row level security;
drop policy if exists "You can see your own invite code" on public.invite_codes;
create policy "You can see your own invite code"
  on public.invite_codes for select to authenticated
  using (user_id = (select auth.uid()));
revoke all on table public.invite_codes from anon;
revoke insert, update, delete, truncate, references, trigger on table public.invite_codes from authenticated;

-- Who has used whose link (at least once). Using the same person's link again only sends a request.
create table if not exists private.invite_uses (
  inviter uuid not null references public.profiles (id) on delete cascade,
  invitee uuid not null references public.profiles (id) on delete cascade,
  first_used_at timestamptz not null default now(),
  primary key (inviter, invitee)
);
create index if not exists invite_uses_invitee_idx on private.invite_uses (invitee);

-- Two people whose friendship (or friend request) was removed: unfriended, declined, cancelled or blocked.
-- One line per pair (the smaller id first), with the last time it happened.
-- On purpose this table is NOT linked to profiles: then writing a line never has to wait for an account
-- that is being deleted at that moment (that wait could get two people stuck waiting for each other).
-- A person's lines are removed by a trigger when their account is deleted (see section 2).
create table if not exists private.past_links (
  person_a uuid not null,
  person_b uuid not null,
  removed_at timestamptz not null default now(),
  primary key (person_a, person_b),
  check (person_a < person_b)
);
-- An earlier copy of this file had those links. Remove them if they are there.
alter table private.past_links drop constraint if exists past_links_person_a_fkey;
alter table private.past_links drop constraint if exists past_links_person_b_fkey;
create index if not exists past_links_person_b_idx on private.past_links (person_b);

-- Every invite that made a friend or a friend request. Never removed when the friendship goes,
-- so unfriending can't give anyone more invites.
-- outcome: 'friends' (friends straight away), 'requested' (a friend request to the link's owner),
-- 'accepted_request' (the link's owner had already asked you, and now you're friends),
-- 'held' (someone under 18 that the child-safety rule stopped: nothing was saved for the link's owner).
create table if not exists private.invite_accepts (
  id bigint generated always as identity primary key,
  accepter uuid not null references public.profiles (id) on delete cascade,
  inviter uuid not null references public.profiles (id) on delete cascade,
  outcome text not null check (outcome in ('friends', 'requested', 'accepted_request', 'held')),
  accepter_adult boolean not null default false,
  friendship_id uuid,
  used_at timestamptz not null default now()
);
-- An earlier copy of this file had no 'held' outcome and a held_for_safety column: bring it up to date.
alter table private.invite_accepts drop constraint if exists invite_accepts_outcome_check;
alter table private.invite_accepts add constraint invite_accepts_outcome_check
  check (outcome in ('friends', 'requested', 'accepted_request', 'held'));
alter table private.invite_accepts drop column if exists held_for_safety;
create index if not exists invite_accepts_accepter_idx on private.invite_accepts (accepter, used_at desc);
create index if not exists invite_accepts_inviter_idx on private.invite_accepts (inviter, used_at desc);

-- The "your link is busy" and child-safety notifications that went out (so each goes out once a day).
create table if not exists private.invite_alerts (
  id bigint generated always as identity primary key,
  inviter uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('busy', 'under_18')),
  sent_at timestamptz not null default now()
);
create index if not exists invite_alerts_inviter_idx on private.invite_alerts (inviter, kind, sent_at desc);

revoke all on table private.invite_uses, private.past_links, private.invite_accepts, private.invite_alerts
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Small helpers (only the server can use them)
-- ---------------------------------------------------------------------
-- A typed or pasted code, cleaned up: capital letters, no spaces or dashes. Null when it can't be a code.
create or replace function private.clean_invite_code(raw text)
returns text language sql immutable set search_path = '' as $$
  select case when cleaned ~ '^[23456789BCDFGHJKLMNPQRSTVWXZ]{10}$' then cleaned end
    from (select regexp_replace(upper(left(coalesce(raw, ''), 100)), '[[:space:]–—-]+', '', 'g') as cleaned) x;
$$;

-- A new random code. The randomness comes from gen_random_uuid() (the database's strong random numbers).
-- Only the fully random bytes of the uuid are used, and bytes 252–255 are skipped so every letter is
-- equally likely.
create or replace function private.new_invite_code()
returns text language plpgsql volatile set search_path = '' as $$
declare
  letters constant text := '23456789BCDFGHJKLMNPQRSTVWXZ';
  made text := '';
  raw bytea;
  pos int;
  b int;
begin
  while length(made) < 10 loop
    raw := uuid_send(gen_random_uuid());
    foreach pos in array array[0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13, 14, 15] loop
      b := get_byte(raw, pos);
      if b < 252 and length(made) < 10 then
        made := made || substr(letters, b % 28 + 1, 1);
      end if;
    end loop;
  end loop;
  return made;
end;
$$;

-- Is this account banned right now? (Supabase → Authentication → Users → Ban user.)
create or replace function private.is_banned(person uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select u.banned_until > now() from auth.users u where u.id = person), false);
$$;

-- Can this person use invites right now? (Logged in, with an account, and not banned.)
create or replace function private.invite_user_ok(person uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select person is not null
     and exists (select 1 from public.profiles p where p.id = person)
     and not private.is_banned(person);
$$;

-- Stops an invite when the person using it, or the link, has had 20 uses in the last 24 hours
-- (tries that the child-safety rule stopped count too).
create or replace function private.check_invite_limits(accepter_id uuid, owner_id uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if (select count(*) from private.invite_accepts a
       where a.accepter = accepter_id and a.used_at > now() - interval '24 hours') >= 20 then
    raise exception 'You''ve used a lot of invites today – try again tomorrow';
  end if;
  if (select count(*) from private.invite_accepts a
       where a.inviter = owner_id and a.used_at > now() - interval '24 hours') >= 20 then
    raise exception 'This invite link is busy – try again tomorrow';
  end if;
end;
$$;

-- When a friendship or friend request is removed (unfriend, decline, cancel, block), remember the pair.
-- Not when an account is being deleted: then that person's profile is already gone here, so nothing is
-- written (the friendship goes with the account).
create or replace function private.remember_past_link()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.profiles p where p.id = old.requester_id)
     and exists (select 1 from public.profiles p where p.id = old.addressee_id) then
    insert into private.past_links (person_a, person_b, removed_at)
    values (least(old.requester_id, old.addressee_id), greatest(old.requester_id, old.addressee_id), now())
    on conflict (person_a, person_b) do update set removed_at = excluded.removed_at;
  end if;
  return null;
end;
$$;
drop trigger if exists friendships_remember_past_link on public.friendships;
create trigger friendships_remember_past_link after delete on public.friendships
  for each row execute function private.remember_past_link();

-- When an account is deleted, its past_links lines go too. Triggers run in name order, and the "zz_" makes
-- this one run after everything that is deleted with the account (friendships included). So it also
-- removes a line that someone else's unfriend wrote while the account was being deleted.
create or replace function private.forget_past_links()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from private.past_links l where l.person_a = old.id or l.person_b = old.id;
  return null;
end;
$$;
drop trigger if exists zz_profiles_forget_past_links on public.profiles;
create trigger zz_profiles_forget_past_links after delete on public.profiles
  for each row execute function private.forget_past_links();

-- ---------------------------------------------------------------------
-- 3. Your code: get it (made the first time you ask) or get a new one
-- ---------------------------------------------------------------------
create or replace function public.my_invite_code()
returns text language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  mine text;
  tries int := 0;
begin
  if not private.invite_user_ok(me) then
    raise exception 'Please log in again';
  end if;
  select c.code into mine from public.invite_codes c where c.user_id = me;
  while mine is null loop
    tries := tries + 1;
    if tries > 10 then
      raise exception 'Something went wrong – please try again';
    end if;
    begin
      insert into public.invite_codes (user_id, code) values (me, private.new_invite_code())
      on conflict (user_id) do nothing;
    exception when unique_violation then
      null;                                   -- someone else has that code (very unlikely): try another
    end;
    select c.code into mine from public.invite_codes c where c.user_id = me;
  end loop;
  return mine;
end;
$$;
revoke execute on function public.my_invite_code() from public, anon;
grant execute on function public.my_invite_code() to authenticated;

-- "Get a new link": the old code stops working at once. Friend requests that came in through your link in
-- the last 7 days and are still waiting are removed too (people who just found your old link).
create or replace function public.reset_invite_code()
returns text language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  fresh text;
  tries int := 0;
begin
  if not private.invite_user_ok(me) then
    raise exception 'Please log in again';
  end if;
  -- Waits until anyone who is using your link right now has finished.
  perform pg_advisory_xact_lock(hashtextextended('invite-inviter:' || me::text, 0));
  loop
    tries := tries + 1;
    if tries > 10 then
      raise exception 'Something went wrong – please try again';
    end if;
    fresh := private.new_invite_code();
    begin
      insert into public.invite_codes (user_id, code) values (me, fresh)
      on conflict (user_id) do update set code = excluded.code, created_at = now();
      exit;
    exception when unique_violation then
      null;                                   -- someone else has that code (very unlikely): try another
    end;
  end loop;
  delete from public.friendships f
   using private.invite_accepts a
   where a.inviter = me and a.outcome = 'requested' and a.used_at > now() - interval '7 days'
     and f.id = a.friendship_id and f.status = 'pending' and f.addressee_id = me;
  return fresh;
end;
$$;
revoke execute on function public.reset_invite_code() from public, anon;
grant execute on function public.reset_invite_code() to authenticated;

-- ---------------------------------------------------------------------
-- 4. Who sent this invite? (for the invite screen in the app – logged-in people only)
-- ---------------------------------------------------------------------
-- The same fields anyone logged in can already see on a profile. No rows when the link can't be used:
-- unknown or old code, a deleted or banned account, or a block either way. Your own code shows you.
create or replace function public.invite_preview(invite_code text)
returns table (id uuid, username text, display_name text, avatar_path text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  me uuid := auth.uid();
  clean text := private.clean_invite_code(invite_code);
begin
  if me is null or private.is_banned(me) then
    raise exception 'Please log in again';
  end if;
  return query
    select p.id, p.username, p.display_name, p.avatar_path
      from public.invite_codes c
      join public.profiles p on p.id = c.user_id
     where c.code = clean
       and not private.is_banned(p.id)
       and (p.id = me or not private.is_blocked(me, p.id));
end;
$$;
revoke execute on function public.invite_preview(text) from public, anon;
grant execute on function public.invite_preview(text) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Tapping "Add <name>" on an invite
-- ---------------------------------------------------------------------
-- Returns 'friends' (you're friends now), 'requested' (a friend request), 'already' (already friends),
-- 'self' (your own link) or 'busy' (the child-safety rule stopped it: nothing was saved for the link's
-- owner). expected_user_id is the account the app thinks is logged in (like block_user): if the phone
-- switched accounts in the meantime, nothing happens.
create or replace function public.accept_invite(invite_code text, expected_user_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  clean text := private.clean_invite_code(invite_code);
  them uuid;
  still_theirs uuid;
  existing public.friendships%rowtype;
  saved public.friendships%rowtype;
  i_am_adult boolean;
  instant boolean;
  what text;
  person uuid;
begin
  if me is null then
    raise exception 'Please log in again';
  end if;
  if expected_user_id is distinct from me then
    raise exception 'Your login has changed - please try again';
  end if;
  if not private.invite_user_ok(me) then
    raise exception 'Please log in again';
  end if;
  if clean is null then
    raise exception 'This invite link doesn''t work any more';
  end if;

  -- One invite at a time for you (so the daily limit is exact) ...
  perform pg_advisory_xact_lock(hashtextextended('invite-accept:' || me::text, 0));
  select c.user_id into them from public.invite_codes c where c.code = clean;
  if them is null then
    raise exception 'This invite link doesn''t work any more';
  end if;
  if them = me then
    return 'self';
  end if;
  -- ... then for the link's owner, then for the two of you.
  perform pg_advisory_xact_lock(hashtextextended('invite-inviter:' || them::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(
    'invite-pair:' || least(me, them)::text || ':' || greatest(me, them)::text, 0));
  -- Hold their account first, and only then their code: the same order as deleting an account, so this
  -- and their account deletion never wait for each other. If they are deleting their account right now,
  -- this waits until that is done, and then their code is gone too ("doesn't work any more" below).
  perform 1 from public.profiles p where p.id = them for key share;
  -- The link must still be theirs (they may have just made a new one). Holding it makes "Get a new link"
  -- wait until this invite is finished.
  select c.user_id into still_theirs from public.invite_codes c where c.code = clean for share;
  if still_theirs is distinct from them
     or not private.invite_user_ok(them)
     or private.is_blocked(me, them) then
    raise exception 'This invite link doesn''t work any more';
  end if;

  select * into existing from public.friendships f
   where least(f.requester_id, f.addressee_id) = least(me, them)
     and greatest(f.requester_id, f.addressee_id) = greatest(me, them)
   for update;

  if found then
    if existing.status = 'accepted' then
      return 'already';
    end if;
    if existing.requester_id = me then
      return 'requested';                     -- you already asked them: it stays a request, nothing new
    end if;
    -- They had asked you: this is your yes. (They get "… accepted your friend request".)
    perform private.check_invite_limits(me, them);
    update public.friendships set status = 'accepted', accepted_at = now()
     where id = existing.id
     returning * into saved;
    what := 'accepted_request';
  else
    -- Removed in the last 7 days (they said no, or someone unfriended): nothing happens at all.
    if exists (select 1 from private.past_links l
                where l.person_a = least(me, them) and l.person_b = greatest(me, them)
                  and l.removed_at > now() - interval '7 days') then
      return 'requested';
    end if;
    perform private.check_invite_limits(me, them);
    i_am_adult := coalesce(private.age_group(me) = 'adult', false);
    -- Child safety: 3 people under 18 (or with no birthday) already used this link in 24 hours, and its owner is
    -- an adult or never saved a birthday (so skipping the birthday can't dodge this) →
    -- more of them can't use it for now. Nothing is saved that the adult could see or accept (no friend
    -- request, no notification to them), so they can't collect under-18s through a link. The try is written
    -- down (it counts towards the daily limits), and the people who get report alerts are told (once a day
    -- per link). The answer is "busy" and not an error, because an error would undo the note and the alert.
    if not i_am_adult
       and private.age_group(them) is distinct from 'teen'
       and (select count(distinct a.accepter) from private.invite_accepts a
             where a.inviter = them and not a.accepter_adult
               and a.used_at > now() - interval '24 hours') >= 3 then
      insert into private.invite_accepts (accepter, inviter, outcome, accepter_adult)
      values (me, them, 'held', false);
      if not exists (select 1 from private.invite_alerts x
                      where x.inviter = them and x.kind = 'under_18' and x.sent_at > now() - interval '24 hours') then
        insert into private.invite_alerts (inviter, kind) values (them, 'under_18');
        for person in select r.user_id from private.report_alert_people r loop
          begin
            perform private.send_push(person, 'reports', '🚩 Invite link check',
              'Lots of under-18s used one invite link today (its owner is an adult or has no birthday saved), '
                || 'so more under-18s can''t use it for now. '
                || 'Check private.invite_accepts in Supabase.',
              jsonb_build_object('type', 'invite_check', 'inviter', them));
          exception when others then
            null;                             -- never stop this because of a notification problem
          end;
        end loop;
      end if;
      return 'busy';
    end if;
    -- Friends straight away only with an adult's public account, and only the first time ever.
    instant := coalesce((select not p.is_private from public.profiles p where p.id = them), false)
      and coalesce(private.age_group(them) = 'adult', false)
      and not exists (select 1 from private.past_links l
                       where l.person_a = least(me, them) and l.person_b = greatest(me, them))
      and not exists (select 1 from private.invite_uses u
                       where (u.inviter = them and u.invitee = me) or (u.inviter = me and u.invitee = them));
    -- The person tapping is the one asking. The second lock (friendships_need_their_ok) checks it again.
    insert into public.friendships (requester_id, addressee_id, status, accepted_at)
    values (me, them, case when instant then 'accepted' else 'pending' end, case when instant then now() end)
    on conflict do nothing
    returning * into saved;
    if saved.id is null then
      -- Another add for the two of you was saved at the same moment: use that one.
      select * into existing from public.friendships f
       where least(f.requester_id, f.addressee_id) = least(me, them)
         and greatest(f.requester_id, f.addressee_id) = greatest(me, them);
      return case when existing.status = 'accepted' then 'already' else 'requested' end;
    end if;
    -- What was really saved (the second lock may have turned it into a request).
    what := case when saved.status = 'accepted' then 'friends' else 'requested' end;
  end if;

  -- A block made while this was running undoes everything.
  if private.is_blocked(me, them) then
    raise exception 'This invite link doesn''t work any more';
  end if;

  insert into private.invite_uses (inviter, invitee) values (them, me) on conflict do nothing;
  insert into private.invite_accepts (accepter, inviter, outcome, accepter_adult, friendship_id)
  values (me, them, what, coalesce(private.age_group(me) = 'adult', false), saved.id);

  -- The link's 20th use in 24 hours: tell its owner (once a day) in case it got out.
  if (select count(*) from private.invite_accepts a
       where a.inviter = them and a.used_at > now() - interval '24 hours') >= 20
     and not exists (select 1 from private.invite_alerts x
                      where x.inviter = them and x.kind = 'busy' and x.sent_at > now() - interval '24 hours') then
    insert into private.invite_alerts (inviter, kind) values (them, 'busy');
    perform private.send_push(them, 'invite_alerts', '🔗 Your invite link',
      'Lots of people used your invite link today – not you? Get a new link', jsonb_build_object('type', 'friends'));
  end if;

  return case when saved.status = 'accepted' then 'friends' else 'requested' end;
end;
$$;
revoke execute on function public.accept_invite(text, uuid) from public, anon;
grant execute on function public.accept_invite(text, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 6. Nobody but the server can use the helpers
-- ---------------------------------------------------------------------
revoke execute on function private.clean_invite_code(text) from public, anon, authenticated;
revoke execute on function private.new_invite_code() from public, anon, authenticated;
revoke execute on function private.is_banned(uuid) from public, anon, authenticated;
revoke execute on function private.invite_user_ok(uuid) from public, anon, authenticated;
revoke execute on function private.check_invite_limits(uuid, uuid) from public, anon, authenticated;
revoke execute on function private.remember_past_link() from public, anon, authenticated;
revoke execute on function private.forget_past_links() from public, anon, authenticated;

commit;
