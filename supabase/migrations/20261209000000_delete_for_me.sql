-- =====================================================================
-- Delete for me 🗑️ and Clear chat 🧹
--
-- * "Delete for everyone" (your own messages) already exists: the message is gone for both of you.
-- * "Delete for me" hides any message (yours or theirs) from your own chat only. Your friend still has it.
-- * "Clear chat" hides every message in a chat from your side. New messages show up as normal.
-- Hidden messages are only hidden for you. Reports still work: a reported message stays in the database.
-- =====================================================================

create table if not exists public.message_hides (
  user_id uuid not null references public.profiles (id) on delete cascade,
  message_id uuid not null references public.messages (id) on delete cascade,
  hidden_at timestamptz not null default now(),
  primary key (user_id, message_id)
);
alter table public.message_hides enable row level security;

create policy "You can see what you hid"
  on public.message_hides for select to authenticated
  using (user_id = (select auth.uid()));

-- Hide one message for yourself (only messages you sent or received).
create or replace function public.hide_message(message uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
begin
  if not exists (select 1 from public.messages m where m.id = message and me in (m.sender_id, m.recipient_id)) then
    raise exception 'That message is gone';
  end if;
  insert into public.message_hides (user_id, message_id) values (me, message) on conflict do nothing;
end;
$$;
revoke execute on function public.hide_message(uuid) from public, anon;
grant execute on function public.hide_message(uuid) to authenticated;

-- Clear a whole chat for yourself. Returns how many messages were hidden.
create or replace function public.clear_chat(friend uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  n integer;
begin
  if me is null then
    raise exception 'Please log in again';
  end if;
  insert into public.message_hides (user_id, message_id)
  select me, m.id from public.messages m
   where (m.sender_id = me and m.recipient_id = friend) or (m.sender_id = friend and m.recipient_id = me)
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.clear_chat(uuid) from public, anon;
grant execute on function public.clear_chat(uuid) to authenticated;
