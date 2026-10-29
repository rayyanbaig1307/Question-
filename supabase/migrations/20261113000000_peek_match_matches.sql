-- =====================================================================
-- Peek Match – step 4: matches and the match chat
--
-- * When two people like each other, it's a match, and they get a Peek Match chat.
-- * "Likes you": people who liked you and are waiting for an answer (like back = match).
-- * In the chat, each other's photos start blurred and unblur once you've BOTH sent
--   5 messages.
-- * Unmatch, block and report in every chat. Unmatching hides the chat from both of
--   you (the messages are kept only so reports can be checked, and are deleted when
--   either of you leaves Peek Match).
-- * Chat messages only carry dating ids, never normal account ids.
-- =====================================================================

create table public.dating_matches (
  id uuid primary key default gen_random_uuid(),
  user_a uuid not null references public.dating_members (user_id) on delete cascade,
  user_b uuid not null references public.dating_members (user_id) on delete cascade,
  created_at timestamptz not null default now(),
  ended_at timestamptz,                         -- unmatched
  check (user_a < user_b),
  unique (user_a, user_b)
);
alter table public.dating_matches enable row level security;
-- (Only used through the functions below – the rows hold normal account ids.)

create table public.dating_messages (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.dating_matches (id) on delete cascade,
  sender uuid not null references public.dating_members (dating_id) on delete cascade,   -- a dating id
  body text not null check (char_length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index dating_messages_match_idx on public.dating_messages (match_id, created_at desc);
alter table public.dating_messages enable row level security;

-- Are you in this (still running) match?
create or replace function private.in_match(match uuid, person uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.dating_matches mt
     where mt.id = match and mt.ended_at is null and person in (mt.user_a, mt.user_b)
       and private.in_peek_match(person)
       and not private.dating_blocked(mt.user_a, mt.user_b)
  );
$$;

create or replace function private.match_partner(match uuid, person uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select case when mt.user_a = person then mt.user_b else mt.user_a end
    from public.dating_matches mt where mt.id = match and person in (mt.user_a, mt.user_b);
$$;

-- You can read the messages of your own matches (this is also what lets new messages pop in live).
create policy "You can read your match chats"
  on public.dating_messages for select to authenticated
  using (private.in_match(match_id, (select auth.uid())));

alter publication supabase_realtime add table public.dating_messages;

-- Like one photo or one prompt of someone (with an optional comment).
-- If they'd already liked you, it's a match! Returns 'match' or 'liked'.
create or replace function public.peek_match_like(target uuid, liked_photo uuid default null, liked_prompt smallint default null, note text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  them uuid := private.dating_user(target);
  new_match uuid;
begin
  if them is null or not private.dating_visible(me, them) or not private.dating_fits(me, them) then
    raise exception 'This person isn''t in Peek Match any more';
  end if;
  if (liked_photo is null) = (liked_prompt is null) then
    raise exception 'Like one photo or one prompt';
  end if;
  if liked_photo is not null and not exists (select 1 from public.dating_photos ph where ph.id = liked_photo and ph.user_id = them) then
    raise exception 'That photo is gone';
  end if;
  if liked_prompt is not null and not exists (select 1 from public.dating_prompts pr where pr.user_id = them and pr.position = liked_prompt) then
    raise exception 'That prompt is gone';
  end if;
  insert into public.dating_likes (from_user, to_user, kind, photo_id, prompt_position, comment)
  values (me, them, 'like', liked_photo, liked_prompt, nullif(btrim(left(note, 200)), ''))
  on conflict (from_user, to_user) do nothing;
  if exists (select 1 from public.dating_likes l where l.from_user = them and l.to_user = me and l.kind = 'like') then
    insert into public.dating_matches (user_a, user_b) values (least(me, them), greatest(me, them))
    on conflict (user_a, user_b) do nothing
    returning id into new_match;
    if new_match is not null then
      perform private.send_push(them, 'likes', 'It''s a match! 💘', 'You matched in Peek Match – say hi!',
        jsonb_build_object('type', 'peek-match-chat', 'match', new_match));
    end if;
    return 'match';
  end if;
  perform private.send_push(them, 'likes', 'Peek Match 💘', 'Someone liked your dating profile',
    jsonb_build_object('type', 'peek-match'));
  return 'liked';
end;
$$;
revoke execute on function public.peek_match_like(uuid, uuid, smallint, text) from public, anon;
grant execute on function public.peek_match_like(uuid, uuid, smallint, text) to authenticated;


-- Your matches: the other person's dating profile, how many messages each of you has sent (photos unblur at
-- 5 each), the last message and how many you haven't read. Newest chats first. `only` = just one match.
create or replace function public.peek_match_matches(only_match uuid default null)
returns setof jsonb language sql stable security definer set search_path = '' as $$
  with me as (select auth.uid() as id, private.my_dating_id() as dating_id),
  mine as (
    select mt.id, mt.created_at, case when mt.user_a = me.id then mt.user_b else mt.user_a end as other
      from public.dating_matches mt, me
     where me.id in (mt.user_a, mt.user_b) and (only_match is null or mt.id = only_match)
       and private.in_match(mt.id, me.id)
  )
  select jsonb_build_object(
    'match_id', mine.id,
    'created_at', mine.created_at,
    'person', private.dating_card(me.id, mine.other),
    'my_count', (select count(*) from public.dating_messages d where d.match_id = mine.id and d.sender = me.dating_id),
    'their_count', (select count(*) from public.dating_messages d where d.match_id = mine.id and d.sender <> me.dating_id),
    'unread', (select count(*) from public.dating_messages d
                where d.match_id = mine.id and d.sender <> me.dating_id and d.read_at is null),
    'last', (select jsonb_build_object('body', d.body, 'mine', d.sender = me.dating_id, 'created_at', d.created_at)
               from public.dating_messages d where d.match_id = mine.id order by d.created_at desc limit 1)
  )
  from mine, me
  order by coalesce((select max(d.created_at) from public.dating_messages d where d.match_id = mine.id), mine.created_at) desc;
$$;
revoke execute on function public.peek_match_matches(uuid) from public, anon;
grant execute on function public.peek_match_matches(uuid) to authenticated;

-- People who liked you and are waiting for your answer: their profile, what they liked and their comment.
create or replace function public.peek_match_likes_me()
returns setof jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'person', private.dating_card(auth.uid(), l.from_user),
    'comment', l.comment,
    'liked_photo', (select ph.path from public.dating_photos ph where ph.id = l.photo_id),
    'liked_prompt', (select pr.prompt from public.dating_prompts pr where pr.user_id = auth.uid() and pr.position = l.prompt_position),
    'created_at', l.created_at
  )
  from public.dating_likes l
  where l.to_user = auth.uid() and l.kind = 'like'
    and not exists (select 1 from public.dating_likes back where back.from_user = auth.uid() and back.to_user = l.from_user)
    and private.dating_visible(auth.uid(), l.from_user)
  order by l.created_at desc
  limit 50;
$$;
revoke execute on function public.peek_match_likes_me() from public, anon;
grant execute on function public.peek_match_likes_me() to authenticated;

-- Send a message in a match chat.
create or replace function public.peek_match_send(match uuid, message text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  them uuid;
  my_name text;
begin
  if not private.in_match(match, me) then
    raise exception 'This match has ended';
  end if;
  insert into public.dating_messages (match_id, sender, body) values (match, private.my_dating_id(), btrim(message));
  them := private.match_partner(match, me);
  select name into my_name from public.dating_profiles where user_id = me;
  perform private.send_push(them, 'messages', coalesce(my_name, 'Your match') || ' 💘', left(btrim(message), 140),
    jsonb_build_object('type', 'peek-match-chat', 'match', match));
end;
$$;
revoke execute on function public.peek_match_send(uuid, text) from public, anon;
grant execute on function public.peek_match_send(uuid, text) to authenticated;

-- Opening a match chat marks their messages as read.
create or replace function public.peek_match_read(match uuid)
returns void language sql security definer set search_path = '' as $$
  update public.dating_messages
     set read_at = now()
   where match_id = match and read_at is null and sender <> private.my_dating_id()
     and private.in_match(match, auth.uid());
$$;
revoke execute on function public.peek_match_read(uuid) from public, anon;
grant execute on function public.peek_match_read(uuid) to authenticated;

-- Unmatch: the chat disappears for both of you.
create or replace function public.peek_match_unmatch(match uuid)
returns void language sql security definer set search_path = '' as $$
  update public.dating_matches
     set ended_at = now()
   where id = match and auth.uid() in (user_a, user_b) and ended_at is null;
$$;
revoke execute on function public.peek_match_unmatch(uuid) from public, anon;
grant execute on function public.peek_match_unmatch(uuid) to authenticated;

-- Matched photos stay visible to each other (e.g. after one of you hides your profile).
create or replace function private.can_see_dating_photo(object_name text, viewer uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.dating_photos ph
     where ph.path = object_name
       and (
         private.dating_visible(viewer, ph.user_id)
         or exists (
           select 1 from public.dating_matches mt
            where mt.user_a = least(viewer, ph.user_id) and mt.user_b = greatest(viewer, ph.user_id)
              and private.in_match(mt.id, viewer)
         )
       )
  );
$$;
