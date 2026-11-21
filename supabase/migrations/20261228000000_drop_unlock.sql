-- =====================================================================
-- Posting your drop opens EVERY drop (the owner, 21 Nov 2026)
--
-- Before: a friend's drop only opened if you had posted your own drop on that SAME day. So every older drop from
-- a day you skipped stayed "Give a peek to get a peek 🙈" forever, even right after you posted today's drop.
--
-- Now:
-- * Post your drop and every drop you're allowed to see opens – friends' and public accounts' on Home, from any
--   day, old or new. It stays open until the NEXT day's drop goes off (worked out in the time zone you posted
--   from). Then the new day's drops show the 🙈 until you post the new drop (late is fine). Drops from the day of
--   your drop and before stay open ONE HOUR longer: when the clocks go back in autumn, the new drop goes off an
--   hour later than the time worked out from your old drop, and without that hour your older drops would lock
--   before you could even post the new one. (Known leftover: on that night, a friend's drop for the NEW day from
--   a time zone ahead of yours can lock up to an hour before your own drop goes off; after flying west across
--   several time zones, older drops can lock for a few hours before your new drop goes off. Both end as soon
--   as your new drop goes off and you post it.)
-- * The old rule stays too: a drop from a day you posted your own drop is always open (old app versions only
--   know that rule, and they keep working).
-- * Never posted a drop? You still only see the blurry previews.
-- * Group Peek: "Waiting on your group" now ends once that day is over everywhere (nobody can post that day's drop
--   any more), instead of hiding the drops forever. Today's group drops still wait for the whole group.
-- * Who can see a drop at all (friends, close friends, private accounts, blocks) is unchanged.
--
-- The app has the same window in src/lib/drop.ts (nextDropAt, dropDayOpen) – keep them in sync.
-- Safe to run more than once.
-- =====================================================================
begin;
set local lock_timeout = '15s';

-- ---------------------------------------------------------------------
-- 1. When the next drop goes off
-- ---------------------------------------------------------------------
-- The moment the drop AFTER `day` goes off, for someone whose time zone is `offset_minutes` ahead of UTC.
-- (private.drop_minute gives the clock time of a day's drop: the same for everyone, in their own time zone.)
-- The app's copy: nextDropAt in src/lib/drop.ts.
create or replace function private.next_drop_at(day date, offset_minutes integer)
returns timestamptz language sql stable set search_path = '' as $$
  select ((day + 1) + make_interval(mins => private.drop_minute(day + 1) - coalesce(offset_minutes, 0))) at time zone 'utc';
$$;
revoke all on function private.next_drop_at(date, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. The one rule: is a drop from `day` open for `viewer`?
-- ---------------------------------------------------------------------
-- Yes if the viewer posted their own drop that same day (the old rule), or their latest drop is still the
-- current one (the next day's drop hasn't gone off yet for them) – for drops from the day of their drop and
-- before, one hour longer (see the top: the clocks going back).
-- Only says whether posting a drop unlocked it – who may see the post at all is checked separately, first.
-- The app has the same rule: dropDayOpen and OLDER_DROPS_EXTRA_MS in src/lib/drop.ts.
create or replace function private.drop_open_for(viewer uuid, day date)
returns boolean language sql stable security definer set search_path = '' as $$
  select viewer is not null and exists (
    select 1 from public.posts mine
     where mine.user_id = viewer and mine.drop_day is not null
       and (
         mine.drop_day = day
         -- A drop is only ever current for up to about 2 days (time zones), so only recent ones are checked.
         or (mine.drop_day >= (now() at time zone 'utc')::date - 2
             and now() < private.next_drop_at(mine.drop_day, mine.drop_offset_minutes)
                         + case when day <= mine.drop_day then interval '1 hour' else interval '0' end)
       )
  );
$$;
revoke all on function private.drop_open_for(uuid, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Group Peek holds end once that day is over everywhere
-- ---------------------------------------------------------------------
-- A drop for `day` can be posted while it's `day` somewhere on Earth: until midnight at UTC-12, which is
-- 12:00 UTC the next day. After that nobody can post it any more, so waiting for them would hide the group's
-- drops forever. (Same as 20261105000000_group_peek.sql otherwise.)
create or replace function private.drop_day_over_at(day date)
returns timestamptz language sql stable set search_path = '' as $$
  select ((day + 1) + interval '12 hours') at time zone 'utc';
$$;
revoke all on function private.drop_day_over_at(date) from public, anon, authenticated;

-- Is `poster`'s drop for `day` held back from `viewer` by a group they're both in, where someone
-- (who was in the group that day) still hasn't posted that day's drop – and still could?
create or replace function private.group_holds_drop(viewer uuid, poster uuid, day date)
returns boolean language sql stable security definer set search_path = '' as $$
  select viewer is distinct from poster
    and now() < private.drop_day_over_at(day)
    and exists (
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

-- ---------------------------------------------------------------------
-- 4. The three places that checked "same day" now use the one rule
-- ---------------------------------------------------------------------
-- * private.can_read_media: who may download a drop's photo or video (storage);
-- * private.report_evidence_paths: a report on a drop you can't open keeps only its blurry preview;
-- * public.mark_drop_seen: "Who Peeked" only counts a reveal if the drop was open for you.
-- These functions are long and were changed by several migrations (20261225000000_public_chat.sql added lines
-- to two of them). Instead of copying them here (and risking an old copy), this reads each one as it is now,
-- swaps the old "same day" check for the new rule at that exact spot, and saves it back. If the spot isn't
-- there, the whole migration stops and nothing is changed. Running it again does nothing (it sees its own
-- change).
do $patch$
declare
  item record;
  body text;
begin
  for item in
    select * from (values
      ('private.can_read_media(text)'::regprocedure,
       $a$not exists (select 1 from public.posts mine where mine.user_id=me and mine.drop_day=p.drop_day)$a$,
       $b$not private.drop_open_for(me, p.drop_day)$b$),
      ('private.report_evidence_paths(text,uuid,uuid)'::regprocedure,
       $a$not exists (select 1 from public.posts mine where mine.user_id = reporter and mine.drop_day = p.drop_day)$a$,
       $b$not private.drop_open_for(reporter, p.drop_day)$b$),
      ('public.mark_drop_seen(uuid,boolean)'::regprocedure,
       $a$not exists (select 1 from public.posts mine where mine.user_id = me and mine.drop_day = day)$a$,
       $b$not private.drop_open_for(me, day)$b$)
    ) as t(fn, anchor, replacement)
  loop
    body := pg_get_functiondef(item.fn);
    if position('drop_open_for' in body) > 0 then
      continue;
    end if;
    if position(item.anchor in body) = 0 then
      raise exception 'drop unlock: could not find the spot to change in %', item.fn;
    end if;
    execute replace(body, item.anchor, item.replacement);
  end loop;
end;
$patch$;

commit;
