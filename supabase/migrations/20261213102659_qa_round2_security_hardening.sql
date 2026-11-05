-- Fresh QA of b0dc637: preserve group chat, OAuth and cleanup while repairing
-- recurrent and newly introduced privacy and integrity failures.
-- This migration follows the last existing 20261212 migration deliberately.
-- QA fixes: keep drafts private, keep anonymous reports anonymous, and make
-- daily limits and auth throttling decisions inside one database transaction.
begin;

-- A file in a posts folder is not public just because its owner is public.
-- It must still belong to a visible post. This also protects files left over
-- when a delete/upload is interrupted before Storage cleanup completes.
create or replace function private.can_read_media(object_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  owner_text text := split_part(object_name, '/', 1);
  kind text := split_part(object_name, '/', 2);
  owner uuid;
begin
  if me is null then return false; end if;
  if owner_text = 'mystery' then
    return private.uploaded_by_me(object_name) or exists (
      select 1 from public.mystery_posts g
      where object_name in (g.media_path, g.poster_path, g.overlay_path)
        and private.can_see_mystery(g.user_id, g.expires_at, me)
    );
  end if;
  if owner_text = me::text then return true; end if;
  if owner_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  owner := owner_text::uuid;
  if kind = 'posts' then
    return private.can_see_posts(owner)
      and exists (
        select 1 from public.posts p
        where p.user_id = owner and object_name in (p.media_path,p.poster_path,p.overlay_path)
          and private.in_audience(p.user_id,p.audience)
      )
      and not exists (
        select 1 from public.posts p
        where p.user_id = owner and object_name in (p.media_path,p.poster_path,p.overlay_path)
          and (
            not private.in_audience(p.user_id,p.audience)
            or (p.drop_day is not null and (
              not exists (select 1 from public.posts mine where mine.user_id=me and mine.drop_day=p.drop_day)
              or private.group_holds_drop(me,p.user_id,p.drop_day)
            ))
          )
      );
  elsif kind = 'blurs' then
    return private.can_see_posts(owner) and exists (
      select 1 from public.posts p where p.user_id=owner and p.blur_path=object_name
        and private.in_audience(p.user_id,p.audience)
    );
  elsif kind = 'stories' then
    return private.can_see_stories(owner) and exists (
      select 1 from public.stories s where s.user_id=owner
        and object_name in (s.media_path,s.poster_path,s.overlay_path)
        and s.expires_at>now() and private.in_audience(s.user_id,s.audience)
    );
  elsif kind = 'snaps' then
    return not private.is_blocked(owner,me) and exists (
      select 1 from public.messages m where m.sender_id=owner
        and object_name in (m.media_path,m.poster_path,m.overlay_path) and m.recipient_id=me
        and (m.opened_at is null or m.saved_at is not null
          or (m.replayed_at is null and m.opened_at>now()-interval '24 hours'))
    );
  elsif kind = 'voice' then
    return not private.is_blocked(owner,me) and (
      exists (select 1 from public.messages m where m.sender_id=owner
        and m.media_path=object_name and m.recipient_id=me)
      or exists (select 1 from public.group_messages g where g.sender_id=owner
        and g.media_path=object_name and private.is_group_member(g.group_id,me))
    );
  elsif kind = 'group' then
    return not private.is_blocked(owner,me) and exists (
      select 1 from public.group_messages g where g.sender_id=owner
        and object_name in(g.media_path,g.poster_path,g.overlay_path)
        and private.is_group_member(g.group_id,me)
    );
  end if;
  return false;
end;
$$;

-- Editing a caption must not let someone attach another person's stored files.
alter policy "You can edit your own posts" on public.posts
  with check (
    user_id=(select auth.uid())
    and media_path like (select auth.uid())::text || '/posts/%'
    and (blur_path is null or blur_path like (select auth.uid())::text || '/blurs/%')
    and (poster_path is null or poster_path like (select auth.uid())::text || '/posts/%')
    and (overlay_path is null or overlay_path like (select auth.uid())::text || '/posts/%')
  );

-- Reports must retain the real account for moderators without disclosing it to
-- the person who reports an anonymous Guess Who post.
alter table public.reports add column anonymous_content boolean not null default false;
update public.reports set anonymous_content=true where details='Guess Who (anonymous) post';
alter policy "You can see your own reports" on public.reports
  using (reporter_id=(select auth.uid()) and not anonymous_content);
alter policy "You can report" on public.reports
  with check (reporter_id=(select auth.uid()) and not anonymous_content);

create or replace function public.report_mystery(post uuid, reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  real_poster uuid;
begin
  select g.user_id into real_poster from public.mystery_posts g
    where g.id=post and private.can_see_mystery(g.user_id,now()+interval '1 second',me);
  if real_poster is null then raise exception 'This Guess Who is gone'; end if;
  insert into public.reports (reporter_id,reported_user_id,content_type,content_id,reason,details,anonymous_content)
    values (me,real_poster,'post',post,left(reason,100),'Guess Who (anonymous) post',true);
end;
$$;

-- Guess Who follows the same strict 24-hour clock as stories.
create trigger mystery_posts_set_expiry before insert on public.mystery_posts
  for each row execute function private.set_story_expiry();

-- Display times and initial workflow states come from the server.
create or replace function private.prepare_post_timestamp()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op='INSERT' then new.created_at:=now();
  else new.created_at:=old.created_at;
  end if;
  return new;
end;
$$;
create trigger posts_prepare_timestamp before insert or update on public.posts
  for each row execute function private.prepare_post_timestamp();

create or replace function private.prepare_report()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.status:='open';
  new.created_at:=now();
  return new;
end;
$$;
create trigger reports_prepare before insert on public.reports
  for each row execute function private.prepare_report();

create or replace function private.prepare_message_state()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.sender_id=auth.uid() then
    new.created_at:=now();
    new.opened_at:=null;
  end if;
  new.saved_at:=null;
  new.saved_by:=null;
  new.replayed_at:=null;
  return new;
end;
$$;
create trigger messages_prepare_state before insert on public.messages
  for each row execute function private.prepare_message_state();

-- Two rows in the same INSERT used to both pass the unpaid check before the
-- after-insert trigger ran. A unique constraint also covers parallel requests.
-- If older duplicate rows exist, stop for review instead of deleting any data.
create unique index posts_one_payment_per_forfeit on public.posts(forfeit_id)
  where forfeit_id is not null;

-- PostgreSQL CHECK accepts NULL. Explicitly require the fields these message
-- kinds need, otherwise a voice message with no recording used to save.
alter table public.messages add constraint messages_voice_content_required
  check (kind<>'voice' or (media_path is not null and media_path like '%/voice/%' and audio_ms is not null)) not valid;
alter table public.messages add constraint messages_screenshot_content_required
  check (kind<>'screenshot' or (body is not null and body in ('chat','peek') and media_path is null)) not valid;

create or replace function private.valid_waveform(bars smallint[])
returns boolean language sql immutable set search_path = '' as $$
  select bars is null or (
    cardinality(bars)<=64 and not exists (
      select 1 from unnest(bars) bar where bar is null or bar<0 or bar>100
    )
  );
$$;
alter table public.messages add constraint messages_waveform_values
  check (private.valid_waveform(waveform)) not valid;

-- These fields are managed by votes/moderation/the daily picker, never by a new
-- suggestion's author. Lock one author's quota while checking it; this also
-- catches several suggestions in one INSERT statement.
create or replace function private.prepare_dare_idea()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('dare-idea:' || new.user_id::text,0));
  if exists (select 1 from public.dare_ideas where user_id=new.user_id and created_at>now()-interval '24 hours') then
    raise exception 'You can suggest one dare a day';
  end if;
  new.votes:=0;
  new.hidden:=false;
  new.used_on:=null;
  new.created_at:=now();
  return new;
end;
$$;
create trigger dare_ideas_prepare before insert on public.dare_ideas
  for each row execute function private.prepare_dare_idea();

-- Updating a counter directly takes a row lock, avoiding stale counts when
-- different people vote at the same time.
create or replace function private.count_dare_votes()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op='INSERT' then
    update public.dare_ideas set votes=votes+1 where id=new.idea_id;
  else
    update public.dare_ideas set votes=greatest(0,votes-1) where id=old.idea_id;
  end if;
  return null;
end;
$$;
update public.dare_ideas d set votes=(select count(*) from public.dare_votes v where v.idea_id=d.id);

-- The Edge Function must reserve a place BEFORE attempting a login/signup.
-- Keeping the count and insert under the same lock stops parallel requests
-- slipping through. This helper is available only to the server role.
create or replace function public.reserve_username_auth_attempt(
  attempt_kind text, attempt_key text, max_attempts integer, window_minutes integer
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if attempt_kind is null or attempt_kind not in ('signup','fail')
     or attempt_key is null or char_length(attempt_key) not between 1 and 256
     or max_attempts is null or max_attempts not between 1 and 100
     or window_minutes is null or window_minutes not between 1 and 1440 then
    raise exception 'Invalid throttle arguments';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('username-auth:' || attempt_kind || ':' || attempt_key,0));
  delete from public.username_auth_log where kind=attempt_kind and key=attempt_key and created_at<now()-interval '24 hours';
  if (select count(*) from public.username_auth_log
      where kind=attempt_kind and key=attempt_key and created_at>now()-make_interval(mins=>window_minutes)) >= max_attempts then
    return false;
  end if;
  insert into public.username_auth_log(kind,key) values (attempt_kind,attempt_key);
  return true;
end;
$$;
revoke execute on function public.reserve_username_auth_attempt(text,text,integer,integer) from public,anon,authenticated;
grant execute on function public.reserve_username_auth_attempt(text,text,integer,integer) to service_role;

-- Account deletion must also find uploads whose post row was already removed.
-- The server supplies the authenticated account id; ordinary app users cannot
-- call this helper or learn who owns an anonymous upload.
create or replace function public.account_mystery_files(account uuid)
returns table(path text) language sql stable security invoker set search_path = '' as $$
  select o.name from storage.objects o
  where o.bucket_id='media' and o.name like 'mystery/%' and o.owner_id=account::text
  order by o.name;
$$;
revoke execute on function public.account_mystery_files(uuid) from public,anon,authenticated;
grant execute on function public.account_mystery_files(uuid) to service_role;

-- A notification is a side effect. If its queue is unavailable, the user's
-- message, friend request or like must still save successfully.
create or replace function private.send_push(target uuid, kind text, title text, body text, data jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  allowed boolean;
  batch jsonb;
begin
  if target is null then return; end if;
  select case kind
    when 'messages' then p.messages
    when 'friend_requests' then p.friend_requests
    when 'likes' then p.likes
    when 'comments' then p.comments
    when 'drops' then p.drops
    else true
  end into allowed from public.notification_prefs p where p.user_id=target;
  if allowed is false then return; end if;
  select jsonb_agg(jsonb_build_object(
    'to',t.token,'title',title,'body',body,'data',data,'sound','default','channelId','default'
  )) into batch from public.push_tokens t where t.user_id=target;
  if batch is null then return; end if;
  begin
    perform net.http_post(
      url:='https://exp.host/--/api/v2/push/send',
      body:=batch,
      headers:='{"Content-Type":"application/json","Accept":"application/json"}'::jsonb
    );
  exception when others then
    raise warning 'Push notification could not be queued';
  end;
end;
$$;

create or replace function public.hit_up(target uuid, note text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  problem text;
  theirs uuid;
  clean text := nullif(btrim(note), '');
begin
  if me is null then
    raise exception 'Please log in again';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('hit-up-pair:' || least(me,target)::text || ':' || greatest(me,target)::text,0));
  if char_length(clean) > 150 then
    raise exception 'Keep it to 150 letters';
  end if;
  if private.age_group(me) is distinct from 'adult' then
    raise exception 'Hit ups are only for people 18 and over';
  end if;

  -- They already hit you up: this is a hit back (their own setting doesn't matter – they reached out).
  select id into theirs from public.hit_ups where from_user = target and to_user = me and status = 'pending';
  if theirs is not null and not private.is_blocked(me, target) and not private.are_friends(me, target) then
    perform private.connect_hit_up(theirs);
    if clean is not null then
      perform set_config('peekaboo.quiet_push', 'on', true);
      insert into public.messages (sender_id, recipient_id, kind, body) values (me, target, 'text', clean);
      perform set_config('peekaboo.quiet_push', 'off', true);
    end if;
    perform private.send_push(target, 'friend_requests', '👋 ' || private.push_name(me) || ' hit you back!',
      'You can chat now – say hi', jsonb_build_object('type', 'message', 'from', me));
    return 'connected';
  end if;

  problem := private.hit_up_problem(me, target);
  if problem = 'self' then
    raise exception 'That''s you 😄';
  elsif problem = 'no_birthday' then
    raise exception 'Add your birthday first (Settings → Birthday) – hit ups are only for people 18 and over';
  elsif problem = 'under_18' then
    raise exception 'Hit ups are only for people 18 and over';
  elsif problem = 'friends' then
    raise exception 'You''re already friends – just send a message';
  elsif problem = 'their_birthday' then
    raise exception 'They haven''t added their birthday yet, so they can''t get hit ups – ask them to add it in Settings → Birthday';
  elsif problem is not null then
    raise exception 'Hit ups aren''t available for this person';
  end if;

  if exists (select 1 from public.hit_ups where from_user = me and to_user = target) then
    raise exception 'You already hit them up – it''s up to them now';
  end if;
  if (select count(*) from public.hit_ups where from_user = me and created_at > now() - interval '24 hours') >= 10 then
    raise exception 'You''ve used your 10 hit ups for today – try again tomorrow';
  end if;

  insert into public.hit_ups (from_user, to_user, message) values (me, target, clean);
  perform private.send_push(target, 'friend_requests', '👋 ' || private.push_name(me) || ' hit you up',
    coalesce(left(clean, 140), 'Tap to see who it is'), jsonb_build_object('type', 'hitups'));
  return 'sent';
end;
$$;


-- Quotas are checked again under a lock at the actual write. A client can have
-- several requests in flight after all of them passed an earlier RPC check.
create or replace function private.enforce_hit_up_quota()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('hit-up-quota:' || new.from_user::text,0));
  if (select count(*) from public.hit_ups where from_user=new.from_user and created_at>now()-interval '24 hours')>=10 then
    raise exception 'You have used your 10 hit ups for today';
  end if;
  new.created_at:=now();
  return new;
end;
$$;
create trigger hit_ups_enforce_quota before insert on public.hit_ups
  for each row execute function private.enforce_hit_up_quota();

create or replace function private.enforce_group_size()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.peek_groups where id=new.group_id for update;
  if exists(select 1 from public.peek_group_members where group_id=new.group_id and user_id=new.user_id) then return new; end if;
  if (select count(*) from public.peek_group_members where group_id=new.group_id)>=12 then
    raise exception 'A group can have up to 12 people';
  end if;
  return new;
end;
$$;
create trigger peek_group_members_enforce_size before insert on public.peek_group_members
  for each row execute function private.enforce_group_size();

create or replace function private.enforce_nudge_cooldown()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('nudge:' || new.group_id::text || ':' || new.from_id::text || ':' || new.to_id::text,0));
  if exists(select 1 from public.nudges where group_id=new.group_id and from_id=new.from_id and to_id=new.to_id and created_at>now()-interval '15 minutes') then
    raise exception 'You just nudged them - give them a minute';
  end if;
  new.created_at:=now();
  return new;
end;
$$;
create trigger nudges_enforce_cooldown before insert on public.nudges
  for each row execute function private.enforce_nudge_cooldown();

create or replace function public.respond_hit_up(hit uuid, accept boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  h public.hit_ups%rowtype;
begin
  select * into h from public.hit_ups
    where id=hit and to_user=me and status='pending' and ignored_at is null
    for update;
  if h.id is null then raise exception 'This hit up is gone'; end if;
  if not accept then
    update public.hit_ups set ignored_at=now(),responded_at=now() where id=h.id;
    return;
  end if;
  if private.is_blocked(me,h.from_user) or private.age_group(me) is distinct from 'adult'
     or private.age_group(h.from_user) is distinct from 'adult' then
    raise exception 'This hit up is gone';
  end if;
  perform private.connect_hit_up(h.id);
  perform private.send_push(h.from_user,'friend_requests','👋 ' || private.push_name(me) || ' hit you back!',
    'You can chat now - say hi',jsonb_build_object('type','message','from',me));
end;
$$;

create or replace function private.connect_hit_up(hit uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  h public.hit_ups%rowtype;
begin
  select * into h from public.hit_ups where id = hit for update;
  if h.id is null or h.status <> 'pending' then raise exception 'This hit up is gone'; end if;
  if auth.uid() is null or auth.uid() not in (h.from_user,h.to_user) or private.is_blocked(h.from_user,h.to_user) or private.age_group(h.from_user) is distinct from 'adult' or private.age_group(h.to_user) is distinct from 'adult' then raise exception 'This hit up is gone'; end if;
  perform set_config('peekaboo.quiet_push', 'on', true);
  update public.hit_ups set status = 'accepted', responded_at = now() where id = h.id;
  -- A friend request one of them already sent becomes a friendship; otherwise start one.
  update public.friendships
     set status = 'accepted', accepted_at = now()
   where status = 'pending'
     and ((requester_id = h.from_user and addressee_id = h.to_user) or (requester_id = h.to_user and addressee_id = h.from_user));
  if not private.are_friends(h.from_user, h.to_user) then
    insert into public.friendships (requester_id, addressee_id, status, accepted_at)
    values (h.from_user, h.to_user, 'accepted', now())
    on conflict do nothing;
  end if;
  insert into public.messages (sender_id, recipient_id, kind, body, created_at, opened_at)
  values (h.from_user, h.to_user, 'text', coalesce(nullif(btrim(h.message), ''), '👋'), h.created_at, now());
  perform set_config('peekaboo.quiet_push', 'off', true);
end;
$$;




-- =====================================================================
-- Activity 🔔: what happened to you in the last 30 days, newest first, shown at the top of Chat.
-- * Someone liked your post, commented on it, replied to your comment, or liked your comment.
-- * Someone added you (public account), accepted your friend request, or hit you back.
-- Nothing new is stored: it's read from the likes, comments, friendships and hit ups that already exist.
-- People you blocked (or who blocked you) never show up. Your own actions never show up.
-- =====================================================================

create or replace function public.my_activity()
returns table (
  kind text,            -- 'like' · 'comment' · 'reply' · 'comment_like' · 'added_you' · 'accepted' · 'hit_back'
  at timestamptz,
  actor_id uuid,
  actor_username text,
  actor_name text,
  actor_avatar text,
  post_id uuid,         -- the post it's about (likes and comments), so the app can open it
  snippet text          -- the start of the comment, for comments and replies
) language sql stable security definer set search_path = '' as $$
  with me as (select auth.uid() as id),
  since as (select now() - interval '30 days' as t),
  events as (
    -- Likes on your posts.
    select 'like'::text as kind, l.created_at as at, l.user_id as actor, p.id as post, null::text as snippet
      from public.likes l join public.posts p on p.id = l.post_id
     where p.user_id = (select id from me) and l.created_at > (select t from since)
    union all
    -- Comments on your posts (top-level ones and replies under them).
    select case when c.parent_id is null then 'comment' else 'reply' end, c.created_at, c.user_id, p.id, left(c.body, 80)
      from public.comments c join public.posts p on p.id = c.post_id
     where p.user_id = (select id from me) and c.created_at > (select t from since)
    union all
    -- Replies to your comments on someone else's post.
    select 'reply', c.created_at, c.user_id, c.post_id, left(c.body, 80)
      from public.comments c
      join public.comments parent on parent.id = c.parent_id
      join public.posts p on p.id = c.post_id
     where parent.user_id = (select id from me) and p.user_id <> (select id from me)
       and c.created_at > (select t from since)
    union all
    -- Likes on your comments.
    select 'comment_like', cl.created_at, cl.user_id, c.post_id, left(c.body, 80)
      from public.comment_likes cl join public.comments c on c.id = cl.comment_id
     where c.user_id = (select id from me) and cl.created_at > (select t from since)
    union all
    -- Friends: they added you (a public account is added straight away), or they accepted your request.
    -- Friendships made by a hit back are left out here (they show as 'hit_back' instead).
    select case when f.requester_id = (select id from me) then 'accepted' else 'added_you' end,
           f.accepted_at,
           case when f.requester_id = (select id from me) then f.addressee_id else f.requester_id end,
           null, null
      from public.friendships f
     where f.status = 'accepted' and f.accepted_at > (select t from since)
       and (
         -- They added you: they sent it and it was accepted straight away (no request for you to answer).
         (f.addressee_id = (select id from me) and f.accepted_at - f.created_at < interval '5 seconds')
         -- They accepted the request you sent.
         or (f.requester_id = (select id from me) and f.accepted_at - f.created_at >= interval '5 seconds')
       )
       and not exists (
         select 1 from public.hit_ups h
          where h.status = 'accepted'
            and ((h.from_user = f.requester_id and h.to_user = f.addressee_id)
              or (h.from_user = f.addressee_id and h.to_user = f.requester_id))
       )
    union all
    -- They hit you back.
    select 'hit_back', h.responded_at, h.to_user, null, null
      from public.hit_ups h
     where h.from_user = (select id from me) and h.status = 'accepted' and h.responded_at > (select t from since)
  )
  select e.kind, e.at, e.actor, pr.username, pr.display_name, pr.avatar_path, e.post, e.snippet
    from events e
    join public.profiles pr on pr.id = e.actor
   where e.actor <> (select id from me)
     and not private.is_blocked((select id from me), e.actor)
     and (e.post is null or private.can_see_post(e.post))
   order by e.at desc
   limit 60;
$$;
revoke execute on function public.my_activity() from public, anon;
grant execute on function public.my_activity() to authenticated;

create or replace function public.claim_chat_dare(dare uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  m public.messages%rowtype;
begin
  select * into m from public.messages where id = dare and kind = 'dare' and recipient_id = me and private.are_friends(sender_id,recipient_id) and not private.is_blocked(sender_id,recipient_id) for update;
  if m.id is null then
    raise exception 'This dare is gone';
  end if;
  if m.dare_state = 'done' then
    return 'done';
  end if;
  if m.dare_state = 'claimed' then
    return 'claimed';
  end if;
  update public.messages set dare_state = 'claimed', dare_claimed_at = now() where id = m.id;
  perform private.send_push(m.sender_id, 'messages', '🎯 ' || private.push_name(me) || ' did your dare!',
    'Tap to check the proof and confirm it ✅', jsonb_build_object('type', 'message', 'from', me));
  return 'claimed';
end;
$$;
revoke execute on function public.claim_chat_dare(uuid) from public, anon;
grant execute on function public.claim_chat_dare(uuid) to authenticated;

-- The one who sent the dare confirms it (ok = true) or says it doesn't count (ok = false).
-- Returns the new streak (0 when it didn't count).
create or replace function public.confirm_chat_dare(dare uuid, ok boolean)
returns int language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  m public.messages%rowtype;
  streak int;
begin
  select * into m from public.messages where id = dare and kind = 'dare' and sender_id = me and private.are_friends(sender_id,recipient_id) and not private.is_blocked(sender_id,recipient_id) for update;
  if m.id is null then
    raise exception 'This dare is gone';
  end if;
  if m.dare_state is distinct from 'claimed' then
    raise exception 'They haven''t said they did it yet';
  end if;
  if ok then
    update public.messages set dare_state = 'done', dare_done_at = now() where id = m.id;
    streak := private.dare_streak(me, m.recipient_id);
    perform private.send_push(m.recipient_id, 'messages', '✅ Dare completed!',
      private.push_name(me) || ' confirmed it' || case when streak > 1 then ' · 🔥 ' || streak || ' dare streak' else '' end
        || ' – dare them back!',
      jsonb_build_object('type', 'message', 'from', me));
    return streak;
  end if;
  update public.messages set dare_state = 'nope', dare_claimed_at = null where id = m.id;
  perform private.send_push(m.recipient_id, 'messages', '❌ ' || private.push_name(me) || ' says that doesn''t count',
    'Try the dare again 🎯', jsonb_build_object('type', 'message', 'from', me));
  return 0;
end;
$$;
revoke execute on function public.confirm_chat_dare(uuid, boolean) from public, anon;
grant execute on function public.confirm_chat_dare(uuid, boolean) to authenticated;

-- Deleted-for-me messages must stay hidden through direct reads and search too.
alter policy "You can see messages you sent or received" on public.messages
  using ((select auth.uid()) in(sender_id,recipient_id) and not exists(
    select 1 from public.message_hides h where h.message_id=id and h.user_id=(select auth.uid())
  ));

-- Blocks have the same meaning for group text/photos/reactions as group voice
-- and push notifications. Group membership itself is not changed by a block.
alter policy "Members can read their group chats" on public.group_messages
  using(private.is_group_member(group_id,(select auth.uid())) and not private.is_blocked(sender_id,(select auth.uid())));
create or replace function private.in_message(message uuid,person uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.messages m where m.id=message and person in(m.sender_id,m.recipient_id)
    and private.are_friends(m.sender_id,m.recipient_id) and not private.is_blocked(m.sender_id,m.recipient_id)
    and not exists(select 1 from public.message_hides h where h.message_id=m.id and h.user_id=person));
$$;
create or replace function private.in_group_message(message uuid,person uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.group_messages g where g.id=message
    and private.is_group_member(g.group_id,person) and not private.is_blocked(g.sender_id,person));
$$;
alter policy "Members see reactions in their group chats" on public.group_message_reactions
  using(private.in_group_message(message_id,(select auth.uid())) and not private.is_blocked(user_id,(select auth.uid())));

create or replace function public.my_group_chats()
returns table(group_id uuid,unread integer,last_body text,last_at timestamptz,last_sender uuid,muted boolean)
language sql stable security definer set search_path='' as $$
  select m.group_id,
    (select count(*)::int from public.group_messages g where g.group_id=m.group_id
      and g.created_at>m.chat_read_at and g.sender_id<>m.user_id and not private.is_blocked(g.sender_id,m.user_id)),
    private.group_message_preview(last.kind,last.body),last.created_at,last.sender_id,m.chat_muted
  from public.peek_group_members m
  left join lateral(select g.kind,g.body,g.created_at,g.sender_id from public.group_messages g
    where g.group_id=m.group_id and not private.is_blocked(g.sender_id,m.user_id)
    order by g.created_at desc limit 1) last on true
  where m.user_id=auth.uid();
$$;

create or replace function public.pin_group_message(grp uuid,message uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not private.is_group_member(grp,auth.uid()) then raise exception 'You are not in this group';end if;
  if message is not null and not exists(select 1 from public.group_messages g where g.id=message
      and g.group_id=grp and private.in_group_message(g.id,auth.uid())) then raise exception 'That message is gone';end if;
  update public.peek_groups set pinned_message_id=message,pinned_by=case when message is null then null else auth.uid() end where id=grp;
end;
$$;

create or replace function private.prepare_group_message()
returns trigger language plpgsql set search_path='' as $$
begin new.created_at:=now();return new;end;
$$;
create trigger group_messages_prepare before insert on public.group_messages
  for each row execute function private.prepare_group_message();
create or replace function private.valid_group_waveform(bars integer[])
returns boolean language sql immutable set search_path='' as $$
  select bars is null or(cardinality(bars)<=64 and not exists(select 1 from unnest(bars) bar where bar is null or bar<0 or bar>100));
$$;
alter table public.group_messages add constraint group_messages_voice_required
  check(kind<>'voice' or(media_path is not null and media_path like '%/voice/%' and audio_ms is not null and audio_ms between 0 and 120000)) not valid;
alter table public.group_messages add constraint group_messages_waveform_valid
  check(private.valid_group_waveform(waveform)) not valid;
alter table public.group_messages add constraint group_messages_body_size
  check(body is null or char_length(body)<=2000) not valid;
alter table public.group_messages add constraint group_messages_media_kind
  check((kind<>'photo' or(media_type is not null and media_type='photo'))
    and(kind<>'video' or(media_type is not null and media_type='video'))
    and(kind<>'proof' or(media_type is not null and media_type in('photo','video')))) not valid;

alter table public.reports drop constraint reports_content_type_check;
alter table public.reports add constraint reports_content_type_check
  check(content_type in('user','post','story','message','comment','dare_idea','group_message'));

-- Cleanup uses a logical deletion boundary: Storage commits its metadata
-- transaction before deleting bytes. Recheck claimed files at that boundary,
-- while reports and new references hold the same path lock.
create table private.media_cleanup_claims(
  object_name text primary key,
  reason text not null check(reason in('daily','client')),
  claimed_at timestamptz not null default now()
);
create table private.account_media_deletions(
  user_id uuid primary key references auth.users(id) on delete cascade,
  expires_at timestamptz not null
);
-- Keep the evidence path even after an author removes the visible content row.
-- The deferred FK permits the BEFORE INSERT report trigger to save its paths
-- atomically before the report row itself has been inserted.
create table private.report_media_evidence(
  report_id uuid not null references public.reports(id) on delete cascade deferrable initially deferred,
  object_name text not null,
  primary key(report_id,object_name)
);
create index report_media_evidence_path on private.report_media_evidence(object_name);
alter table private.media_cleanup_claims enable row level security;
alter table private.account_media_deletions enable row level security;
alter table private.report_media_evidence enable row level security;
revoke all on table private.media_cleanup_claims,private.account_media_deletions,private.report_media_evidence from public,anon,authenticated;
grant all on table private.media_cleanup_claims,private.account_media_deletions,private.report_media_evidence to service_role;
create or replace function public.begin_account_media_deletion(account uuid)
returns void language sql security definer set search_path='' as $$
  insert into private.account_media_deletions(user_id,expires_at) values(account,now()+interval '10 minutes')
    on conflict(user_id) do update set expires_at=excluded.expires_at;
$$;
revoke execute on function public.begin_account_media_deletion(uuid) from public,anon,authenticated;
grant execute on function public.begin_account_media_deletion(uuid) to service_role;

create or replace function private.media_cleanup_safe(path_value text,retention_days integer)
returns boolean language sql stable security definer set search_path='' as $$
  select
    not exists(select 1 from private.report_media_evidence e where e.object_name=path_value)
    and
    not exists(select 1 from public.posts p where path_value in(p.media_path,p.poster_path,p.overlay_path,p.blur_path))
    and not exists(select 1 from public.keeps k where path_value in(k.media_path,k.poster_path,k.overlay_path))
    and not exists(select 1 from public.group_messages g where path_value in(g.media_path,g.poster_path,g.overlay_path))
    and not exists(select 1 from public.stories s where path_value in(s.media_path,s.poster_path,s.overlay_path)
      and(s.expires_at>=now()-interval '7 days' or exists(select 1 from public.reports r where r.content_id=s.id)))
    and not exists(select 1 from public.mystery_posts g where path_value in(g.media_path,g.poster_path,g.overlay_path)
      and(g.expires_at>=now()-interval '7 days' or exists(select 1 from public.reports r where r.content_id=g.id)))
    and not exists(select 1 from public.messages m where path_value in(m.media_path,m.poster_path,m.overlay_path)
      and(m.kind<>'snap' or m.opened_at is null or m.opened_at>=now()-make_interval(days=>retention_days)
        or m.saved_at is not null or exists(select 1 from public.reports r where r.content_id=m.id)));
$$;

create or replace function private.media_cleanup_eligible(path_value text)
returns boolean language sql stable security definer set search_path='' as $$
  select private.media_cleanup_safe(path_value,7) and(
    exists(select 1 from public.stories s where path_value in(s.media_path,s.poster_path,s.overlay_path)
      and s.expires_at<now()-interval '7 days')
    or exists(select 1 from public.mystery_posts g where path_value in(g.media_path,g.poster_path,g.overlay_path)
      and g.expires_at<now()-interval '7 days')
    or exists(select 1 from public.messages m where path_value in(m.media_path,m.poster_path,m.overlay_path)
      and m.kind='snap' and m.opened_at<now()-interval '7 days' and m.saved_at is null)
  );
$$;

create or replace function public.media_cleanup_candidates(max_files integer default 500)
returns table(name text) language sql stable security definer set search_path='' as $$
  with dead as(
    select unnest(array[s.media_path,s.poster_path,s.overlay_path]) as path from public.stories s where s.expires_at<now()-interval '7 days'
    union all
    select unnest(array[g.media_path,g.poster_path,g.overlay_path]) from public.mystery_posts g where g.expires_at<now()-interval '7 days'
    union all
    select unnest(array[m.media_path,m.poster_path,m.overlay_path]) from public.messages m
      where m.kind='snap' and m.opened_at<now()-interval '7 days' and m.saved_at is null
  )
  select distinct d.path from dead d join storage.objects o on o.bucket_id='media' and o.name=d.path
  where d.path is not null and private.media_cleanup_eligible(d.path)
  order by d.path limit least(1000,greatest(coalesce(max_files,0),0));
$$;

create or replace function public.claim_media_cleanup(max_files integer default 500)
returns table(name text) language plpgsql security definer set search_path='' as $$
declare item record;
begin
  for item in select c.name as path from public.media_cleanup_candidates(max_files)c order by c.name loop
    perform pg_advisory_xact_lock(hashtextextended('media-cleanup:' || item.path,0));
    if private.media_cleanup_eligible(item.path) then
      insert into private.media_cleanup_claims(object_name,reason) values(item.path,'daily')
        on conflict(object_name) do update set reason='daily',claimed_at=now();
      name:=item.path;return next;
    end if;
  end loop;
end;
$$;
revoke execute on function public.claim_media_cleanup(integer) from public,anon,authenticated;
grant execute on function public.claim_media_cleanup(integer) to service_role;

-- This trusted check sees every recipient even when the sender hid the message.
-- It also supports deleting an unsent voice recording once no row uses it.
create or replace function public.can_cleanup_snap(object_name text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or split_part(object_name,'/',1)<>auth.uid()::text
    or split_part(object_name,'/',2) not in('snaps','voice','group') then return false;end if;
  perform pg_advisory_xact_lock(hashtextextended('media-cleanup:' || object_name,0));
  if not private.media_cleanup_safe(object_name,1) then return false;end if;
  insert into private.media_cleanup_claims(object_name,reason) values(object_name,'client')
    on conflict on constraint media_cleanup_claims_pkey do update set reason='client',claimed_at=now();
  return true;
end;
$$;
revoke execute on function public.can_cleanup_snap(text) from public,anon;
grant execute on function public.can_cleanup_snap(text) to authenticated;

create or replace function private.guard_claimed_media_delete()
returns trigger language plpgsql security definer set search_path='' as $$
declare claim_reason text;
begin
  if old.bucket_id<>'media' then return old;end if;
  perform pg_advisory_xact_lock(hashtextextended('media-cleanup:' || old.name,0));
  -- Explicit, verified account deletion is different from scheduled cleanup:
  -- the person is intentionally removing all of their own account files.
  if exists(select 1 from private.account_media_deletions d where d.expires_at>now()
      and(d.user_id::text=old.owner_id or d.user_id::text=split_part(old.name,'/',1))) then
    insert into private.media_cleanup_claims(object_name,reason) values(old.name,'client') on conflict(object_name) do nothing;
    return old;
  end if;
  select c.reason into claim_reason from private.media_cleanup_claims c where c.object_name=old.name;
  if not(case claim_reason when 'daily' then private.media_cleanup_eligible(old.name)
      else private.media_cleanup_safe(old.name,1) end) then
    raise exception 'Cleanup cancelled because media is still in use or reported';
  end if;
  insert into private.media_cleanup_claims(object_name,reason) values(old.name,coalesce(claim_reason,'client'))
    on conflict(object_name) do nothing;
  return old;
end;
$$;
create trigger objects_guard_claimed_cleanup before delete on storage.objects
  for each row execute function private.guard_claimed_media_delete();

-- Paths are UUID-based and are never reused by the app. Keep a cleanup
-- tombstone so a pending physical delete cannot erase a replacement upload.
create or replace function private.guard_cleaned_media_path()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.bucket_id='media' then
    perform pg_advisory_xact_lock(hashtextextended('media-cleanup:' || new.name,0));
    if exists(select 1 from private.media_cleanup_claims c where c.object_name=new.name) then
      if tg_op='INSERT' then raise exception 'That media path has expired - use a new file name';end if;
      if new.name is distinct from old.name or new.bucket_id is distinct from old.bucket_id
        or to_jsonb(new)->>'version' is distinct from to_jsonb(old)->>'version' then
        raise exception 'That media path has expired - use a new file name';
      end if;
    end if;
  end if;
  return new;
end;
$$;
create trigger objects_guard_cleaned_path before insert or update on storage.objects
  for each row execute function private.guard_cleaned_media_path();

-- Auth deletion does not instantly expire a previously issued JWT. Do not let
-- that token upload orphan files after its account/profile was removed.
create policy "An existing profile is required for uploads" on storage.objects
  as restrictive for insert to authenticated
  with check(exists(select 1 from public.profiles p where p.id=(select auth.uid())));
create policy "An existing profile is required to replace uploads" on storage.objects
  as restrictive for update to authenticated
  using(exists(select 1 from public.profiles p where p.id=(select auth.uid())))
  with check(exists(select 1 from public.profiles p where p.id=(select auth.uid())));

create or replace function private.guard_cleanup_media_reference()
returns trigger language plpgsql security definer set search_path='' as $$
declare path_value text;
begin
  for path_value in select distinct p from unnest(array[
    to_jsonb(new)->>'media_path',to_jsonb(new)->>'poster_path',to_jsonb(new)->>'overlay_path',to_jsonb(new)->>'blur_path'
  ])p where p is not null order by p loop
    perform pg_advisory_xact_lock(hashtextextended('media-cleanup:' || path_value,0));
    if exists(select 1 from private.media_cleanup_claims c where c.object_name=path_value)
      and not exists(select 1 from storage.objects o where o.bucket_id='media' and o.name=path_value) then
      raise exception 'That media has expired - choose another photo or video';
    end if;
  end loop;
  return new;
end;
$$;
do $$ declare target text;begin
  foreach target in array array['posts','stories','mystery_posts','messages','keeps','group_messages'] loop
    execute format('create trigger guard_cleanup_reference before insert or update on public.%I for each row execute function private.guard_cleanup_media_reference()',target);
  end loop;
end;$$;

create or replace function private.report_media_paths(kind_value text,id_value uuid)
returns setof text language sql stable security definer set search_path='' as $$
  select unnest(array[p.media_path,p.poster_path,p.overlay_path,p.blur_path]) from public.posts p where kind_value='post' and p.id=id_value
  union select unnest(array[g.media_path,g.poster_path,g.overlay_path]) from public.mystery_posts g where kind_value='post' and g.id=id_value
  union select unnest(array[s.media_path,s.poster_path,s.overlay_path]) from public.stories s where kind_value='story' and s.id=id_value
  union select unnest(array[m.media_path,m.poster_path,m.overlay_path]) from public.messages m where kind_value='message' and m.id=id_value
  union select unnest(array[g.media_path,g.poster_path,g.overlay_path]) from public.group_messages g where kind_value='group_message' and g.id=id_value
  union select unnest(array[p.media_path,p.poster_path,p.overlay_path,p.blur_path]) from public.comments c join public.posts p on p.id=c.post_id where kind_value='comment' and c.id=id_value;
$$;
revoke execute on function private.report_media_paths(text,uuid) from public,anon,authenticated;

insert into private.report_media_evidence(report_id,object_name)
  select r.id,p.path from public.reports r
  cross join lateral private.report_media_paths(r.content_type,r.content_id) as p(path)
  where p.path is not null
  on conflict do nothing;

-- Report capture and author deletion use the same lock. Removing content from
-- the app never removes the private evidence mapping of an existing report.
create or replace function private.lock_deleted_content_media()
returns trigger language plpgsql security definer set search_path='' as $$
declare path_value text;
begin
  for path_value in select distinct p from unnest(array[
    to_jsonb(old)->>'media_path',to_jsonb(old)->>'poster_path',to_jsonb(old)->>'overlay_path',to_jsonb(old)->>'blur_path'
  ])p where p is not null order by p loop
    perform pg_advisory_xact_lock(hashtextextended('media-cleanup:' || path_value,0));
  end loop;
  return old;
end;
$$;
do $$ declare target text;begin
  foreach target in array array['posts','stories','mystery_posts','messages','keeps','group_messages'] loop
    execute format('create trigger lock_deleted_content_media before delete on public.%I for each row execute function private.lock_deleted_content_media()',target);
  end loop;
end;$$;

create or replace function private.prepare_report()
returns trigger language plpgsql security definer set search_path='' as $$
declare path_value text;reported_sender uuid;
begin
  new.status:='open';new.created_at:=now();
  if new.content_type='group_message' then
    select g.sender_id into reported_sender from public.group_messages g where g.id=new.content_id
      and private.is_group_member(g.group_id,new.reporter_id);
    if reported_sender is null then raise exception 'That message is gone';end if;
    new.reported_user_id:=reported_sender;
  end if;
  for path_value in select distinct p from private.report_media_paths(new.content_type,new.content_id)p where p is not null order by p loop
    perform pg_advisory_xact_lock(hashtextextended('media-cleanup:' || path_value,0));
    insert into private.report_media_evidence(report_id,object_name) values(new.id,path_value) on conflict do nothing;
  end loop;
  return new;
end;
$$;

create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  base text;
  candidate text;
  attempts int := 0;
  -- The app sends display_name; Google sends full_name / name.
  shared_name text := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'name'), '')
  );
begin
  base := lower(coalesce(new.raw_user_meta_data ->> 'username', shared_name, ''));
  base := regexp_replace(base, '[^a-z0-9_.]', '', 'g');
  if char_length(base) < 3 then
    base := 'user' || substr(replace(new.id::text, '-', ''), 1, 6);
  end if;
  base := left(base, 20);
  perform pg_advisory_xact_lock(hashtextextended('profile-username:' || base,0));
  candidate := base;

  -- If the username got taken in the meantime, add some numbers.
  while exists (select 1 from public.profiles where username = candidate) loop
    attempts := attempts + 1;
    if attempts > 20 then
      candidate := 'user' || substr(replace(new.id::text, '-', ''), 1, 12);
      exit;
    end if;
    candidate := left(base, 16) || (floor(random() * 9000) + 1000)::int::text;
  end loop;

  insert into public.profiles (id, username, display_name)
  values (new.id, candidate, left(coalesce(shared_name, candidate), 40));
  return new;
end;
$$;


create or replace function private.send_drop_reminders()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  person record;
  sent integer := 0;
begin
  for person in
    with away as (
      select t.user_id,
             max(t.updated_at) as last_open,
             -- The time zone from the phone they used most recently.
             (array_agg(t.utc_offset_minutes order by t.updated_at desc) filter (where t.utc_offset_minutes is not null))[1] as offset_minutes
        from public.push_tokens t
       group by t.user_id
    ),
    local_time as (
      select a.user_id, (now() at time zone 'utc') + make_interval(mins => a.offset_minutes) as local_now
        from away a
       where a.offset_minutes is not null
         and a.last_open < now() - interval '7 days'
         and a.last_open > now() - interval '45 days'
    )
    select l.user_id, l.local_now::date as day
      from local_time l
     where floor(extract(epoch from (l.local_now - l.local_now::date)) / 60)::int = private.drop_minute(l.local_now::date)
       and not exists (select 1 from private.drop_reminders_sent s where s.user_id = l.user_id and s.day = l.local_now::date)
  loop
    insert into private.drop_reminders_sent (user_id, day) values (person.user_id, person.day) on conflict do nothing;
    if not found then continue; end if;
    perform private.send_push(person.user_id, 'drops', '⏰ Peekaboo drop!', 'You have 2 minutes to post your drop 👀',
      jsonb_build_object('type', 'drop'));
    sent := sent + 1;
  end loop;
  delete from private.drop_reminders_sent where day < current_date - 3;
  return sent;
end;
$$;
revoke execute on function private.send_drop_reminders() from public, anon, authenticated;


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
  if grp is not null and not private.is_group_member(grp,owner) then return new;end if;
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

-- A safety confirmation belongs to the account that opened it. The newer
-- client supplies that captured id, so a later login cannot inherit the action.
create or replace function public.block_user(target uuid,expected_user_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if expected_user_id is null or auth.uid() is distinct from expected_user_id then
    raise exception 'Your login has changed - please try again';
  end if;
  perform public.block_user(target);
end;
$$;
revoke execute on function public.block_user(uuid,uuid) from public,anon;
grant execute on function public.block_user(uuid,uuid) to authenticated;

commit;
