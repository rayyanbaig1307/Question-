-- =====================================================================
-- Delete my account: removes the login and, through the "on delete cascade"
-- links, everything else (profile, posts, stories, chats, friends, likes…).
-- The app deletes your photo files first (the database isn't allowed to).
-- =====================================================================
create or replace function public.delete_my_account()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Not logged in';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;
revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
