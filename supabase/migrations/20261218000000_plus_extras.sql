-- =====================================================================
-- Peekaboo+ ⭐ extras
--
-- 1. 🙈 Peek-a-Save: when a dare streak with a friend breaks, a Plus member can bring it back within 24 hours.
--    One Peek-a-Save per calendar month (UTC). An unused one does not carry over to the next month.
--    Works for both kinds of dare streak:
--    * daily dare streaks (you both do the daily dare, day after day – public.dare_streaks), and
--    * chat dare streaks (dares you send each other in chat, no gap over 3 days – private.dare_streak).
--    The friend gets a push: "🙈 Ray used Peek-a-Save on your streak!".
-- 2. ⏰ Drop rewind: once a week (Monday to Sunday, UTC) a Plus member can post a late daily drop without the
--    "late" label. The app asks for it with posts.drop_rewound = true; the database checks Plus and the
--    weekly allowance itself, and quietly posts it as late when the rewind isn't allowed.
-- 3. 🕵️ Guess Who hint: a Plus member can ask for one clue per Guess Who post ("Their name starts with R",
--    "They joined Peekaboo in March"…). The clue never says who it is: no id and no full name.
--
-- Everything is checked here on the server (private.is_plus from 20261215000000_peekaboo_plus.sql), so
-- changing the app can't unlock it. Safe to run twice.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. 🙈 Peek-a-Save
-- ---------------------------------------------------------------------

-- Every Peek-a-Save that was used. Only the functions below add rows.
create table if not exists public.peek_a_saves (
  id uuid primary key default gen_random_uuid(),
  -- who used their Peek-a-Save, and the friend whose streak it was
  user_id uuid not null references public.profiles (id) on delete cascade,
  friend_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('daily_dare', 'chat_dare')),
  -- daily dare streaks: the missed dare day that now counts as done by both of you
  saved_day date,
  -- chat dare streaks: the moment the streak was picked back up
  saved_at timestamptz not null default now(),
  -- the first day of the month this Peek-a-Save belongs to (one per month)
  used_month date not null,
  -- how long the streak was when it was saved
  streak integer not null check (streak > 0),
  created_at timestamptz not null default now(),
  constraint peek_a_saves_day_for_daily check ((kind = 'daily_dare') = (saved_day is not null)),
  constraint peek_a_saves_not_self check (user_id <> friend_id)
);
-- One per person per month (this also stops two phones using it at the same moment).
create unique index if not exists peek_a_saves_one_per_month on public.peek_a_saves (user_id, used_month);
-- A missed day can only be saved once for two friends.
create unique index if not exists peek_a_saves_one_per_day
  on public.peek_a_saves (least(user_id, friend_id), greatest(user_id, friend_id), saved_day)
  where kind = 'daily_dare';
create index if not exists peek_a_saves_friend_idx on public.peek_a_saves (friend_id);

alter table public.peek_a_saves enable row level security;
drop policy if exists "You can see Peek-a-Saves on your streaks" on public.peek_a_saves;
create policy "You can see Peek-a-Saves on your streaks"
  on public.peek_a_saves for select to authenticated
  using ((select auth.uid()) in (user_id, friend_id));
-- (No insert/update/delete policies: only public.peek_a_save adds rows.)
revoke insert, update, delete, truncate on public.peek_a_saves from anon, authenticated;

-- Daily dare streaks: for each friend, every run of days in a row that you BOTH did the daily dare.
-- A day saved with Peek-a-Save joins the run up but isn't counted as a streak day.
create or replace function private.daily_dare_runs(me uuid)
returns table (run_friend uuid, run_start date, run_end date, run_days integer)
language sql stable security definer set search_path = '' as $$
  with friends as (
    select case when f.requester_id = me then f.addressee_id else f.requester_id end as fid
      from public.friendships f
     where f.status = 'accepted' and me in (f.requester_id, f.addressee_id)
  ),
  mine as (
    select distinct p.dare_day as d from public.posts p
     where p.user_id = me and p.dare_day is not null
  ),
  theirs as (
    select distinct p.user_id as uid, p.dare_day as d from public.posts p
     where p.dare_day is not null and p.user_id in (select fid from friends)
  ),
  saved as (
    select case when s.user_id = me then s.friend_id else s.user_id end as uid, s.saved_day as d
      from public.peek_a_saves s
     where s.kind = 'daily_dare' and me in (s.user_id, s.friend_id)
  ),
  days as (
    select x.uid, x.d, bool_and(x.saved) as saved from (
      select t.uid, t.d, false as saved from theirs t join mine m on m.d = t.d
      union all
      select s.uid, s.d, true from saved s where s.uid in (select fid from friends)
    ) x
    group by x.uid, x.d
  ),
  grouped as (
    select d.uid, d.d, d.saved, d.d - (row_number() over (partition by d.uid order by d.d))::int as run from days d
  )
  select g.uid, min(g.d), max(g.d), (count(*) filter (where not g.saved))::int
    from grouped g
   group by g.uid, g.run;
