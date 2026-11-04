-- =====================================================================
-- Birthday rules and hit ups for adults only
--
-- * Birthdays: not in the future, not more than 100 years ago, and you must be 13 or older (the app's age
--   limit). The app checks the same things before it even asks the database.
-- * Hit ups are now only for people 18 and over. Anyone under 18 sees no Hit up button at all, and nobody
--   can hit them up. Teens still make friends the normal way (friend requests).
-- =====================================================================

create or replace function public.set_birthday(day date)
returns text language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'Please log in again';
  end if;
  if exists (select 1 from public.age_checks where user_id = me) then
    raise exception 'Your birthday is already saved';
  end if;
  if day is null or day > current_date then
    raise exception 'That birthday is in the future – check the year';
  end if;
  if day < (current_date - interval '100 years')::date then
    raise exception 'That birthday is more than 100 years ago – check the year';
  end if;
  if day > (current_date - interval '13 years')::date then
    raise exception 'You need to be 13 or older to use Peekaboo';
  end if;
  insert into public.age_checks (user_id, birthday, blocked)
  values (me, day, day > (current_date - interval '18 years')::date);
  return 'ok';
end;
$$;

-- Why `me` can't hit `target` up, or null if they can.
-- 'under_18' = you're under 18, so hit ups are off for you. Someone else being under 18 just looks
-- 'unavailable' (nobody can find out someone's age from the button).
create or replace function private.hit_up_problem(me uuid, target uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  setting text;
  my_group text := private.age_group(me);
  their_group text;
begin
  if target = me then
    return 'self';
  end if;
  if my_group is null then
    return 'no_birthday';
  end if;
  if my_group <> 'adult' then
    return 'under_18';
  end if;
  select p.hit_ups_from into setting from public.profiles p where p.id = target;
  if setting is null or private.is_blocked(me, target) then
    return 'unavailable';
  end if;
  if private.are_friends(me, target) then
    return 'friends';
  end if;
  if setting = 'nobody' or (setting = 'friends_of_friends' and not private.have_mutual_friend(me, target)) then
    return 'unavailable';
  end if;
  their_group := private.age_group(target);
  if their_group is null then
    return 'their_birthday';
  end if;
  if their_group <> 'adult' then
    return 'unavailable';
  end if;
  return null;
end;
$$;

-- Same as before, plus the message for 'under_18'. Hitting back also needs you to be 18+ now.
create or replace function public.hit_up(target uuid, note text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  problem text;
  theirs uuid;
  clean text := nullif(btrim(note), '');
begin
  if me is null then
    raise exception 'Please log in again';
  end if;
  if char_length(clean) > 150 then
    raise exception 'Keep it to 150 letters';
  end if;
  if private.age_group(me) is distinct from 'adult' then
    raise exception 'Hit ups are only for people 18 and over';
  end if;

  -- They already hit you up: this is a hit back (their own setting doesn't matter – they reached out).
  select id into theirs from public.hit_ups where from_user = target and to_user = me and status = 'pending';
  if theirs is not null and not private.is_blocked(me, target) and not private.are_friends(me, target) then
    perform private.connect_hit_up(theirs);
    if clean is not null then
      perform set_config('peekaboo.quiet_push', 'on', true);
      insert into public.messages (sender_id, recipient_id, kind, body) values (me, target, 'text', clean);
      perform set_config('peekaboo.quiet_push', 'off', true);
    end if;
    perform private.send_push(target, 'friend_requests', '👋 ' || private.push_name(me) || ' hit you back!',
      'You can chat now – say hi', jsonb_build_object('type', 'message', 'from', me));
    return 'connected';
  end if;

  problem := private.hit_up_problem(me, target);
  if problem = 'self' then
    raise exception 'That''s you 😄';
  elsif problem = 'no_birthday' then
    raise exception 'Add your birthday first (Settings → Birthday) – hit ups are only for people 18 and over';
  elsif problem = 'under_18' then
    raise exception 'Hit ups are only for people 18 and over';
  elsif problem = 'friends' then
    raise exception 'You''re already friends – just send a message';
  elsif problem = 'their_birthday' then
    raise exception 'They haven''t added their birthday yet, so they can''t get hit ups – ask them to add it in Settings → Birthday';
  elsif problem is not null then
    raise exception 'Hit ups aren''t available for this person';
  end if;

  if exists (select 1 from public.hit_ups where from_user = me and to_user = target) then
    raise exception 'You already hit them up – it''s up to them now';
  end if;
  if (select count(*) from public.hit_ups where from_user = me and created_at > now() - interval '24 hours') >= 10 then
    raise exception 'You''ve used your 10 hit ups for today – try again tomorrow';
  end if;

  insert into public.hit_ups (from_user, to_user, message) values (me, target, clean);
  perform private.send_push(target, 'friend_requests', '👋 ' || private.push_name(me) || ' hit you up',
    coalesce(left(clean, 140), 'Tap to see who it is'), jsonb_build_object('type', 'hitups'));
  return 'sent';
end;
$$;

-- Hitting back from the Chat box also needs you to be 18+ (a pending hit up could only have reached an adult,
-- but check anyway).
create or replace function public.respond_hit_up(hit uuid, accept boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  h public.hit_ups%rowtype;
begin
  select * into h from public.hit_ups where id = hit and to_user = me and status = 'pending' and ignored_at is null;
  if h.id is null then
    raise exception 'This hit up is gone';
  end if;
  if not accept then
    update public.hit_ups set ignored_at = now(), responded_at = now() where id = h.id;
    return;
  end if;
  if private.is_blocked(me, h.from_user) or private.age_group(me) is distinct from 'adult' then
    raise exception 'This hit up is gone';
  end if;
  perform private.connect_hit_up(h.id);
  perform private.send_push(h.from_user, 'friend_requests', '👋 ' || private.push_name(me) || ' hit you back!',
    'You can chat now – say hi', jsonb_build_object('type', 'message', 'from', me));
end;
$$;
