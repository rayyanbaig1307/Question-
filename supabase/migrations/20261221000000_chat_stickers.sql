-- ---------------------------------------------------------------------------
-- Stickers in chat 🏷️ (friend chats and group chats).
--
-- A sticker message has kind 'sticker':
--   sticker = which sticker (its name in the app, like 'googly-eyes', 'word-slay' or 'plus-slay')
--   body    = a short text version of it ("Sticker: SLAY"). Older app versions that don't know stickers
--             yet show this text, and the chat list and notifications use it too.
--
-- Peekaboo+ stickers (their names start with 'plus-') can only be SENT by people who have Peekaboo+ right
-- now (private.is_plus). That is checked here on the server, so an old app or a tampered app can't get
-- around it. Anyone can still SEE a Plus sticker a friend sent them.
-- ---------------------------------------------------------------------------

alter table public.messages add column if not exists sticker text;
alter table public.group_messages add column if not exists sticker text;

-- Friend chats: allow the new kind, and say what a sticker message must look like.
alter table public.messages drop constraint messages_kind_check;
alter table public.messages add constraint messages_kind_check
  check (kind in ('text', 'snap', 'screenshot', 'voice', 'reaction', 'dare', 'sticker'));

alter table public.messages drop constraint messages_content;
alter table public.messages add constraint messages_content check (
  (kind = 'text' and body is not null and char_length(body) > 0)
  or (kind = 'snap' and media_path is not null)
  or (kind = 'screenshot' and body in ('chat', 'peek') and media_path is null)
  or (kind = 'voice' and media_path like '%/voice/%' and audio_ms is not null)
  or (kind = 'reaction' and body is not null and char_length(body) between 1 and 16 and media_path is null)
  or (kind = 'dare' and body is not null and char_length(btrim(body)) between 1 and 200 and media_path is null)
  or (kind = 'sticker' and sticker is not null and body is not null and char_length(body) between 1 and 80
      and media_path is null)
);

-- Only sticker messages have a sticker, and its name is short and plain.
alter table public.messages drop constraint if exists messages_sticker_shape;
alter table public.messages add constraint messages_sticker_shape check (
  (kind = 'sticker') = (sticker is not null) and (sticker is null or sticker ~ '^[a-z0-9-]{1,40}$')
);

-- Group chats: the same.
alter table public.group_messages drop constraint group_messages_kind_check;
alter table public.group_messages add constraint group_messages_kind_check
  check (kind in ('text', 'photo', 'video', 'voice', 'dare', 'proof', 'sticker'));

alter table public.group_messages drop constraint group_messages_content;
alter table public.group_messages add constraint group_messages_content check (
  (kind = 'text' and body is not null and char_length(btrim(body)) between 1 and 2000 and media_path is null)
  or (kind in ('photo', 'video') and media_path is not null and (body is null or char_length(body) <= 500))
  or (kind = 'voice' and media_path like '%/voice/%' and audio_ms is not null)
  or (kind = 'dare' and body is not null and char_length(btrim(body)) between 1 and 200 and media_path is null)
  or (kind = 'proof' and dare_id is not null and media_path is not null)
  or (kind = 'sticker' and sticker is not null and body is not null and char_length(body) between 1 and 80
      and media_path is null)
);

alter table public.group_messages drop constraint if exists group_messages_sticker_shape;
alter table public.group_messages add constraint group_messages_sticker_shape check (
  (kind = 'sticker') = (sticker is not null) and (sticker is null or sticker ~ '^[a-z0-9-]{1,40}$')
);

-- 🔒 Peekaboo+ stickers need Peekaboo+. Runs after the other "before insert" steps (triggers run in name
-- order, and group_messages_prepare fills in the sender first).
create or replace function private.check_plus_sticker()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind = 'sticker' and new.sticker like 'plus-%' and not private.is_plus(new.sender_id) then
    raise exception 'That sticker is part of Peekaboo+ ⭐'
      using errcode = 'P0001', hint = 'plus_required';
  end if;
  return new;
end;
$$;
revoke all on function private.check_plus_sticker() from public, anon, authenticated;

drop trigger if exists zzz_messages_plus_sticker on public.messages;
create trigger zzz_messages_plus_sticker
  before insert on public.messages
  for each row execute function private.check_plus_sticker();

drop trigger if exists zzz_group_messages_plus_sticker on public.group_messages;
create trigger zzz_group_messages_plus_sticker
  before insert on public.group_messages
  for each row execute function private.check_plus_sticker();

-- Notifications: "Sent you a sticker" instead of the text version.
create or replace function private.push_new_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting('peekaboo.quiet_push', true) = 'on' then
    return new;
  end if;
  if exists (
    select 1 from public.friend_settings s
     where s.user_id = new.recipient_id and s.friend_id = new.sender_id and s.mute_messages
  ) then
    return new;
  end if;
  perform private.send_push(
    new.recipient_id,
    'messages',
    private.push_name(new.sender_id),
    case new.kind
      when 'text' then left(new.body, 140)
      when 'snap' then 'Sent you a peek 👀'
      when 'screenshot' then case new.body when 'peek' then 'Took a screenshot of your peek 📸' else 'Took a screenshot of the chat 📸' end
      when 'voice' then 'Sent you a voice note 🎤'
      when 'reaction' then 'Reacted ' || new.body || ' to your story'
      when 'dare' then '🎯 Dared you: ' || left(new.body, 120)
      when 'sticker' then 'Sent you a sticker ✨'
      else 'New message'
    end,
    jsonb_build_object('type', 'message', 'from', new.sender_id)
  );
  return new;
end;
$$;

-- Group chat list + group notifications.
create or replace function private.group_message_preview(kind text, body text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case kind
    when 'photo' then '📷 Photo'
    when 'video' then '🎬 Video'
    when 'voice' then '🎤 Voice note'
    when 'dare' then '🎯 Dared the group: ' || left(body, 100)
    when 'proof' then '📸 Posted proof – legit or cap?'
    when 'sticker' then '✨ Sticker'
    else left(body, 120)
  end;
$$;