$$;
revoke all on function private.daily_dare_runs(uuid) from public, anon, authenticated;

-- Same as before (20261119000000_dare_streaks.sql), but a day saved with Peek-a-Save keeps the streak going.
create or replace function public.dare_streaks()
returns table (friend_id uuid, streak integer, me_today boolean, them_today boolean)
language sql stable security definer set search_path = '' as $$
  with me as (select auth.uid() as id),
  today as (select private.current_dare_day() as d),
  friends as (
    select case when f.requester_id = (select id from me) then f.addressee_id else f.requester_id end as fid
      from public.friendships f
     where f.status = 'accepted'
       and ((select id from me) in (f.requester_id, f.addressee_id))
  ),
  runs as (select * from private.daily_dare_runs((select id from me))),
  mine_today as (
    select exists (
      select 1 from public.posts p where p.user_id = (select id from me) and p.dare_day = (select d from today)
    ) as done
  )
  select fr.fid,
         coalesce((select r.run_days from runs r
                    where r.run_friend = fr.fid and r.run_end >= (select d from today) - 1
                    order by r.run_end desc limit 1), 0),
         (select done from mine_today),
         exists (select 1 from public.posts p where p.user_id = fr.fid and p.dare_day = (select d from today))
    from friends fr;
$$;
revoke execute on function public.dare_streaks() from public, anon;
grant execute on function public.dare_streaks() to authenticated;

-- Chat dare streaks, counted back from a moment (`since`): dares the two of you completed, with no gap over
-- 3 days. A Peek-a-Save bridges the gap just before it and isn't counted as a dare.
create or replace function private.dare_streak_since(a uuid, b uuid, since timestamptz)
returns int language plpgsql stable security definer set search_path = '' as $$
declare
  streak int := 0;
  previous timestamptz := since;
  bridged boolean := false;
  d record;
begin
  for d in
    select x.at, x.saved from (
      select m.dare_done_at as at, false as saved from public.messages m
       where m.kind = 'dare' and m.dare_state = 'done' and m.dare_done_at <= since
         and ((m.sender_id = a and m.recipient_id = b) or (m.sender_id = b and m.recipient_id = a))
      union all
      select s.saved_at, true from public.peek_a_saves s
       where s.kind = 'chat_dare' and s.saved_at <= since
         and ((s.user_id = a and s.friend_id = b) or (s.user_id = b and s.friend_id = a))
    ) x
    order by x.at desc, x.saved
  loop
    exit when not bridged and previous - d.at > interval '3 days';
    if d.saved then
      bridged := true;
    else
      streak := streak + 1;
      bridged := false;
    end if;
    previous := d.at;
  end loop;
  return streak;
end;
$$;
revoke all on function private.dare_streak_since(uuid, uuid, timestamptz) from public, anon, authenticated;

-- The chat dare streak right now (used by chat_dare_streak and confirm_chat_dare). Now knows Peek-a-Saves.
create or replace function private.dare_streak(a uuid, b uuid)
returns int language sql stable security definer set search_path = '' as $$
  select private.dare_streak_since(a, b, now());
$$;
revoke all on function private.dare_streak(uuid, uuid) from public, anon, authenticated;

