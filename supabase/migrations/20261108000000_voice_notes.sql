-- =====================================================================
-- Voice notes in chat (+ room for story reactions)
--
-- * A voice note is a chat message of kind 'voice': the recording lives in your
--   own "voice" folder, with its length and a little waveform (up to 64 bars,
--   each 0–100) so the chat can draw it without downloading the sound first.
-- * Kind 'reaction' is added now too (an emoji sent from a friend's story), so the
--   message rules only need changing once.
-- =====================================================================

alter table public.messages
  add column if not exists audio_ms integer check (audio_ms between 0 and 120000),
  add column if not exists waveform smallint[] check (cardinality(waveform) <= 64);

alter table public.messages drop constraint messages_kind_check;
alter table public.messages add constraint messages_kind_check
  check (kind in ('text', 'snap', 'screenshot', 'voice', 'reaction'));

alter table public.messages drop constraint messages_content;
alter table public.messages add constraint messages_content check (
  (kind = 'text' and body is not null and char_length(body) > 0)
  or (kind = 'snap' and media_path is not null)
  or (kind = 'screenshot' and body in ('chat', 'peek') and media_path is null)
  or (kind = 'voice' and media_path like '%/voice/%' and audio_ms is not null)
  or (kind = 'reaction' and body is not null and char_length(body) between 1 and 16 and media_path is null)
);

-- Voice notes go in your own "voice" folder.
alter policy "You can message your friends" on public.messages
  with check (
    sender_id = (select auth.uid())
    and opened_at is null
    and private.are_friends(sender_id, recipient_id)
    and not private.is_blocked(sender_id, recipient_id)
    and (
      media_path is null
      or media_path like (select auth.uid())::text || '/snaps/%'
      or (kind = 'voice' and media_path like (select auth.uid())::text || '/voice/%')
    )
    and (poster_path is null or poster_path like (select auth.uid())::text || '/snaps/%')
    and (overlay_path is null or overlay_path like (select auth.uid())::text || '/snaps/%')
  );

alter policy "You can upload your own photos" on storage.objects
  with check (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (storage.foldername(name))[2] in ('posts', 'stories', 'snaps', 'blurs', 'voice')
  );

-- The photo store also takes voice recordings (.m4a).
update storage.buckets
   set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime',
                                  'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac']
 where id = 'media';

-- Opening a chat marks everything they sent you as read (except peeks, which are opened one by one).
create or replace function public.mark_chat_read(friend uuid)
returns void language sql security definer set search_path = '' as $$
  update public.messages
     set opened_at = now()
   where sender_id = friend and recipient_id = auth.uid()
     and kind in ('text', 'screenshot', 'voice', 'reaction') and opened_at is null;
$$;

-- Notification text for the new kinds.
create or replace function private.push_new_message()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
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
      else 'New message'
    end,
    jsonb_build_object('type', 'message', 'from', new.sender_id)
  );
  return new;
end;
$$;

-- Media rules: same as before, plus voice notes for the person they were sent to.
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
    -- a drop post's files only after you've posted your own drop that day ("give a peek to get a peek"),
    -- and only once every group you share with them has posted that day's drop
    return private.can_see_posts(owner)
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
    -- voice notes: the person they were sent to (they stay in the chat, like texts)
    return not private.is_blocked(owner, me)
      and exists (select 1 from public.messages m where m.media_path = object_name and m.recipient_id = me);
  end if;
  return false;
end;
$$;
