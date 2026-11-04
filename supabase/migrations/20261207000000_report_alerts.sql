-- =====================================================================
-- Report alerts 🚩: when anyone reports something (a post, story, comment, chat, profile, hit up, Guess Who
-- or dare idea), the people in private.report_alert_people get a push notification on their phone.
-- The report itself is saved in public.reports as before – open it in Supabase → Table Editor → reports.
--
-- * To add someone else (for example a second moderator), add their user id:
--     insert into private.report_alert_people (user_id) values ('<their user id>');
-- * The alert can never stop a report from being saved: if the push fails, the report still goes in.
-- =====================================================================

create table if not exists private.report_alert_people (
  user_id uuid primary key references public.profiles (id) on delete cascade
);

-- The owner (@coolname) gets the alerts – but only if that account exists in this database.
-- On a brand-new, empty database (a fresh copy of the app, or a test database) the account is not
-- there yet, so this simply adds nobody instead of stopping with an error.
-- New owner? After you have made your account in the app, find your user id in
-- Supabase → Authentication → Users and run the "insert into private.report_alert_people" line above.
insert into private.report_alert_people (user_id)
select p.id from public.profiles p
where p.id = 'd3614487-2fa7-477c-8b64-be66ce1f5f3f'
on conflict do nothing;

create or replace function private.alert_new_report()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  person uuid;
  what text;
begin
  what := coalesce(nullif(new.content_type, ''), 'something');
  for person in select a.user_id from private.report_alert_people a loop
    begin
      perform private.send_push(
        person,
        'reports',
        '🚩 New report',
        'Someone reported a ' || what || coalesce(' for ' || nullif(new.reason, ''), '')
          || '. Check the reports table in Supabase.',
        jsonb_build_object('type', 'report', 'report', new.id)
      );
    exception when others then
      -- Never block the report because of a push problem.
      null;
    end;
  end loop;
  return new;
end;
$$;

drop trigger if exists alert_new_report on public.reports;
create trigger alert_new_report
  after insert on public.reports
  for each row execute function private.alert_new_report();
