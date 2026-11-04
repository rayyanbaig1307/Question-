-- ---------------------------------------------------------------------
-- New accounts are made with "Sign in with Apple" (iPhone) or "Sign in with Google" (Android).
-- Apple and Google have already checked the person is real, so there's no password and no email to confirm.
-- Older accounts (username or email + password) keep logging in as before.
--
-- 1. New profiles get their name from Google when it's there ("Rayyan Baig" → @rayyanbaig as a starting
--    username). Apple doesn't share a name with the server, so those start as "user3f9a1c". Either way the app's
--    setup screen asks for a username and name next.
-- 2. A sign-up guard that only lets Apple and Google make new accounts. It does nothing until it's switched
--    on in Supabase → Authentication → Auth Hooks → "Before User Created" (choose this function). Switch it on
--    once the new app builds with the Apple/Google buttons are out – older builds can't sign up after that.
-- ---------------------------------------------------------------------

-- 1. The profile made for every new account (same as before, plus the name from Google).
create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  base text;
  candidate text;
  attempts int := 0;
  -- The app sends display_name; Google sends full_name / name.
  shared_name text := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'name'), '')
  );
begin
  base := lower(coalesce(new.raw_user_meta_data ->> 'username', shared_name, ''));
  base := regexp_replace(base, '[^a-z0-9_.]', '', 'g');
  if char_length(base) < 3 then
    base := 'user' || substr(replace(new.id::text, '-', ''), 1, 6);
  end if;
  base := left(base, 20);
  candidate := base;

  -- If the username got taken in the meantime, add some numbers.
  while exists (select 1 from public.profiles where username = candidate) loop
    attempts := attempts + 1;
    if attempts > 20 then
      candidate := 'user' || substr(replace(new.id::text, '-', ''), 1, 12);
      exit;
    end if;
    candidate := left(base, 16) || (floor(random() * 9000) + 1000)::int::text;
  end loop;

  insert into public.profiles (id, username, display_name)
  values (new.id, candidate, left(coalesce(shared_name, candidate), 40));
  return new;
end;
$$;

-- 2. Only Apple and Google can make new accounts (once the hook is switched on – see the top).
-- Logging in to an existing account isn't affected.
create or replace function public.hook_only_apple_or_google_sign_ups(event jsonb)
returns jsonb language plpgsql set search_path = '' as $$
begin
  if coalesce(event -> 'user' -> 'app_metadata' ->> 'provider', '') in ('apple', 'google') then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', 'New accounts are made with Apple or Google now. Update Peekaboo to the newest version.'
  ));
end;
$$;
grant execute on function public.hook_only_apple_or_google_sign_ups(jsonb) to supabase_auth_admin;
revoke execute on function public.hook_only_apple_or_google_sign_ups(jsonb) from authenticated, anon, public;
