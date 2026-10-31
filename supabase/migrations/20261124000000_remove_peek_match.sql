-- =====================================================================
-- Peek Match (dating) is gone – Hit ups replace it.
-- Removes the dating tables, functions, photo rules and the Stripe age-check fields.
-- (All dating tables were empty when this ran.) Birthdays stay: age_checks.birthday is used by Hit ups.
-- =====================================================================

drop policy if exists "You can upload your dating photos" on storage.objects;
drop policy if exists "You can delete your dating photos" on storage.objects;

drop table if exists
  public.dating_messages,
  public.dating_matches,
  public.dating_likes,
  public.dating_blocks,
  public.dating_prompts,
  public.dating_photos,
  public.dating_profiles,
  public.dating_members
  cascade;

do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as signature
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'private')
       and (p.proname like 'peek_match%' or p.proname like '%dating%'
            or p.proname in ('is_verified_adult', 'in_peek_match', 'in_match', 'match_partner', 'age_of'))
  loop
    execute 'drop function if exists ' || fn.signature || ' cascade';
  end loop;
end;
$$;

-- The Stripe ID-check fields aren't used any more.
alter table public.age_checks
  drop column if exists verified_birthday,
  drop column if exists check_session,
  drop column if exists check_state,
  drop column if exists check_error,
  drop column if exists verified_at;
