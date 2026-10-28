-- =====================================================================
-- Peeks: replay once, save in chat. Chat: "is typing…".
--
-- Rules:
-- * After opening a peek you get ONE replay, within 24 hours.
-- * Either person in the chat can save a peek (press and hold it). A saved peek
--   stays: both of you can open it any time, until one of you unsaves it.
-- * The photo file is kept for 24 hours after opening (so it can be replayed or
--   saved), then the sender's app deletes it – unless it's saved.
-- * "Typing…" signals only go between two friends, through a private live channel.
-- =====================================================================

alter table public.messages
  add column replayed_at timestamptz,                  -- when the one replay was used
  add column saved_at timestamptz,                     -- when it was saved in chat (empty = not saved)
  add column saved_by uuid references public.profiles (id) on delete set null;

-- Who may download a photo from the private "media" bucket?
-- Same as before, except peeks: also while saved, or while the one replay is still unused.
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
  if owner_text = me::text then
    return true;                                      -- your own files
  end if;
  if owner_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  owner := owner_text::uuid;

  if kind = 'posts' then
    return private.can_see_posts(owner);
  elsif kind = 'stories' then
    return private.can_see_stories(owner)
      and exists (
        select 1 from public.stories s
        where s.media_path = object_name and s.expires_at > now()
      );
  elsif kind = 'snaps' then
    -- only the person it was sent to: before opening, while saved, or while the replay is unused
    return not private.is_blocked(owner, me)
      and exists (
        select 1 from public.messages m
        where m.media_path = object_name and m.recipient_id = me
          and (
            m.opened_at is null
            or m.saved_at is not null
            or (m.replayed_at is null and m.opened_at > now() - interval '24 hours')
          )
      );
  end if;
  return false;
end;
$$;

-- Use your one replay of a peek. Returns false if there's no replay left.
create or replace function public.replay_snap(message_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.messages
     set replayed_at = now()
   where id = message_id and recipient_id = auth.uid() and kind = 'snap'
     and opened_at is not null and replayed_at is null and saved_at is null
     and opened_at > now() - interval '24 hours';
  return found;
end;
$$;
revoke execute on function public.replay_snap(uuid) from public, anon;
grant execute on function public.replay_snap(uuid) to authenticated;

-- Save (or unsave) a peek in the chat. Either person in the chat can do it.
-- Saving only works while the photo is still kept (not opened yet, or opened in the last 24 hours).
create or replace function public.set_snap_saved(message_id uuid, save boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if save then
    update public.messages
       set saved_at = now(), saved_by = auth.uid()
     where id = message_id and kind = 'snap' and saved_at is null
       and auth.uid() in (sender_id, recipient_id)
       and not private.is_blocked(sender_id, recipient_id)
       and (opened_at is null or opened_at > now() - interval '24 hours');
  else
    update public.messages
       set saved_at = null, saved_by = null
     where id = message_id and kind = 'snap' and saved_at is not null
       and auth.uid() in (sender_id, recipient_id);
  end if;
  return found;
end;
$$;
revoke execute on function public.set_snap_saved(uuid, boolean) from public, anon;
grant execute on function public.set_snap_saved(uuid, boolean) to authenticated;

-- "Typing…" goes through the live channel  typing:<friend id>:<friend id>  (the two ids sorted).
-- Only those two people may join it, and only while they're friends and nobody blocked anybody.
create or replace function private.can_use_typing_topic(topic text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  a uuid;
  b uuid;
begin
  if me is null or topic !~ '^typing:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  a := split_part(topic, ':', 2)::uuid;
  b := split_part(topic, ':', 3)::uuid;
  return me in (a, b) and a <> b and private.are_friends(a, b) and not private.is_blocked(a, b);
end;
$$;

create policy "Friends can see each other typing"
  on realtime.messages for select to authenticated
  using (realtime.messages.extension = 'broadcast' and private.can_use_typing_topic((select realtime.topic())));

create policy "Friends can say they are typing"
  on realtime.messages for insert to authenticated
  with check (realtime.messages.extension = 'broadcast' and private.can_use_typing_topic((select realtime.topic())));
