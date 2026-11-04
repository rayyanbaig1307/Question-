-- =====================================================================
-- Group chat 💬: every Group Peek group gets its own chat.
--
-- * Members can read and write; anyone can delete their own messages (for everyone).
-- * Everyone else in the group gets a push ("Group name · Ray: hey"), unless they muted the group chat.
-- * Each member's "last read" time gives the unread count on the group in the Chat list.
-- * Messages arrive live (realtime). Leaving or being removed from the group ends access.
-- =====================================================================

create table if not exists public.group_messages (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.peek_groups (id) on delete cascade,
  sender_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists group_messages_group_created_idx on public.group_messages (group_id, created_at desc);
alter table public.group_messages enable row level security;

create policy "Members can read their group chats"
  on public.group_messages for select to authenticated
  using (private.is_group_member(group_id, (select auth.uid())));

create policy "Members can write in their group chats"
  on public.group_messages for insert to authenticated
  with check (sender_id = (select auth.uid()) and private.is_group_member(group_id, (select auth.uid())));

create policy "You can delete your own group messages"
  on public.group_messages for delete to authenticated
  using (sender_id = (select auth.uid()));

-- Per member: when they last read the group chat, and whether they muted it.
alter table public.peek_group_members
  add column if not exists chat_read_at timestamptz not null default now(),
  add column if not exists chat_muted boolean not null default false;

create or replace function public.mark_group_chat_read(grp uuid)
returns void language sql security definer set search_path = '' as $$
  update public.peek_group_members set chat_read_at = now() where group_id = grp and user_id = auth.uid();
$$;
revoke execute on function public.mark_group_chat_read(uuid) from public, anon;
grant execute on function public.mark_group_chat_read(uuid) to authenticated;

create or replace function public.set_group_chat_muted(grp uuid, muted boolean)
returns void language sql security definer set search_path = '' as $$
  update public.peek_group_members set chat_muted = muted where group_id = grp and user_id = auth.uid();
$$;
revoke execute on function public.set_group_chat_muted(uuid, boolean) from public, anon;
grant execute on function public.set_group_chat_muted(uuid, boolean) to authenticated;

-- For the Chat list: each of your groups with its unread count, the latest message and whether you muted it.
create or replace function public.my_group_chats()
returns table (group_id uuid, unread integer, last_body text, last_at timestamptz, last_sender uuid, muted boolean)
language sql stable security definer set search_path = '' as $$
  select m.group_id,
         (select count(*)::int from public.group_messages g
           where g.group_id = m.group_id and g.created_at > m.chat_read_at and g.sender_id <> m.user_id),
         last.body, last.created_at, last.sender_id, m.chat_muted
    from public.peek_group_members m
    left join lateral (
      select g.body, g.created_at, g.sender_id from public.group_messages g
       where g.group_id = m.group_id order by g.created_at desc limit 1
    ) last on true
   where m.user_id = auth.uid();
$$;
revoke execute on function public.my_group_chats() from public, anon;
grant execute on function public.my_group_chats() to authenticated;

-- Push to everyone else in the group (not muted, not blocked either way).
create or replace function private.push_group_message()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  member record;
  group_name text;
begin
  select name into group_name from public.peek_groups where id = new.group_id;
  for member in
    select m.user_id from public.peek_group_members m
     where m.group_id = new.group_id and m.user_id <> new.sender_id and not m.chat_muted
       and not private.is_blocked(m.user_id, new.sender_id)
  loop
    perform private.send_push(member.user_id, 'messages', '👯 ' || coalesce(group_name, 'Group'),
      private.push_name(new.sender_id) || ': ' || left(new.body, 120),
      jsonb_build_object('type', 'group_chat', 'group', new.group_id));
  end loop;
  return new;
end;
$$;
drop trigger if exists group_messages_push on public.group_messages;
create trigger group_messages_push after insert on public.group_messages
  for each row execute function private.push_group_message();

-- Live updates.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'group_messages'
  ) then
    alter publication supabase_realtime add table public.group_messages;
  end if;
end $$;