-- The last completed dare (or Peek-a-Save) between two people in chat.
create or replace function private.chat_streak_last(a uuid, b uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select max(x.at) from (
    select m.dare_done_at as at from public.messages m
     where m.kind = 'dare' and m.dare_state = 'done'
       and ((m.sender_id = a and m.recipient_id = b) or (m.sender_id = b and m.recipient_id = a))
    union all
    select s.saved_at from public.peek_a_saves s
     where s.kind = 'chat_dare'
       and ((s.user_id = a and s.friend_id = b) or (s.user_id = b and s.friend_id = a))
  ) x;
$$;
revoke all on function private.chat_streak_last(uuid, uuid) from public, anon, authenticated;

-- Your streaks that broke in the last 24 hours and can still be saved (2 or more days/dares long).
-- * daily dare: the streak ended the day before yesterday (dare days roll over at 10:00 UTC), so it broke
--   when today's dare day started; it can be saved until the next dare day starts.
-- * chat dare: the last completed dare was 3 to 4 days ago.
create or replace function public.my_broken_streaks()
returns table (kind text, friend_id uuid, streak integer, broke_at timestamptz, save_until timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  today date := private.current_dare_day();
  day_started timestamptz := (today + time '10:00') at time zone 'utc';
begin
  if me is null then
    return;
  end if;
  return query
    select 'daily_dare'::text, r.run_friend, r.run_days, day_started, day_started + interval '24 hours'
      from private.daily_dare_runs(me) r
     where r.run_end = today - 2 and r.run_days >= 2
       and not private.is_blocked(me, r.run_friend);

  return query
    with recent as (
      select distinct case when m.sender_id = me then m.recipient_id else m.sender_id end as fid
        from public.messages m
       where m.kind = 'dare' and m.dare_state = 'done'
         and m.dare_done_at > now() - interval '4 days' and m.dare_done_at <= now() - interval '3 days'
         and me in (m.sender_id, m.recipient_id)
      union
      select case when s.user_id = me then s.friend_id else s.user_id end
        from public.peek_a_saves s
       where s.kind = 'chat_dare' and me in (s.user_id, s.friend_id)
         and s.saved_at > now() - interval '4 days' and s.saved_at <= now() - interval '3 days'
    ),
    lasts as (
      select r.fid, private.chat_streak_last(me, r.fid) as at from recent r
       where private.are_friends(me, r.fid) and not private.is_blocked(me, r.fid)
    ),
    broken as (
      select l.fid, l.at, private.dare_streak_since(me, l.fid, l.at) as n from lasts l
       where now() - l.at > interval '3 days' and now() - l.at <= interval '4 days'
    )
    select 'chat_dare'::text, b.fid, b.n, b.at + interval '3 days', b.at + interval '4 days'
      from broken b
     where b.n >= 2;
end;
$$;
revoke execute on function public.my_broken_streaks() from public, anon;
grant execute on function public.my_broken_streaks() to authenticated;

-- Use your Peek-a-Save on a broken streak with a friend. Returns the streak that's back.
-- Checks: Peekaboo+, a friend, the streak broke less than 24 hours ago, and this month's Peek-a-Save is unused.
create or replace function public.peek_a_save(streak_type text, friend_user uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  month_start date := date_trunc('month', now() at time zone 'utc')::date;
  today date := private.current_dare_day();
  saved integer;
  last_at timestamptz;
begin
  if me is null then
    raise exception 'Please log in again';
  end if;
  if streak_type is null or streak_type not in ('daily_dare', 'chat_dare') then
    raise exception 'That streak doesn''t look right';
  end if;
  if not private.is_plus(me) then
    raise exception 'Peek-a-Save is part of Peekaboo+ ⭐';
  end if;
  if friend_user is null or friend_user = me or not private.are_friends(me, friend_user)
     or private.is_blocked(me, friend_user) then
    raise exception 'You can only save a streak with a friend';
  end if;
  -- One save at a time for these two friends (so you can't both save the same streak at once).
  perform pg_advisory_xact_lock(hashtext('peek_a_save:' || least(me, friend_user)::text || greatest(me, friend_user)::text));
  if exists (select 1 from public.peek_a_saves s where s.user_id = me and s.used_month = month_start) then
    raise exception 'You''ve used this month''s Peek-a-Save. You get a new one on the 1st 🙈';
  end if;

  if streak_type = 'daily_dare' then
    select r.run_days into saved from private.daily_dare_runs(me) r
     where r.run_friend = friend_user and r.run_end = today - 2 and r.run_days >= 2
     order by r.run_days desc limit 1;
    if saved is null then
      raise exception 'This streak can''t be saved any more – Peek-a-Save only works for 24 hours after it breaks';
    end if;
    begin
      insert into public.peek_a_saves (user_id, friend_id, kind, saved_day, used_month, streak)
      values (me, friend_user, 'daily_dare', today - 1, month_start, saved);
    exception when unique_violation then
      raise exception 'You''ve used this month''s Peek-a-Save. You get a new one on the 1st 🙈';
    end;
  else
    last_at := private.chat_streak_last(me, friend_user);
    if last_at is null or now() - last_at <= interval '3 days' or now() - last_at > interval '4 days' then
      raise exception 'This streak can''t be saved any more – Peek-a-Save only works for 24 hours after it breaks';
    end if;
    saved := private.dare_streak_since(me, friend_user, last_at);
    if saved < 2 then
      raise exception 'This streak can''t be saved any more – Peek-a-Save only works for 24 hours after it breaks';
    end if;
    begin
      insert into public.peek_a_saves (user_id, friend_id, kind, saved_at, used_month, streak)
      values (me, friend_user, 'chat_dare', now(), month_start, saved);
    exception when unique_violation then
      raise exception 'You''ve used this month''s Peek-a-Save. You get a new one on the 1st 🙈';
    end;
  end if;

  perform private.send_push(
    friend_user, 'messages',
    '🙈 ' || private.push_name(me) || ' used Peek-a-Save on your streak!',
    case when streak_type = 'daily_dare'
      then 'Your ' || saved || '-day dare streak is back 🔥 Do today''s dare to keep it going.'
      else 'Your ' || saved || ' dare streak is back 🔥 Dare them back to keep it going.'
    end,
    case when streak_type = 'daily_dare'
      then jsonb_build_object('type', 'dare')
      else jsonb_build_object('type', 'message', 'from', me)
    end
  );
  return saved;
end;
$$;
revoke execute on function public.peek_a_save(text, uuid) from public, anon;
grant execute on function public.peek_a_save(text, uuid) to authenticated;


-- ---------------------------------------------------------------------
-- 2. ⏰ Drop rewind
-- ---------------------------------------------------------------------

-- The app asks for a rewind with this. Afterwards it says whether the drop was really rewound.
alter table public.posts add column if not exists drop_rewound boolean not null default false;

-- Every drop rewind that was used (one per person per week). Only the database adds rows.
create table if not exists public.drop_rewinds (
  user_id uuid not null references public.profiles (id) on delete cascade,
  -- the Monday (UTC) of the week it was used in
  week_start date not null,
  -- the drop post (not a link: a deleted post still used up the rewind)
  post_id uuid not null,
  -- how late the drop really was
  late_seconds integer not null,
  created_at timestamptz not null default now(),
  primary key (user_id, week_start)
);
alter table public.drop_rewinds enable row level security;
drop policy if exists "You can see your own drop rewinds" on public.drop_rewinds;
create policy "You can see your own drop rewinds"
  on public.drop_rewinds for select to authenticated
  using (user_id = (select auth.uid()));
revoke insert, update, delete, truncate on public.drop_rewinds from anon, authenticated;

-- Runs after private.set_drop_fields has worked out how late the drop is (triggers run in name order).
-- A late drop with drop_rewound = true is posted as "On time" when you have Plus and this week's rewind is
-- unused. Otherwise it's posted late as normal, and drop_rewound goes back to false. Never changes later.
create or replace function private.apply_drop_rewind()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  week date := date_trunc('week', now() at time zone 'utc')::date;
begin
  if tg_op = 'UPDATE' then
    new.drop_rewound := old.drop_rewound;
    return new;
  end if;
  if not coalesce(new.drop_rewound, false) then
    new.drop_rewound := false;
    return new;
  end if;
  new.drop_rewound := false;
  -- Only a late drop needs a rewind (an on-time drop doesn't use it up).
  if new.drop_day is null or new.drop_late_seconds is null or new.drop_late_seconds <= 120 then
    return new;
  end if;
  if new.user_id is distinct from auth.uid() or not private.is_plus(new.user_id) then
    return new;
  end if;
  insert into public.drop_rewinds (user_id, week_start, post_id, late_seconds)
  values (new.user_id, week, new.id, new.drop_late_seconds)
  on conflict (user_id, week_start) do nothing;
  if not found then
    return new;                                       -- this week's rewind is already used
  end if;
  new.drop_late_seconds := 0;
  new.drop_rewound := true;
  return new;
end;
$$;
revoke all on function private.apply_drop_rewind() from public, anon, authenticated;
drop trigger if exists posts_set_drop_fields_rewind on public.posts;
create trigger posts_set_drop_fields_rewind
  before insert or update on public.posts
  for each row execute function private.apply_drop_rewind();


-- ---------------------------------------------------------------------
-- 3. 🕵️ Guess Who hint
-- ---------------------------------------------------------------------

-- The one hint each person got for a Guess Who post.
create table if not exists public.mystery_hints (
  post_id uuid not null references public.mystery_posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  hint text not null,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
create index if not exists mystery_hints_user_idx on public.mystery_hints (user_id);
alter table public.mystery_hints enable row level security;
drop policy if exists "You can see your own Guess Who hints" on public.mystery_hints;
create policy "You can see your own Guess Who hints"
  on public.mystery_hints for select to authenticated
  using (user_id = (select auth.uid()));
revoke insert, update, delete, truncate on public.mystery_hints from anon, authenticated;

-- The 4 names someone gets to pick from for a Guess Who post. The same rule as in public.mystery_feed
-- (20261106000000_guess_who.sql) – keep them in sync.
create or replace function private.mystery_options(post uuid, viewer uuid)
returns uuid[] language sql stable security definer set search_path = '' as $$
  with g as (select m.id, m.user_id from public.mystery_posts m where m.id = post),
  my_friends as (
    select case when f.requester_id = viewer then f.addressee_id else f.requester_id end as friend
      from public.friendships f
     where f.status = 'accepted' and viewer in (f.requester_id, f.addressee_id)
  )
  select array(
    select o.person from (
      select g.user_id as person from g
      union all
      (select mf.friend from my_friends mf, g
        where mf.friend <> g.user_id and not private.is_blocked(mf.friend, viewer)
        order by md5(g.id::text || mf.friend::text)
        limit 3)
    ) o, g
    order by md5(g.id::text || ':' || o.person::text)
  );
$$;
revoke all on function private.mystery_options(uuid, uuid) from public, anon, authenticated;

-- Get your one hint for a Guess Who post (asking again gives the same hint). Peekaboo+ only.
-- The hint is a small true fact about whoever posted it. When possible it's one that fits at least one of the
-- other names too, so it narrows things down without giving the answer away.
create or replace function public.mystery_hint(post uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  real_poster uuid;
  expires timestamptz;
  my_joined timestamptz;
  picked text;
begin
  if me is null then
    raise exception 'Please log in again';
  end if;
  if not private.is_plus(me) then
    raise exception 'Hints are part of Peekaboo+ ⭐';
  end if;
  select g.user_id, g.expires_at into real_poster, expires from public.mystery_posts g where g.id = post;
  if real_poster is null or not private.can_see_mystery(real_poster, expires, me) then
    raise exception 'This Guess Who is gone';
  end if;
  if real_poster = me then
    raise exception 'That one''s yours 😄';
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
-- What's left this month / this week (for the buttons in the app)
-- ---------------------------------------------------------------------

create or replace function public.plus_allowances()
returns table (plus boolean, saves_left integer, save_resets_at timestamptz, rewinds_left integer, rewind_resets_at timestamptz)
language sql stable security definer set search_path = '' as $$
  with me as (select auth.uid() as id),
  month_start as (select date_trunc('month', now() at time zone 'utc')::date as d),
  week_start as (select date_trunc('week', now() at time zone 'utc')::date as d)
  select
    coalesce(private.is_plus((select id from me)), false),
    case when exists (
      select 1 from public.peek_a_saves s where s.user_id = (select id from me) and s.used_month = (select d from month_start)
    ) then 0 else 1 end,
    ((select d from month_start) + interval '1 month')::timestamp at time zone 'utc',
    case when exists (
      select 1 from public.drop_rewinds r where r.user_id = (select id from me) and r.week_start = (select d from week_start)
    ) then 0 else 1 end,
    ((select d from week_start) + interval '7 days')::timestamp at time zone 'utc'
  where (select id from me) is not null;
$$;
revoke execute on function public.plus_allowances() from public, anon;
grant execute on function public.plus_allowances() to authenticated;
