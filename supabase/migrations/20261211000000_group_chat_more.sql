-- =====================================================================
-- Group chats, part 2 💬
--
-- * Photos, videos and voice notes in group chats (files live in your own "group" folder; everyone in the
--   group can open them, nobody else).
-- * Group dares 🎯: dare the whole group at once. Everyone posts their proof (a photo or video) in the chat,
--   and the dare card shows who has done it.
-- * "Typing…" in group chats: a private live channel only the group's members can join.
-- * Search inside a chat (1:1 or group): the app searches the text of your messages (the database rules
--   already decide which messages you can see).
-- "Seen by" uses each member's last-read time, which members of a group can already see.
-- =====================================================================

-- ---- New kinds of group message ----
alter table public.group_messages alter column body drop not null;
alter table public.group_messages drop constraint if exists group_messages_body_check;
alter table public.group_messages
  add column if not exists kind text not null default 'text'
    check (kind in ('text', 'photo', 'video', 'voice', 'dare', 'proof')),
  add column if not exists media_path text,
  add column if not exists media_type text check (media_type in ('photo', 'video')),
  add column if not exists poster_path text,
  add column if not exists overlay_path text,
  add column if not exists audio_ms integer,
  add column if not exists waveform integer[],
  -- A proof: the group dare it's for.
  add column if not exists dare_id uuid references public.group_messages (id) on delete cascade;

alter table public.group_messages drop constraint if exists group_messages_content;
alter table public.group_messages add constraint group_messages_content check (
  (kind = 'text' and body is not null and char_length(btrim(body)) between 1 and 2000 and media_path is null)
  or (kind in ('photo', 'video') and media_path is not null and (body is null or char_length(body) <= 500))
  or (kind = 'voice' and media_path like '%/voice/%' and audio_ms is not null)
  or (kind = 'dare' and body is not null and char_length(btrim(body)) between 1 and 200 and media_path is null)
  or (kind = 'proof' and dare_id is not null and media_path is not null)
);
-- Files must be your own (you can't point a message at someone else's file).
alter table public.group_messages drop constraint if exists group_messages_own_files;
alter table public.group_messages add constraint group_messages_own_files check (
  (media_path is null or split_part(media_path, '/', 1) = sender_id::text)
  and (poster_path is null or split_part(poster_path, '/', 1) = sender_id::text)
  and (overlay_path is null or split_part(overlay_path, '/', 1) = sender_id::text)
);
create index if not exists group_messages_dare_idx on public.group_messages (dare_id) where dare_id is not null;

-- A proof has to be for a dare in the same group.
create or replace function private.check_group_proof()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'proof' and not exists (
    select 1 from public.group_messages d where d.id = new.dare_id and d.kind = 'dare' and d.group_id = new.group_id
  ) then
    raise exception 'That dare is gone';
  end if;
  return new;
end;
$$;
drop trigger if exists group_messages_check_proof on public.group_messages;
create trigger group_messages_check_proof before insert on public.group_messages
  for each row execute function private.check_group_proof();

-- ---- Files: your own "group" folder ----
alter policy "You can upload your own photos" on storage.objects
  with check (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (storage.foldername(name))[2] in ('posts', 'stories', 'snaps', 'blurs', 'voice', 'keeps', 'group')
  );

