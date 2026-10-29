-- =====================================================================
-- Reactions on stories
--
-- While watching a friend's story you can tap 😂 🔥 😍 😮 👀. It arrives in your chat
-- with them as a message of kind 'reaction' (allowed since the voice notes update),
-- remembering which story it was for (story_id, emptied when the story is deleted).
-- =====================================================================

alter table public.messages
  add column if not exists story_id uuid references public.stories (id) on delete set null;

-- A reaction can only point at a story by the person you're sending it to.
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
    and (
      story_id is null
      or (kind = 'reaction' and exists (select 1 from public.stories s where s.id = story_id and s.user_id = recipient_id))
    )
  );
