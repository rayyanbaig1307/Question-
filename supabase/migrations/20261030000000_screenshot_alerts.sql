-- =====================================================================
-- Screenshot alerts: when someone screenshots your chat or your peek,
-- a little notice appears in the chat ("📸 Ayaan took a screenshot").
-- It's stored as a chat message of kind 'screenshot' whose body says what
-- was screenshotted: 'chat' or 'peek'.
-- =====================================================================

alter table public.messages drop constraint messages_kind_check;
alter table public.messages add constraint messages_kind_check
  check (kind in ('text', 'snap', 'screenshot'));

alter table public.messages drop constraint messages_content;
alter table public.messages add constraint messages_content check (
  (kind = 'text' and body is not null and char_length(body) > 0)
  or (kind = 'snap' and media_path is not null)
  or (kind = 'screenshot' and body in ('chat', 'peek') and media_path is null)
);

-- Opening a chat marks their text messages AND screenshot notices as read.
create or replace function public.mark_chat_read(friend uuid)
returns void language sql security definer set search_path = '' as $$
  update public.messages
     set opened_at = now()
   where sender_id = friend and recipient_id = auth.uid()
     and kind in ('text', 'screenshot') and opened_at is null;
$$;

-- You can unsend your messages and peeks, but not a screenshot notice (no hiding it!).
drop policy "You can delete messages you sent" on public.messages;
create policy "You can delete messages you sent"
  on public.messages for delete to authenticated
  using (sender_id = (select auth.uid()) and kind <> 'screenshot');
