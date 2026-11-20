-- =====================================================================
-- Lives 🔴 (app version 1.2.0): go live with video to your friends. Safe to run more than once.
--
-- The video itself goes through LiveKit (a video service). Nothing is recorded or saved. This file is the
-- database side: who may go live, who may watch, comments, bringing a friend on ("co-host"), the limits, the
-- notification, reports, and a small job list that tells LiveKit to take people out of a live.
-- Two Edge Functions go with it: live-token (gives a phone its LiveKit pass) and live-admin (removes people
-- and closes rooms in LiveKit; this database wakes it up). Their LiveKit keys live in Edge Function secrets,
-- never here.
--
-- The safety rules, all checked here on the server (an old or changed app can't skip them):
--   * Friends only. Only the host's accepted friends can watch – not blocked either way, not banned, not removed
--     from this live. Never public, never listed for strangers. People who aren't friends learn nothing, not
--     even that the live has ended.
--   * Older one-tap friendships of under-18s: before the launch-safety rule (6 Nov), a public account could be
--     added in one tap. Those friendships of under-18s are listed once in private.live_unconfirmed_friends and
--     left out of an under-18 host's audience and live notifications. Nothing else about them changes.
--   * Bringing a friend on: only the host asks, the friend must say yes, one ask at a time, 60 seconds to answer,
--     at most 2 asks per friend per live and none after a "Not now", 10 asks per live. While a friend is on,
--     only people who are friends with BOTH can watch; everyone else waits and comes back by themselves after.
--   * To go live (or come on): a saved birthday, the Live rules accepted, not banned, not stopped by the owner,
--     at least one friend, and (while lives are for testers) being on the testers list.
--   * Limits: 60 minutes a live, 3 lives a day, 20 viewers, 4 lives at the same time, a monthly minute budget,
--     600 minutes per host per month, a live with nobody watching ends after 5 minutes, one "is live"
--     notification per host every 2 hours, comment slow mode, 30 pass requests per person per 10 minutes (a
--     friend coming on has a separate allowance for the "getting the stage ready" retries), 10 starts an hour.
--   * Comments: the slur filter and the dare-safety rules, 150 characters, one every 3 seconds. The host can
--     delete comments or switch them off. Blocked people never see each other's comments.
--   * Reports: the live, the person brought on, or a comment, up to 24 hours after the end, only by people who
--     were there. Each report keeps a private record (who was there, comments, also deleted ones, what happened)
--     for 90 days. 2 different people reporting the same person ends their live (or takes them off) and stops
--     them going live for 24 hours (never shorter than a stop the owner set). 2 reporting a comment hides it.
--     Only reports from people the reported person hadn't removed or blocked count towards that (all reports
--     are still kept for the owner). The same report twice, or a report about yourself, is quietly skipped.
--   * Unfriend, block, ban, account deletion, the owner ending a live and the report limit take people out
--     within seconds; a check every minute catches anything missed.
--   * The owner gets a "👀 Live check" notification when an adult's live has 5 or more under-18 viewers.
--
-- For the owner (Supabase → Table Editor):
--   * End a live now: schema "public" → lives → the row → ended_at → type now() → Save. The reason fills itself
--     in and the room closes within seconds.
--   * Stop someone going live: schema dropdown "private" → live_restrictions → Insert row → user_id = their id,
--     leave "until" empty (= until you delete the row) → Save. It also takes them off a friend's live within a
--     minute.
--   * Ban: Auth → Users → Ban, as today. Their live ends within a second (the minute check is the backup).
--   * Remove a comment: schema "public" → live_comments → the row → set deleted_at to now() → Save (the text is
--     emptied and kept privately in private.live_removed_comments). Don't delete the row: phones only hear about
--     changes, so a deleted row would stay on screen.
--   * Switch lives off, or open them up: schema "private" → live_settings → the one row → who_can_go_live →
--     nobody / testers / everyone → Save. "nobody" also ends running lives within a minute.
--   * Testers: schema "private" → live_testers → Insert row with their user_id (tick no_limits only for the App
--     Review accounts: it skips the 3-a-day limit and the 2-hour notification wait).
--   * Cost limits: schema "private" → live_settings → change the number → Save.
--   * Reading a report: reports (content_type 'live' or 'live_comment'; "details" has the comment text only if
--     the comment was still up when it was reported), then private.live_snapshots by report_id (its
--     "reported_comment" has the words, also of a deleted comment; or by live_id for a 'host_deleted' one), then
--     lives / live_viewers. private.live_report_votes says which reports counted towards the automatic stop:
--     reports from people the reported person had removed or blocked are kept for you but don't count.
--   * How many older one-tap friendships of under-18s were found (SQL Editor):
--       select count(*) from private.live_unconfirmed_friends;
--     To give one back (that friend can then watch that under-18's lives again): delete its row. The list is
--     filled only the first time this file runs, so running it again doesn't bring deleted rows back.
--   * Check the LiveKit secrets without a phone (SQL Editor): select private.live_selftest(); wait 10 seconds,
--     then: select done_at, last_error from private.live_jobs where room = 'live_selftest' order by id desc limit 1;
--     A time in done_at and an empty last_error means the LiveKit address, key and secret all work.
-- =====================================================================
begin;
set local lock_timeout = '15s';

-- ---------------------------------------------------------------------
-- 1. The owner's tables (private: only the owner sees and edits them, in the Table Editor)
-- ---------------------------------------------------------------------
-- One row with the switches and limits.
create table if not exists private.live_settings (
  id boolean primary key default true check (id),
  -- 'nobody' = lives off, 'testers' = only people in private.live_testers, 'everyone'.
  who_can_go_live text not null default 'testers' check (who_can_go_live in ('nobody', 'testers', 'everyone')),
  max_minutes integer not null default 60 check (max_minutes between 3 and 240),
  max_viewers integer not null default 20 check (max_viewers between 1 and 500),
  lives_per_day integer not null default 3 check (lives_per_day between 1 and 50),
  max_live_now integer not null default 4 check (max_live_now between 1 and 1000),
  monthly_minutes integer not null default 4000 check (monthly_minutes >= 0),       -- 0 = no limit
  push_every interval not null default '2 hours' check (push_every >= interval '0'),
  report_end_count integer not null default 2 check (report_end_count between 1 and 20),
  empty_minutes integer not null default 5 check (empty_minutes between 2 and 60),  -- on air with nobody watching
  host_month_minutes integer not null default 600 check (host_month_minutes >= 0),  -- per host; 0 = no limit
  min_account_days integer not null default 0 check (min_account_days between 0 and 365)
);
-- (So a second run on an older copy of this table still gets every column.)
alter table private.live_settings add column if not exists who_can_go_live text not null default 'testers'
  check (who_can_go_live in ('nobody', 'testers', 'everyone'));
alter table private.live_settings add column if not exists max_minutes integer not null default 60 check (max_minutes between 3 and 240);
alter table private.live_settings add column if not exists max_viewers integer not null default 20 check (max_viewers between 1 and 500);
alter table private.live_settings add column if not exists lives_per_day integer not null default 3 check (lives_per_day between 1 and 50);
alter table private.live_settings add column if not exists max_live_now integer not null default 4 check (max_live_now between 1 and 1000);
alter table private.live_settings add column if not exists monthly_minutes integer not null default 4000 check (monthly_minutes >= 0);
alter table private.live_settings add column if not exists push_every interval not null default '2 hours' check (push_every >= interval '0');
alter table private.live_settings add column if not exists report_end_count integer not null default 2 check (report_end_count between 1 and 20);
alter table private.live_settings add column if not exists empty_minutes integer not null default 5 check (empty_minutes between 2 and 60);
alter table private.live_settings add column if not exists host_month_minutes integer not null default 600 check (host_month_minutes >= 0);
alter table private.live_settings add column if not exists min_account_days integer not null default 0 check (min_account_days between 0 and 365);
insert into private.live_settings (id) values (true) on conflict do nothing;

-- Who may go live while lives are for testers.
create table if not exists private.live_testers (
  user_id uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now(),
  no_limits boolean not null default false     -- true = skips the daily limit and the notification wait (App Review)
);
-- The owner, and @ayaan only while he is the owner's friend (so nobody gets in just by taking that name). Adds
-- nobody on an empty or test database. The App Review accounts are NOT added here: a name like
-- 'peekaboo_review2' could be taken by a stranger first. The owner's copy page adds them by the id of the
-- account the owner has just made.
insert into private.live_testers (user_id)
  select p.id from public.profiles p
   where p.id = 'df5aae76-7e6a-4e91-9645-5b897a533156'
      or (p.username = 'ayaan' and private.are_friends(p.id, 'df5aae76-7e6a-4e91-9645-5b897a533156'::uuid))
  on conflict do nothing;

-- People the owner (or 2 reports) stopped from going live or coming on.
create table if not exists private.live_restrictions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  until timestamptz,                               -- empty = until the owner deletes the row
  reason text not null default 'owner',
  created_at timestamptz not null default now()
);

-- Older one-tap friendships of under-18s (see the header). Filled only when this table is first made.
select set_config('peekaboo.live_fill_unconfirmed',
  case when to_regclass('private.live_unconfirmed_friends') is null then 'yes' else 'no' end, true);
create table if not exists private.live_unconfirmed_friends (
  teen uuid not null references auth.users (id) on delete cascade,
  other uuid not null references auth.users (id) on delete cascade,
  primary key (teen, other)
);
insert into private.live_unconfirmed_friends (teen, other)
  select f.addressee_id, f.requester_id from public.friendships f
   where current_setting('peekaboo.live_fill_unconfirmed', true) = 'yes'
     and f.status = 'accepted' and f.accepted_at is not null
     and abs(extract(epoch from f.accepted_at - f.created_at)) < 1       -- made accepted in one step (a one-tap add)
     and private.age_group(f.addressee_id) is distinct from 'adult'       -- the added person is under 18 or has no birthday
     and (private.age_group(f.requester_id) = 'adult' or private.age_group(f.requester_id) is null)
  on conflict do nothing;

revoke all on private.live_settings, private.live_testers, private.live_restrictions,
  private.live_unconfirmed_friends from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. The app's tables
-- ---------------------------------------------------------------------
create table if not exists public.lives (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references public.profiles (id) on delete cascade,
  room text not null unique,                     -- LiveKit's room name, set by start_live
  started_at timestamptz not null default now(),
  on_air_at timestamptz,                         -- friends see it and get the notification only after this
  ends_at timestamptz not null,                  -- started_at + max_minutes
  host_seen_at timestamptz not null default now(),
  cohost_id uuid references public.profiles (id) on delete set null,
  cohost_since timestamptz,
  stage_clean_at timestamptz,                    -- live-token cleared the stage for the current co-host
  last_viewer_at timestamptz,                    -- the last time anyone was watching (for the 'empty' end)
  comments_on boolean not null default true,
  hearts integer not null default 0 check (hearts between 0 and 1000000),
  pushed_at timestamptz,
  teen_alert_at timestamptz,
  ended_at timestamptz,
  ended_reason text check (ended_reason in ('host', 'time', 'host_gone', 'empty', 'reports', 'owner', 'safety')),
  constraint lives_room_name check (room = 'live_' || id::text),
  constraint lives_cohost_not_host check (cohost_id is distinct from host_id)
);
create unique index if not exists lives_one_per_host on public.lives (host_id) where ended_at is null;
create index if not exists lives_active_idx on public.lives (started_at desc) where ended_at is null;
create index if not exists lives_host_idx on public.lives (host_id, started_at desc);
create index if not exists lives_ended_idx on public.lives (ended_at) where ended_at is not null;

