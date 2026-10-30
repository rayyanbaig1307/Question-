-- =====================================================================
-- Dare streaks 🔥
--
-- You and a friend both do the daily dare → the streak goes up by one each day you both do it.
-- Miss a day (either of you) and it's back to zero. Counted on the fly from dare posts – nothing to store.
-- =====================================================================

-- For each friend: the current streak, and whether each of you has done today's dare yet.
-- The streak counts back from today (if you've both done it) or from yesterday (then today is "at risk").
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
  mine as (
    select distinct p.dare_day as d from public.posts p
     where p.user_id = (select id from me) and p.dare_day is not null
  ),
  theirs as (
    select distinct p.user_id as uid, p.dare_day as d from public.posts p
     where p.dare_day is not null and p.user_id in (select fid from friends)
  ),
  -- days you BOTH did the dare, grouped into runs of consecutive days
  both_days as (
    select t.uid, t.d, t.d - (row_number() over (partition by t.uid order by t.d))::int as run
      from theirs t join mine m on m.d = t.d
  ),
  runs as (
    select b.uid, max(b.d) as last_day, count(*)::int as days from both_days b group by b.uid, b.run
  )
  select fr.fid,
         coalesce((select r.days from runs r where r.uid = fr.fid and r.last_day >= (select d from today) - 1 order by r.last_day desc limit 1), 0),
         exists (select 1 from mine m where m.d = (select d from today)),
         exists (select 1 from theirs t where t.uid = fr.fid and t.d = (select d from today))
    from friends fr;
$$;
revoke execute on function public.dare_streaks() from public, anon;
grant execute on function public.dare_streaks() to authenticated;
