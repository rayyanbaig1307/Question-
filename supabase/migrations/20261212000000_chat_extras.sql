-- =====================================================================
-- Chat extras ✨
--
-- * Reactions: hold a message and tap ❤️ 😂 🔥 😮 😢 👍 – one reaction per person per message (tap another to
--   change it, the same one to take it back). Works in one-on-one and group chats. The sender gets a push.
-- * Replies: a message can answer an earlier message in the same chat (reply_to).
-- * Group photo: any member can set (or remove) the group's picture. It's stored with profile pictures.
-- * Pinned message: any member can pin one message to the top of the group chat (or unpin it).
-- =====================================================================

-- ---- Reactions ----
create table if not exists public.message_reactions (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  emoji text not null check (emoji in ('❤️', '😂', '🔥', '😮', '😢', '👍')),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);
alter table public.message_reactions enable row level security;

create table if not exists public.group_message_reactions (
  message_id uuid not null references public.group_messages (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  emoji text not null check (emoji in ('❤️', '😂', '🔥', '😮', '😢', '👍')),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);
alter table public.group_message_reactions enable row level security;

-- Who's in a one-on-one message / which group a group message is in.
create or replace function private.in_message(message uuid, person uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.messages m where m.id = message and person in (m.sender_id, m.recipient_id));
$$;
create or replace function private.in_group_message(message uuid, person uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.group_messages g where g.id = message and private.is_group_member(g.group_id, person)
  );
$$;

create policy "You see reactions in your chats"
  on public.message_reactions for select to authenticated
  using (private.in_message(message_id, (select auth.uid())));
create policy "You react in your chats"
  on public.message_reactions for insert to authenticated
  with check (user_id = (select auth.uid()) and private.in_message(message_id, (select auth.uid())));
create policy "You change your own reaction"
  on public.message_reactions for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and private.in_message(message_id, (select auth.uid())));
create policy "You take back your own reaction"
  on public.message_reactions for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "Members see reactions in their group chats"
  on public.group_message_reactions for select to authenticated
  using (private.in_group_message(message_id, (select auth.uid())));
create policy "Members react in their group chats"
  on public.group_message_reactions for insert to authenticated
  with check (user_id = (select auth.uid()) and private.in_group_message(message_id, (select auth.uid())));
create policy "Members change their own group reaction"
  on public.group_message_reactions for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and private.in_group_message(message_id, (select auth.uid())));
create policy "Members take back their own group reaction"
  on public.group_message_reactions for delete to authenticated
  using (user_id = (select auth.uid()));

-- A push to the person whose message got a reaction (not for your own messages; respects mutes).
create or replace function private.push_reaction()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  owner uuid;
  grp uuid;
  muted boolean := false;
begin
  if tg_table_name = 'message_reactions' then
    select m.sender_id into owner from public.messages m where m.id = new.message_id;
    select coalesce(s.mute_messages, false) into muted from public.friend_settings s
     where s.user_id = owner and s.friend_id = new.user_id;
  else
    select g.sender_id, g.group_id into owner, grp from public.group_messages g where g.id = new.message_id;
    select m.chat_muted into muted from public.peek_group_members m where m.group_id = grp and m.user_id = owner;
  end if;
  if owner is null or owner = new.user_id or coalesce(muted, false) or private.is_blocked(owner, new.user_id) then
    return new;
  end if;
  perform private.send_push(owner, 'messages', private.push_name(new.user_id),
    'Reacted ' || new.emoji || ' to your message',
    case when grp is null then jsonb_build_object('type', 'message', 'from', new.user_id)
         else jsonb_build_object('type', 'group_chat', 'group', grp) end);
  return new;
end;
$$;
drop trigger if exists message_reactions_push on public.message_reactions;
create trigger message_reactions_push after insert on public.message_reactions
  for each row execute function private.push_reaction();
drop trigger if exists group_message_reactions_push on public.group_message_reactions;
create trigger group_message_reactions_push after insert on public.group_message_reactions
  for each row execute function private.push_reaction();

-- ---- Replies ----
alter table public.messages add column if not exists reply_to uuid references public.messages (id) on delete set null;
alter table public.group_messages add column if not exists reply_to uuid references public.group_messages (id) on delete set null;

-- A reply has to answer a message in the same chat.
create or replace function private.check_reply_to()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.reply_to is null then
    return new;
  end if;
  if tg_table_name = 'messages' then
    if not exists (
      select 1 from public.messages m where m.id = new.reply_to
         and least(m.sender_id, m.recipient_id) = least(new.sender_id, new.recipient_id)
         and greatest(m.sender_id, m.recipient_id) = greatest(new.sender_id, new.recipient_id)
    ) then
      new.reply_to := null;
    end if;
  elsif not exists (select 1 from public.group_messages g where g.id = new.reply_to and g.group_id = new.group_id) then
    new.reply_to := null;
  end if;
  return new;
end;
$$;
drop trigger if exists messages_check_reply on public.messages;
create trigger messages_check_reply before insert on public.messages
  for each row execute function private.check_reply_to();
drop trigger if exists group_messages_check_reply on public.group_messages;
create trigger group_messages_check_reply before insert on public.group_messages
  for each row execute function private.check_reply_to();

-- ---- Group photo + pinned message ----
alter table public.peek_groups
  add column if not exists photo_path text,
  add column if not exists pinned_message_id uuid references public.group_messages (id) on delete set null,
  add column if not exists pinned_by uuid references public.profiles (id) on delete set null;

-- `photo` is a file you uploaded to the profile-pictures bucket (your own folder), or null to remove it.
create or replace function public.set_group_photo(grp uuid, photo text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_group_member(grp, auth.uid()) then
    raise exception 'You''re not in this group';
  end if;
  if photo is not null and split_part(photo, '/', 1) <> auth.uid()::text then
    raise exception 'That picture isn''t yours';
  end if;
  update public.peek_groups set photo_path = photo where id = grp;
end;
$$;
revoke execute on function public.set_group_photo(uuid, text) from public, anon;
grant execute on function public.set_group_photo(uuid, text) to authenticated;

-- Pin a message of this group's chat to the top (null = unpin).
create or replace function public.pin_group_message(grp uuid, message uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_group_member(grp, auth.uid()) then
    raise exception 'You''re not in this group';
  end if;
  if message is not null and not exists (select 1 from public.group_messages g where g.id = message and g.group_id = grp) then
    raise exception 'That message is gone';
  end if;
  update public.peek_groups
     set pinned_message_id = message, pinned_by = case when message is null then null else auth.uid() end
   where id = grp;
end;
$$;
revoke execute on function public.pin_group_message(uuid, uuid) from public, anon;
grant execute on function public.pin_group_message(uuid, uuid) to authenticated;

-- ---- Live updates for reactions and pins ----
do $$
declare
  t text;
begin
  foreach t in array array['message_reactions', 'group_message_reactions', 'peek_groups'] loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
