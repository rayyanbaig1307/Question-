-- =====================================================================
-- Custom dares 🎯: write your own dare and send it to a friend in your chat.
--
-- * A new kind of chat message, 'dare'. The dare's words are in body (1–200 characters).
-- * Your friend sees a dare card with "Do it 📸", which opens the camera to send the proof back to you as a peek.
-- * The usual chat rules apply (only friends can message each other, blocks stop it).
-- =====================================================================

alter table public.messages drop constraint messages_kind_check;
alter table public.messages add constraint messages_kind_check
  check (kind = any (array['text', 'snap', 'screenshot', 'voice', 'reaction', 'dare']));

alter table public.messages drop constraint messages_content;
alter table public.messages add constraint messages_content check (
  (kind = 'text' and body is not null and char_length(body) > 0)
  or (kind = 'snap' and media_path is not null)
  or (kind = 'screenshot' and body = any (array['chat', 'peek']) and media_path is null)
  or (kind = 'voice' and media_path like '%/voice/%' and audio_ms is not null)
  or (kind = 'reaction' and body is not null and char_length(body) between 1 and 16 and media_path is null)
  or (kind = 'dare' and body is not null and char_length(btrim(body)) between 1 and 200 and media_path is null)
);

-- Opening the chat marks dares as read too (they show "Seen" like texts).
create or replace function public.mark_chat_read(friend uuid)
returns void language sql security definer set search_path = '' as $$
  update public.messages
     set opened_at = now()
   where sender_id = friend and recipient_id = auth.uid()
     and kind in ('text', 'screenshot', 'voice', 'reaction', 'dare') and opened_at is null;
$$;

-- The push for a new message now knows about dares.
create or replace function private.push_new_message()
returns trigger language plpgsql security definer set search_path = '' as $$
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
      else 'New message'
    end,
    jsonb_build_object('type', 'message', 'from', new.sender_id)
  );
  return new;
end;
$$;
