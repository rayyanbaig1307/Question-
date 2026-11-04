-- =====================================================================
-- Daily drop reminder from the server ⏰
--
-- Phones remind themselves about the daily drop for the next 7 days (local notifications, set each time the
-- app opens). Someone who hasn't opened Peekaboo for a week runs out of those. For them, the server sends the
-- drop alert as a push instead, at their own local drop time:
-- * the app tells the server its time zone (minutes from UTC) when it signs up for pushes;
-- * a timer in the database (pg_cron) runs every minute and finds people whose drop time is now, who last
--   opened the app 7–45 days ago (after 45 days we stop – they've probably moved on);
-- * at most one reminder per person per day; the "Drops" switch in Settings → Notifications is respected.
-- No email, no extra services.
-- =====================================================================

alter table public.push_tokens add column if not exists utc_offset_minutes integer
  check (utc_offset_minutes between -720 and 840);

-- Signing up for pushes now also saves the phone's time zone (older copies of the app just leave it empty).
drop function if exists public.register_push_token(text, text);
create or replace function public.register_push_token(push_token text, phone text, utc_offset integer default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Not logged in';
  end if;
  if utc_offset is not null and utc_offset not between -720 and 840 then
    utc_offset := null;
  end if;
  insert into public.push_tokens (token, user_id, platform, utc_offset_minutes)
  values (push_token, auth.uid(), phone, utc_offset)
  on conflict (token) do update
    set user_id = auth.uid(), platform = excluded.platform, updated_at = now(),
        utc_offset_minutes = coalesce(excluded.utc_offset_minutes, public.push_tokens.utc_offset_minutes);
end;
$$;
revoke execute on function public.register_push_token(text, text, integer) from public, anon;
grant execute on function public.register_push_token(text, text, integer) to authenticated;

-- Who already got today's reminder (so nobody gets two).
create table if not exists private.drop_reminders_sent (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  primary key (user_id, day)
);

-- Runs every minute: sends the drop alert to people away from the app whose local drop time is right now.
create or replace function private.send_drop_reminders()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  person record;
  sent integer := 0;
begin
  for person in
    with away as (
      select t.user_id,
             max(t.updated_at) as last_open,
             -- The time zone from the phone they used most recently.
             (array_agg(t.utc_offset_minutes order by t.updated_at desc) filter (where t.utc_offset_minutes is not null))[1] as offset_minutes
        from public.push_tokens t
       group by t.user_id
    ),
    local_time as (
      select a.user_id, (now() at time zone 'utc') + make_interval(mins => a.offset_minutes) as local_now
        from away a
       where a.offset_minutes is not null
         and a.last_open < now() - interval '7 days'
         and a.last_open > now() - interval '45 days'
    )
    select l.user_id, l.local_now::date as day
      from local_time l
     where floor(extract(epoch from (l.local_now - l.local_now::date)) / 60)::int = private.drop_minute(l.local_now::date)
       and not exists (select 1 from private.drop_reminders_sent s where s.user_id = l.user_id and s.day = l.local_now::date)
  loop
    insert into private.drop_reminders_sent (user_id, day) values (person.user_id, person.day) on conflict do nothing;
    perform private.send_push(person.user_id, 'drops', '⏰ Peekaboo drop!', 'You have 2 minutes to post your drop 👀',
      jsonb_build_object('type', 'drop'));
    sent := sent + 1;
  end loop;
  delete from private.drop_reminders_sent where day < current_date - 3;
  return sent;
end;
$$;
revoke execute on function private.send_drop_reminders() from public, anon, authenticated;

-- The every-minute timer (Supabase's built-in pg_cron). Skipped where pg_cron isn't available (local tests).
do $$
begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'peekaboo-drop-reminders';
  perform cron.schedule('peekaboo-drop-reminders', '* * * * *', 'select private.send_drop_reminders()');
exception when others then
  raise notice 'pg_cron not available here – drop reminders are not scheduled: %', sqlerrm;
end $$;
