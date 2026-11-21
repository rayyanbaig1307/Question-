-- =====================================================================
-- Group snaps 📸, photos from the camera roll in 1:1 chats, and deleting or leaving a group
-- (the owner, 21 Nov 2026)
--
-- 1. GROUP SNAPS. A picture taken with the camera button inside a group chat is now a SNAP (like a 1:1 peek):
--    * it's a group_messages row with kind 'snap', and its files sit in the sender's own "snaps" folder;
--    * each person who was in the group when it was sent can open it ONCE and replay it ONCE, both within
--      24 hours of it being sent. Then it's gone for everyone;
--    * anyone who opened it (or the sender) can SAVE it in the chat. A saved snap is a normal photo that
--      everyone in the group can open again (until the person who saved it, or the sender, unsaves it);
--    * the file can only be downloaded for 5 minutes after the app's "open" (or "replay") step, and only by the
--      phone (login) that took that step. Old app versions never take that step, so they can never show an unsaved
--      snap – they get an empty frame, also on a second phone or tablet signed in to the same account;
--    * a screenshot of a snap tells its sender ("📸 Took a screenshot of your snap"), like a 1:1 peek;
--    * the daily cleanup deletes the files of a snap that wasn't saved, 8 days after it was sent
--      (24 hours to open it + 7 days for reports), unless a report still needs them;
--    * push and Chat list: "Name: 📸 Sent a snap".
--    Photos and videos picked from the camera roll, group dare proofs, group Guess Who and the public chat
--    stay exactly as they were.
-- 2. 1:1 CHATS. A picture picked from the camera roll is sent as a peek that is SAVED from the start – a
--    normal photo that never disappears. No new kind of message: every old app version already shows a saved
--    peek ("Saved peek · tap to view", no timer). The push says "Sent you a photo 📷".
-- 3. DELETE OR LEAVE A GROUP.
--    * The person who made the group can delete it any time. Anyone who is the only person left can delete it.
--      Everyone else can leave.
--    * When the last person leaves, the group is deleted. When the maker leaves, whoever has been in the group
--      longest becomes the maker.
--    * When a group is deleted, every photo, video and voice note of its chat goes to the daily cleanup (a file a
--      report still needs is kept for the report), and so does the group's picture.
--    * Groups that everybody had already left before this update are deleted now (the old app's "Leave group"
--      left them behind), and groups whose maker had left get the longest-standing member as their maker.
--
-- The app's side: src/lib/groupChat.ts, src/lib/chat.ts, src/lib/groups.ts.
-- Safe to run more than once.
-- =====================================================================
begin;
set local lock_timeout = '15s';

-- ---------------------------------------------------------------------
-- 1. Group snaps: the new kind of group message
-- ---------------------------------------------------------------------
-- Saved in the chat: when, and by whom. Only the server fills these in (set_group_snap_saved).
alter table public.group_messages
  add column if not exists saved_at timestamptz,
  add column if not exists saved_by uuid references public.profiles (id) on delete set null;

alter table public.group_messages drop constraint if exists group_messages_kind_check;
alter table public.group_messages add constraint group_messages_kind_check
  check (kind in ('text', 'photo', 'video', 'voice', 'dare', 'proof', 'sticker', 'snap'));

-- Same as 20261221000000_chat_stickers.sql, plus the snap: a photo or video whose files are all in the
-- sender's own "snaps" folder, with no text. (Every part of the snap rule is true or false, never "unknown",
-- because a check lets "unknown" through.)
alter table public.group_messages drop constraint if exists group_messages_content;
alter table public.group_messages add constraint group_messages_content check (
  (kind = 'text' and body is not null and char_length(btrim(body)) between 1 and 2000 and media_path is null)
  or (kind in ('photo', 'video') and media_path is not null and (body is null or char_length(body) <= 500))
  or (kind = 'voice' and media_path like '%/voice/%' and audio_ms is not null)
  or (kind = 'dare' and body is not null and char_length(btrim(body)) between 1 and 200 and media_path is null)
  or (kind = 'proof' and dare_id is not null and media_path is not null)
  or (kind = 'sticker' and sticker is not null and body is not null and char_length(body) between 1 and 80
      and media_path is null)
  or (kind = 'snap' and media_path is not null and split_part(media_path, '/', 2) = 'snaps'
      and (poster_path is null or split_part(poster_path, '/', 2) = 'snaps')
      and (overlay_path is null or split_part(overlay_path, '/', 2) = 'snaps')
      and media_type is not null and media_type in ('photo', 'video')
      and body is null and dare_id is null and audio_ms is null and waveform is null)
);

