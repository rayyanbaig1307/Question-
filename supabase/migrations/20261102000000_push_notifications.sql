-- =====================================================================
-- Push notifications (via Expo's free push service).
-- * Each phone registers its "push address" (an Expo push token).
-- * Your on/off choices per type live in notification_prefs (no row = all on).
-- * When something happens (message, friend request, like, comment), the
--   database itself sends the push straight away, using pg_net.
-- * The daily Peekaboo drop alert is set by each phone itself (see the app);
--   its on/off switch is stored here too.
-- =====================================================================

create extension if not exists pg_net with schema extensions;

create table public.push_tokens (
  token text primary key,                        -- the phone's Expo push address
  user_id uuid references public.profiles (id) on delete cascade, -- empty after logging out
  platform text check (platform in ('ios', 'android')),
  updated_at timestamptz not null default now()
);
create index push_tokens_user_idx on public.push_tokens (user_id);
alter table public.push_tokens enable row level security;
-- Nobody reads or writes this table directly; the two functions below do it.

create table public.notification_prefs (
  user_id uuid primary key default auth.uid() references public.profiles (id) on delete cascade,
  messages boolean not null default true,
  friend_requests boolean not null default true,
  likes boolean not null default true,
  comments boolean not null default true,
  drops boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.notification_prefs enable row level security;
create policy "You can see your notification settings"
  on public.notification_prefs for select to authenticated
  using (user_id = (select auth.uid()));
create policy "You can save your notification settings"
  on public.notification_prefs for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "You can change your notification settings"
  on public.notification_prefs for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- This phone now belongs to you (also takes it over from whoever was logged in on it before).
create or replace function public.register_push_token(push_token text, phone text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Not logged in';
  end if;
  insert into public.push_tokens (token, user_id, platform)
  values (push_token, auth.uid(), phone)
  on conflict (token) do update set user_id = auth.uid(), platform = excluded.platform, updated_at = now();
end;
$$;
revoke execute on function public.register_push_token(text, text) from public, anon;
grant execute on function public.register_push_token(text, text) to authenticated;

-- Logging out: stop sending your notifications to this phone.
create or replace function public.unregister_push_token(push_token text)
returns void language sql security definer set search_path = '' as $$
  update public.push_tokens set user_id = null, updated_at = now()
   where token = push_token and user_id = auth.uid();
$$;
revoke execute on function public.unregister_push_token(text) from public, anon;
grant execute on function public.unregister_push_token(text) to authenticated;

-- Send a push to all of someone's phones – if they have that type switched on.
create or replace function private.send_push(target uuid, kind text, title text, body text, data jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  allowed boolean;
  batch jsonb;
begin
  if target is null then
    return;
  end if;
  select case kind
           when 'messages' then p.messages
           when 'friend_requests' then p.friend_requests
           when 'likes' then p.likes
           when 'comments' then p.comments
           else true
         end
    into allowed
    from public.notification_prefs p
   where p.user_id = target;
  if allowed is false then
    return;                                           -- they turned this type off
  end if;
  select jsonb_agg(jsonb_build_object(
           'to', t.token, 'title', title, 'body', body, 'data', data, 'sound', 'default', 'channelId', 'default'))
    into batch
    from public.push_tokens t
   where t.user_id = target;
  if batch is null then
    return;                                           -- no phones registered
  end if;
  perform net.http_post(
    url := 'https://exp.host/--/api/v2/push/send',
    body := batch,
    headers := '{"Content-Type": "application/json", "Accept": "application/json"}'::jsonb
  );
end;
$$;

-- A person's name for notifications: their display name, or @username.
create or replace function private.push_name(person uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(display_name, ''), '@' || username) from public.profiles where id = person;
$$;

-- New chat message / peek / screenshot notice.
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
      else 'New message'
    end,
    jsonb_build_object('type', 'message', 'from', new.sender_id)
  );
  return new;
end;
$$;
create trigger messages_push after insert on public.messages
  for each row execute function private.push_new_message();

-- New friend request, or your request was accepted.
create or replace function private.push_friendship()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' and new.status = 'pending' then
    perform private.send_push(new.addressee_id, 'friend_requests', 'New friend request 👋',
      private.push_name(new.requester_id) || ' wants to be friends', jsonb_build_object('type', 'friends'));
  elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status = 'accepted' then
    perform private.send_push(new.requester_id, 'friend_requests', 'You have a new friend 🎉',
      private.push_name(new.addressee_id) || ' accepted your friend request', jsonb_build_object('type', 'friends'));
  end if;
  return new;
end;
$$;
create trigger friendships_push after insert or update of status on public.friendships
  for each row execute function private.push_friendship();

-- Someone liked your post.
create or replace function private.push_like()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  owner uuid;
begin
  select user_id into owner from public.posts where id = new.post_id;
  if owner is distinct from new.user_id then
    perform private.send_push(owner, 'likes', private.push_name(new.user_id), 'Liked your post ❤️',
      jsonb_build_object('type', 'post', 'post', new.post_id));
  end if;
  return new;
end;
$$;
create trigger likes_push after insert on public.likes
  for each row execute function private.push_like();

-- Someone commented on your post.
create or replace function private.push_comment()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  owner uuid;
begin
  select user_id into owner from public.posts where id = new.post_id;
  if owner is distinct from new.user_id then
    perform private.send_push(owner, 'comments', private.push_name(new.user_id),
      'Commented: ' || left(new.body, 120), jsonb_build_object('type', 'comments', 'post', new.post_id));
  end if;
  return new;
end;
$$;
create trigger comments_push after insert on public.comments
  for each row execute function private.push_comment();