create or replace function private.can_read_media(object_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  owner_text text := split_part(object_name, '/', 1);
  kind text := split_part(object_name, '/', 2);
  owner uuid;
begin
  if me is null then
    return false;
  end if;
  if owner_text = 'mystery' then
    return private.uploaded_by_me(object_name) or exists (
      select 1 from public.mystery_posts g
       where object_name in (g.media_path, g.poster_path, g.overlay_path)
         and private.can_see_mystery(g.user_id, g.expires_at, me)
    );
  end if;
  if owner_text = me::text then
    return true;                                      -- your own files
  end if;
  if owner_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  owner := owner_text::uuid;

  if kind = 'posts' then
    -- close-friends posts only for their close friends;
    -- a drop post's files only after you've posted your own drop that day ("give a peek to get a peek"),
    -- and only once every group you share with them has posted that day's drop
    return private.can_see_posts(owner)
      and not exists (
        select 1 from public.posts p
        where object_name in (p.media_path, p.poster_path, p.overlay_path)
          and not private.in_audience(p.user_id, p.audience)
      )
      and not exists (
        select 1 from public.posts p
        where object_name in (p.media_path, p.poster_path, p.overlay_path) and p.drop_day is not null
          and (
            not exists (select 1 from public.posts mine where mine.user_id = me and mine.drop_day = p.drop_day)
            or private.group_holds_drop(me, p.user_id, p.drop_day)
          )
      );
  elsif kind = 'blurs' then
    return private.can_see_posts(owner);
  elsif kind = 'stories' then
    return private.can_see_stories(owner)
      and exists (
        select 1 from public.stories s
        where object_name in (s.media_path, s.poster_path, s.overlay_path) and s.expires_at > now()
          and private.in_audience(s.user_id, s.audience)
      );
  elsif kind = 'snaps' then
    -- only the person it was sent to: before opening, while saved, or while the replay is unused
    return not private.is_blocked(owner, me)
      and exists (
        select 1 from public.messages m
        where object_name in (m.media_path, m.poster_path, m.overlay_path) and m.recipient_id = me
          and (
            m.opened_at is null
            or m.saved_at is not null
            or (m.replayed_at is null and m.opened_at > now() - interval '24 hours')
          )
      );
  elsif kind = 'voice' then
    -- voice notes: the person they were sent to (they stay in the chat, like texts), or everyone in the group
    -- chat they were sent to
    return not private.is_blocked(owner, me)
      and (
        exists (select 1 from public.messages m where m.media_path = object_name and m.recipient_id = me)
        or exists (
          select 1 from public.group_messages g
           where g.media_path = object_name and private.is_group_member(g.group_id, me)
        )
      );
  elsif kind = 'group' then
    -- photos and videos in a group chat: everyone in that group
    return exists (
      select 1 from public.group_messages g
       where object_name in (g.media_path, g.poster_path, g.overlay_path)
         and private.is_group_member(g.group_id, me)
    );
  end if;
  return false;
end;
$$;
-- ---- Pushes and the Chat list know the new kinds ----
create or replace function private.group_message_preview(kind text, body text)
returns text language sql immutable set search_path = '' as $$
  select case kind
    when 'photo' then '📷 Photo'
    when 'video' then '🎬 Video'
    when 'voice' then '🎤 Voice note'
    when 'dare' then '🎯 Dared the group: ' || left(body, 100)
    when 'proof' then '✅ Did the dare!'
    else left(body, 120)
  end;
$$;

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
      private.push_name(new.sender_id) || ': ' || private.group_message_preview(new.kind, new.body),
      jsonb_build_object('type', 'group_chat', 'group', new.group_id));
  end loop;
  return new;
end;
$$;

create or replace function public.my_group_chats()
returns table (group_id uuid, unread integer, last_body text, last_at timestamptz, last_sender uuid, muted boolean)
language sql stable security definer set search_path = '' as $$
  select m.group_id,
         (select count(*)::int from public.group_messages g
           where g.group_id = m.group_id and g.created_at > m.chat_read_at and g.sender_id <> m.user_id),
         private.group_message_preview(last.kind, last.body), last.created_at, last.sender_id, m.chat_muted
    from public.peek_group_members m
    left join lateral (
      select g.kind, g.body, g.created_at, g.sender_id from public.group_messages g
       where g.group_id = m.group_id order by g.created_at desc limit 1
    ) last on true
   where m.user_id = auth.uid();
$$;

-- ---- "Typing…" in group chats: channel  typing-group:<group id>  (members only) ----
create or replace function private.can_use_group_typing_topic(topic text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or topic !~ '^typing-group:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return private.is_group_member(split_part(topic, ':', 2)::uuid, auth.uid());
end;
$$;

drop policy if exists "Group members can see each other typing" on realtime.messages;
create policy "Group members can see each other typing"
  on realtime.messages for select to authenticated
  using (realtime.messages.extension = 'broadcast' and private.can_use_group_typing_topic((select realtime.topic())));

drop policy if exists "Group members can say they are typing" on realtime.messages;
create policy "Group members can say they are typing"
  on realtime.messages for insert to authenticated
  with check (realtime.messages.extension = 'broadcast' and private.can_use_group_typing_topic((select realtime.topic())));
