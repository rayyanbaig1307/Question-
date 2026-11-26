-- =====================================================================
-- Names on the Supabase "Users" page 👤
--
-- The Users page (Supabase → Authentication → Users) only shows a "Display name" when the login itself has one.
-- People who sign in with Apple or Google pick their name later, in Peekaboo's own setup screen, and the app
-- saves it in public.profiles – so the column was blank for almost everyone.
--
-- This copies each person's display name and username onto their login: everyone now, and again whenever
-- someone changes their name or username.
-- * It's only for the owner's dashboard. The app never reads these copies (public.profiles is still the real one).
-- * It can never stop a profile from saving: if the copy fails, the profile change still goes through.
-- * It only fires when the name or username really changes, so it costs nothing the rest of the time.
-- =====================================================================

create or replace function private.copy_name_to_login()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    update auth.users u
       set raw_user_meta_data = coalesce(u.raw_user_meta_data, '{}'::jsonb)
             || jsonb_build_object('display_name', new.display_name, 'username', new.username)
     where u.id = new.id;
  exception when others then
    -- Only a copy for the dashboard: never let it break saving a profile.
    null;
  end;
  return null;
end $$;

revoke all on function private.copy_name_to_login() from public, anon, authenticated;

drop trigger if exists profiles_copy_name_to_login on public.profiles;
create trigger profiles_copy_name_to_login
  after update of display_name, username on public.profiles
  for each row
  when (old.display_name is distinct from new.display_name or old.username is distinct from new.username)
  execute function private.copy_name_to_login();

-- Everyone who already has a profile.
update auth.users u
   set raw_user_meta_data = coalesce(u.raw_user_meta_data, '{}'::jsonb)
         || jsonb_build_object('display_name', p.display_name, 'username', p.username)
  from public.profiles p
 where p.id = u.id
   and (u.raw_user_meta_data ->> 'display_name' is distinct from p.display_name
     or u.raw_user_meta_data ->> 'username' is distinct from p.username);