-- For the daily cleanup (old snaps) and for deleting an account (who saved what).
create index if not exists group_messages_snap_created_idx on public.group_messages (created_at) where kind = 'snap';
create index if not exists group_messages_saved_by_idx on public.group_messages (saved_by) where saved_by is not null;

-- A new message never arrives saved. Same as 20261216000000_group_dare_votes.sql (the server sets the time,
-- no votes), plus the two "saved" fields.
create or replace function private.prepare_group_message()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.created_at := now();
  new.proof_legit := 0;
  new.proof_cap := 0;
  new.proof_legacy := false;
  new.saved_at := null;
  new.saved_by := null;
  return new;
end;
$$;

-- Who opened which snap, and when they used their one replay. Only the functions below write it.
create table if not exists public.group_snap_opens (
  message_id uuid not null references public.group_messages (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  opened_at timestamptz not null default now(),
  replayed_at timestamptz,
  primary key (message_id, user_id)
);
-- Which login opened it (every signed-in phone or tablet has its own, see private.request_session), and when the
-- person took a screenshot of it (see group_snap_screenshot).
alter table public.group_snap_opens
  add column if not exists session_id text,
  add column if not exists screenshot_at timestamptz;
create index if not exists group_snap_opens_user_idx on public.group_snap_opens (user_id);
alter table public.group_snap_opens enable row level security;
-- You see your own opens. The sender sees who opened their snaps (not people blocked either way).
drop policy if exists "You see your opens, and who opened your snaps" on public.group_snap_opens;
create policy "You see your opens, and who opened your snaps"
  on public.group_snap_opens for select to authenticated
  using (
    user_id = (select auth.uid())
    or (exists (select 1 from public.group_messages g
                 where g.id = message_id and g.sender_id = (select auth.uid()))
        and not private.is_blocked(user_id, (select auth.uid())))
  );
revoke all on table public.group_snap_opens from anon;
revoke insert, update, delete, truncate, references, trigger on table public.group_snap_opens from authenticated;
-- The app may read every column except which login opened it (that stays on the server).
revoke select on table public.group_snap_opens from authenticated;
grant select (message_id, user_id, opened_at, replayed_at, screenshot_at) on table public.group_snap_opens to authenticated;

-- The login this request comes from. Every signed-in phone or tablet has its own (it stays the same when the login
-- refreshes itself). null when the request carries none.
create or replace function private.request_session()
returns text language sql stable set search_path = '' as $$
  select nullif(auth.jwt() ->> 'session_id', '');
$$;
revoke all on function private.request_session() from public, anon, authenticated;

-- Can `person` still open (or replay) this snap? A member who isn't blocked with the sender, who was in the group
-- when it was sent, and it's less than 24 hours old.
create or replace function private.group_snap_open_for(message uuid, person uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.group_messages g
      join public.peek_group_members m on m.group_id = g.group_id and m.user_id = person
     where g.id = message and g.kind = 'snap' and g.sender_id <> person
       and g.created_at > now() - interval '24 hours'
       and m.joined_at <= g.created_at
       and not private.is_blocked(g.sender_id, person)
  );
$$;
revoke all on function private.group_snap_open_for(uuid, uuid) from public, anon, authenticated;

-- Open a group snap. True = go ahead: you may download it for the next 5 minutes (your first open, which is
-- recorded now – or the snap is saved, which every member can open any time). False = no view left: you already
-- opened it (use your replay), it's over 24 hours old, you joined after it was sent, you sent it, you're not in the
-- group, or it's not a snap.
create or replace function public.open_group_snap(message uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'Please log in again';
  end if;
  -- A saved snap is a normal photo for everyone in the group (still remembered as "opened").
  if exists (select 1 from public.group_messages g
              where g.id = message and g.kind = 'snap' and g.saved_at is not null and g.sender_id <> me
                and private.in_group_message(g.id, me)) then
    insert into public.group_snap_opens (message_id, user_id, session_id) values (message, me, private.request_session())
      on conflict (message_id, user_id) do nothing;
    return true;
  end if;
  if not private.group_snap_open_for(message, me) then
    return false;
  end if;
  -- Remember which login opened it: only that phone may download it (see can_read_group_snap).
  insert into public.group_snap_opens (message_id, user_id, session_id) values (message, me, private.request_session())
    on conflict (message_id, user_id) do nothing;
  return found;
end;
$$;
revoke execute on function public.open_group_snap(uuid) from public, anon;
grant execute on function public.open_group_snap(uuid) to authenticated;

-- Use your one replay of a group snap (after opening it, within its 24 hours, while it isn't saved).
-- True = you may download it for the next 5 minutes.
create or replace function public.replay_group_snap(message uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'Please log in again';
  end if;
  -- The phone that replays it is the one that may download it now.
  update public.group_snap_opens o
     set replayed_at = now(), session_id = private.request_session()
   where o.message_id = message and o.user_id = me and o.replayed_at is null
     and private.group_snap_open_for(message, me)
     and exists (select 1 from public.group_messages g where g.id = message and g.saved_at is null);
  return found;
end;
$$;
revoke execute on function public.replay_group_snap(uuid) from public, anon;
grant execute on function public.replay_group_snap(uuid) to authenticated;

-- Save (or unsave) a group snap in the chat.
-- * Save: the sender, or anyone in the group who opened it, while it's less than 24 hours old.
-- * Unsave: the person who saved it, or the sender. (An unsaved snap over 24 hours old is gone at once.)
-- True = done; false = not allowed, or nothing to change.
create or replace function public.set_group_snap_saved(message uuid, save boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'Please log in again';
  end if;
  if save then
    update public.group_messages g
       set saved_at = now(), saved_by = me
     where g.id = message and g.kind = 'snap' and g.saved_at is null
       and g.created_at > now() - interval '24 hours'
       and private.in_group_message(g.id, me)
       and (g.sender_id = me
            or exists (select 1 from public.group_snap_opens o where o.message_id = g.id and o.user_id = me));
  else
    update public.group_messages g
       set saved_at = null, saved_by = null
     where g.id = message and g.kind = 'snap' and g.saved_at is not null
       and private.in_group_message(g.id, me)
       and (g.sender_id = me or g.saved_by = me);
  end if;
  return found;
end;
$$;
revoke execute on function public.set_group_snap_saved(uuid, boolean) from public, anon;
grant execute on function public.set_group_snap_saved(uuid, boolean) to authenticated;

-- You took a screenshot of a group snap you opened: its sender is told, like with a 1:1 peek – a push
-- "Name: 📸 Took a screenshot of your snap" (unless they muted the group chat, or left the group) and
-- "📸 Screenshot by Name" under the snap in their chat. Once per person per snap. Not for a saved snap (that's a
-- normal photo now), and not for your own. True = the sender was told; false = nothing to tell.
create or replace function public.group_snap_screenshot(message uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  snap record;
begin
  if me is null then
    raise exception 'Please log in again';
  end if;
  select g.group_id, g.sender_id into snap from public.group_messages g
   where g.id = message and g.kind = 'snap' and g.saved_at is null and g.sender_id <> me
     and private.in_group_message(g.id, me);
  if not found then
    return false;
  end if;
  -- Only someone who opened it, and only the first time.
  update public.group_snap_opens o set screenshot_at = now()
   where o.message_id = message and o.user_id = me and o.screenshot_at is null;
  if not found then
    return false;
  end if;
  if exists (select 1 from public.peek_group_members m
              where m.group_id = snap.group_id and m.user_id = snap.sender_id and not m.chat_muted) then
    perform private.send_push(snap.sender_id, 'messages',
      '👯 ' || coalesce((select g.name from public.peek_groups g where g.id = snap.group_id), 'Group'),
      private.push_name(me) || ': 📸 Took a screenshot of your snap',
      jsonb_build_object('type', 'group_chat', 'group', snap.group_id));
  end if;
  return true;
end;
$$;
revoke execute on function public.group_snap_screenshot(uuid) from public, anon;
grant execute on function public.group_snap_screenshot(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Who may download a group snap's file
-- ---------------------------------------------------------------------
-- A group snap's files are in the sender's "snaps" folder (like a 1:1 peek), so the "group" rule (every member,
-- any time) never applies to them. Allowed: everyone in the group (not blocked with the sender) while it's saved;
-- otherwise only for 5 minutes after you opened or replayed it, and only on the phone (login) you did that on.
-- (Someone signed in on a phone with the new app and on a tablet with an old one: opening it on the phone doesn't
-- let the tablet's old app show it as a normal photo. A request that carries no login at all can't come from a
-- signed-in phone – every app login has one – so then the 5 minutes alone decide.)
create or replace function private.can_read_group_snap(object_name text, owner uuid, me uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select not private.is_blocked(owner, me) and exists (
    select 1 from public.group_messages g
     where g.sender_id = owner and g.kind = 'snap'
       and object_name in (g.media_path, g.poster_path, g.overlay_path)
       and private.is_group_member(g.group_id, me)
       and (g.saved_at is not null or exists (
         select 1 from public.group_snap_opens o
          where o.message_id = g.id and o.user_id = me
            and greatest(o.opened_at, o.replayed_at) > now() - interval '5 minutes'
            and (o.session_id is null or private.request_session() is null
                 or o.session_id = private.request_session())))
  );
$$;
revoke all on function private.can_read_group_snap(text, uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Old group snaps go to the daily cleanup
-- ---------------------------------------------------------------------
-- Files of disappearing media. Same as 20261213200000_qa_review_media_fixes.sql (no later migration changed
-- it), plus group snaps that weren't saved and were sent over 8 days ago (24 hours to open them, then the same
-- 7 days for reports as every other disappearing file).
create or replace function private.expired_media_paths()
returns setof text language sql stable security definer set search_path = '' as $$
  select unnest(array[s.media_path, s.poster_path, s.overlay_path]) from public.stories s
    where s.expires_at < now() - interval '7 days'
  union all
  select unnest(array[g.media_path, g.poster_path, g.overlay_path]) from public.mystery_posts g
    where g.expires_at < now() - interval '7 days'
  union all
  select unnest(array[m.media_path, m.poster_path, m.overlay_path]) from public.messages m
    where m.kind = 'snap' and m.opened_at < now() - interval '7 days' and m.saved_at is null
  union all
  select unnest(array[g.media_path, g.poster_path, g.overlay_path]) from public.group_messages g
    where g.kind = 'snap' and g.created_at < now() - interval '8 days' and g.saved_at is null;
$$;

-- May the daily cleanup delete this file now? Same as 20261213200000_qa_review_media_fixes.sql (no later
-- migration changed it), plus the old group snaps above.
create or replace function private.media_cleanup_eligible(path_value text)
returns boolean language sql stable security definer set search_path = '' as $$
  select not private.media_held_as_evidence(path_value) and (
    -- Its owner already deleted it while a report needed it.
    (private.media_deletion_deferred(path_value) and not private.media_path_in_use(path_value, 1))
    -- Old disappearing media: expired stories / Guess Who, opened peeks nobody saved, old group snaps.
    or (not private.media_path_in_use(path_value, 7) and (
      exists (select 1 from public.stories s
        where (s.media_path = path_value or s.poster_path = path_value or s.overlay_path = path_value)
          and s.expires_at < now() - interval '7 days')
      or exists (select 1 from public.mystery_posts g
        where (g.media_path = path_value or g.poster_path = path_value or g.overlay_path = path_value)
          and g.expires_at < now() - interval '7 days')
      or exists (select 1 from public.messages m
        where (m.media_path = path_value or m.poster_path = path_value or m.overlay_path = path_value)
          and m.kind = 'snap' and m.opened_at < now() - interval '7 days' and m.saved_at is null)
      or exists (select 1 from public.group_messages g
        where (g.media_path = path_value or g.poster_path = path_value or g.overlay_path = path_value)
          and g.kind = 'snap' and g.created_at < now() - interval '8 days' and g.saved_at is null)
    ))
  );
$$;

-- ---------------------------------------------------------------------
-- 4. Two existing functions each get one change, in place
-- ---------------------------------------------------------------------
-- * private.can_read_media: the group snap rule above, just before the 1:1 peek rule;
-- * private.media_path_in_use: a group snap's file is only "in use" while it's saved, or until a day (plus the
--   cleanup's waiting days) after it was sent – every other group message's file stays in use while its row is
--   there, as before.
-- Both were changed by later migrations (the public chat added lines, the drop unlock changed can_read_media), so
-- instead of copying them here (and risking an old copy) this reads each one as it is now, changes it at one known
-- spot, and saves it back. If the spot isn't there exactly once, the whole migration stops and nothing is changed.
-- Running it again does nothing (it sees its own change).
do $patch$
declare
  item record;
  body text;
begin
  for item in
    select * from (values
      ('private.can_read_media(text)'::regprocedure, 'can_read_group_snap',
       $a$  elsif kind = 'snaps' then$a$,
       $b$  elsif kind = 'snaps' and private.can_read_group_snap(object_name, owner, me) then
    return true;
  elsif kind = 'snaps' then$b$),
      ('private.media_path_in_use(text,integer)'::regprocedure, 'g.saved_at is not null',
       -- (The group chat line. The Guess Who line below it has a "(" after "where", so it doesn't match.)
       $a$where g.media_path = path_value or g.poster_path = path_value or g.overlay_path = path_value)$a$,
       $b$where (g.media_path = path_value or g.poster_path = path_value or g.overlay_path = path_value)
        and (g.kind <> 'snap' or g.saved_at is not null
          or g.created_at >= now() - interval '1 day' - make_interval(days => retention_days)))$b$)
    ) as t(fn, marker, anchor, replacement)
  loop
    body := pg_get_functiondef(item.fn);
    if position(item.marker in body) > 0 then
      continue;
    end if;
    if position(item.anchor in body) = 0
       or (char_length(body) - char_length(replace(body, item.anchor, ''))) / char_length(item.anchor) <> 1 then
      raise exception 'group snaps: could not find the one spot to change in %', item.fn;
    end if;
    execute replace(body, item.anchor, item.replacement);
  end loop;
end;
$patch$;

-- ---------------------------------------------------------------------
-- 5. Push and Chat list: "📸 Sent a snap"
-- ---------------------------------------------------------------------
-- Same as 20261221000000_chat_stickers.sql, plus the snap. The push reads "Name: 📸 Sent a snap".
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
    when 'snap' then '📸 Sent a snap'
    else left(body, 120)
  end;
$$;

-- ---------------------------------------------------------------------
-- 6. 1:1 chats: a photo from the camera roll is a peek that's saved from the start
-- ---------------------------------------------------------------------
-- Same as 20261213102659_qa_round2_security_hardening.sql, except: when you send a peek yourself and ask for it to
-- be saved (the app sends any saved_at), it arrives saved by you – now. Every other new message still arrives
-- unsaved, unopened and unreplayed. (You could already save your own peek right after sending it; this just does
-- it in the same step, so it never shows up as a disappearing peek, not even for a moment.)
create or replace function private.prepare_message_state()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.sender_id=auth.uid() then
    new.created_at:=now();
    new.opened_at:=null;
  end if;
  if new.kind = 'snap' and new.saved_at is not null and new.sender_id = auth.uid() then
    new.saved_at := now();
    new.saved_by := new.sender_id;
  else
    new.saved_at:=null;
    new.saved_by:=null;
  end if;
  new.replayed_at:=null;
  return new;
end;
$$;

-- Same as 20261221000000_chat_stickers.sql, except a peek that arrives saved says "Sent you a photo 📷".
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
      when 'snap' then case when new.saved_at is not null then 'Sent you a photo 📷' else 'Sent you a peek 👀' end
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

-- ---------------------------------------------------------------------
-- 7. Deleting and leaving a group
-- ---------------------------------------------------------------------
-- The group's maker: the person who made it while they're still in it – otherwise whoever has been in it
-- longest (so a group never ends up with nobody who can delete it).
create or replace function private.group_maker(grp uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select g.created_by from public.peek_groups g
      where g.id = grp
        and exists (select 1 from public.peek_group_members m where m.group_id = grp and m.user_id = g.created_by)),
    (select m.user_id from public.peek_group_members m where m.group_id = grp order by m.joined_at, m.user_id limit 1)
  );
$$;
revoke all on function private.group_maker(uuid) from public, anon, authenticated;

-- Groups whose maker left (or deleted their account) before this update: whoever has been in the group longest
-- becomes its maker now – the same person the rule above picks. (From now on the trigger below does this when
-- someone leaves.)
update public.peek_groups g
   set created_by = private.group_maker(g.id)
 where (g.created_by is null
        or not exists (select 1 from public.peek_group_members m where m.group_id = g.id and m.user_id = g.created_by))
   and exists (select 1 from public.peek_group_members m where m.group_id = g.id);

-- The members of your groups. Same as 20261105000000_group_peek.sql (no later migration changed it), except that
-- people who joined at the very same moment (everyone picked when the group was made) now always come in the same
-- order: by their id, like private.group_maker. The app takes the first one in this list as the maker when the
-- maker isn't in the group (src/lib/groups.ts, groupMaker), so the app and the server pick the same person.
create or replace function public.peek_group_status(day date, only_group uuid default null)
returns table (group_id uuid, user_id uuid, joined_day date, posted boolean, post_id uuid, posted_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select m.group_id, m.user_id, m.joined_day, d.id is not null, d.id, d.created_at
    from public.peek_group_members m
    left join public.posts d on d.user_id = m.user_id and d.drop_day = day
   where private.is_group_member(m.group_id, auth.uid())
     and (only_group is null or m.group_id = only_group)
   order by m.joined_at, m.user_id;
$$;
revoke execute on function public.peek_group_status(date, uuid) from public, anon;
grant execute on function public.peek_group_status(date, uuid) to authenticated;

-- Delete a group for everyone: its chat, dares, proofs, Guess Whos and members go with it (their files go to the
-- daily cleanup, see below). The maker can, any time; anyone who is the only person left can too.
create or replace function public.delete_peek_group(grp uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'Please log in again';
  end if;
  -- The group first (like adding people, and like the old direct delete), so nobody joins or leaves halfway.
  perform 1 from public.peek_groups g where g.id = grp for update;
  if not found or not private.is_group_member(grp, me) then
    raise exception 'This group is gone';
  end if;
  if (select count(*) from public.peek_group_members m where m.group_id = grp) > 1
     and private.group_maker(grp) is distinct from me then
    raise exception 'Only the person who made this group can delete it. You can leave it instead.';
  end if;
  delete from public.peek_groups g where g.id = grp;
end;
$$;
revoke execute on function public.delete_peek_group(uuid) from public, anon;
grant execute on function public.delete_peek_group(uuid) to authenticated;

-- Leave a group. Returns 'left', or 'deleted' when you were the last one (then the group is deleted).
-- (Handing the group over when the maker leaves, and deleting it when nobody is left, happen in the trigger below.)
create or replace function public.leave_peek_group(grp uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'Please log in again';
  end if;
  -- The group first, so two people leaving at the same moment take turns (and the last one out deletes it).
  perform 1 from public.peek_groups g where g.id = grp for update;
  if not found or not private.is_group_member(grp, me) then
    raise exception 'This group is gone';
  end if;
  delete from public.peek_group_members m where m.group_id = grp and m.user_id = me;
  if exists (select 1 from public.peek_groups g where g.id = grp) then
    return 'left';
  end if;
  return 'deleted';
end;
$$;
revoke execute on function public.leave_peek_group(uuid) from public, anon;
grant execute on function public.leave_peek_group(uuid) to authenticated;

-- After someone leaves a group (with leave_peek_group, the old app's "Leave group", being taken out, or deleting
-- their account):
-- * nobody left → the group is deleted;
-- * the maker left (or is gone) → whoever has been in the group longest becomes the maker.
-- The usual case (someone else left, the maker is still in) changes nothing and locks nothing. Otherwise the group
-- row is locked first, but only if nobody else is holding it right now ("skip locked"): this runs after a member
-- row was already taken, and waiting for the group here could wait forever against a group delete that holds the
-- group and waits for that member row. Whoever is holding the group (leave_peek_group, delete_peek_group, adding
-- people) deals with it themselves, or it's done the next time someone leaves. leave_peek_group and
-- delete_peek_group hold the group already, so for them it always runs.
create or replace function private.after_group_member_left()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  maker uuid;
  longest uuid;
begin
  -- The whole group is being deleted: nothing to do.
  select g.created_by into maker from public.peek_groups g where g.id = old.group_id;
  if not found then
    return null;
  end if;
  if maker is not null and maker <> old.user_id
     and exists (select 1 from public.peek_group_members m where m.group_id = old.group_id and m.user_id = maker) then
    return null;
  end if;
  perform 1 from public.peek_groups g where g.id = old.group_id for update skip locked;
  if not found then
    return null;
  end if;
  select m.user_id into longest from public.peek_group_members m
   where m.group_id = old.group_id order by m.joined_at, m.user_id limit 1;
  if longest is null then
    delete from public.peek_groups g where g.id = old.group_id;
  else
    update public.peek_groups g set created_by = longest
     where g.id = old.group_id
       and (g.created_by is null or not exists (
         select 1 from public.peek_group_members m where m.group_id = old.group_id and m.user_id = g.created_by));
  end if;
  return null;
end;
$$;
revoke all on function private.after_group_member_left() from public, anon, authenticated;
drop trigger if exists peek_group_members_after_leave on public.peek_group_members;
create trigger peek_group_members_after_leave after delete on public.peek_group_members
  for each row execute function private.after_group_member_left();

-- When a group is deleted, every file of its chat goes to the daily cleanup. The same as when someone deletes a
-- file in the app (private.guard_claimed_media_delete) and as group Guess Who photos
-- (private.queue_group_mystery_files): the file is remembered for the cleanup and looks deleted from now on; a file
-- a report still needs is kept for the report (private.media_cleanup_eligible says no); a file something else still
-- uses is left alone. A message deleted while its group is still there (you deleting your own) is not touched here:
-- the app cleans those up, as before.
create or replace function private.queue_deleted_group_files()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  path_value text;
begin
  if exists (select 1 from public.peek_groups g where g.id = old.group_id) then
    return null;
  end if;
  for path_value in
    select distinct p from unnest(array[old.media_path, old.poster_path, old.overlay_path]) p
     where p is not null order by p
  loop
    if exists (select 1 from storage.objects o where o.bucket_id = 'media' and o.name = path_value)
       and not private.media_path_in_use(path_value, 1) then
      insert into private.media_cleanup_claims(object_name, reason) values (path_value, 'client')
        on conflict (object_name) do nothing;
      insert into private.media_deferred_deletions(object_name) values (path_value)
        on conflict (object_name) do nothing;
    end if;
  end loop;
  return null;
end;
$$;
revoke all on function private.queue_deleted_group_files() from public, anon, authenticated;
drop trigger if exists group_messages_queue_files on public.group_messages;
create trigger group_messages_queue_files after delete on public.group_messages
  for each row when (old.media_path is not null or old.poster_path is not null or old.overlay_path is not null)
  execute function private.queue_deleted_group_files();

-- A group's picture is in the public "avatars" storage, like profile pictures. When a group is deleted, or its picture
-- is changed or taken off, the old picture is put on this list, and the daily cleanup (supabase/functions/
-- cleanup-media, with claim_avatar_cleanup below) deletes it from storage. Not when something still uses that very
-- file: the app could also have made it someone's profile picture or another group's picture.
create table if not exists private.avatar_deferred_deletions (
  object_name text primary key,
  queued_at timestamptz not null default now()
);
revoke all on table private.avatar_deferred_deletions from public, anon, authenticated;

-- Is this picture still someone's profile picture or a group's picture?
create or replace function private.avatar_in_use(path_value text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.avatar_path = path_value)
      or exists (select 1 from public.peek_groups g where g.photo_path = path_value);
$$;
revoke all on function private.avatar_in_use(text) from public, anon, authenticated;

create or replace function private.queue_old_group_photo()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.photo_path is not distinct from old.photo_path then
    return null;
  end if;
  -- (The group's own row is already gone or changed here, so only other uses count.)
  if not private.avatar_in_use(old.photo_path) then
    insert into private.avatar_deferred_deletions(object_name) values (old.photo_path)
      on conflict (object_name) do nothing;
  end if;
  return null;
end;
$$;
revoke all on function private.queue_old_group_photo() from public, anon, authenticated;
drop trigger if exists peek_groups_queue_old_photo on public.peek_groups;
create trigger peek_groups_queue_old_photo after delete or update of photo_path on public.peek_groups
  for each row when (old.photo_path is not null)
  execute function private.queue_old_group_photo();

-- For the daily cleanup only (it runs with the service key): the old group pictures to delete from the "avatars"
-- storage now. Pictures that are in use again, or are already gone from storage, are taken off the list first – so
-- once the cleanup has deleted a picture, the next day's run forgets it.
create or replace function public.claim_avatar_cleanup(max_files integer default 1000)
returns table (name text) language plpgsql security definer set search_path = '' as $$
begin
  delete from private.avatar_deferred_deletions d
   where private.avatar_in_use(d.object_name)
      or not exists (select 1 from storage.objects o where o.bucket_id = 'avatars' and o.name = d.object_name);
  return query
    select d.object_name from private.avatar_deferred_deletions d
     order by d.queued_at, d.object_name
     limit greatest(0, least(coalesce(max_files, 1000), 1000));
end;
$$;
revoke execute on function public.claim_avatar_cleanup(integer) from public, anon, authenticated;
grant execute on function public.claim_avatar_cleanup(integer) to service_role;

-- Groups that everyone had already left before this update (the old app's "Leave group" didn't delete a group when
-- the last person left): delete them now, so their chat files and picture go to the daily cleanup too (the triggers
-- above). A file a report still needs is kept for the report, as always.
delete from public.peek_groups g
 where not exists (select 1 from public.peek_group_members m where m.group_id = g.id);

-- ---------------------------------------------------------------------
-- 8. App users never call these helpers themselves (the functions above still use them)
-- ---------------------------------------------------------------------
revoke execute on function private.prepare_group_message() from public, anon, authenticated;
revoke execute on function private.prepare_message_state() from public, anon, authenticated;
revoke execute on function private.push_new_message() from public, anon, authenticated;
revoke execute on function private.group_message_preview(text, text) from public, anon, authenticated;
revoke execute on function private.expired_media_paths() from public, anon, authenticated;
revoke execute on function private.media_cleanup_eligible(text) from public, anon, authenticated;
revoke execute on function private.request_session() from public, anon, authenticated;
revoke execute on function private.avatar_in_use(text) from public, anon, authenticated;
revoke execute on function private.queue_old_group_photo() from public, anon, authenticated;

commit;
