-- =====================================================================
-- Dares in chat get an ending, and a streak 🔥
--
-- * Your friend does your dare and sends the proof (a peek), or taps "I did it". The dare is now "claimed".
-- * You confirm it ✅ (the dare is "done") or say it doesn't count ❌ ("nope": they can try again).
-- * Your dare streak with a friend: how many dares you two completed in a row, with no gap longer than 3 days.
--   It shows in your chat with them. Dare them back to keep it going.
-- Only these functions can change a dare's state, so nobody can fake a streak.
-- =====================================================================

alter table public.messages
  add column if not exists dare_state text check (dare_state in ('claimed', 'done', 'nope')),
  add column if not exists dare_claimed_at timestamptz,
  add column if not exists dare_done_at timestamptz;

-- A new message always starts without a dare state (the app can't send one already "done").
create or replace function private.clear_new_dare_state()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.dare_state := null;
  new.dare_claimed_at := null;
  new.dare_done_at := null;
  return new;
end;
$$;
drop trigger if exists messages_clear_dare_state on public.messages;
create trigger messages_clear_dare_state before insert on public.messages
  for each row execute function private.clear_new_dare_state();

create index if not exists messages_dare_done_idx on public.messages (dare_done_at) where dare_state = 'done';

-- The dare streak between you and a friend.
create or replace function private.dare_streak(a uuid, b uuid)
returns int language plpgsql stable security definer set search_path = '' as $$
declare
  streak int := 0;
  previous timestamptz := now();
  d record;
begin
  for d in
    select m.dare_done_at as at from public.messages m
     where m.kind = 'dare' and m.dare_state = 'done'
       and ((m.sender_id = a and m.recipient_id = b) or (m.sender_id = b and m.recipient_id = a))
     order by m.dare_done_at desc
  loop
    exit when previous - d.at > interval '3 days';
    streak := streak + 1;
    previous := d.at;
  end loop;
  return streak;
end;
$$;

create or replace function public.chat_dare_streak(friend uuid)
returns int language sql stable security definer set search_path = '' as $$
  select case when auth.uid() is null then 0 else private.dare_streak(auth.uid(), friend) end;
$$;
revoke execute on function public.chat_dare_streak(uuid) from public, anon;
grant execute on function public.chat_dare_streak(uuid) to authenticated;

-- "I did it": the friend who got the dare says they did it (also done for them after they send the proof).
create or replace function public.claim_chat_dare(dare uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  m public.messages%rowtype;
begin
  select * into m from public.messages where id = dare and kind = 'dare' and recipient_id = me;
  if m.id is null then
    raise exception 'This dare is gone';
  end if;
  if m.dare_state = 'done' then
    return 'done';
  end if;
  if m.dare_state = 'claimed' then
    return 'claimed';
  end if;
  update public.messages set dare_state = 'claimed', dare_claimed_at = now() where id = m.id;
  perform private.send_push(m.sender_id, 'messages', '🎯 ' || private.push_name(me) || ' did your dare!',
    'Tap to check the proof and confirm it ✅', jsonb_build_object('type', 'message', 'from', me));
  return 'claimed';
end;
$$;
revoke execute on function public.claim_chat_dare(uuid) from public, anon;
grant execute on function public.claim_chat_dare(uuid) to authenticated;

-- The one who sent the dare confirms it (ok = true) or says it doesn't count (ok = false).
-- Returns the new streak (0 when it didn't count).
create or replace function public.confirm_chat_dare(dare uuid, ok boolean)
returns int language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  m public.messages%rowtype;
  streak int;
begin
  select * into m from public.messages where id = dare and kind = 'dare' and sender_id = me;
  if m.id is null then
    raise exception 'This dare is gone';
  end if;
  if m.dare_state is distinct from 'claimed' then
    raise exception 'They haven''t said they did it yet';
  end if;
  if ok then
    update public.messages set dare_state = 'done', dare_done_at = now() where id = m.id;
    streak := private.dare_streak(me, m.recipient_id);
    perform private.send_push(m.recipient_id, 'messages', '✅ Dare completed!',
      private.push_name(me) || ' confirmed it' || case when streak > 1 then ' · 🔥 ' || streak || ' dare streak' else '' end
        || ' – dare them back!',
      jsonb_build_object('type', 'message', 'from', me));
    return streak;
  end if;
  update public.messages set dare_state = 'nope', dare_claimed_at = null where id = m.id;
  perform private.send_push(m.recipient_id, 'messages', '❌ ' || private.push_name(me) || ' says that doesn''t count',
    'Try the dare again 🎯', jsonb_build_object('type', 'message', 'from', me));
  return 0;
end;
$$;
revoke execute on function public.confirm_chat_dare(uuid, boolean) from public, anon;
grant execute on function public.confirm_chat_dare(uuid, boolean) to authenticated;
