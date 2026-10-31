-- =====================================================================
-- Hit ups: say why when the other person hasn't added their birthday yet (instead of the button just
-- not being there). They still can't get hit ups until they add it – that's what keeps teens and adults apart.
-- Only that one reason is shown; their age and settings stay private ('unavailable' as before).
-- =====================================================================

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
  if their_group <> my_group then
    return 'unavailable';
  end if;
  return null;
end;
$$;

-- Same as before, plus the message for 'their_birthday'.
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
    raise exception 'Add your birthday first (Settings → Birthday) – hit ups are only between people your age';
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
