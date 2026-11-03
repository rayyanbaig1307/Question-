-- =====================================================================
-- Hold down a chat → options for that friend: mute their notifications, hide their stories, pin the chat.
-- Only you can see your own settings. (Close friends already have their own table.)
-- =====================================================================

create table public.friend_settings (
  user_id uuid not null references public.profiles (id) on delete cascade,
  friend_id uuid not null references public.profiles (id) on delete cascade,
  mute_messages boolean not null default false,   -- no notifications for their messages and peeks
  mute_stories boolean not null default false,    -- their stories stay out of the row on Home
  pinned boolean not null default false,          -- their chat stays at the top of Chat
  updated_at timestamptz not null default now(),
  primary key (user_id, friend_id),
  check (user_id <> friend_id)
);
alter table public.friend_settings enable row level security;
create policy "You manage your own chat settings"
  on public.friend_settings for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- New message → notification, same as before, except when you've muted that friend.
create or replace function private.push_new_message()
returns trigger language plpgsql security definer set search_path = '' as $$
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