-- Who is watching, and who was there (kept as the record). The app can't read it directly.
create table if not exists public.live_viewers (
  live_id uuid not null references public.lives (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  first_joined_at timestamptz not null default now(),
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  left_at timestamptz,
  watch_seconds integer not null default 0,
  was_cohost boolean not null default false,
  removed_at timestamptz,                        -- removed by the host: no new pass for this live
  primary key (live_id, user_id)
);
create index if not exists live_viewers_user_idx on public.live_viewers (user_id);

create table if not exists public.live_comments (
  id uuid primary key default gen_random_uuid(),
  live_id uuid not null references public.lives (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,                            -- display name, else @username; filled in by the server
  avatar_path text,
  body text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint live_comments_body check ((deleted_at is null and char_length(body) between 1 and 150)
                                    or (deleted_at is not null and body = ''))
);
create index if not exists live_comments_live_idx on public.live_comments (live_id, created_at desc);
create index if not exists live_comments_user_idx on public.live_comments (user_id, live_id, created_at desc);

-- "Come on my live?" asks.
create table if not exists public.live_invites (
  id uuid primary key default gen_random_uuid(),
  live_id uuid not null references public.lives (id) on delete cascade,
  host_id uuid not null references public.profiles (id) on delete cascade,
  guest_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,               -- created_at + 60 seconds
  answer text check (answer in ('accepted', 'declined', 'expired', 'cancelled')),
  answered_at timestamptz
);
create unique index if not exists live_invites_one_open on public.live_invites (live_id) where answer is null;
create index if not exists live_invites_guest_idx on public.live_invites (guest_id, created_at desc);

-- Phones with the new app (that can open a live) say so; only they get the "is live" notification.
alter table public.push_tokens add column if not exists can_live boolean not null default false;
-- The "Lives" switch in Settings → Notifications (no row = on).
alter table public.notification_prefs add column if not exists lives boolean not null default true;
-- The Live rules card is saved like the Terms (accept_legal itself doesn't change).
alter table public.legal_acceptances drop constraint if exists legal_acceptances_document_check;
alter table public.legal_acceptances add constraint legal_acceptances_document_check
  check (document in ('terms', 'dare_rules', 'live_rules'));

-- ---------------------------------------------------------------------
-- 3. Private logs (no links to accounts, so they outlive an account deletion until they are cleaned up)
-- ---------------------------------------------------------------------
-- Things live-admin must tell LiveKit. What to do is decided when the job is picked up (live_jobs_claim).
create table if not exists private.live_jobs (
  id bigint generated always as identity primary key,
  live_id uuid not null,
  room text not null,
  person uuid,
  kind text not null check (kind in ('end', 'check', 'demote', 'audit')),
  created_at timestamptz not null default now(),
  tries integer not null default 0,
  next_try_at timestamptz not null default now(),
  is_recheck boolean not null default false,     -- the one re-check after LiveKit said "not found"
  done_at timestamptz,
  last_error text
);
create unique index if not exists live_jobs_waiting_once on private.live_jobs
  (live_id, kind, coalesce(person, '00000000-0000-0000-0000-000000000000'::uuid), is_recheck)
  where done_at is null and tries = 0;
create index if not exists live_jobs_due on private.live_jobs (next_try_at) where done_at is null;
create index if not exists live_jobs_done_idx on private.live_jobs (done_at) where done_at is not null;

-- Rooms to keep checking after their live ended or was deleted (a pass that is still valid can open a room again).
create table if not exists private.live_watch_rooms (
  room text primary key,
  live_id uuid not null,
  until timestamptz not null
);

-- Every pass request, allowed or refused (for the 30-per-10-minutes limit). Kept 1 day.
create table if not exists private.live_token_log (
  id bigint generated always as identity primary key,
  account uuid not null,
  at timestamptz not null default now(),
  ok boolean not null
);
create index if not exists live_token_log_idx on private.live_token_log (account, at desc);
-- A friend coming on stage asks again every 2 seconds while the stage is made ready: those requests are counted
-- on their own (stage = true), so they can never use up that friend's allowance for watching.
alter table private.live_token_log add column if not exists stage boolean not null default false;

-- What happened in each live (the record for reports). Kept 30 days.
create table if not exists private.live_events (
  id bigint generated always as identity primary key,
  live_id uuid not null,
  at timestamptz not null default now(),
  kind text not null,  -- start|on_air|end|join|remove|cohost_on|cohost_off|invite|comment_deleted|report|gave_up
  actor uuid,
  target uuid,
  detail jsonb
);
create index if not exists live_events_live_idx on private.live_events (live_id, at);
create index if not exists live_events_at_idx on private.live_events (at);

-- The words of deleted comments (the record for reports). Kept 30 days.
create table if not exists private.live_removed_comments (
  comment_id uuid primary key,
  live_id uuid not null,
  user_id uuid not null,
  body text not null,
  created_at timestamptz not null,
  removed_at timestamptz not null default now(),
  removed_by uuid
);

-- A frozen copy of a live for a report (90 days), or made just before a host's account deletion removes it.
create table if not exists private.live_snapshots (
  id bigint generated always as identity primary key,
  report_id uuid unique,                         -- empty for a 'host_deleted' copy
  live_id uuid not null,
  reason text not null check (reason in ('report', 'host_deleted')),
  made_at timestamptz not null default now(),
  keep_until timestamptz not null,
  snapshot jsonb not null
);
create index if not exists live_snapshots_live_idx on private.live_snapshots (live_id);

-- Does each live report count towards the automatic stop? Decided once, when the report is filed, and never
-- looked at again (so removing or blocking someone later doesn't undo a report they already made). Kept 30 days.
create table if not exists private.live_report_votes (
  report_id uuid primary key,
  live_id uuid not null,
  content_type text not null,
  content_id uuid not null,
  reported_user_id uuid,
  reporter_id uuid,
  counts boolean not null,
  created_at timestamptz not null default now()
);
create index if not exists live_report_votes_idx on private.live_report_votes (content_type, content_id, reported_user_id);

revoke all on private.live_jobs, private.live_watch_rooms, private.live_token_log, private.live_events,
  private.live_removed_comments, private.live_snapshots, private.live_report_votes from public, anon, authenticated;

-- A random password, kept in the Vault, that this database sends so only it can wake live-admin.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'live_admin_key') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
      'live_admin_key',
      'Lets the database wake the live-admin Edge Function'
    );
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Small helpers
-- ---------------------------------------------------------------------
-- The owner's settings. If the row was deleted, lives count as switched off.
create or replace function private.live_config()
returns private.live_settings language plpgsql stable security definer set search_path = '' as $$
declare
  s private.live_settings;
begin
  select * into s from private.live_settings where id;
  if not found then
    s.id := true; s.who_can_go_live := 'nobody'; s.max_minutes := 60; s.max_viewers := 20; s.lives_per_day := 3;
    s.max_live_now := 4; s.monthly_minutes := 4000; s.push_every := interval '2 hours'; s.report_end_count := 2;
    s.empty_minutes := 5; s.host_month_minutes := 600; s.min_account_days := 0;
  end if;
  return s;
end;
$$;
revoke all on function private.live_config() from public, anon, authenticated;

-- Stops with a plain sentence the app can show, and a short code ("hint") the app can act on.
-- Every sentence is written out once, here.
create or replace function private.live_fail(code text, words text default null)
returns void language plpgsql set search_path = '' as $$
declare
  message text;
  state text := 'P0001';
begin
  case code
    when 'live_login' then message := 'Your login changed – please log in again.'; state := '28000';
    when 'live_off' then message := 'Lives are switched off right now.'; state := '42501';
    when 'live_testers' then message := 'Lives are only open to a few testers right now – soon for everyone! 🔴'; state := '42501';
    when 'live_banned' then message := 'Your account can''t go live.'; state := '42501';
    when 'live_restricted' then message := 'You can''t go live right now.'; state := '42501';
    when 'live_birthday' then message := 'Add your birthday first (Settings → Birthday) to go live.'; state := '42501';
    when 'live_rules' then message := 'Please read and accept the Live rules first.'; state := '42501';
    when 'live_no_friends' then message := 'Add a friend first – lives are just for your friends.'; state := '42501';
    when 'live_new_account' then message := 'Your account is too new to go live – try again in a few days.'; state := '42501';
    when 'live_daily_limit' then message := 'That''s all your lives for today – try again tomorrow.'; state := '23514';
    when 'live_month_limit' then message := 'You''ve used your live time for this month – more next month.'; state := '23514';
    when 'live_busy' then message := 'Lives are busy right now – try again later.'; state := '23514';
    when 'live_not_host' then message := 'Only the host can do that.'; state := '42501';
    when 'live_not_on' then message := 'This live isn''t on right now.';
    when 'live_has_cohost' then message := 'Someone is already on the live.';
    when 'live_invite_open' then message := 'You already asked someone – wait for their answer.';
    when 'live_not_watching' then message := 'You''re not watching this live right now.';
    when 'live_guest_cant' then message := 'They can''t come on right now.'; state := '42501';
    when 'live_invite_wait' then message := 'You can''t ask them again this live.'; state := '23514';
    when 'live_invite_limit' then message := 'That''s a lot of asks for one live.'; state := '23514';
    when 'live_invite_gone' then message := 'That ask isn''t there any more.';
    -- Comments (the app's checkLiveComment shows the very same sentences).
    when 'live_comments_off' then message := 'Comments are off for this live.';
    when 'live_comment_size' then message := 'Comments can be 1 to 150 characters.'; state := '23514';
    when 'live_comment_word' then message := private.word_filter_message('content'); state := '23514';
    when 'live_comment_harm' then message := 'That comment isn''t allowed – no hurting anyone (or yourself), no violence and no abuse. 🙏'; state := '23514';
    when 'live_comment_sexual' then message := 'That comment isn''t allowed – nothing sexual. 🙏'; state := '23514';
    when 'live_comment_hate' then message := 'That comment isn''t allowed – no hate, bullying or slurs. 🙏'; state := '23514';
    when 'live_comment_spam' then message := 'That comment looks like spam – no links, phone numbers or the same thing over and over. 🙏'; state := '23514';
    when 'live_comment_slow' then message := 'Slow down a little – one comment every 3 seconds.'; state := '23514';
    when 'live_comment_same' then message := 'You just said that. 🙂'; state := '23514';
    when 'live_comment_limit' then message := 'That''s a lot of comments – let others have a turn.'; state := '23514';
    when 'live_comment_busy' then message := 'Lots of comments right now – try again in a moment.'; state := '23514';
    else message := 'That didn''t work – try again.';
  end case;
  raise exception '%', coalesce(words, message) using errcode = state, hint = code;
end;
$$;
revoke all on function private.live_fail(text, text) from public, anon, authenticated;

-- Stopped by the owner (or by reports) right now?
create or replace function private.live_restricted(person uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.live_restrictions r
                  where r.user_id = person and (r.until is null or r.until > now()));
$$;
revoke all on function private.live_restricted(uuid) from public, anon, authenticated;

-- Can `person` watch `owner`'s lives? Accepted friends, not blocked either way – minus the older one-tap adds
-- an under-18 never approved. (can_see_stories with the person named, because the server has no logged-in user.)
create or replace function private.live_friends(owner uuid, person uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(private.are_friends(owner, person), false)
     and not private.is_blocked(owner, person)
     and not (private.age_group(owner) is distinct from 'adult'
              and exists (select 1 from private.live_unconfirmed_friends u where u.teen = owner and u.other = person));
$$;
revoke all on function private.live_friends(uuid, uuid) from public, anon, authenticated;

-- Can this person go live (or come on) right now? Null = yes, otherwise why not:
-- 'off', 'testers', 'banned', 'restricted', 'birthday' or 'rules' (checked in that order).
create or replace function private.can_host(person uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  s private.live_settings := private.live_config();
begin
  if s.who_can_go_live = 'nobody' then return 'off'; end if;
  if s.who_can_go_live = 'testers' and not exists (select 1 from private.live_testers t where t.user_id = person) then
    return 'testers';
  end if;
  if not private.invite_user_ok(person) then return 'banned'; end if;
  if private.live_restricted(person) then return 'restricted'; end if;
  if not exists (select 1 from public.age_checks a where a.user_id = person and a.birthday is not null) then
    return 'birthday';
  end if;
  if not exists (select 1 from public.legal_acceptances g where g.user_id = person and g.document = 'live_rules') then
    return 'rules';
  end if;
  return null;
end;
$$;
revoke all on function private.can_host(uuid) from public, anon, authenticated;

-- Pinged in the last 75 seconds and hasn't left. Never a permission on its own.
create or replace function private.connected(live uuid, person uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.live_viewers v
                  where v.live_id = live and v.user_id = person
                    and v.left_at is null and v.last_seen_at > now() - interval '75 seconds');
$$;
revoke all on function private.connected(uuid, uuid) from public, anon, authenticated;

-- Was this person in the live (host, co-host, or got a pass to watch)? Only live_join makes presence rows.
create or replace function private.was_in_live(live uuid, person uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select person is not null and (
    exists (select 1 from public.lives l where l.id = live and (l.host_id = person or l.cohost_id = person))
    or exists (select 1 from public.live_viewers v where v.live_id = live and v.user_id = person));
$$;
revoke all on function private.was_in_live(uuid, uuid) from public, anon, authenticated;

-- Minutes used this (UTC) month by everyone: hosts' time plus viewers' watching time (LiveKit counts both).
create or replace function private.live_month_minutes()
returns integer language sql stable security definer set search_path = '' as $$
  with month_lives as (
    select l.id, l.started_at, l.ended_at from public.lives l
     where l.started_at >= (date_trunc('month', now() at time zone 'utc') at time zone 'utc')
  )
  select floor((
    coalesce((select sum(extract(epoch from (coalesce(m.ended_at, now()) - m.started_at))) from month_lives m), 0)
    + coalesce((select sum(v.watch_seconds) from public.live_viewers v join month_lives m on m.id = v.live_id), 0)
  ) / 60)::integer;
$$;
revoke all on function private.live_month_minutes() from public, anon, authenticated;

-- One host's own on-air minutes this (UTC) month.
create or replace function private.live_host_month_minutes(person uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select floor(coalesce(sum(extract(epoch from (coalesce(l.ended_at, now()) - l.on_air_at))), 0) / 60)::integer
    from public.lives l
   where l.host_id = person and l.on_air_at is not null
     and l.started_at >= (date_trunc('month', now() at time zone 'utc') at time zone 'utc');
$$;
revoke all on function private.live_host_month_minutes(uuid) from public, anon, authenticated;

-- THE rule: what is this person to this live?
-- 'host', 'cohost', 'viewer' (may watch), 'paused' (waits while someone they're not friends with is on),
-- 'removed', 'ended' or 'not_allowed'. People who aren't friends never learn anything (not even 'ended').
create or replace function private.live_access(live uuid, person uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  l public.lives%rowtype;
begin
  select * into l from public.lives x where x.id = live;
  if not found then return 'not_allowed'; end if;
  if person is null or not private.invite_user_ok(person) then return 'not_allowed'; end if;
  if person = l.host_id then
    return case when l.ended_at is not null or now() >= l.ends_at then 'ended' else 'host' end;
  end if;
  if not private.live_friends(l.host_id, person) then return 'not_allowed'; end if;
  if l.ended_at is not null or now() >= l.ends_at or not private.invite_user_ok(l.host_id) then return 'ended'; end if;
  -- A co-host who is now banned, stopped or no longer allowed counts as a viewer (and is taken off the stage).
  if person = l.cohost_id and private.can_host(person) is null then return 'cohost'; end if;
  if exists (select 1 from public.live_viewers v where v.live_id = live and v.user_id = person and v.removed_at is not null) then
    return 'removed';
  end if;
  -- While someone is on with the host, only friends of both can watch.
  if l.cohost_id is not null and person <> l.cohost_id and not private.live_friends(l.cohost_id, person) then
    return 'paused';
  end if;
  return 'viewer';
end;
$$;
revoke all on function private.live_access(uuid, uuid) from public, anon, authenticated;

-- For the comments privacy rule: may the logged-in person read this live's comments?
create or replace function private.can_read_live_comments(live uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.live_access(live, (select auth.uid())) in ('host', 'cohost', 'viewer');
$$;
-- The privacy rule below calls it as the logged-in person.
revoke all on function private.can_read_live_comments(uuid) from public, anon;
grant execute on function private.can_read_live_comments(uuid) to authenticated;

-- How many friends are watching right now (not the host or the person brought on).
create or replace function private.live_viewer_count(live uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select count(*)::integer
    from public.live_viewers v join public.lives l on l.id = v.live_id
   where v.live_id = live and v.left_at is null and v.last_seen_at > now() - interval '75 seconds'
     and v.user_id <> l.host_id and v.user_id is distinct from l.cohost_id
     and private.live_access(live, v.user_id) = 'viewer';
$$;
revoke all on function private.live_viewer_count(uuid) from public, anon, authenticated;

-- Writes one line of what happened.
create or replace function private.live_log(live uuid, what text, by_whom uuid, about uuid, extra jsonb default null)
returns void language sql security definer set search_path = '' as $$
  insert into private.live_events (live_id, kind, actor, target, detail) values (live, what, by_whom, about, extra);
$$;
revoke all on function private.live_log(uuid, text, uuid, uuid, jsonb) from public, anon, authenticated;

-- Keep checking a room for a while (it ended, or someone was still found in it).
create or replace function private.live_watch(room_name text, live uuid, how_long interval)
returns void language sql security definer set search_path = '' as $$
  insert into private.live_watch_rooms as w (room, live_id, until) values (room_name, live, now() + how_long)
  on conflict (room) do update set until = greatest(w.until, excluded.until), live_id = excluded.live_id;
$$;
revoke all on function private.live_watch(text, uuid, interval) from public, anon, authenticated;

-- A frozen copy of a live for the record: the live, who was there (with their age group at the time),
-- the last 50 comments (also deleted ones), the last 100 events and how many reports there were (reports
-- aren't among the 100, so a flood of reports can't push the real events out).
create or replace function private.live_snapshot(live uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'made_at', now(),
    'live', (select jsonb_build_object(
        'id', l.id, 'room', l.room, 'host_id', l.host_id,
        'host_username', coalesce(hp.username,
          (select e.detail->>'host_username' from private.live_events e where e.live_id = l.id and e.kind = 'start' order by e.at limit 1)),
        'host_age_group', coalesce(private.age_group(l.host_id),
          (select e.detail->>'host_age_group' from private.live_events e where e.live_id = l.id and e.kind = 'start' order by e.at limit 1)),
        'cohost_id', l.cohost_id, 'cohost_since', l.cohost_since,
        'started_at', l.started_at, 'on_air_at', l.on_air_at, 'ends_at', l.ends_at,
        'ended_at', l.ended_at, 'ended_reason', l.ended_reason,
        'comments_on', l.comments_on, 'hearts', l.hearts, 'teen_alert_at', l.teen_alert_at)
      from public.lives l left join public.profiles hp on hp.id = l.host_id where l.id = live),
    'viewers', coalesce((select jsonb_agg(jsonb_build_object(
        'user_id', v.user_id, 'username', p.username, 'age_group', private.age_group(v.user_id),
        'first_joined_at', v.first_joined_at, 'joined_at', v.joined_at, 'last_seen_at', v.last_seen_at,
        'left_at', v.left_at, 'removed_at', v.removed_at, 'watch_seconds', v.watch_seconds,
        'was_cohost', v.was_cohost) order by v.first_joined_at)
      from public.live_viewers v left join public.profiles p on p.id = v.user_id where v.live_id = live), '[]'::jsonb),
    'comments', coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at) from (
        select x.id, x.user_id, x.name, coalesce(r.body, x.body) as body, x.created_at, x.deleted_at
          from public.live_comments x left join private.live_removed_comments r on r.comment_id = x.id
         where x.live_id = live order by x.created_at desc limit 50) c), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(to_jsonb(e) order by e.at, e.id) from (
        select y.id, y.at, y.kind, y.actor, y.target, y.detail from private.live_events y
         where y.live_id = live and y.kind <> 'report' order by y.at desc, y.id desc limit 100) e), '[]'::jsonb),
    'report_count', (select count(*)::integer from private.live_events y where y.live_id = live and y.kind = 'report')
  );
$$;
revoke all on function private.live_snapshot(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. Privacy rules (RLS) and live updates
-- ---------------------------------------------------------------------
alter table public.lives enable row level security;
alter table public.live_viewers enable row level security;
alter table public.live_comments enable row level security;
alter table public.live_invites enable row level security;
revoke all on public.lives, public.live_viewers, public.live_comments, public.live_invites from anon, authenticated;
-- lives and live_viewers: no rules at all, so the app can't read or write them (only the functions below can).
-- Comments: read while you may watch, never from someone blocked either way. Only the functions below write them.
grant select on public.live_comments to authenticated;
drop policy if exists "Viewers can read the live's comments" on public.live_comments;
create policy "Viewers can read the live's comments" on public.live_comments for select to authenticated
  using (private.can_read_live_comments(live_id) and not private.is_blocked(user_id, (select auth.uid())));
-- Asks: only the host and the friend asked.
grant select on public.live_invites to authenticated;
drop policy if exists "The host and the guest can see an ask" on public.live_invites;
create policy "The host and the guest can see an ask" on public.live_invites for select to authenticated
  using ((select auth.uid()) in (host_id, guest_id));

-- New and deleted comments, and asks, reach phones live. (Not "lives": the host's ping changes it every
-- 15 seconds, which would go out to every Home screen.)
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'live_comments') then
      alter publication supabase_realtime add table public.live_comments;
    end if;
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'live_invites') then
      alter publication supabase_realtime add table public.live_invites;
    end if;
  end if;
end;
$$;

-- A deleted comment keeps its words privately (also when the owner deletes one in the Table Editor).
create or replace function private.live_comment_keep_text()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    insert into private.live_removed_comments (comment_id, live_id, user_id, body, created_at, removed_by)
    values (old.id, old.live_id, old.user_id, old.body, old.created_at, auth.uid())
    on conflict (comment_id) do nothing;
    new.body := '';
  end if;
  return new;
end;
$$;
revoke all on function private.live_comment_keep_text() from public, anon, authenticated;
drop trigger if exists live_comments_keep_text on public.live_comments;
create trigger live_comments_keep_text before update on public.live_comments
  for each row execute function private.live_comment_keep_text();

-- ---------------------------------------------------------------------
-- 6. The job list for live-admin
-- ---------------------------------------------------------------------
-- Wakes live-admin, at most once per transaction. pg_net sends after the transaction is saved, so
-- live-admin always sees the new jobs. A problem here never stops anything else.
create or replace function private.live_poke()
returns void language plpgsql security definer set search_path = '' as $$
declare
  secret_key text;
begin
  if coalesce(current_setting('peekaboo.live_poke', true), '') = 'on' then
    return;
  end if;
  begin
    select s.decrypted_secret into secret_key from vault.decrypted_secrets s where s.name = 'live_admin_key';
    perform net.http_post(
      url := 'https://vclexbnnykjpmxoyakcp.supabase.co/functions/v1/live-admin',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-live-key', secret_key),
      body := '{}'::jsonb
    );
    perform set_config('peekaboo.live_poke', 'on', true);
  exception when others then
    raise warning 'Lives: could not wake live-admin: %', sqlerrm;
  end;
end;
$$;
revoke all on function private.live_poke() from public, anon, authenticated;

-- Adds a job (a copy that is still waiting is not added twice) and wakes live-admin.
create or replace function private.live_enqueue(live uuid, room_name text, who uuid, job_kind text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into private.live_jobs (live_id, room, person, kind) values (live, room_name, who, job_kind)
  on conflict do nothing;
  perform private.live_poke();
end;
$$;
revoke all on function private.live_enqueue(uuid, text, uuid, text) from public, anon, authenticated;

-- "Check this person in this live": live-admin takes them out if they may not watch any more. If they may
-- not watch right now, they also drop out of the host's list and the counts at once.
create or replace function private.live_check(live uuid, who uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  room_name text;
begin
  select l.room into room_name from public.lives l where l.id = live;
  if room_name is null or who is null then
    return;
  end if;
  perform private.live_enqueue(live, room_name, who, 'check');
  if private.live_access(live, who) not in ('host', 'cohost', 'viewer') then
    update public.live_viewers v set left_at = now() where v.live_id = live and v.user_id = who and v.left_at is null;
  end if;
end;
$$;
revoke all on function private.live_check(uuid, uuid) from public, anon, authenticated;

-- Two people stopped being friends (or one blocked the other). In every running live where one of them is the
-- host or the person brought on, the other one is checked. If they were host and co-host, the co-host comes off.
create or replace function private.live_pair_changed(a uuid, b uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  l public.lives%rowtype;
begin
  if a is null or b is null then
    return;
  end if;
  for l in select * from public.lives x
            where x.ended_at is null and (x.host_id in (a, b) or x.cohost_id in (a, b)) loop
    if (l.host_id = a and l.cohost_id = b) or (l.host_id = b and l.cohost_id = a) then
      update public.lives x set cohost_id = null, cohost_since = null where x.id = l.id;
    end if;
    if (a = l.host_id or a = l.cohost_id) and (b = l.cohost_id or exists (
        select 1 from public.live_viewers v where v.live_id = l.id and v.user_id = b)) then
      perform private.live_check(l.id, b);
    end if;
    if (b = l.host_id or b = l.cohost_id) and (a = l.cohost_id or exists (
        select 1 from public.live_viewers v where v.live_id = l.id and v.user_id = a)) then
      perform private.live_check(l.id, a);
    end if;
  end loop;
end;
$$;
revoke all on function private.live_pair_changed(uuid, uuid) from public, anon, authenticated;

-- Banned: their own lives end, they come off any stage, and they are checked in every live they were in.
create or replace function private.live_after_ban(who uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v record;
begin
  update public.lives x set ended_at = now(), ended_reason = 'safety' where x.host_id = who and x.ended_at is null;
  update public.lives x set cohost_id = null, cohost_since = null where x.cohost_id = who and x.ended_at is null;
  for v in select y.live_id from public.live_viewers y join public.lives l on l.id = y.live_id
            where y.user_id = who and l.ended_at is null loop
    perform private.live_check(v.live_id, who);
  end loop;
end;
$$;
revoke all on function private.live_after_ban(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 7. Notifications: "🔴 Sam is live" to friends, and the owner's teen check
-- ---------------------------------------------------------------------
-- Friends who may watch, who have the "Lives" switch on and haven't hidden the host's stories, on phones with
-- the new app. 100 messages per request (Expo's limit). A problem never stops going live.
create or replace function private.push_live(live uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  host uuid;
  title_words text;
  batch jsonb;
begin
  select l.host_id into host from public.lives l where l.id = live;
  if host is null then
    return;
  end if;
  title_words := '🔴 ' || coalesce(private.push_name(host), 'A friend') || ' is live';
  for batch in
    with phones as (
      select t.token, (row_number() over (order by t.token) - 1) as n
        from public.friendships f
        join public.push_tokens t
          on t.user_id = case when f.requester_id = host then f.addressee_id else f.requester_id end
       where f.status = 'accepted' and (f.requester_id = host or f.addressee_id = host)
         and t.can_live
         and private.live_friends(host, t.user_id)
         and private.invite_user_ok(t.user_id)
         and coalesce((select p.lives from public.notification_prefs p where p.user_id = t.user_id), true)
         and not coalesce((select s.mute_stories from public.friend_settings s
                            where s.user_id = t.user_id and s.friend_id = host), false)
    )
    select jsonb_agg(jsonb_build_object(
             'to', ph.token, 'title', title_words, 'body', 'Tap to watch',
             'data', jsonb_build_object('type', 'live', 'live', live, 'host', host),
             'sound', 'default', 'channelId', 'default') order by ph.n)
      from phones ph group by ph.n / 100 order by ph.n / 100
  loop
    begin
      perform net.http_post(
        url := 'https://exp.host/--/api/v2/push/send',
        body := batch,
        headers := '{"Content-Type":"application/json","Accept":"application/json"}'::jsonb
      );
    exception when others then
      raise warning 'Lives: a notification batch could not be queued: %', sqlerrm;
    end;
  end loop;
end;
$$;
revoke all on function private.push_live(uuid) from public, anon, authenticated;

-- The owner's "👀 Live check": an adult's live with 5 or more under-18 viewers (once per live).
-- Hosts are never shown anyone's age.
create or replace function private.live_teen_check(live uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  l public.lives%rowtype;
  person_to_tell uuid;
begin
  select * into l from public.lives x where x.id = live;
  if not found or l.teen_alert_at is not null or private.age_group(l.host_id) is distinct from 'adult' then
    return;
  end if;
  if (select count(*) from public.live_viewers v
       where v.live_id = live and private.age_group(v.user_id) is distinct from 'adult') < 5 then
    return;
  end if;
  update public.lives x set teen_alert_at = now() where x.id = live;
  for person_to_tell in select a.user_id from private.report_alert_people a loop
    begin
      perform private.send_push(person_to_tell, 'reports', '👀 Live check',
        'An adult''s live has 5 or more under-18 viewers', '{"type":"report"}'::jsonb);
    exception when others then
      null;
    end;
  end loop;
end;
$$;
revoke all on function private.live_teen_check(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 8. What the app calls
-- ---------------------------------------------------------------------
-- Why can't this person go live right now? Null = they can. In this order: off, testers, banned, restricted,
-- birthday, rules, no_friends, new_account, daily_limit, month_limit, busy.
create or replace function private.live_why_not(person uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  s private.live_settings := private.live_config();
  why text := private.can_host(person);
begin
  if why is not null then
    return why;
  end if;
  if not exists (
    select 1 from public.friendships f
     where f.status = 'accepted' and (f.requester_id = person or f.addressee_id = person)
       and private.live_friends(person, case when f.requester_id = person then f.addressee_id else f.requester_id end)
  ) then
    return 'no_friends';
  end if;
  if s.min_account_days > 0 and exists (
    select 1 from public.profiles p where p.id = person and p.created_at > now() - make_interval(days => s.min_account_days)
  ) then
    return 'new_account';
  end if;
  -- Only lives that went on air count, so a start that failed doesn't use one up.
  if not exists (select 1 from private.live_testers t where t.user_id = person and t.no_limits)
     and (select count(*) from public.lives l
           where l.host_id = person and l.on_air_at > now() - interval '24 hours') >= s.lives_per_day then
    return 'daily_limit';
  end if;
  if s.host_month_minutes > 0 and private.live_host_month_minutes(person) >= s.host_month_minutes then
    return 'month_limit';
  end if;
  if (select count(*) from public.lives l
       where l.ended_at is null and now() < l.ends_at and l.host_id <> person) >= s.max_live_now
     or (s.monthly_minutes > 0 and private.live_month_minutes() >= s.monthly_minutes) then
    return 'busy';
  end if;
  return null;
end;
$$;
revoke all on function private.live_why_not(uuid) from public, anon, authenticated;

-- What the Go live sheet shows. Changes nothing.
create or replace function public.live_state()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  s private.live_settings := private.live_config();
  why text;
  used integer;
begin
  if me is null then
    perform private.live_fail('live_login');
  end if;
  why := private.live_why_not(me);
  select count(*) into used from public.lives l where l.host_id = me and l.on_air_at > now() - interval '24 hours';
  return jsonb_build_object(
    'can_go_live', why is null,
    'why_not', why,
    'my_live', (select l.id from public.lives l where l.host_id = me and l.ended_at is null and now() < l.ends_at limit 1),
    'max_minutes', s.max_minutes,
    'lives_left_today', case when exists (select 1 from private.live_testers t where t.user_id = me and t.no_limits)
                             then s.lives_per_day else greatest(s.lives_per_day - used, 0) end,
    'rules_accepted', exists (select 1 from public.legal_acceptances g where g.user_id = me and g.document = 'live_rules')
  );
end;
$$;
revoke execute on function public.live_state() from public, anon;
grant execute on function public.live_state() to authenticated;

-- Starts a live (not on air yet: friends see it only after live_on_air). Ends any live of mine still open.
create or replace function public.start_live(expected_user_id uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  s private.live_settings;
  why text;
  made uuid := gen_random_uuid();
begin
  if me is null or (expected_user_id is not null and expected_user_id <> me) then
    perform private.live_fail('live_login');
  end if;
  -- One start at a time per person.
  perform pg_advisory_xact_lock(hashtextextended('live:' || me::text, 0));
  -- One start at a time for everyone, so two people starting at the same moment can't both get past the
  -- "busy" limits (lives at once, the monthly minutes). It is its own statement on purpose: the checks below
  -- then see a start that was saved while we waited. (Minutes still add up while lives run, so the monthly
  -- budget stays a soft limit.)
  perform pg_advisory_xact_lock(hashtextextended('live:start', 0));
  why := private.live_why_not(me);
  if why is not null then
    perform private.live_fail('live_' || why);
  end if;
  -- At most 10 starts an hour, for everyone (testers too), counting starts that never went on air: each start
  -- adds work to the job list every live shares, and calls to LiveKit.
  if (select count(*) from public.lives l where l.host_id = me and l.started_at > now() - interval '1 hour') >= 10 then
    perform private.live_fail('live_busy');
  end if;
  s := private.live_config();
  update public.lives x
     set ended_at = now(), ended_reason = case when now() >= x.ends_at then 'time' else 'host_gone' end
   where x.host_id = me and x.ended_at is null;
  insert into public.lives (id, host_id, room, ends_at, last_viewer_at)
  values (made, me, 'live_' || made::text, now() + make_interval(mins => s.max_minutes), now());
  -- The host's age group and username are kept with the record (an account deletion removes them later).
  perform private.live_log(made, 'start', me, null, jsonb_build_object(
    'host_age_group', private.age_group(me),
    'host_username', (select p.username from public.profiles p where p.id = me)));
  return made;
end;
$$;
revoke execute on function public.start_live(uuid) from public, anon;
grant execute on function public.start_live(uuid) to authenticated;

-- The camera is out: friends can see the live now, and get the notification (at most once every
-- push_every per host; never twice for one live).
create or replace function public.live_on_air(live uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  l public.lives%rowtype;
  s private.live_settings := private.live_config();
begin
  select * into l from public.lives x where x.id = live for update;
  if not found or me is null or l.host_id <> me then
    perform private.live_fail('live_not_host');
  end if;
  if l.ended_at is not null or now() >= l.ends_at then
    perform private.live_fail('live_not_on');
  end if;
  if l.on_air_at is not null then
    return;
  end if;
  update public.lives x set on_air_at = now(), last_viewer_at = now(), host_seen_at = now() where x.id = live;
  perform private.live_log(live, 'on_air', me, null);
  if l.pushed_at is null and (
    exists (select 1 from private.live_testers t where t.user_id = me and t.no_limits)
    or not exists (select 1 from public.lives o where o.host_id = me and o.pushed_at > now() - s.push_every)
  ) then
    update public.lives x set pushed_at = now() where x.id = live;
    perform private.push_live(live);
  end if;
end;
$$;
revoke execute on function public.live_on_air(uuid) from public, anon;
grant execute on function public.live_on_air(uuid) to authenticated;

-- The host ends the live. Safe to repeat. Returns the numbers for "That's a wrap".
create or replace function public.end_live(live uuid, heart_count integer default 0)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  l public.lives%rowtype;
begin
  select * into l from public.lives x where x.id = live for update;
  if not found or me is null or l.host_id <> me then
    perform private.live_fail('live_not_host');
  end if;
  if l.ended_at is null then
    update public.lives x
       set ended_at = now(),
           ended_reason = case when now() >= x.ends_at - interval '5 seconds' then 'time' else 'host' end,
           hearts = least(greatest(coalesce(heart_count, 0), 0), 1000000)
     where x.id = live
    returning * into l;
  end if;
  return jsonb_build_object(
    'seconds', case when l.on_air_at is null then 0
                    else greatest(floor(extract(epoch from (l.ended_at - l.on_air_at))), 0)::integer end,
    'viewers', (select count(*)::integer from public.live_viewers v where v.live_id = live),
    'comments', (select count(*)::integer from public.live_comments c where c.live_id = live and c.deleted_at is null),
    'hearts', l.hearts,
    'ended_reason', l.ended_reason
  );
end;
$$;
revoke execute on function public.end_live(uuid, integer) from public, anon;
grant execute on function public.end_live(uuid, integer) to authenticated;

-- What a live looks like to this person. Only friends learn anything; only people who may watch right now see
-- who is on with the host, the count and their ask; only the host learns why it ended.
create or replace function private.live_status_json(live uuid, me uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  access text := private.live_access(live, me);
  l public.lives%rowtype;
  s private.live_settings := private.live_config();
  state text;
  host_card jsonb;
  cohost_card jsonb;
  open_invite jsonb;
  seen integer := 0;
begin
  if access = 'not_allowed' then
    return jsonb_build_object('status', 'not_allowed', 'role', null, 'live_id', live);
  end if;
  select * into l from public.lives x where x.id = live;
  state := case when access in ('host', 'cohost', 'viewer') then 'live' else access end;
  select jsonb_build_object('id', p.id, 'username', p.username, 'display_name', p.display_name, 'avatar_path', p.avatar_path)
    into host_card from public.profiles p where p.id = l.host_id;
  if state = 'live' then
    if l.cohost_id is not null then
      select jsonb_build_object('id', p.id, 'username', p.username, 'display_name', p.display_name, 'avatar_path', p.avatar_path)
        into cohost_card from public.profiles p where p.id = l.cohost_id;
    end if;
    seen := private.live_viewer_count(live);
    select jsonb_build_object('id', i.id, 'expires_at', i.expires_at) into open_invite
      from public.live_invites i
     where i.live_id = live and i.guest_id = me and i.answer is null and i.expires_at > now()
     order by i.created_at desc limit 1;
  end if;
  return jsonb_build_object(
    'status', state,
    'role', case when state = 'live' then access end,
    'live_id', l.id,
    'host', host_card,
    'cohost', cohost_card,
    'started_at', l.started_at,
    'on_air_at', l.on_air_at,
    'ends_at', l.ends_at,
    'comments_on', l.comments_on,
    'viewers', seen,
    'invite', open_invite,
    'ended_reason', case when me = l.host_id then l.ended_reason end,
    'empty_ends_at', case when state = 'live' and access = 'host' and l.on_air_at is not null and seen = 0
                          then l.last_viewer_at + make_interval(mins => s.empty_minutes) end
  );
end;
$$;
revoke all on function private.live_status_json(uuid, uuid) from public, anon, authenticated;

create or replace function public.live_status(live uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select private.live_status_json(live, (select auth.uid()));
$$;
revoke execute on function public.live_status(uuid) from public, anon;
grant execute on function public.live_status(uuid) to authenticated;

-- "Still here" (host every 15 s, others every 30 s). Same answer as live_status. Only someone who may watch
-- right now is counted as here; it never makes a presence row.
create or replace function public.live_ping(live uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  access text := private.live_access(live, me);
begin
  if access = 'host' then
    update public.lives x set host_seen_at = now() where x.id = live;
  elsif access in ('cohost', 'viewer') then
    update public.live_viewers v
       set watch_seconds = v.watch_seconds + least(greatest(floor(extract(epoch from (now() - v.last_seen_at))), 0), 60)::integer,
           last_seen_at = now(), left_at = null
     where v.live_id = live and v.user_id = me and v.removed_at is null
       and v.last_seen_at <= now() - interval '10 seconds';
  end if;
  return private.live_status_json(live, me);
end;
$$;
revoke execute on function public.live_ping(uuid) from public, anon;
grant execute on function public.live_ping(uuid) to authenticated;

-- Leaving. The person brought on leaving also comes off the stage. (The host ends with end_live.)
create or replace function public.leave_live(live uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    return;
  end if;
  -- The live row before the presence row (the same order as everything else, so two can't wait on each
  -- other). It is only locked when you really are the person brought on.
  update public.lives x set cohost_id = null, cohost_since = null
   where x.id = live and x.cohost_id = me and x.ended_at is null;
  update public.live_viewers v
     set watch_seconds = v.watch_seconds + least(greatest(floor(extract(epoch from (now() - v.last_seen_at))), 0), 60)::integer,
         left_at = now()
   where v.live_id = live and v.user_id = me and v.left_at is null;
end;
$$;
revoke execute on function public.leave_live(uuid) from public, anon;
grant execute on function public.leave_live(uuid) to authenticated;

-- Friends live right now (for the circles on Home). Not my own, not someone I hid, never one I'd be waiting on.
create or replace function public.friends_live_now()
returns table(live_id uuid, host_id uuid, host_username text, host_name text, host_avatar text,
              cohost_id uuid, cohost_username text, cohost_avatar text, started_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select l.id, l.host_id, hp.username, coalesce(nullif(hp.display_name, ''), hp.username), hp.avatar_path,
         l.cohost_id, cp.username, cp.avatar_path, l.started_at
    from public.lives l
    join public.profiles hp on hp.id = l.host_id
    left join public.profiles cp on cp.id = l.cohost_id
   where l.ended_at is null and l.on_air_at is not null and now() < l.ends_at
     and l.host_seen_at > now() - interval '90 seconds'
     and l.host_id <> (select auth.uid())
     and private.live_access(l.id, (select auth.uid())) in ('viewer', 'cohost')
     and not coalesce((select s.mute_stories from public.friend_settings s
                        where s.user_id = (select auth.uid()) and s.friend_id = l.host_id), false)
   order by l.started_at desc
   limit 50;
$$;
revoke execute on function public.friends_live_now() from public, anon;
grant execute on function public.friends_live_now() to authenticated;

-- Why can't the host ask this friend on right now? Null = they can. (The same checks for the list and the ask.)
create or replace function private.live_invite_problem(live uuid, guest uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  l public.lives%rowtype;
  why text;
begin
  select * into l from public.lives x where x.id = live;
  if not found or l.ended_at is not null or now() >= l.ends_at or l.on_air_at is null then
    return 'live_not_on';
  end if;
  if l.cohost_id is not null then
    return 'live_has_cohost';
  end if;
  if exists (select 1 from public.live_invites i where i.live_id = live and i.answer is null and i.expires_at > now()) then
    return 'live_invite_open';
  end if;
  if guest is null or guest = l.host_id or not private.connected(live, guest)
     or private.live_access(live, guest) <> 'viewer' then
    return 'live_not_watching';
  end if;
  why := private.can_host(guest);
  if why is not null and why <> 'rules' then
    return 'live_guest_cant';
  end if;
  -- At most 2 asks per friend per live, and none after a "Not now".
  if exists (select 1 from public.live_invites i where i.live_id = live and i.guest_id = guest and i.answer = 'declined')
     or (select count(*) from public.live_invites i where i.live_id = live and i.guest_id = guest) >= 2 then
    return 'live_invite_wait';
  end if;
  if (select count(*) from public.live_invites i where i.live_id = live) >= 10 then
    return 'live_invite_limit';
  end if;
  return null;
end;
$$;
revoke all on function private.live_invite_problem(uuid, uuid) from public, anon, authenticated;

-- Who's watching (the host only; the person brought on only gets the count).
create or replace function public.live_viewers_list(live uuid)
returns table(user_id uuid, username text, display_name text, avatar_path text, joined_at timestamptz,
              is_cohost boolean, can_cohost boolean)
language sql stable security definer set search_path = '' as $$
  select v.user_id, p.username, p.display_name, p.avatar_path, v.joined_at,
         coalesce(v.user_id = l.cohost_id, false),
         private.live_invite_problem(l.id, v.user_id) is null
    from public.lives l
    join public.live_viewers v on v.live_id = l.id
    join public.profiles p on p.id = v.user_id
   where l.id = live
     and private.live_access(l.id, (select auth.uid())) = 'host'
     and (v.user_id = l.cohost_id
          or (private.connected(l.id, v.user_id) and private.live_access(l.id, v.user_id) in ('viewer', 'cohost')))
   order by v.joined_at;
$$;
revoke execute on function public.live_viewers_list(uuid) from public, anon;
grant execute on function public.live_viewers_list(uuid) to authenticated;

-- The person brought on: who may see and hear me right now? The host, me, and everyone in this live who may
-- watch while I'm on (friends of both). My phone gives LiveKit this list before my camera goes out, and again
-- every few seconds, so LiveKit itself never sends my camera or voice to anyone else – not even to someone
-- who comes back with an old pass while they should be waiting. Anyone else asking gets an empty list.
create or replace function public.live_stage_allowlist(live uuid)
returns text[] language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  l public.lives%rowtype;
begin
  if private.live_access(live, me) is distinct from 'cohost' then
    return '{}'::text[];
  end if;
  select * into l from public.lives x where x.id = live;
  return array[l.host_id::text, me::text] || array(
    select v.user_id::text from public.live_viewers v
     where v.live_id = live and v.removed_at is null and v.user_id <> l.host_id and v.user_id <> me
       and private.live_access(live, v.user_id) = 'viewer'
     order by v.user_id);
end;
$$;
revoke execute on function public.live_stage_allowlist(uuid) from public, anon;
grant execute on function public.live_stage_allowlist(uuid) to authenticated;

-- The host asks a friend who is watching to come on (60 seconds to answer).
create or replace function public.invite_cohost(live uuid, guest uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  l public.lives%rowtype;
  problem text;
  guest_name text;
  made uuid;
begin
  select * into l from public.lives x where x.id = live for update;
  if not found or me is null or l.host_id <> me then
    perform private.live_fail('live_not_host');
  end if;
  -- Old asks nobody answered count as "didn't answer".
  update public.live_invites i set answer = 'expired', answered_at = now()
   where i.live_id = live and i.answer is null and i.expires_at <= now();
  problem := private.live_invite_problem(live, guest);
  if problem is not null then
    guest_name := coalesce(private.push_name(guest), 'They');
    perform private.live_fail(problem, case problem
      when 'live_guest_cant' then guest_name || ' can''t come on right now.'
      when 'live_invite_wait' then 'You can''t ask ' || guest_name || ' again this live.'
      when 'live_not_watching' then guest_name || ' isn''t watching right now.'
    end);
  end if;
  insert into public.live_invites (live_id, host_id, guest_id, expires_at)
  values (live, me, guest, now() + interval '60 seconds')
  returning id into made;
  perform private.live_log(live, 'invite', me, guest);
  return made;
end;
$$;
revoke execute on function public.invite_cohost(uuid, uuid) from public, anon;
grant execute on function public.invite_cohost(uuid, uuid) to authenticated;

-- The host takes back an ask nobody answered yet.
create or replace function public.cancel_cohost_invite(live uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
begin
  if me is null or not exists (select 1 from public.lives x where x.id = live and x.host_id = me) then
    perform private.live_fail('live_not_host');
  end if;
  update public.live_invites i set answer = 'cancelled', answered_at = now()
   where i.live_id = live and i.answer is null;
end;
$$;
revoke execute on function public.cancel_cohost_invite(uuid) from public, anon;
grant execute on function public.cancel_cohost_invite(uuid) to authenticated;

-- The friend answers. "Not now" can't be asked again this live. Yes needs everything going live needs; if only
-- the Live rules are missing, the ask stays open (the app shows the rules card and tries again).
create or replace function public.answer_cohost_invite(invite uuid, accept boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  live uuid;
  i public.live_invites%rowtype;
  l public.lives%rowtype;
  why text;
begin
  select y.live_id into live from public.live_invites y where y.id = invite;
  if not found or me is null then
    perform private.live_fail('live_invite_gone');
  end if;
  -- The live first, then the ask (the same order as invite_cohost).
  select * into l from public.lives x where x.id = live for update;
  select * into i from public.live_invites y where y.id = invite for update;
  if i.guest_id <> me then
    perform private.live_fail('live_invite_gone');
  end if;
  if not coalesce(accept, false) then
    if i.answer is null then
      update public.live_invites y
         set answer = case when y.expires_at <= now() then 'expired' else 'declined' end, answered_at = now()
       where y.id = invite;
    end if;
    return jsonb_build_object('role', 'viewer');
  end if;
  -- A second tap on Yes.
  if i.answer = 'accepted' and l.cohost_id = me and l.ended_at is null then
    return jsonb_build_object('role', 'cohost');
  end if;
  if i.answer is not null or i.expires_at <= now() or l.ended_at is not null or now() >= l.ends_at then
    perform private.live_fail('live_invite_gone');
  end if;
  if l.cohost_id is not null then
    perform private.live_fail('live_has_cohost');
  end if;
  if private.live_access(live, me) <> 'viewer' then
    perform private.live_fail('live_not_watching');
  end if;
  why := private.can_host(me);
  if why is not null then
    perform private.live_fail('live_' || why);
  end if;
  update public.live_invites y set answer = 'accepted', answered_at = now() where y.id = invite;
  update public.lives x set cohost_id = me, cohost_since = now() where x.id = live;
  update public.live_viewers v set was_cohost = true where v.live_id = live and v.user_id = me;
  perform private.live_log(live, 'cohost_on', me, l.host_id);
  return jsonb_build_object('role', 'cohost');
end;
$$;
revoke execute on function public.answer_cohost_invite(uuid, boolean) from public, anon;
grant execute on function public.answer_cohost_invite(uuid, boolean) to authenticated;

-- "Back to watching" (the host) or "Leave stage" (the person brought on).
create or replace function public.end_cohost(live uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  l public.lives%rowtype;
begin
  select * into l from public.lives x where x.id = live for update;
  if not found or me is null then
    perform private.live_fail('live_not_host');
  end if;
  if me = l.host_id or me = l.cohost_id then
    if l.cohost_id is not null then
      update public.lives x set cohost_id = null, cohost_since = null where x.id = live;
    end if;
    return;
  end if;
  -- Already taken off: nothing to do.
  if exists (select 1 from public.live_viewers v where v.live_id = live and v.user_id = me and v.was_cohost) then
    return;
  end if;
  perform private.live_fail('live_not_host');
end;
$$;
revoke execute on function public.end_cohost(uuid) from public, anon;
grant execute on function public.end_cohost(uuid) to authenticated;

-- The host removes someone who is (or was) watching. They can't get back into this live. Only someone with a
-- presence row can be removed, so a host can't add a stranger to the "who was there" record.
create or replace function public.remove_live_viewer(live uuid, viewer uuid, also_block boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  l public.lives%rowtype;
begin
  select * into l from public.lives x where x.id = live for update;
  if not found or me is null or l.host_id <> me then
    perform private.live_fail('live_not_host');
  end if;
  if viewer is null or viewer = me then
    perform private.live_fail('live_not_watching', 'They''re not watching this live.');
  end if;
  update public.live_viewers v set removed_at = coalesce(v.removed_at, now()), left_at = coalesce(v.left_at, now())
   where v.live_id = live and v.user_id = viewer;
  if not found then
    perform private.live_fail('live_not_watching', 'They''re not watching this live.');
  end if;
  if l.cohost_id = viewer then
    update public.lives x set cohost_id = null, cohost_since = null where x.id = live;
  end if;
  perform private.live_check(live, viewer);
  perform private.live_log(live, 'remove', me, viewer);
  if coalesce(also_block, false) then
    perform public.block_user(viewer);
  end if;
end;
$$;
revoke execute on function public.remove_live_viewer(uuid, uuid, boolean) from public, anon;
grant execute on function public.remove_live_viewer(uuid, uuid, boolean) to authenticated;

-- A comment. Only from someone who may watch right now (and, for a viewer, is really there).
create or replace function public.send_live_comment(live uuid, comment text)
returns public.live_comments language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  l public.lives%rowtype;
  access text;
  clean text;
  problem text;
  last_one public.live_comments%rowtype;
  saved public.live_comments%rowtype;
begin
  if me is null then
    perform private.live_fail('live_login');
  end if;
  -- One at a time per person and live, so two quick taps can't both get past slow mode.
  perform pg_advisory_xact_lock(hashtextextended('live_comment:' || coalesce(live::text, '') || ':' || me::text, 0));
  access := private.live_access(live, me);
  if access = 'ended' then
    perform private.live_fail('live_not_on');
  end if;
  if access not in ('host', 'cohost', 'viewer') or (access = 'viewer' and not private.connected(live, me)) then
    perform private.live_fail('live_not_watching');
  end if;
  select * into l from public.lives x where x.id = live;
  if not l.comments_on and access <> 'host' then
    perform private.live_fail('live_comments_off');
  end if;
  clean := btrim(regexp_replace(coalesce(comment, ''), '\s+', ' ', 'g'));
  if char_length(clean) not between 1 and 150 then
    perform private.live_fail('live_comment_size');
  end if;
  if private.blocked_word(clean, 'content') is not null then
    perform private.live_fail('live_comment_word');
  end if;
  problem := private.dare_problem(clean);
  if problem is not null then
    perform private.live_fail('live_comment_' || problem);
  end if;
  select * into last_one from public.live_comments c
   where c.live_id = live and c.user_id = me order by c.created_at desc limit 1;
  if found and last_one.created_at > now() - interval '3 seconds' then
    perform private.live_fail('live_comment_slow');
  end if;
  if found and last_one.deleted_at is null and lower(last_one.body) = lower(clean) then
    perform private.live_fail('live_comment_same');
  end if;
  if (select count(*) from public.live_comments c where c.live_id = live and c.user_id = me) >= 100 then
    perform private.live_fail('live_comment_limit');
  end if;
  if (select count(*) from public.live_comments c
       where c.live_id = live and c.created_at > now() - interval '10 seconds') >= 30 then
    perform private.live_fail('live_comment_busy');
  end if;
  insert into public.live_comments (live_id, user_id, name, avatar_path, body)
  select live, me, coalesce(private.push_name(me), 'Someone'), p.avatar_path, clean
    from public.profiles p where p.id = me
  returning * into saved;
  return saved;
end;
$$;
revoke execute on function public.send_live_comment(uuid, text) from public, anon;
grant execute on function public.send_live_comment(uuid, text) to authenticated;

-- Deletes a comment (its writer or the host). The words are kept privately for reports.
create or replace function public.delete_live_comment(comment_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  c public.live_comments%rowtype;
begin
  select * into c from public.live_comments x where x.id = delete_live_comment.comment_id for update;
  if not found then
    return;
  end if;
  if me is null or (me <> c.user_id and not exists (
      select 1 from public.lives l where l.id = c.live_id and l.host_id = me)) then
    perform private.live_fail('live_not_host', 'You can''t delete that comment.');
  end if;
  if c.deleted_at is not null then
    return;
  end if;
  update public.live_comments x set deleted_at = now(), body = '' where x.id = c.id;
  perform private.live_log(c.live_id, 'comment_deleted', me, c.user_id, jsonb_build_object('comment', c.id));
end;
$$;
revoke execute on function public.delete_live_comment(uuid) from public, anon;
grant execute on function public.delete_live_comment(uuid) to authenticated;

-- The host switches comments on or off.
create or replace function public.set_live_comments(live uuid, turn_on boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
begin
  update public.lives x set comments_on = coalesce(turn_on, true)
   where x.id = live and x.host_id = me and x.ended_at is null;
  if not found then
    perform private.live_fail('live_not_host');
  end if;
end;
$$;
revoke execute on function public.set_live_comments(uuid, boolean) from public, anon;
grant execute on function public.set_live_comments(uuid, boolean) to authenticated;

-- The app says whether this phone can open a live (sent after register_push_token; only your own phone).
create or replace function public.set_push_capability(push_token text, live_ok boolean)
returns void language sql security definer set search_path = '' as $$
  update public.push_tokens set can_live = coalesce(live_ok, false)
   where token = push_token and user_id = (select auth.uid());
$$;
revoke execute on function public.set_push_capability(text, boolean) from public, anon;
grant execute on function public.set_push_capability(text, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- 9. What only the server calls (the live-token and live-admin Edge Functions)
-- ---------------------------------------------------------------------
-- The pass gate: may this account get a LiveKit pass for this live? Every request is counted, refused ones too.
create or replace function public.live_join(account uuid, live uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  who uuid := account;
  l public.lives%rowtype;
  s private.live_settings := private.live_config();
  access text;
  stage_wait boolean;
  allowance integer;
begin
  if who is null then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('live_token:' || who::text, 0));
  -- The live is locked BEFORE anything is decided, so a removal (or a change of who is on stage) being saved at
  -- this very moment is waited for and seen. The order is always: this person, then the live, then presence.
  select * into l from public.lives x where x.id = live for update;
  access := private.live_access(live, who);
  -- A friend coming on asks again every 2 seconds while the stage is made ready. Those requests have their own
  -- allowance (80 per 10 minutes), so they can never use up the 30 per 10 minutes for watching.
  stage_wait := access = 'cohost' and (l.stage_clean_at is null or l.stage_clean_at < l.cohost_since);
  allowance := case when stage_wait then 80 else 30 end;
  if (select count(*) from private.live_token_log t
       where t.account = who and t.stage = stage_wait and t.at > now() - interval '10 minutes') >= allowance then
    insert into private.live_token_log (account, ok, stage) values (who, false, stage_wait);
    return jsonb_build_object('ok', false, 'reason', 'busy');
  end if;
  if access not in ('host', 'cohost', 'viewer') then
    insert into private.live_token_log (account, ok, stage) values (who, false, false);
    return jsonb_build_object('ok', false, 'reason', access);
  end if;
  if access = 'viewer' and not private.connected(live, who) and (
    select count(*) from public.live_viewers v
     where v.live_id = live and v.left_at is null and v.last_seen_at > now() - interval '75 seconds'
       and v.removed_at is null and v.user_id is distinct from l.cohost_id
  ) >= s.max_viewers then
    insert into private.live_token_log (account, ok, stage) values (who, false, false);
    return jsonb_build_object('ok', false, 'reason', 'full');
  end if;
  if access = 'host' then
    update public.lives x set host_seen_at = now() where x.id = live;
  else
    insert into public.live_viewers as v (live_id, user_id, was_cohost) values (live, who, access = 'cohost')
    on conflict (live_id, user_id) do update
      set joined_at = now(), last_seen_at = now(), left_at = null, was_cohost = v.was_cohost or excluded.was_cohost;
    if access = 'viewer' then
      update public.lives x set last_viewer_at = now() where x.id = live;
      perform private.live_teen_check(live);
    end if;
  end if;
  if not exists (select 1 from private.live_events e
                  where e.live_id = live and e.kind = 'join' and e.actor = who and e.at > now() - interval '60 seconds') then
    perform private.live_log(live, 'join', who, null, jsonb_build_object('role', access));
  end if;
  insert into private.live_token_log (account, ok, stage) values (who, true, stage_wait);
  return jsonb_build_object(
    'ok', true,
    'role', access,
    'room', l.room,
    'max_participants', s.max_viewers + 2,
    'create_room', access = 'host',
    'ttl', case when access = 'viewer' then 60 else 600 end,
    'stage_check', stage_wait,
    'cohost_since', case when access = 'cohost' then l.cohost_since end
  );
end;
$$;
revoke execute on function public.live_join(uuid, uuid) from public, anon, authenticated;
grant execute on function public.live_join(uuid, uuid) to service_role;

-- Before a newly brought-on friend's camera goes out: who in the room must go first (people waiting are taken
-- out "softly", so they can come back at once later), and whether someone who must wait could still join with a
-- pass from the last minute.
create or replace function public.live_stage_check(live uuid, identities text[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  listed text;
  access text;
  removals jsonb := '[]'::jsonb;
  people text[] := coalesce(identities, '{}');
begin
  foreach listed in array people loop
    access := case when listed ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   then private.live_access(live, listed::uuid) else 'not_allowed' end;
    if access not in ('host', 'cohost', 'viewer') then
      removals := removals || jsonb_build_array(jsonb_build_object('identity', listed, 'soft', access = 'paused'));
    end if;
  end loop;
  return jsonb_build_object(
    'remove', removals,
    'wait', exists (select 1 from public.live_viewers v
                     where v.live_id = live and v.joined_at > now() - interval '60 seconds'
                       and not (lower(v.user_id::text) = any (array(select lower(p) from unnest(people) p)))
                       and private.live_access(live, v.user_id) = 'paused')
  );
end;
$$;
revoke execute on function public.live_stage_check(uuid, text[]) from public, anon, authenticated;
grant execute on function public.live_stage_check(uuid, text[]) to service_role;

-- The stage is clean for this co-host turn (only if it is still the same turn).
create or replace function public.live_stage_clean(live uuid, since timestamptz)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.lives x set stage_clean_at = now()
   where x.id = live and x.ended_at is null and x.cohost_id is not null and x.cohost_since = since;
  return found;
end;
$$;
revoke execute on function public.live_stage_clean(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.live_stage_clean(uuid, timestamptz) to service_role;

-- Is this the Vault password live-admin was woken with?
create or replace function public.live_admin_key_ok(given text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(given, '') <> ''
     and exists (select 1 from vault.decrypted_secrets where name = 'live_admin_key' and decrypted_secret = given);
$$;
revoke execute on function public.live_admin_key_ok(text) from public, anon, authenticated;
grant execute on function public.live_admin_key_ok(text) to service_role;

-- live-admin picks up due jobs. What to do is decided NOW, from the one rule (live_access):
--   end    → close the room, if the live has ended (or its row is gone);
--   audit  → list the room, while the live is on air or its ended room is still watched;
--   check  → nothing if they may watch; a soft removal if they wait (they can come back); else a hard one;
--   demote → turn a former co-host back into a viewer, or remove them like "check".
-- Each pick-up counts as a try and moves the next try back (15 s × 2^tries, at most 10 minutes), which also
-- works as a lease: if live-admin crashes, the job is simply picked up again later.
create or replace function public.live_jobs_claim(max_jobs integer default 25)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  j private.live_jobs%rowtype;
  l public.lives%rowtype;
  live_gone boolean;
  watched boolean;
  access text;
  act text;
  soft boolean;
  picked jsonb := '[]'::jsonb;
begin
  for j in
    select * from private.live_jobs q
     where q.done_at is null and q.next_try_at <= now()
     order by q.id
     limit greatest(least(coalesce(max_jobs, 25), 100), 0)
     for update skip locked
  loop
    -- Tried 6 times without an answer: give up (the minute check and the audit are still there).
    if j.tries >= 6 then
      update private.live_jobs q set done_at = now(), last_error = 'gave up: ' || coalesce(q.last_error, 'no answer')
       where q.id = j.id;
      perform private.live_log(j.live_id, 'gave_up', null, j.person, jsonb_build_object('job', j.id, 'kind', j.kind));
      continue;
    end if;
    update private.live_jobs q
       set tries = q.tries + 1,
           next_try_at = now() + least(interval '15 seconds' * power(2, q.tries + 1), interval '10 minutes')
     where q.id = j.id;
    select * into l from public.lives x where x.id = j.live_id;
    live_gone := not found or l.ended_at is not null or now() >= l.ends_at;
    watched := exists (select 1 from private.live_watch_rooms w where w.room = j.room and w.until > now());
    access := case when j.person is null then null else private.live_access(j.live_id, j.person) end;
    act := null;
    soft := false;
    if j.kind = 'end' then
      if live_gone then act := 'end_room'; end if;
    elsif j.kind = 'audit' then
      if (live_gone and watched) or (not live_gone and l.on_air_at is not null) then act := 'audit'; end if;
    elsif j.kind = 'check' then
      if live_gone then
        if watched then act := 'remove'; end if;
      elsif access = 'paused' then
        act := 'remove'; soft := true;
      elsif access not in ('host', 'cohost', 'viewer') then
        act := 'remove';
      end if;
    elsif j.kind = 'demote' then
      if not live_gone then
        if access = 'viewer' then
          act := 'demote';
        elsif access = 'paused' then
          act := 'remove'; soft := true;
        elsif access not in ('host', 'cohost') then
          act := 'remove';
        end if;
      end if;
    end if;
    if act is null then
      update private.live_jobs q set done_at = now() where q.id = j.id;
    else
      picked := picked || jsonb_build_array(jsonb_build_object(
        'job_id', j.id, 'action', act, 'room', j.room, 'identity', j.person, 'soft', soft,
        'recheck', act = 'remove' and not j.is_recheck));
    end if;
  end loop;
  return picked;
end;
$$;
revoke execute on function public.live_jobs_claim(integer) from public, anon, authenticated;
grant execute on function public.live_jobs_claim(integer) to service_role;

-- live-admin reports back. failed = [{"id":1,"error":"…"}]. recheck = removals LiveKit answered "not found"
-- (the person may be between connections): one more try 60 seconds later.
create or replace function public.live_jobs_finish(done bigint[], failed jsonb default '[]'::jsonb, recheck bigint[] default '{}')
returns void language plpgsql security definer set search_path = '' as $$
declare
  item jsonb;
  failed_id bigint;
  problem text;
  j private.live_jobs%rowtype;
begin
  update private.live_jobs q set done_at = now(), last_error = null
   where q.id = any (coalesce(done, '{}')) and q.done_at is null;
  for item in select x from jsonb_array_elements(case when jsonb_typeof(failed) = 'array' then failed else '[]'::jsonb end) x loop
    if coalesce(item->>'id', '') !~ '^[0-9]{1,18}$' then
      continue;
    end if;
    failed_id := (item->>'id')::bigint;
    problem := left(coalesce(nullif(item->>'error', ''), 'failed'), 500);
    update private.live_jobs q
       set last_error = case when q.tries >= 6 then 'gave up: ' || problem else problem end,
           done_at = case when q.tries >= 6 then now() end
     where q.id = failed_id and q.done_at is null
    returning * into j;
    if found and j.done_at is not null then
      perform private.live_log(j.live_id, 'gave_up', null, j.person,
        jsonb_build_object('job', j.id, 'kind', j.kind, 'error', problem));
    end if;
  end loop;
  for j in update private.live_jobs q set done_at = now()
            where q.id = any (coalesce(recheck, '{}')) and q.done_at is null returning * loop
    if not j.is_recheck then
      insert into private.live_jobs (live_id, room, person, kind, is_recheck, next_try_at)
      values (j.live_id, j.room, j.person, j.kind, true, now() + interval '60 seconds')
      on conflict do nothing;
    end if;
  end loop;
end;
$$;
revoke execute on function public.live_jobs_finish(bigint[], jsonb, bigint[]) from public, anon, authenticated;
grant execute on function public.live_jobs_finish(bigint[], jsonb, bigint[]) to service_role;

-- Who LiveKit says is in a room → who must go. A room that isn't a running live: everyone goes, the room is
-- closed and watched for longer. Otherwise anyone who may not watch now goes (people waiting softly, and a
-- viewer who is sending video is taken out softly too). Everyone who may stay counts as "here".
create or replace function public.live_audit(room_name text, identities text[], publishers text[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  l public.lives%rowtype;
  listed text;
  access text;
  removals jsonb := '[]'::jsonb;
  watching boolean := false;
  people text[] := coalesce(identities, '{}');
begin
  -- The live row first, before any presence row (the same order as everything else).
  select * into l from public.lives x where x.room = room_name for update;
  if not found or l.ended_at is not null or now() >= l.ends_at then
    foreach listed in array people loop
      removals := removals || jsonb_build_array(jsonb_build_object('identity', listed, 'soft', false));
    end loop;
    if cardinality(people) > 0 then
      update private.live_watch_rooms w set until = greatest(w.until, now() + interval '15 minutes')
       where w.room = room_name;
      if not found and l.id is not null then
        perform private.live_watch(room_name, l.id, interval '15 minutes');
      end if;
    end if;
    return jsonb_build_object('remove', removals, 'delete_room', cardinality(people) > 0);
  end if;
  foreach listed in array people loop
    access := case when listed ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   then private.live_access(l.id, listed::uuid) else 'not_allowed' end;
    if access in ('host', 'cohost') or (access = 'viewer' and not (listed = any (coalesce(publishers, '{}')))) then
      if access <> 'host' then
        update public.live_viewers v set last_seen_at = now(), left_at = null
         where v.live_id = l.id and v.user_id = listed::uuid;
        if found and access = 'viewer' then
          watching := true;
        end if;
      end if;
    else
      removals := removals || jsonb_build_array(jsonb_build_object('identity', listed, 'soft', access in ('paused', 'viewer')));
    end if;
  end loop;
  if watching then
    update public.lives x set last_viewer_at = now() where x.id = l.id;
  end if;
  return jsonb_build_object('remove', removals, 'delete_room', false);
end;
$$;
revoke execute on function public.live_audit(text, text[], text[]) from public, anon, authenticated;
grant execute on function public.live_audit(text, text[], text[]) to service_role;

-- ---------------------------------------------------------------------
-- 10. Triggers. Each one's body is guarded: a problem in the live code can never stop a block, an unfriend,
--     a ban, a report or an account deletion. The ones on existing tables return at once when no live is on.
-- ---------------------------------------------------------------------
-- The owner ends a live by typing now() into ended_at: the reason fills itself in. A new co-host turn needs
-- a clean stage again.
create or replace function private.lives_before_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    if old.ended_at is null and new.ended_at is not null and new.ended_reason is null then
      new.ended_reason := 'owner';
    end if;
    if new.cohost_id is distinct from old.cohost_id then
      new.stage_clean_at := null;
      if new.cohost_id is null then
        new.cohost_since := null;
      elsif new.cohost_since is not distinct from old.cohost_since then
        new.cohost_since := now();
      end if;
    end if;
  exception when others then
    raise warning 'Lives (before update): %', sqlerrm;
  end;
  return new;
end;
$$;
revoke all on function private.lives_before_update() from public, anon, authenticated;
drop trigger if exists lives_before_update on public.lives;
create trigger lives_before_update before update on public.lives
  for each row execute function private.lives_before_update();

-- A live ended: the room is closed and watched for 20 minutes, open asks expire, everyone counts as gone.
-- The co-host changed: the old one is turned back into a viewer; with a new one, everyone who must now wait
-- is checked. Each step is guarded on its own, most important first, so one step failing (for example two
-- saves waiting on each other) can never undo the others. The minute check also closes any ended room that
-- was missed.
create or replace function private.lives_after_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v record;
begin
  if old.ended_at is null and new.ended_at is not null then
    begin
      perform private.live_enqueue(new.id, new.room, null, 'end');
    exception when others then
      raise warning 'Lives (after change, close the room): %', sqlerrm;
    end;
    begin
      perform private.live_watch(new.room, new.id, interval '20 minutes');
    exception when others then
      raise warning 'Lives (after change, watch the room): %', sqlerrm;
    end;
    begin
      perform private.live_log(new.id, 'end', auth.uid(), null, jsonb_build_object('reason', new.ended_reason));
    exception when others then
      raise warning 'Lives (after change, log): %', sqlerrm;
    end;
    begin
      update public.live_invites i set answer = 'expired', answered_at = now()
       where i.live_id = new.id and i.answer is null;
    exception when others then
      raise warning 'Lives (after change, asks): %', sqlerrm;
    end;
    begin
      update public.live_viewers y set left_at = now() where y.live_id = new.id and y.left_at is null;
    exception when others then
      raise warning 'Lives (after change, presence): %', sqlerrm;
    end;
  elsif new.ended_at is null and new.cohost_id is distinct from old.cohost_id then
    if old.cohost_id is not null then
      begin
        perform private.live_enqueue(new.id, new.room, old.cohost_id, 'demote');
      exception when others then
        raise warning 'Lives (after change, demote): %', sqlerrm;
      end;
      begin
        perform private.live_log(new.id, 'cohost_off', auth.uid(), old.cohost_id);
      exception when others then
        raise warning 'Lives (after change, log): %', sqlerrm;
      end;
    end if;
    if new.cohost_id is not null then
      begin
        for v in select y.user_id from public.live_viewers y where y.live_id = new.id and y.user_id <> new.cohost_id loop
          if private.live_access(new.id, v.user_id) = 'paused' then
            perform private.live_check(new.id, v.user_id);
          end if;
        end loop;
      exception when others then
        raise warning 'Lives (after change, checks): %', sqlerrm;
      end;
    end if;
  end if;
  return null;
end;
$$;
revoke all on function private.lives_after_change() from public, anon, authenticated;
drop trigger if exists lives_after_change on public.lives;
create trigger lives_after_change after update of ended_at, cohost_id on public.lives
  for each row execute function private.lives_after_change();

-- A live row is deleted (also when the host deletes their account): close the room, keep watching it, and
-- (unless it's the 30-day clean-up) keep a copy of who was there, so the record can't be wiped before anyone
-- reports: 90 days when an adult host had an under-18 viewer, else 30 days.
create or replace function private.lives_before_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  host_age text;
  clean_up boolean := coalesce(current_setting('peekaboo.live_retention', true), '') = 'on';
begin
  begin
    if old.ended_at is null then
      perform private.live_enqueue(old.id, old.room, null, 'end');
    end if;
    if not clean_up then
      perform private.live_watch(old.room, old.id, interval '20 minutes');
      if exists (select 1 from public.live_viewers v where v.live_id = old.id) then
        -- During an account deletion the host's birthday may already be gone: the age group saved at the
        -- start is used then. If it still can't be known, the longer time is used.
        host_age := coalesce(private.age_group(old.host_id),
          (select e.detail->>'host_age_group' from private.live_events e
            where e.live_id = old.id and e.kind = 'start' order by e.at limit 1));
        insert into private.live_snapshots (report_id, live_id, reason, keep_until, snapshot)
        values (null, old.id, 'host_deleted',
          now() + case when host_age is distinct from 'teen' and exists (
                         select 1 from public.live_viewers v
                          where v.live_id = old.id and private.age_group(v.user_id) is distinct from 'adult')
                       then interval '90 days' else interval '30 days' end,
          private.live_snapshot(old.id));
      end if;
    end if;
  exception when others then
    raise warning 'Lives (before delete): %', sqlerrm;
  end;
  return old;
end;
$$;
revoke all on function private.lives_before_delete() from public, anon, authenticated;
drop trigger if exists lives_before_delete on public.lives;
create trigger lives_before_delete before delete on public.lives
  for each row execute function private.lives_before_delete();

-- A viewer's account was deleted: check them in a running live (no account → taken out for good).
create or replace function private.live_viewers_after_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    if not exists (select 1 from public.lives x where x.ended_at is null) then
      return null;
    end if;
    if exists (select 1 from public.lives x where x.id = old.live_id and x.ended_at is null) then
      perform private.live_check(old.live_id, old.user_id);
    end if;
  exception when others then
    raise warning 'Lives (viewer deleted): %', sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function private.live_viewers_after_delete() from public, anon, authenticated;
drop trigger if exists live_viewers_after_delete on public.live_viewers;
create trigger live_viewers_after_delete after delete on public.live_viewers
  for each row execute function private.live_viewers_after_delete();

-- Unfriend, block, a declined or cancelled request.
create or replace function private.friendships_live_kick()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    if not exists (select 1 from public.lives x where x.ended_at is null) then
      return null;
    end if;
    perform private.live_pair_changed(old.requester_id, old.addressee_id);
  exception when others then
    raise warning 'Lives (friendship removed): %', sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function private.friendships_live_kick() from public, anon, authenticated;
drop trigger if exists friendships_live_kick on public.friendships;
create trigger friendships_live_kick after delete on public.friendships
  for each row execute function private.friendships_live_kick();

-- A block (also between a co-host and a viewer, which touches no friendship with the host).
create or replace function private.blocks_live_kick()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    if not exists (select 1 from public.lives x where x.ended_at is null) then
      return null;
    end if;
    perform private.live_pair_changed(new.blocker_id, new.blocked_id);
  exception when others then
    raise warning 'Lives (block): %', sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function private.blocks_live_kick() from public, anon, authenticated;
drop trigger if exists blocks_live_kick on public.blocks;
create trigger blocks_live_kick after insert on public.blocks
  for each row execute function private.blocks_live_kick();

-- A ban (Supabase → Authentication → Users → Ban user). The ban itself can never fail because of this.
create or replace function private.auth_users_live_ban()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    if not exists (select 1 from public.lives x where x.ended_at is null) then
      return null;
    end if;
    perform private.live_after_ban(new.id);
  exception when others then
    raise warning 'Lives (ban): %', sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function private.auth_users_live_ban() from public, anon, authenticated;
drop trigger if exists auth_users_live_ban on auth.users;
create trigger auth_users_live_ban after update of banned_until on auth.users
  for each row when (new.banned_until is distinct from old.banned_until and new.banned_until > now())
  execute function private.auth_users_live_ban();

-- ---------------------------------------------------------------------
-- 11. Reports: the live (the host, or the person brought on) and comments
-- ---------------------------------------------------------------------
alter table public.reports drop constraint if exists reports_content_type_check;
alter table public.reports add constraint reports_content_type_check
  check (content_type in ('user', 'post', 'story', 'message', 'comment', 'dare_idea', 'group_message', 'public_photo',
                          'live', 'live_comment'));

-- Who a live report is about, and whether the reporter was there. Allowed while the live is on and for 24
-- hours after. "Report @cohost" uses the same kind: the chosen person counts only if they were on the stage.
create or replace function private.live_report_author(kind text, target uuid, chosen uuid, me uuid)
returns table(author uuid, visible boolean)
language sql stable security definer set search_path = '' as $$
  select case when chosen is not null and (chosen = l.cohost_id or exists (
              select 1 from public.live_viewers v where v.live_id = l.id and v.user_id = chosen and v.was_cohost))
              then chosen else l.host_id end,
         me is null or private.was_in_live(l.id, me)
    from public.lives l
   where kind = 'live' and l.id = target
     and (l.ended_at is null or l.ended_at > now() - interval '24 hours')
  union all
  select c.user_id, me is null or private.was_in_live(c.live_id, me)
    from public.live_comments c join public.lives l on l.id = c.live_id
   where kind = 'live_comment' and c.id = target
     and (l.ended_at is null or l.ended_at > now() - interval '24 hours');
$$;
revoke all on function private.live_report_author(text, uuid, uuid, uuid) from public, anon, authenticated;

-- Nothing is recorded, so a reported comment's words go into the report – but only while the comment is still
-- up. Reporters can read their own reports back, so the words of a deleted or hidden comment never go there
-- (the owner finds them in the report's private copy: private.live_snapshots → "reported_comment").
create or replace function private.live_report_details(kind text, target uuid, given text)
returns text language sql stable security definer set search_path = '' as $$
  select case when kind = 'live_comment' then
    nullif(left(concat_ws(E'\n',
      'Comment: "' || (select c.body from public.live_comments c
                         where c.id = target and c.deleted_at is null and c.body <> '') || '"',
      nullif(btrim(given), '')), 1000), '')
  else given end;
$$;
revoke all on function private.live_report_details(text, uuid, text) from public, anon, authenticated;

-- A repeat report (you already reported this person for this) or a report about yourself is quietly skipped
-- (true = skip). More than 20 reports about one live from one person get a friendly "no".
create or replace function private.live_report_repeat(kind text, target uuid, author uuid, me uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  live uuid;
begin
  if me is null or author is null then
    return false;
  end if;
  if author = me or exists (select 1 from public.reports r
                             where r.reporter_id = me and r.content_type = kind and r.content_id = target
                               and r.reported_user_id is not distinct from author) then
    return true;
  end if;
  live := case when kind = 'live' then target else (select c.live_id from public.live_comments c where c.id = target) end;
  if (select count(*) from public.reports r
       where r.reporter_id = me
         and ((r.content_type = 'live' and r.content_id = live)
              or (r.content_type = 'live_comment'
                  and r.content_id in (select c.id from public.live_comments c where c.live_id = live)))) >= 20 then
    raise exception 'You''ve sent a lot of reports for this live – we''ll look at them.';
  end if;
  return false;
end;
$$;
revoke all on function private.live_report_repeat(text, uuid, uuid, uuid) from public, anon, authenticated;

-- One live report per person, thing and reported person (the back-stop for two taps at the same moment).
create unique index if not exists reports_live_once on public.reports (reporter_id, content_type, content_id, reported_user_id)
  where content_type in ('live', 'live_comment');

-- Does this report count towards the automatic stop? Decided once, when it is filed (private.live_report_votes).
-- It counts only if:
--   (a) the reported person had not blocked the reporter (one way only: someone who reports and then blocks,
--       as the app suggests, still counts);
--   (b) the reporter was the host, the person on stage, or someone watching who wasn't removed;
--   (c) for a report about the person brought on: the reporter could see them (the host, one of their friends,
--       or someone who blocked them).
-- So the people a host (or the person on stage) removed or blocked can't use the automatic stop against them.
create or replace function private.live_report_counts(kind text, live uuid, reported uuid, reporter uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select reported is not null and reporter is not null
     and not exists (select 1 from public.blocks b where b.blocker_id = reported and b.blocked_id = reporter)
     and (exists (select 1 from public.lives l where l.id = live and reporter in (l.host_id, l.cohost_id))
          or exists (select 1 from public.live_viewers v
                      where v.live_id = live and v.user_id = reporter and v.removed_at is null))
     and (kind <> 'live'
          or exists (select 1 from public.lives l where l.id = live and reported = l.host_id)
          or exists (select 1 from public.lives l where l.id = live and reporter = l.host_id)
          or coalesce(private.are_friends(reported, reporter), false)
          or exists (select 1 from public.blocks b where b.blocker_id = reporter and b.blocked_id = reported));
$$;
revoke all on function private.live_report_counts(text, uuid, uuid, uuid) from public, anon, authenticated;

-- After a live report is saved: a frozen copy for the owner (90 days; for a comment, with the reported
-- comment's words, also when it was deleted). With enough different reporters whose reports count (see
-- live_report_counts): the reported host's live ends (or the reported co-host comes off) and they can't go
-- live for 24 hours (never shorter than a stop the owner set); a reported comment is hidden.
create or replace function private.live_after_report()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  live uuid;
  l public.lives%rowtype;
  s private.live_settings := private.live_config();
  reporters integer;
  reported_comment jsonb;
begin
  begin
    if new.content_type = 'live' then
      live := new.content_id;
    else
      select c.live_id into live from public.live_comments c where c.id = new.content_id;
      select jsonb_build_object('reported_comment', jsonb_build_object(
               'id', c.id, 'user_id', c.user_id, 'body', coalesce(r.body, c.body),
               'created_at', c.created_at, 'deleted_at', c.deleted_at))
        into reported_comment
        from public.live_comments c left join private.live_removed_comments r on r.comment_id = c.id
       where c.id = new.content_id;
    end if;
    if live is null then
      return null;
    end if;
    insert into private.live_snapshots (report_id, live_id, reason, keep_until, snapshot)
    values (new.id, live, 'report', now() + interval '90 days',
            private.live_snapshot(live) || coalesce(reported_comment, '{}'::jsonb))
    on conflict (report_id) do nothing;
    perform private.live_log(live, 'report', new.reporter_id, new.reported_user_id,
      jsonb_build_object('report', new.id, 'kind', new.content_type, 'reason', new.reason));
    insert into private.live_report_votes (report_id, live_id, content_type, content_id, reported_user_id, reporter_id, counts)
    values (new.id, live, new.content_type, new.content_id, new.reported_user_id, new.reporter_id,
            private.live_report_counts(new.content_type, live, new.reported_user_id, new.reporter_id))
    on conflict (report_id) do nothing;
    select count(distinct v.reporter_id) into reporters from private.live_report_votes v
     where v.counts and v.content_type = new.content_type and v.content_id = new.content_id
       and v.reported_user_id is not distinct from new.reported_user_id;
    if reporters >= s.report_end_count and new.reported_user_id is not null then
      if new.content_type = 'live' then
        select * into l from public.lives x where x.id = live;
        if l.host_id = new.reported_user_id then
          update public.lives x set ended_at = now(), ended_reason = 'reports' where x.id = live and x.ended_at is null;
        elsif l.cohost_id = new.reported_user_id then
          update public.lives x set cohost_id = null, cohost_since = null where x.id = live and x.ended_at is null;
        end if;
        insert into private.live_restrictions as r (user_id, until, reason)
        values (new.reported_user_id, now() + interval '24 hours', 'reports')
        on conflict (user_id) do update
          set until  = case when r.until is null then null else greatest(r.until, excluded.until) end,
              reason = case when r.reason = 'owner' then r.reason else excluded.reason end;
      else
        -- Kept privately first with no "removed by" (nobody deleted it: the reports hid it).
        insert into private.live_removed_comments (comment_id, live_id, user_id, body, created_at, removed_by)
        select c.id, c.live_id, c.user_id, c.body, c.created_at, null
          from public.live_comments c where c.id = new.content_id and c.deleted_at is null
        on conflict (comment_id) do nothing;
        update public.live_comments c set deleted_at = now(), body = '' where c.id = new.content_id and c.deleted_at is null;
      end if;
    end if;
  exception when others then
    raise warning 'Lives (report): %', sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function private.live_after_report() from public, anon, authenticated;
drop trigger if exists reports_live_after_insert on public.reports;
create trigger reports_live_after_insert after insert on public.reports
  for each row when (new.content_type in ('live', 'live_comment'))
  execute function private.live_after_report();

-- private.prepare_report gets the live lines. It is long and has been changed by several migrations (the
-- public chat added its own lines), so instead of copying it here this reads it as it is now, adds the live
-- lines at a known spot, and saves it back. If the spot isn't there exactly once, the whole migration stops
-- and nothing is changed. Running it again does nothing (it sees its own lines). The public chat lines stay.
do $patch$
declare
  item record;
  body text;
begin
  for item in
    select * from (values
      ('private.prepare_report()'::regprocedure, 'live_report_author',
       $a$elsif new.content_type = 'group_message' then$a$,
       $b$elsif new.content_type in ('live', 'live_comment') then
    -- Lives (20261226000000_livestreams.sql): who it is about, and whether you were there.
    select r.author, r.visible into author, visible
      from private.live_report_author(new.content_type, new.content_id, new.reported_user_id, me) r;
    -- The same report twice, or a report about yourself: quietly skipped.
    if coalesce(visible, false) and private.live_report_repeat(new.content_type, new.content_id, author, me) then
      return null;
    end if;
    new.details := private.live_report_details(new.content_type, new.content_id, new.details);
  elsif new.content_type = 'group_message' then$b$)
    ) as t(fn, marker, anchor, replacement)
  loop
    body := pg_get_functiondef(item.fn);
    if position(item.marker in body) > 0 then
      continue;
    end if;
    if position(item.anchor in body) = 0
       or (char_length(body) - char_length(replace(body, item.anchor, ''))) / char_length(item.anchor) <> 1 then
      raise exception 'livestreams: could not find the one spot to change in %', item.fn;
    end if;
    execute replace(body, item.anchor, item.replacement);
  end loop;
end;
$patch$;

-- ---------------------------------------------------------------------
-- 12. The minute check (pg_cron, every minute)
-- ---------------------------------------------------------------------
create or replace function private.live_sweep()
returns void language plpgsql security definer set search_path = '' as $$
declare
  s private.live_settings := private.live_config();
  v record;
begin
  -- Lives someone is really watching aren't "empty".
  begin
    update public.lives l set last_viewer_at = now()
     where l.ended_at is null and l.on_air_at is not null and private.live_viewer_count(l.id) > 0;
  exception when others then
    raise warning 'Lives check (watching): %', sqlerrm;
  end;
  -- 1. End lives: switched off, host banned or stopped, time's up, host gone, or nobody watching.
  begin
    update public.lives l
       set ended_at = now(),
           ended_reason = case
             when s.who_can_go_live = 'nobody' then 'owner'
             when not private.invite_user_ok(l.host_id) or private.live_restricted(l.host_id) then 'safety'
             when now() >= l.ends_at then 'time'
             when l.host_seen_at < now() - interval '90 seconds'
               or (l.on_air_at is null and l.started_at < now() - interval '2 minutes') then 'host_gone'
             else 'empty' end
     where l.ended_at is null and (
       s.who_can_go_live = 'nobody'
       or not private.invite_user_ok(l.host_id) or private.live_restricted(l.host_id)
       or now() >= l.ends_at
       or l.host_seen_at < now() - interval '90 seconds'
       or (l.on_air_at is null and l.started_at < now() - interval '2 minutes')
       or (l.on_air_at is not null and l.last_viewer_at < now() - make_interval(mins => s.empty_minutes)));
  exception when others then
    raise warning 'Lives check (end): %', sqlerrm;
  end;
  -- 2. A co-host who stopped pinging, or who may not be on any more (banned, stopped, not allowed).
  begin
    update public.lives l set cohost_id = null, cohost_since = null
     where l.ended_at is null and l.cohost_id is not null and (
       private.can_host(l.cohost_id) is not null
       or not exists (select 1 from public.live_viewers y
                       where y.live_id = l.id and y.user_id = l.cohost_id and y.last_seen_at > now() - interval '90 seconds'));
  exception when others then
    raise warning 'Lives check (co-host): %', sqlerrm;
  end;
  -- 3. People who stopped pinging have left; old asks expire.
  begin
    update public.live_viewers y set left_at = y.last_seen_at
     where y.left_at is null and y.last_seen_at < now() - interval '90 seconds'
       and exists (select 1 from public.lives l where l.id = y.live_id and l.ended_at is null);
    update public.live_invites i set answer = 'expired', answered_at = now()
     where i.answer is null and i.expires_at <= now();
  exception when others then
    raise warning 'Lives check (presence): %', sqlerrm;
  end;
  -- 4. Anyone active in the last 2 minutes who may not watch any more is checked again (bans, missed jobs,
  --    the owner's stops). Older rows are left to the audit.
  begin
    for v in select y.live_id, y.user_id from public.live_viewers y join public.lives l on l.id = y.live_id
              where l.ended_at is null and greatest(y.joined_at, y.last_seen_at) > now() - interval '2 minutes'
                and private.live_access(y.live_id, y.user_id) not in ('host', 'cohost', 'viewer') loop
      perform private.live_check(v.live_id, v.user_id);
    end loop;
  exception when others then
    raise warning 'Lives check (re-check): %', sqlerrm;
  end;
  -- 5. One audit per live on air, and per room still watched after its live ended.
  begin
    for v in select l.id, l.room from public.lives l where l.ended_at is null and l.on_air_at is not null loop
      perform private.live_enqueue(v.id, v.room, null, 'audit');
    end loop;
    for v in select w.live_id, w.room from private.live_watch_rooms w where w.until > now() loop
      perform private.live_enqueue(v.live_id, v.room, null, 'audit');
    end loop;
  exception when others then
    raise warning 'Lives check (audit): %', sqlerrm;
  end;
  -- 5b. A live that ended in the last 30 minutes but whose room was never closed (a step that failed when it
  --     ended): close it and watch it now, and count everyone as gone.
  begin
    for v in select l.id, l.room from public.lives l
              where l.ended_at > now() - interval '30 minutes'
                and not exists (select 1 from private.live_jobs j where j.live_id = l.id and j.kind = 'end') loop
      perform private.live_enqueue(v.id, v.room, null, 'end');
      if not exists (select 1 from private.live_watch_rooms w where w.room = v.room) then
        perform private.live_watch(v.room, v.id, interval '20 minutes');
      end if;
    end loop;
    update public.live_viewers y set left_at = least(y.last_seen_at, l.ended_at)
      from public.lives l
     where l.id = y.live_id and y.left_at is null and l.ended_at > now() - interval '30 minutes';
  exception when others then
    raise warning 'Lives check (missed ends): %', sqlerrm;
  end;
  -- 6. Clean-up.
  begin
    delete from public.live_comments c using public.lives l
     where l.id = c.live_id and l.ended_at < now() - interval '24 hours';
    -- (So deleting old lives doesn't make "host deleted" copies or watch their long-closed rooms.)
    perform set_config('peekaboo.live_retention', 'on', true);
    delete from public.lives l where l.ended_at < now() - interval '30 days';
    perform set_config('peekaboo.live_retention', 'off', true);
    delete from private.live_events e where e.at < now() - interval '30 days';
    delete from private.live_removed_comments r where r.removed_at < now() - interval '30 days';
    delete from private.live_snapshots x where x.keep_until < now();
    delete from private.live_report_votes r where r.created_at < now() - interval '30 days';
    delete from private.live_token_log t where t.at < now() - interval '1 day';
    delete from private.live_watch_rooms w where w.until < now() - interval '1 day';
    delete from private.live_jobs j where j.done_at < now() - interval '7 days';
  exception when others then
    raise warning 'Lives check (clean-up): %', sqlerrm;
  end;
  -- 7. Wake live-admin for anything due (for example a re-check 60 seconds after "not found").
  if exists (select 1 from private.live_jobs j where j.done_at is null and j.next_try_at <= now()) then
    perform private.live_poke();
  end if;
end;
$$;
revoke all on function private.live_sweep() from public, anon, authenticated;

-- The owner's check of the LiveKit secrets (see the header). Uses a made-up room, never a real live.
create or replace function private.live_selftest()
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.live_watch('live_selftest', '00000000-0000-0000-0000-000000000000', interval '5 minutes');
  update private.live_watch_rooms w set until = now() + interval '5 minutes' where w.room = 'live_selftest';
  perform private.live_enqueue('00000000-0000-0000-0000-000000000000', 'live_selftest', null, 'audit');
end;
$$;
revoke all on function private.live_selftest() from public, anon, authenticated;

-- Every minute (Supabase's built-in pg_cron). Skipped where pg_cron isn't available.
do $$
begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'peekaboo-live-sweep';
  perform cron.schedule('peekaboo-live-sweep', '* * * * *', 'select private.live_sweep()');
exception when others then
  raise notice 'pg_cron not available here – the live check is not scheduled: %', sqlerrm;
end $$;

commit;
