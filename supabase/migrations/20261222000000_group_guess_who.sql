-- =====================================================================
-- 🕵️ Guess Who in a group chat
--
-- In a group chat, someone can post a Guess Who photo. It shows up in that chat with NO name on it, and
-- everyone else in the group guesses who sent it.
--
-- How it works:
-- * A group Guess Who is a normal Guess Who post (public.mystery_posts) with a group (group_id). It is NOT a
--   group chat message, so nothing that names a message's sender (the message row, its file path, the chat
--   push, the Chat list's "last sender", older app versions) ever sees it. Older apps simply don't show it.
-- * The photo lives in the same "mystery" folder as every Guess Who (no name in the file path).
-- * When it is posted, the server writes down everyone who was in the group at that moment, the poster
--   included (group_candidates). The app can't choose or change that list.
-- * Who sees it: the poster, and everyone on that list who is still in the group, as long as:
--     - it hasn't ended (24 hours, like every Guess Who),
--     - they have no block (either way) with ANYONE on the list. (Not just the poster: then hiding it would
--       give away who posted it. A block with anyone in the group hides every Guess Who of that group.)
--     - they have at least 2 names to pick from (otherwise the only name left gives it away).
--   People added to the group later don't see it. Someone who leaves loses it. If the poster leaves, it stays
--   (taking it away would give them away).
-- * The names to pick from are everyone on the list who still has an account, except yourself, always in the
--   same mixed-up order. A guess must be one of those names. One guess each; the poster can't guess.
-- * You only find out who it was (and how many people guessed / got it right) after you guess. The poster
--   always sees the counts. Nobody can see who guessed what.
-- * Group rules: only people in the group can post, the group needs at least 3 people (with 2, the other
--   person would know), photos only for now (no video, no extra layers), and at most 3 per person per group
--   in 24 hours. Deleting one doesn't give it back (a private log keeps when each was posted).
-- * You can only post as yourself. Posting in someone else's name always gets the same answer, so it can't
--   show who is in a group or who has already posted 3 today. Visitors who aren't logged in can't post at all.
-- * No Peekaboo+ hints for group Guess Whos (people in the group could put their hints together).
-- * Blocking whoever posted it only works after you've guessed (then you know who it was anyway).
-- * Reports stay anonymous, exactly like every Guess Who (the reporter never learns who posted it).
-- * Everyone who can see it (not the poster, not people who muted the chat) gets a push:
--   "🕵️ Someone posted a Guess Who – who was it?" – never a name.
-- * Live updates: public.group_guess_pings has one row per group with only a time in it. It changes when a
--   group Guess Who is posted or deleted (not when someone guesses), so the app knows to load the list again
--   without anyone's name going out live.
-- * Group read times ("Seen") now move only up to the newest group message, not to the moment someone
--   opened the chat. So a read time can't show that someone opened the chat right after a Guess Who appeared.
-- * When a group Guess Who is deleted with its group (or with the poster's account), its photo is queued for
--   the daily cleanup, the same way as when the poster deletes it themselves. A reported photo is kept for the
--   report, exactly like before.
--
-- Known and accepted (not built):
-- * If the poster deletes their account, their group Guess Whos vanish at the same moment they leave the
--   member list.
-- * Older app versions get the push and the Chat list line, but can't open the card until their app updates.
--   (Only new app versions can post one, so this only affects mixed groups for a short time.)
-- * The storage record of the photo (owner_id) is the uploader – the same as every Guess Who today. App users
--   can't read it.
--
-- Safe to run again: everything is "if not exists", "or replace" or removed first.
-- =====================================================================
begin;
set local lock_timeout = '15s';

-- ---------------------------------------------------------------------
-- 1. Which group a Guess Who is in, and who was in the group when it was posted
-- ---------------------------------------------------------------------
alter table public.mystery_posts add column if not exists group_id uuid references public.peek_groups (id) on delete cascade;
alter table public.mystery_posts add column if not exists group_candidates uuid[];
create index if not exists mystery_posts_group_idx on public.mystery_posts (group_id, created_at desc) where group_id is not null;
-- For the friends' Guess Who page: lets it look only at the last 24 hours instead of every Guess Who ever posted.
create index if not exists mystery_posts_friends_recent_idx on public.mystery_posts (created_at desc) where group_id is null;
-- (No new rules on the table: you can still only read and delete your own rows. Everyone else gets group
-- Guess Whos through public.group_mystery_feed below, which never says who posted it before you guess.)
-- Visitors who aren't logged in never post, change or delete Guess Whos.
revoke insert, update, delete, truncate on table public.mystery_posts from anon;

-- When each person posted a group Guess Who in each group, for the "3 a day" limit. Deleting a post doesn't
-- remove its line here, so deleting and posting again doesn't give you more. Only the server reads it; lines
-- older than 24 hours are cleared out the next time that person posts in that group.
create table if not exists private.group_mystery_log (
  id bigint generated always as identity primary key,
  group_id uuid not null references public.peek_groups (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  posted_at timestamptz not null default now()
);
create index if not exists group_mystery_log_idx on private.group_mystery_log (group_id, user_id, posted_at desc);
create index if not exists group_mystery_log_user_idx on private.group_mystery_log (user_id);
alter table private.group_mystery_log enable row level security;
revoke all on table private.group_mystery_log from public, anon, authenticated;

-- The server fills in the group's people and checks the group rules. The app can't change a post's group or
-- its people later (on a change, they are put back as they were).
create or replace function private.prepare_group_mystery()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  -- Someone using the app (logged in, or a visitor with the app's key). The same test as
  -- private.guard_claimed_media_delete. The owner's SQL editor and the server's own tools are neither.
  app_user boolean := coalesce(nullif(current_setting('role', true), 'none'), '') in ('authenticated', 'anon')
    or coalesce(auth.role(), '') in ('authenticated', 'anon');
begin
  if tg_op = 'UPDATE' then
    new.group_id := old.group_id;
    new.group_candidates := old.group_candidates;
    return new;
  end if;
  if new.group_id is null then
    new.group_candidates := null;
    return new;
  end if;
  -- You can only post as yourself. This is checked before anything is looked up, and the answer is always the
  -- same. Otherwise posting in someone else's name could show whether they are in the group, or whether they
  -- already posted 3 today (which would give away who posted the group's Guess Whos).
  if app_user and new.user_id is distinct from auth.uid() then
    raise exception 'Only people in this group can post a Guess Who here';
  end if;
  -- The group first (so people can't be added or removed while we look), then the poster's own place in it
  -- (so two posts by the same person at the same moment take turns for the daily limit).
  perform 1 from public.peek_groups g where g.id = new.group_id for key share;
  if not found then
    raise exception 'This group is gone';
  end if;
  perform 1 from public.peek_group_members m
   where m.group_id = new.group_id and m.user_id = new.user_id
     for no key update;
  if not found then
    raise exception 'Only people in this group can post a Guess Who here';
  end if;
  if new.media_type is distinct from 'photo' or new.poster_path is not null or new.overlay_path is not null then
    raise exception 'Guess Who in groups is photos only for now';
  end if;
  -- Counted from the log (a deleted post still counts), while we hold the poster's place in the group.
  if (select count(*) from private.group_mystery_log l
       where l.group_id = new.group_id and l.user_id = new.user_id
         and l.posted_at > now() - interval '24 hours') >= 3 then
    raise exception 'You can post 3 Guess Whos in this group a day';
  end if;
  new.group_candidates := array(
    select m.user_id from public.peek_group_members m where m.group_id = new.group_id order by m.user_id
  );
  if cardinality(new.group_candidates) < 3 then
    raise exception 'Guess Who needs at least 3 people in the group';
  end if;
  -- Every check passed: write it down. (If the post is still refused after this, for example by the table's own
  -- rules, this line is taken back with it.)
  delete from private.group_mystery_log l
   where l.group_id = new.group_id and l.user_id = new.user_id and l.posted_at <= now() - interval '24 hours';
  insert into private.group_mystery_log (group_id, user_id) values (new.group_id, new.user_id);
  return new;
end;
$$;
drop trigger if exists mystery_posts_group_prepare on public.mystery_posts;
create trigger mystery_posts_group_prepare
  before insert or update of group_id, group_candidates on public.mystery_posts
  for each row execute function private.prepare_group_mystery();

-- ---------------------------------------------------------------------
-- 2. Who can see a Guess Who (one rule, used everywhere)
-- ---------------------------------------------------------------------
-- Friends' Guess Who (no group): the same rule as before (private.can_see_mystery).
-- Group Guess Who: the poster, or someone on the list who is still in the group, while it hasn't ended, with no
-- block (either way) with anyone on the list, and with at least 2 names to pick from.
create or replace function private.mystery_visible(grp uuid, candidates uuid[], poster uuid, expires timestamptz, viewer uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(case
    when grp is null then private.can_see_mystery(poster, expires, viewer)
    else poster = viewer or (
      expires > now()
      and viewer = any(candidates)
      and private.is_group_member(grp, viewer)
      and not exists (
        select 1 from public.blocks b
         where (b.blocker_id = viewer and b.blocked_id = any(candidates))
            or (b.blocked_id = viewer and b.blocker_id = any(candidates))
      )
      and (select count(*) from public.profiles p where p.id = any(candidates) and p.id <> viewer) >= 2
    )
  end, false);
$$;

-- The names someone picks from for a group Guess Who: everyone on the list who still has an account, except
-- yourself, in a mixed-up order that is the same every time (and the same for everyone).
create or replace function private.group_mystery_options(post uuid, viewer uuid)
returns uuid[] language sql stable security definer set search_path = '' as $$
  select array(
    select c.person
      from public.mystery_posts g
      cross join lateral unnest(g.group_candidates) as c(person)
     where g.id = post
       and c.person is distinct from viewer
       and exists (select 1 from public.profiles p where p.id = c.person)
     order by md5(g.id::text || ':' || c.person::text)
  );
$$;

-- ---------------------------------------------------------------------
-- 3. The Guess Who page (friends' Guess Whos) never shows group ones
-- ---------------------------------------------------------------------
-- Same as 20261106000000_guess_who.sql, plus "g.group_id is null" (group Guess Whos only show in their group
-- chat – this also keeps them out of older apps' Guess Who page and its count), using the one rule above.
-- It also looks only at the last 24 hours ("created_at"), so it skips old Guess Whos straight away. That gives
-- the same answer: every Guess Who ends exactly 24 hours after it was posted (private.set_story_expiry).
create or replace function public.mystery_feed()
returns table (
  id uuid,
  media_path text,
  media_type text,
  poster_path text,
  overlay_path text,
  caption text,
  created_at timestamptz,
  expires_at timestamptz,
  mine boolean,
  options uuid[],
  my_guess uuid,
  poster uuid,
  guess_count integer,
  right_count integer
)
language sql stable security definer set search_path = '' as $$
  with me as (select auth.uid() as id),
  my_friends as (
    select case when f.requester_id = me.id then f.addressee_id else f.requester_id end as friend
      from public.friendships f, me
     where f.status = 'accepted' and me.id in (f.requester_id, f.addressee_id)
  )
  select
    g.id, g.media_path, g.media_type, g.poster_path, g.overlay_path, g.caption, g.created_at, g.expires_at,
    g.user_id = me.id,
    case when g.user_id = me.id then null else array(
      -- the real poster plus 3 of your other friends (always the same 3 for this post), in a mixed-up order
      select o.person from (
        select g.user_id as person
        union all
        (select mf.friend from my_friends mf
          where mf.friend <> g.user_id and not private.is_blocked(mf.friend, me.id)
          order by md5(g.id::text || mf.friend::text)
          limit 3)
      ) o
      order by md5(g.id::text || ':' || o.person::text)
    ) end,
    mg.guess,
    case when g.user_id = me.id or mg.post_id is not null then g.user_id end,
    case when g.user_id = me.id then (select count(*)::int from public.mystery_guesses x where x.post_id = g.id) end,
    case when g.user_id = me.id then (select count(*)::int from public.mystery_guesses x where x.post_id = g.id and x.correct) end
  from public.mystery_posts g
  cross join me
  left join public.mystery_guesses mg on mg.post_id = g.id and mg.user_id = me.id
  where g.expires_at > now()
    and g.created_at > now() - interval '24 hours'
    and g.group_id is null
    and private.mystery_visible(g.group_id, g.group_candidates, g.user_id, g.expires_at, me.id)
  order by g.created_at desc
  limit 50;
$$;
revoke execute on function public.mystery_feed() from public, anon;
grant execute on function public.mystery_feed() to authenticated;

-- ---------------------------------------------------------------------
-- 4. A group chat's Guess Whos (for the group chat screen)
-- ---------------------------------------------------------------------
-- Newest first. For each one:
-- * someone else's: the names to pick from, your guess, and – only once you've guessed – who it really was and
--   how many guessed / got it right;
-- * your own: how many guessed, and how many got it right.
-- others_count: how many people can guess it (everyone on the list who still has an account, minus the poster).
-- Not in the group: nothing.
-- (Only the last 24 hours are looked at, so ended Guess Whos are skipped straight away – the same answer, as
-- every Guess Who ends exactly 24 hours after it was posted.)
create or replace function public.group_mystery_feed(grp uuid)
returns table (
  id uuid,
  media_path text,
  media_type text,
  poster_path text,
  overlay_path text,
  caption text,
  created_at timestamptz,
  expires_at timestamptz,
  mine boolean,
  options uuid[],
  my_guess uuid,
  poster uuid,
  guess_count integer,
  right_count integer,
  others_count integer
)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'Please log in again';
  end if;
  if not private.is_group_member(grp, me) then
    return;
  end if;
  return query
  select
    g.id, g.media_path, g.media_type, g.poster_path, g.overlay_path, g.caption, g.created_at, g.expires_at,
    g.user_id = me,
    case when g.user_id = me then null else private.group_mystery_options(g.id, me) end,
    mg.guess,
    case when g.user_id = me or mg.post_id is not null then g.user_id end,
    case when g.user_id = me or mg.post_id is not null
      then (select count(*)::int from public.mystery_guesses x where x.post_id = g.id) end,
    case when g.user_id = me or mg.post_id is not null
      then (select count(*)::int from public.mystery_guesses x where x.post_id = g.id and x.correct) end,
    (select count(*)::int from public.profiles p where p.id = any(g.group_candidates)) - 1
  from public.mystery_posts g
  left join public.mystery_guesses mg on mg.post_id = g.id and mg.user_id = me
  where g.group_id = grp
    and g.expires_at > now()
    and g.created_at > now() - interval '24 hours'
    and private.mystery_visible(g.group_id, g.group_candidates, g.user_id, g.expires_at, me)
  order by g.created_at desc
  limit 50;
end;
$$;
revoke execute on function public.group_mystery_feed(uuid) from public, anon;
grant execute on function public.group_mystery_feed(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Guessing, reporting, blocking and hints follow the same rule
-- ---------------------------------------------------------------------
-- Same as 20261106000000_guess_who.sql, plus: the one rule above, and for a group Guess Who the guess must be
-- one of your names to pick from.
create or replace function public.guess_mystery(post uuid, guess uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  real_poster uuid;
  expires timestamptz;
  grp uuid;
  candidates uuid[];
begin
  select g.user_id, g.expires_at, g.group_id, g.group_candidates into real_poster, expires, grp, candidates
    from public.mystery_posts g where g.id = post;
  if real_poster is null or not private.mystery_visible(grp, candidates, real_poster, expires, me) then
    raise exception 'This Guess Who is gone';
  end if;
  if real_poster = me then
    raise exception 'That one''s yours 😄';
  end if;
  if grp is not null and (guess is null or not (guess = any(private.group_mystery_options(post, me)))) then
    raise exception 'Pick someone from the group';
  end if;
  insert into public.mystery_guesses (post_id, user_id, guess, correct)
  values (post, me, guess, guess = real_poster)
  on conflict (post_id, user_id) do nothing;
  return real_poster;
end;
$$;
revoke execute on function public.guess_mystery(uuid, uuid) from public, anon;
grant execute on function public.guess_mystery(uuid, uuid) to authenticated;

-- Same as 20261213102659_qa_round2_security_hardening.sql, plus the one rule above (a Guess Who that has ended
-- can still be reported by someone who could see it).
create or replace function public.report_mystery(post uuid, reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  real_poster uuid;
begin
  select g.user_id into real_poster from public.mystery_posts g
    where g.id=post and private.mystery_visible(g.group_id,g.group_candidates,g.user_id,now()+interval '1 second',me);
  if real_poster is null then raise exception 'This Guess Who is gone'; end if;
  insert into public.reports (reporter_id,reported_user_id,content_type,content_id,reason,details,anonymous_content)
    values (me,real_poster,'post',post,left(reason,100),'Guess Who (anonymous) post',true);
end;
$$;
revoke execute on function public.report_mystery(uuid, text) from public, anon;
grant execute on function public.report_mystery(uuid, text) to authenticated;

-- Same as 20261106000000_guess_who.sql, plus the one rule above, and for a group Guess Who only once you've
-- guessed (before that, blocking would tell you who posted it).
create or replace function public.block_mystery_poster(post uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  real_poster uuid;
  grp uuid;
begin
  select g.user_id, g.group_id into real_poster, grp from public.mystery_posts g
   where g.id = post and private.mystery_visible(g.group_id, g.group_candidates, g.user_id, now() + interval '1 second', auth.uid());
  if real_poster is null then
    raise exception 'This Guess Who is gone';
  end if;
  if grp is not null and not exists (
    select 1 from public.mystery_guesses x where x.post_id = post and x.user_id = auth.uid()
  ) then
    raise exception 'Make your guess first, then you can block them';
  end if;
  perform public.block_user(real_poster);
end;
$$;
revoke execute on function public.block_mystery_poster(uuid) from public, anon;
grant execute on function public.block_mystery_poster(uuid) to authenticated;

-- Same as 20261218000000_plus_extras.sql, plus: a group Guess Who uses the group's names
-- (private.group_mystery_options). Only public.mystery_hint uses this, and it gives no hints for group ones.
create or replace function private.mystery_options(post uuid, viewer uuid)
returns uuid[] language sql stable security definer set search_path = '' as $$
  with g as (select m.id, m.user_id from public.mystery_posts m where m.id = post),
  my_friends as (
    select case when f.requester_id = viewer then f.addressee_id else f.requester_id end as friend
      from public.friendships f
     where f.status = 'accepted' and viewer in (f.requester_id, f.addressee_id)
  )
  select case
    when exists (select 1 from public.mystery_posts m where m.id = post and m.group_id is not null)
      then private.group_mystery_options(post, viewer)
    else array(
    select o.person from (
      select g.user_id as person from g
      union all
      (select mf.friend from my_friends mf, g
        where mf.friend <> g.user_id and not private.is_blocked(mf.friend, viewer)
        order by md5(g.id::text || mf.friend::text)
        limit 3)
    ) o, g
    order by md5(g.id::text || ':' || o.person::text)
  ) end;
$$;
revoke all on function private.mystery_options(uuid, uuid) from public, anon, authenticated;

-- Same as 20261218000000_plus_extras.sql, plus the one rule above, and no hints for group Guess Whos (people in
-- the group could put their hints together to work out who it was).
create or replace function public.mystery_hint(post uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  real_poster uuid;
  expires timestamptz;
  grp uuid;
  candidates uuid[];
  my_joined timestamptz;
  picked text;
begin
  if me is null then
    raise exception 'Please log in again';
  end if;
  if not private.is_plus(me) then
    raise exception 'Hints are part of Peekaboo+ ⭐';
  end if;
  select g.user_id, g.expires_at, g.group_id, g.group_candidates into real_poster, expires, grp, candidates
    from public.mystery_posts g where g.id = post;
  if real_poster is null or not private.mystery_visible(grp, candidates, real_poster, expires, me) then
    raise exception 'This Guess Who is gone';
  end if;
  if real_poster = me then
    raise exception 'That one''s yours 😄';
  end if;
  if grp is not null then
    raise exception 'No hint for this one, sorry 🙈';
  end if;
  select h.hint into picked from public.mystery_hints h where h.post_id = post and h.user_id = me;
  if picked is not null then
    return picked;
  end if;
  if exists (select 1 from public.mystery_guesses x where x.post_id = post and x.user_id = me) then
    raise exception 'You already guessed this one';
  end if;

  select p.created_at into my_joined from public.profiles p where p.id = me;
  with opts as (
    select distinct unnest(private.mystery_options(post, me)) as person
  ),
  facts as (
    select o.person,
           upper(substring(coalesce(nullif(p.display_name, ''), p.username) from '[[:alnum:]]')) as letter,
           to_char(p.created_at at time zone 'utc', 'FMMonth') as joined_month,
           char_length(p.username) as name_length,
           p.created_at < my_joined as joined_before_me
      from opts o join public.profiles p on p.id = o.person
  ),
  poster as (select * from facts f where f.person = real_poster),
  hints as (
    select 'Their name starts with ' || pf.letter as hint,
           (select count(*) from facts f where f.letter = pf.letter) as shared
      from poster pf where pf.letter is not null
    union all
    select 'They joined Peekaboo in ' || pf.joined_month,
           (select count(*) from facts f where f.joined_month = pf.joined_month)
      from poster pf
    union all
    select 'Their @username is ' || pf.name_length || ' characters long',
           (select count(*) from facts f where f.name_length = pf.name_length)
      from poster pf
    union all
    select case when pf.joined_before_me then 'They joined Peekaboo before you' else 'They joined Peekaboo after you' end,
           (select count(*) from facts f where f.joined_before_me is not distinct from pf.joined_before_me)
      from poster pf
  )
  select h.hint into picked from hints h
   order by (h.shared >= 2) desc, md5(post::text || me::text || h.hint)
   limit 1;
  if picked is null then
    raise exception 'No hint for this one, sorry 🙈';
  end if;

  insert into public.mystery_hints (post_id, user_id, hint) values (post, me, picked)
  on conflict (post_id, user_id) do nothing;
  select h.hint into picked from public.mystery_hints h where h.post_id = post and h.user_id = me;
  return picked;
end;
$$;
revoke execute on function public.mystery_hint(uuid) from public, anon;
grant execute on function public.mystery_hint(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 6. The photo file: only people who can see the Guess Who can open it
-- ---------------------------------------------------------------------
-- Same as 20261213102659_qa_round2_security_hardening.sql, except the "mystery" part uses the one rule above.
create or replace function private.can_read_media(object_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  owner_text text := split_part(object_name, '/', 1);
  kind text := split_part(object_name, '/', 2);
  owner uuid;
begin
  if me is null then return false; end if;
  if owner_text = 'mystery' then
    return private.uploaded_by_me(object_name) or exists (
      select 1 from public.mystery_posts g
      where object_name in (g.media_path, g.poster_path, g.overlay_path)
        and private.mystery_visible(g.group_id, g.group_candidates, g.user_id, g.expires_at, me)
    );
  end if;
  if owner_text = me::text then return true; end if;
  if owner_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  owner := owner_text::uuid;
  if kind = 'posts' then
    return private.can_see_posts(owner)
      and exists (
        select 1 from public.posts p
        where p.user_id = owner and object_name in (p.media_path,p.poster_path,p.overlay_path)
          and private.in_audience(p.user_id,p.audience)
      )
      and not exists (
        select 1 from public.posts p
        where p.user_id = owner and object_name in (p.media_path,p.poster_path,p.overlay_path)
          and (
            not private.in_audience(p.user_id,p.audience)
            or (p.drop_day is not null and (
              not exists (select 1 from public.posts mine where mine.user_id=me and mine.drop_day=p.drop_day)
              or private.group_holds_drop(me,p.user_id,p.drop_day)
            ))
          )
      );
  elsif kind = 'blurs' then
    return private.can_see_posts(owner) and exists (
      select 1 from public.posts p where p.user_id=owner and p.blur_path=object_name
        and private.in_audience(p.user_id,p.audience)
    );
  elsif kind = 'stories' then
    return private.can_see_stories(owner) and exists (
      select 1 from public.stories s where s.user_id=owner
        and object_name in (s.media_path,s.poster_path,s.overlay_path)
        and s.expires_at>now() and private.in_audience(s.user_id,s.audience)
    );
  elsif kind = 'snaps' then
    return not private.is_blocked(owner,me) and exists (
      select 1 from public.messages m where m.sender_id=owner
        and object_name in (m.media_path,m.poster_path,m.overlay_path) and m.recipient_id=me
        and (m.opened_at is null or m.saved_at is not null
          or (m.replayed_at is null and m.opened_at>now()-interval '24 hours'))
    );
  elsif kind = 'voice' then
    return not private.is_blocked(owner,me) and (
      exists (select 1 from public.messages m where m.sender_id=owner
        and m.media_path=object_name and m.recipient_id=me)
      or exists (select 1 from public.group_messages g where g.sender_id=owner
        and g.media_path=object_name and private.is_group_member(g.group_id,me))
    );
  elsif kind = 'group' then
    return not private.is_blocked(owner,me) and exists (
      select 1 from public.group_messages g where g.sender_id=owner
        and object_name in(g.media_path,g.poster_path,g.overlay_path)
        and private.is_group_member(g.group_id,me)
    );
  end if;
  return false;
end;
$$;

-- ---------------------------------------------------------------------
-- 7. Reports made any other way follow the same rule
-- ---------------------------------------------------------------------
-- Same as 20261214100000_qa_final_db_fixes.sql, except the Guess Who part uses the one rule above.
create or replace function private.prepare_report()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  author uuid;
  visible boolean := false;
begin
  new.status := 'open';
  new.created_at := now();
  -- Reporting a person (profile or hit up): the person is the content.
  if new.content_type = 'user' then
    new.content_id := coalesce(new.content_id, new.reported_user_id);
    new.reported_user_id := new.content_id;
    if new.content_id is null then raise exception 'Pick who you want to report'; end if;
    return new;
  end if;
  if new.content_type = 'dare_idea' then
    -- Same rule as the "Ideas are public unless hidden" privacy rule: you can
    -- see an idea that is not hidden, and your own ideas.
    select d.user_id, (me is null or not d.hidden or d.user_id = me) into author, visible
      from public.dare_ideas d where d.id = new.content_id;
    if me is not null and (author is null or not coalesce(visible, false)) then
      raise exception 'This can''t be reported - it is gone or you can''t see it';
    end if;
    if author is null then raise exception 'That idea is gone'; end if;
    new.reported_user_id := author;
    return new;
  end if;

  if new.content_type = 'post' then
    select p.user_id, (me is null or private.can_see_post(p.id)) into author, visible
      from public.posts p where p.id = new.content_id;
    if author is null then
      -- A Guess Who post: the poster stays hidden from the reporter.
      select g.user_id, (me is null or private.mystery_visible(g.group_id, g.group_candidates, g.user_id, now() + interval '1 second', me)) into author, visible
        from public.mystery_posts g where g.id = new.content_id;
      if author is not null then new.anonymous_content := true; end if;
    end if;
  elsif new.content_type = 'story' then
    -- Expired stories can still be reported by someone who could see them.
    select s.user_id, (me is null or (private.can_see_stories(s.user_id) and private.in_audience(s.user_id, s.audience))) into author, visible
      from public.stories s where s.id = new.content_id;
  elsif new.content_type = 'message' then
    select m.sender_id, (me is null or me in (m.sender_id, m.recipient_id)) into author, visible
      from public.messages m where m.id = new.content_id;
  elsif new.content_type = 'comment' then
    select c.user_id, (me is null or private.can_see_post(c.post_id)) into author, visible
      from public.comments c where c.id = new.content_id;
  elsif new.content_type = 'group_message' then
    select g.sender_id, private.is_group_member(g.group_id, new.reporter_id) into author, visible
      from public.group_messages g where g.id = new.content_id;
    if author is null or not coalesce(visible, false) then raise exception 'That message is gone'; end if;
  end if;

  if author is null then
    if me is null then return new; end if;
    raise exception 'This can''t be reported - it is gone or you can''t see it';
  end if;
  if not coalesce(visible, false) then
    raise exception 'This can''t be reported - it is gone or you can''t see it';
  end if;
  new.reported_user_id := author;
  -- Hold the files so a delete by their owner waits until this report is saved.
  perform private.lock_media_paths(array(
    select p from private.report_evidence_paths(new.content_type, new.content_id, new.reporter_id) p), false);
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 8. Live updates without a name: one row per group, with only a time in it
-- ---------------------------------------------------------------------
create table if not exists public.group_guess_pings (
  group_id uuid primary key references public.peek_groups (id) on delete cascade,
  changed_at timestamptz not null default now()
);
alter table public.group_guess_pings enable row level security;
drop policy if exists "Members can see their group's Guess Who updates" on public.group_guess_pings;
create policy "Members can see their group's Guess Who updates"
  on public.group_guess_pings for select to authenticated
  using (private.is_group_member(group_id, (select auth.uid())));
-- (Only the server writes it.)
revoke all on table public.group_guess_pings from anon;
revoke insert, update, delete, truncate, references, trigger on table public.group_guess_pings from authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'group_guess_pings'
  ) then
    alter publication supabase_realtime add table public.group_guess_pings;
  end if;
end $$;

-- "Something changed in this group's Guess Whos." (Skipped when the group itself is being deleted.)
create or replace function private.ping_group_guess(grp uuid)
returns void language sql security definer set search_path = '' as $$
  insert into public.group_guess_pings (group_id, changed_at)
  select grp, now() where exists (select 1 from public.peek_groups g where g.id = grp)
  on conflict (group_id) do update set changed_at = excluded.changed_at;
$$;

-- Only when a group Guess Who is posted or deleted (not when someone guesses).
create or replace function private.ping_group_mystery()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.group_id is not null then perform private.ping_group_guess(new.group_id); end if;
  elsif old.group_id is not null then
    perform private.ping_group_guess(old.group_id);
  end if;
  return null;
end;
$$;
drop trigger if exists mystery_posts_group_ping on public.mystery_posts;
create trigger mystery_posts_group_ping
  after insert or delete on public.mystery_posts
  for each row execute function private.ping_group_mystery();

-- ---------------------------------------------------------------------
-- 9. The push: never a name
-- ---------------------------------------------------------------------
-- Everyone who can see it (the rule above), except the poster and people who muted the group chat. The title is
-- the same as every group chat push (20261211000000_group_chat_more.sql, private.push_group_message).
create or replace function private.push_group_mystery()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  member record;
  group_name text;
begin
  select g.name into group_name from public.peek_groups g where g.id = new.group_id;
  for member in
    select m.user_id from public.peek_group_members m
     where m.group_id = new.group_id and m.user_id <> new.user_id and not m.chat_muted
       and private.mystery_visible(new.group_id, new.group_candidates, new.user_id, new.expires_at, m.user_id)
     order by m.user_id
  loop
    perform private.send_push(member.user_id, 'messages', '👯 ' || coalesce(group_name, 'Group'),
      '🕵️ Someone posted a Guess Who – who was it?',
      jsonb_build_object('type', 'group_chat', 'group', new.group_id));
  end loop;
  return null;
end;
$$;
drop trigger if exists mystery_posts_group_push on public.mystery_posts;
create trigger mystery_posts_group_push
  after insert on public.mystery_posts
  for each row when (new.group_id is not null) execute function private.push_group_mystery();

-- ---------------------------------------------------------------------
-- 10. Deleted with its group (or with the poster's account): the photo goes to the daily cleanup
-- ---------------------------------------------------------------------
-- The same as when the poster deletes the file in the app (private.guard_claimed_media_delete): the file is
-- remembered for the daily cleanup and looks deleted from now on. A file a report still needs is kept for the
-- report (private.media_cleanup_eligible says no). A file another Guess Who still uses is left alone.
create or replace function private.queue_group_mystery_files()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  path_value text;
begin
  for path_value in
    select distinct p from unnest(array[old.media_path, old.poster_path, old.overlay_path]) p
     where p is not null order by p
  loop
    if exists (select 1 from storage.objects o where o.bucket_id = 'media' and o.name = path_value)
       and not private.media_path_in_use(path_value, 1) then
      insert into private.media_cleanup_claims(object_name, reason) values (path_value, 'client')
        on conflict (object_name) do nothing;
      insert into private.media_deferred_deletions(object_name) values (path_value)
        on conflict (object_name) do nothing;
    end if;
  end loop;
  return null;
end;
$$;
drop trigger if exists mystery_posts_group_files on public.mystery_posts;
create trigger mystery_posts_group_files
  after delete on public.mystery_posts
  for each row when (old.group_id is not null) execute function private.queue_group_mystery_files();

-- ---------------------------------------------------------------------
-- 11. The Chat list: the Guess Who line (no sender) and unread Guess Whos
-- ---------------------------------------------------------------------
-- Same as 20261213102659_qa_round2_security_hardening.sql, plus group Guess Whos you can see:
-- * unread: also every one you can see that hasn't ended, isn't yours and you haven't guessed yet;
-- * if the newest thing in the chat is a group Guess Who you can see (that hasn't ended), the line is
--   "🕵️ Guess Who – who sent it?", its time, and no sender.
-- Same columns as before (older apps call it too, and already handle an empty last_sender).
-- (Only the last 24 hours of Guess Whos are looked at, so a group's old ones are skipped straight away.)
create or replace function public.my_group_chats()
returns table(group_id uuid,unread integer,last_body text,last_at timestamptz,last_sender uuid,muted boolean)
language sql stable security definer set search_path='' as $$
  select m.group_id,
    (select count(*)::int from public.group_messages g where g.group_id=m.group_id
      and g.created_at>m.chat_read_at and g.sender_id<>m.user_id and not private.is_blocked(g.sender_id,m.user_id))
    + (select count(*)::int from public.mystery_posts q where q.group_id=m.group_id
      and q.expires_at>now() and q.created_at>now()-interval '24 hours' and q.user_id<>m.user_id
      and not exists(select 1 from public.mystery_guesses x where x.post_id=q.id and x.user_id=m.user_id)
      and private.mystery_visible(q.group_id,q.group_candidates,q.user_id,q.expires_at,m.user_id)),
    case when newest_guess.created_at is not null and (last.created_at is null or newest_guess.created_at>last.created_at)
      then '🕵️ Guess Who – who sent it?' else private.group_message_preview(last.kind,last.body) end,
    case when newest_guess.created_at is not null and (last.created_at is null or newest_guess.created_at>last.created_at)
      then newest_guess.created_at else last.created_at end,
    case when newest_guess.created_at is not null and (last.created_at is null or newest_guess.created_at>last.created_at)
      then null else last.sender_id end,
    m.chat_muted
  from public.peek_group_members m
  left join lateral(select g.kind,g.body,g.created_at,g.sender_id from public.group_messages g
    where g.group_id=m.group_id and not private.is_blocked(g.sender_id,m.user_id)
    order by g.created_at desc limit 1) last on true
  left join lateral(select q.created_at from public.mystery_posts q
    where q.group_id=m.group_id and q.expires_at>now() and q.created_at>now()-interval '24 hours'
      and private.mystery_visible(q.group_id,q.group_candidates,q.user_id,q.expires_at,m.user_id)
    order by q.created_at desc limit 1) newest_guess on true
  where m.user_id=auth.uid();
$$;
revoke execute on function public.my_group_chats() from public, anon;
grant execute on function public.my_group_chats() to authenticated;

-- ---------------------------------------------------------------------
-- 12. Read times ("Seen") only move up to the newest group message
-- ---------------------------------------------------------------------
-- Same as 20261210000000_group_chat.sql, except the read time becomes the time of the newest message in the
-- group (never earlier than before), not the moment the chat was opened. "Seen by" still works (it compares
-- read times with message times), but a read time no longer shows WHEN someone opened the chat.
create or replace function public.mark_group_chat_read(grp uuid)
returns void language sql security definer set search_path = '' as $$
  update public.peek_group_members m
     set chat_read_at = greatest(m.chat_read_at, coalesce(
       (select max(g.created_at) from public.group_messages g where g.group_id = grp), m.chat_read_at))
   where m.group_id = grp and m.user_id = auth.uid();
$$;
revoke execute on function public.mark_group_chat_read(uuid) from public, anon;
grant execute on function public.mark_group_chat_read(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 13. App users never call these helpers themselves (the functions above still use them)
-- ---------------------------------------------------------------------
revoke execute on function private.mystery_visible(uuid, uuid[], uuid, timestamptz, uuid) from public, anon, authenticated;
revoke execute on function private.group_mystery_options(uuid, uuid) from public, anon, authenticated;
revoke execute on function private.prepare_group_mystery() from public, anon, authenticated;
revoke execute on function private.ping_group_guess(uuid) from public, anon, authenticated;
revoke execute on function private.ping_group_mystery() from public, anon, authenticated;
revoke execute on function private.push_group_mystery() from public, anon, authenticated;
revoke execute on function private.queue_group_mystery_files() from public, anon, authenticated;
revoke execute on function private.prepare_report() from public, anon, authenticated;

commit;
