-- =====================================================================
-- Two small fixes after the Peekaboo+ bug review (5 Nov 2026). Safe to run more than once.
--
-- 1. 🚩 Report alerts go to the owner's CURRENT account. The owner moved to Sign in with Apple on 4 Nov 2026
--    and got a new user id; the old one in 20261207000000_report_alerts.sql no longer exists. (On a brand-new
--    database the account isn't there yet, so this adds nobody – add yourself with the insert line in that file.)
-- 2. 🙈 Peek-a-Save: the "your streak broke" card now also shows when the last dare between two friends was a
--    GROUP dare (20261216000000_group_dare_votes.sql). my_broken_streaks used to look only at 1-on-1 chat dares
--    and Peek-a-Saves when finding candidates, while the streak itself (chat_streak_last / dare_streak_since,
--    from 20261218000000_plus_extras.sql) already counts group proofs – so the save was allowed but never offered.
-- =====================================================================

insert into private.report_alert_people (user_id)
select p.id from public.profiles p
where p.id = 'df5aae76-7e6a-4e91-9645-5b897a533156'
on conflict do nothing;

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

  -- Chat dare streaks: every friend's last counting dare (1-on-1, group proof or Peek-a-Save), broken when it
  -- was 3–4 days ago. Friends lists are small, so asking per friend is fine.
  return query
    with friends as (
      select case when f.requester_id = me then f.addressee_id else f.requester_id end as fid
        from public.friendships f
       where f.status = 'accepted' and me in (f.requester_id, f.addressee_id)
    ),
    lasts as (
      select fr.fid, private.chat_streak_last(me, fr.fid) as at from friends fr
       where not private.is_blocked(me, fr.fid)
    ),
    broken as (
      select l.fid, l.at, private.dare_streak_since(me, l.fid, l.at) as n from lasts l
       where l.at is not null and now() - l.at > interval '3 days' and now() - l.at <= interval '4 days'
    )
    select 'chat_dare'::text, b.fid, b.n, b.at + interval '3 days', b.at + interval '4 days'
      from broken b
     where b.n >= 2;
end;
$$;
revoke execute on function public.my_broken_streaks() from public, anon;
grant execute on function public.my_broken_streaks() to authenticated;
