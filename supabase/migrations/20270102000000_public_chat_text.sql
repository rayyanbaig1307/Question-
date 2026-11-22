-- =====================================================================
-- Messages and stickers in the public chat 💬 (the owner, 22 Nov 2026: "add texting to public chats and the
-- ability to send stickers"). Safe to run more than once.
--
-- They go in a NEW table, public.public_messages, next to public.public_photos. Why not add them to
-- public_photos? Older app versions read every row of public_photos and draw each one as a photo, so a message
-- saved there would show up in them as an empty grey photo. The database can't tell app versions apart, so the
-- only way to keep older apps exactly as they are is to leave public_photos alone. Older apps simply don't see
-- messages; photos work everywhere as before.
--
-- The rules, all checked here on the server (an old or changed app can't skip them):
--   * The same room as the photos: 18 and over only (from the saved birthday), blocked people don't see each
--     other's messages (both ways), you can delete your own, and no notifications.
--   * A message is 1 to 300 characters. Spaces at the ends are taken off, and runs of spaces and line breaks
--     (every kind, also the blank-looking ones) become one space. Characters that flip which way text runs are
--     taken out, so reversed text can't show up on screen as a link or a slur. A message has to have something
--     you can see in it. No more than 3 accent marks piled on one letter. Slurs are blocked (the same word filter
--     as all public text: private.blocked_word with 'content'; swearing is allowed, the owner's choice). No links
--     of any kind and no phone numbers (private.public_text_problem below – the app has the very same checks in
--     src/lib/publicText.ts).
--   * A sticker is only its name (like 'googly-eyes' or 'word-slay'), never any words, so nothing can be slipped
--     in with it. Peekaboo+ stickers ('plus-…') only for people who have Peekaboo+ right now (the same check as
--     friend and group chats: private.check_plus_sticker).
--   * Your name and username show with everything you post, so they can't hold a link or a phone number either
--     while you post in the public chat (photos too).
--   * Slow mode for messages and stickers together: one every 5 seconds, and at most 300 a day, per person.
--     Photos keep their own slow mode (one every 30 seconds, 40 a day). Both are counted in a private list of
--     when people posted (private.public_chat_sends), so deleting what you posted doesn't start the count again.
--     That list only keeps the last 24 hours.
--   * Reports: a new kind 'public_message'. The owner gets the usual "🚩 New report" push. The words (or the
--     sticker's name) are copied into the report, so the owner still has them if the sender deletes the message.
--     3 different people reporting a message hides it from everyone except the person who sent it. Reporting the
--     same photo or message again does nothing (no second push).
--   * Deleting an account deletes its messages (and the reports about them): "on delete cascade". A private copy
--     of each public chat report is kept for 90 days anyway (private.public_chat_report_copies), so someone
--     can't wipe the evidence by deleting their account.
-- =====================================================================
begin;
set local lock_timeout = '15s';

-- ---------------------------------------------------------------------
-- 1. The messages
-- ---------------------------------------------------------------------
create table if not exists public.public_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles (id) on delete cascade,
  -- 'text' or 'sticker'.
  kind text not null default 'text',
  -- The words (text messages only).
  body text,
  -- The sticker's name (stickers only), the same names as in friend and group chats.
  sticker text,
  created_at timestamptz not null default now(),
  -- Hidden after 3 reports (or by the owner in the Table Editor).
  hidden boolean not null default false
);
-- A message has words and no sticker; a sticker has a name and no words.
alter table public.public_messages drop constraint if exists public_messages_shape;
alter table public.public_messages add constraint public_messages_shape check (
  (kind = 'text' and body is not null and sticker is null and char_length(body) between 1 and 300)
  or (kind = 'sticker' and sticker is not null and body is null and sticker ~ '^[a-z0-9-]{1,40}$')
);
create index if not exists public_messages_newest_idx on public.public_messages (created_at desc);
create index if not exists public_messages_sender_idx on public.public_messages (sender_id, created_at desc);

alter table public.public_messages enable row level security;
revoke all on public.public_messages from anon, authenticated;
grant select, delete on public.public_messages to authenticated;
-- People only say what they send; who sent it, when, and "hidden" are filled in by the server.
grant insert (kind, body, sticker) on public.public_messages to authenticated;

-- The same three rules as the photos (private.in_public_chat is from 20261225000000_public_chat.sql).
drop policy if exists "Adults can see public chat messages" on public.public_messages;
create policy "Adults can see public chat messages" on public.public_messages for select to authenticated
  using (
    private.in_public_chat((select auth.uid()))
    and (sender_id = (select auth.uid())
      or (not hidden and not private.is_blocked(sender_id, (select auth.uid()))))
  );
drop policy if exists "Adults can send public chat messages" on public.public_messages;
create policy "Adults can send public chat messages" on public.public_messages for insert to authenticated
  with check (sender_id = (select auth.uid()) and private.in_public_chat((select auth.uid())));
drop policy if exists "You can delete your own public messages" on public.public_messages;
create policy "You can delete your own public messages" on public.public_messages for delete to authenticated
  using (sender_id = (select auth.uid()));

-- ---------------------------------------------------------------------
-- 2. The checks on the words: tidy, no links and no phone numbers
-- ---------------------------------------------------------------------
-- The lists the checks use. The same lists are in src/lib/publicText.ts (tests/unit/public-text.test.mjs checks
-- they match, and tests/support/public-text-cases.json runs against both).
--   'endings': what comes after the dot in a web address (".com"). Common words that people type straight after a
--              full stop ("so", "it", "to", "lol", "at", "us"...) are left out on purpose, so "ok.so tired" isn't a
--              link. (A dotted name followed by "/" is always a link, whatever its ending: "zoom.us/j/1".)
--   'said':    the ones also caught when the dot is written out ("site dot com", "site (dot) com").
--   'spaced':  the ones also caught with a space after the dot ("site. com", "site . com"). Only endings that are
--              never everyday words, so "Love it. Me too" stays fine.
--   'mail':    email services caught even without the ending ("name@gmail").
create or replace function private.public_text_lists()
returns jsonb language sql immutable parallel safe set search_path = '' as $$
  select jsonb_build_object(
    'endings', jsonb_build_array(
      'com', 'net', 'org', 'info', 'biz', 'xyz', 'app', 'dev', 'io', 'ai', 'co', 'me', 'ly', 'gg', 'tv', 'fm',
      'link', 'site', 'online', 'store', 'shop', 'live', 'club', 'vip', 'pro', 'page', 'bio', 'click', 'website',
      'blog', 'cam', 'porn', 'sex', 'xxx', 'adult', 'onion', 'tk', 'ml', 'ga', 'cf', 'gq', 'pw', 'ru', 'su', 'cn',
      'uk', 'ca', 'de', 'fr', 'es', 'nl', 'au', 'nz', 'in', 'be', 'ee', 'eu', 'ch', 'jp', 'kr', 'br', 'mx', 'ws',
      'cc', 'sh', 'gl', 'la', 'icu', 'buzz', 'ink', 'tech', 'top', 'fun', 'gd', 'gy', 'ph', 'world', 'party',
      'mobi', 'cyou', 'sbs', 'cfd', 'bond'),
    'said', jsonb_build_array(
      'com', 'net', 'org', 'io', 'co', 'me', 'ly', 'gg', 'xyz', 'app', 'tv', 'uk', 'ca', 'ru', 'info', 'link',
      'site'),
    'spaced', jsonb_build_array(
      'com', 'net', 'org', 'io', 'ly', 'xyz', 'ru'),
    'mail', jsonb_build_array(
      'gmail', 'googlemail', 'yahoo', 'ymail', 'hotmail', 'outlook', 'icloud', 'protonmail', 'proton', 'aol',
      'gmx', 'yandex')
  );
$$;

-- 'link', 'phone', or null when the text is fine. Same steps as publicTextProblem() in src/lib/publicText.ts.
-- First the text is made plain like the word filter does (fancy look-alike letters and full-width dots become
-- plain ones, invisible characters are deleted), A–Z become a–z, dots that look like a dot become a dot, and
-- digits from other writing systems become 0–9. Letters are written out in full (not a-z) so the result never
-- depends on the server's language settings.
create or replace function private.public_text_problem(value text)
returns text language plpgsql immutable strict parallel safe set search_path = '' as $$
declare
  lists jsonb := private.public_text_lists();
  az text := 'abcdefghijklmnopqrstuvwxyz';
  word text := '[abcdefghijklmnopqrstuvwxyz0123456789-]+';
  stop text := '([^abcdefghijklmnopqrstuvwxyz0123456789]|$)';
  endings text := (select string_agg(e, '|') from jsonb_array_elements_text(lists -> 'endings') e);
  said text := (select string_agg(e, '|') from jsonb_array_elements_text(lists -> 'said') e);
  spaced text := (select string_agg(e, '|') from jsonb_array_elements_text(lists -> 'spaced') e);
  mail text := (select string_agg(e, '|') from jsonb_array_elements_text(lists -> 'mail') e);
  t text;
  numbers text;
begin
  -- 。 · ‧ ⸱ ・ ∙ ⋅ are all dots in a web address too.
  t := translate(private.word_filter_plain_letters(value),
         upper(az) || E'\u3002\u00B7\u2027\u2E31\u30FB\u2219\u22C5', az || '.......');
  -- Arabic, Persian, Hindi, Bengali and Thai digits become 0–9, so a phone number in them is still a number.
  t := translate(t,
         (select string_agg(chr(b + d), '' order by b, d)
            from unnest(array[1632, 1776, 2406, 2534, 3664]) b, generate_series(0, 9) d),
         repeat('0123456789', 5));
  if strpos(t, '://') > 0
     or t ~ '(https?|ftp)[:/]'
     or t ~ 'www *\.'
     -- site.com, site .com, site.co.uk
     or t ~ (word || ' ?\.(' || endings || ')' || stop)
     -- site. com, site . com
     or t ~ (word || ' ?\. (' || spaced || ')' || stop)
     -- anything.xx/… : a web address with a path, whatever its ending (bit.do/x, zoom.us/j/1, shorturl.at/x)
     or t ~ (word || ' ?\.[abcdefghijklmnopqrstuvwxyz]{2,}/')
     -- site dot com, site dotcom, site d0t com, site (dot) com, site [.] com
     or t ~ (word || ' ?(\(dot\)|\[dot\]|\{dot\}|\(\.\)|\[\.\]| d[o0]t ?) ?(' || said || ')' || stop)
     -- name@anything.xx
     or t ~ ('[abcdefghijklmnopqrstuvwxyz0123456789._%+-]+@' || word || '(\.' || word || ')*\.[abcdefghijklmnopqrstuvwxyz][abcdefghijklmnopqrstuvwxyz]')
     -- name@gmail, name @ gmail
     or t ~ ('@ ?(' || mail || ')' || stop)
     -- 1.2.3.4
     or t ~ '[0123456789]{1,3}\.[0123456789]{1,3}\.[0123456789]{1,3}\.[0123456789]{1,3}' then
    return 'link';
  end if;
  -- Numbers that aren't phone numbers are set aside first (each becomes the letter n): times (10:30), dates with
  -- slashes (12/25/2026) and big numbers with commas (1,000,000).
  numbers := regexp_replace(t, '(^|[^0123456789])[0123456789]{1,2}:[0123456789]{2}(?![0123456789]|:[0123456789])', '\1n', 'g');
  numbers := regexp_replace(numbers, '(^|[^0123456789])[0123456789]{1,2}/[0123456789]{1,2}/([0123456789]{4}|[0123456789]{2})(?![0123456789]|/[0123456789])', '\1n', 'g');
  numbers := regexp_replace(numbers, '(^|[^0123456789])[0123456789]{1,3}(,[0123456789]{3})+(?![0123456789]|,[0123456789])', '\1n', 'g');
  -- A phone number: 7 or more digits, also with up to 3 other characters between them (spaces, dots, dashes,
  -- brackets, slashes, commas...; not letters, money signs or %).
  if regexp_replace(numbers, '([0123456789])[^abcdefghijklmnopqrstuvwxyz0123456789$%\u20AC\u00A3\u00A5]{1,3}(?=[0123456789])', '\1', 'g')
       ~ '[0123456789]{7}' then
    return 'phone';
  end if;
  return null;
end;
$$;

-- A message tidied the way it is saved (the same as tidyPublicText in src/lib/publicText.ts):
-- * the characters that change which way text runs are taken out (U+061C, U+200E, U+200F, U+202A–U+202E,
--   U+2066–U+2069): one of them can make "moc.elpmaxe" show up on screen as "example.com";
-- * every run of spaces and line breaks becomes one space – also the other kinds of space and line break, and the
--   blank-looking characters (U+2800, U+3164, U+FFA0), so a message is always one line of words;
-- * the spaces at the ends are taken off.
create or replace function private.public_text_tidy(value text)
returns text language sql immutable strict parallel safe set search_path = '' as $$
  select btrim(regexp_replace(
    regexp_replace(value, '[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]', '', 'g'),
    '[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\u2800\u3164\uFFA0]+', ' ', 'g'), ' ');
$$;

-- What's wrong with a message, or null when it can be sent: 'size' (not 1–300 characters, or nothing you can
-- see), 'marks' (more than 3 accent marks on one letter), 'word' (a slur), 'link' or 'phone'. Checked in this
-- order, the same as publicMessageProblem() in src/lib/publicText.ts.
create or replace function private.public_message_problem(value text)
returns text language plpgsql immutable strict parallel safe set search_path = '' as $$
declare
  clean text;
begin
  -- Very long text is refused before anything reads through it.
  if char_length(value) > 2000 then
    return 'size';
  end if;
  clean := private.public_text_tidy(value);
  -- The word filter's plain letters leave out invisible characters (zero-width spaces and the like).
  if char_length(clean) not between 1 and 300
     or char_length(replace(private.word_filter_plain_letters(clean), ' ', '')) = 0 then
    return 'size';
  end if;
  -- "Zalgo" text (a letter with a pile of accent marks) draws over the messages around it.
  if normalize(clean, NFD) ~ '[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]{4}' then
    return 'marks';
  end if;
  if private.blocked_word(clean, 'content') is not null then
    return 'word';
  end if;
  return private.public_text_problem(clean);
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Slow mode, counted in a list deleting can't change
-- ---------------------------------------------------------------------
-- When each person posted a photo or message in the last 24 hours. Deleting a photo or message doesn't take it
-- off this list, so it can't be used to get round slow mode or the daily limit. Older rows are removed as people
-- post, and every night (private.public_chat_tidy below). Nobody can read it from the app.
create table if not exists private.public_chat_sends (
  sender_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('photo', 'message')),
  sent_at timestamptz not null default now()
);
create index if not exists public_chat_sends_sender_idx on private.public_chat_sends (sender_id, kind, sent_at desc);
create index if not exists public_chat_sends_sent_idx on private.public_chat_sends (sent_at);
revoke all on private.public_chat_sends from public, anon, authenticated;

-- The photos posted in the last day before this list existed count too (only the first time this runs).
insert into private.public_chat_sends (sender_id, kind, sent_at)
select f.sender_id, 'photo', f.created_at from public.public_photos f
 where f.created_at > now() - interval '24 hours'
   and not exists (select 1 from private.public_chat_sends);

-- Slow mode for one person: 'photo' = one every 30 seconds, 40 a day; 'message' (messages and stickers) = one
-- every 5 seconds, 300 a day. Says no with a friendly sentence, or notes the new post.
create or replace function private.public_chat_slow_mode(person uuid, what text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  gap interval := case what when 'message' then interval '5 seconds' else interval '30 seconds' end;
  most integer := case what when 'message' then 300 else 40 end;
begin
  -- One at a time per person, so two quick taps can't both get past slow mode.
  perform pg_advisory_xact_lock(hashtextextended('public-' || what || ':' || person::text, 0));
  delete from private.public_chat_sends s
   where s.sender_id = person and s.kind = what and s.sent_at <= now() - interval '24 hours';
  if exists (select 1 from private.public_chat_sends s
              where s.sender_id = person and s.kind = what and s.sent_at > now() - gap) then
    if what = 'message' then
      raise exception 'Slow mode is on – one message every 5 seconds 🐢' using errcode = '23514', hint = 'public_chat_slow';
    end if;
    raise exception 'Slow mode is on – you can post again in a few seconds 🐢' using errcode = '23514', hint = 'public_chat_slow';
  end if;
  if (select count(*) from private.public_chat_sends s
       where s.sender_id = person and s.kind = what and s.sent_at > now() - interval '24 hours') >= most then
    if what = 'message' then
      raise exception 'That''s a lot of messages for one day – come back tomorrow 🙏' using errcode = '23514', hint = 'public_chat_daily';
    end if;
    raise exception 'That''s a lot of photos for one day – come back tomorrow 🙏' using errcode = '23514', hint = 'public_chat_daily';
  end if;
  insert into private.public_chat_sends (sender_id, kind, sent_at) values (person, what, now());
end;
$$;

-- Your name and username show with everything you post, so they can't hold a link or a phone number while you
-- post in the public chat (the same check as messages). The app shows the same sentence (PUBLIC_TEXT_WORDS.name).
create or replace function private.check_public_chat_name(person uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if exists (select 1 from public.profiles p
              where p.id = person
                and (private.public_text_problem(p.username) is not null
                     or private.public_text_problem(p.display_name) is not null)) then
    raise exception 'Your name or username looks like a link or a phone number. Change it in Edit profile to post in the public chat.'
      using errcode = '23514', hint = 'public_chat_name';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Runs before a message is saved: who and when, 18+, your name, the words, slow mode
-- ---------------------------------------------------------------------
-- The sentences are the same as PUBLIC_TEXT_WORDS in src/lib/publicChat.ts (the app shows them before sending).
create or replace function private.prepare_public_message()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  problem text;
begin
  -- The owner and the server (no logged-in person) aren't checked.
  if me is null then
    return new;
  end if;
  new.sender_id := me;
  new.created_at := now();
  new.hidden := false;
  if not private.in_public_chat(me) then
    raise exception 'The public chat is only for people 18 and over'
      using errcode = '42501', hint = 'public_chat_adults';
  end if;
  perform private.check_public_chat_name(me);
  if new.kind = 'text' then
    problem := private.public_message_problem(coalesce(new.body, ''));
    if problem = 'size' then
      raise exception 'Messages can be 1 to 300 characters.' using errcode = '23514', hint = 'public_chat_size';
    elsif problem = 'marks' then
      raise exception 'Too many accent marks on one letter.' using errcode = '23514', hint = 'public_chat_marks';
    elsif problem = 'word' then
      raise exception using errcode = 'check_violation', message = private.word_filter_message('content'),
        hint = 'public_chat_word';
    elsif problem = 'link' then
      raise exception 'Links aren''t allowed in the public chat.' using errcode = '23514', hint = 'public_chat_link';
    elsif problem = 'phone' then
      raise exception 'Phone numbers aren''t allowed in the public chat.' using errcode = '23514', hint = 'public_chat_phone';
    end if;
    new.body := private.public_text_tidy(new.body);
  end if;
  perform private.public_chat_slow_mode(me, 'message');
  return new;
end;
$$;

-- The photos get the same two changes: slow mode counted in the list above (so deleting a photo doesn't start
-- the count again), and no link or phone number in your name. Everything else is as in 20261225000000_public_chat.sql,
-- with the same sentences, so older apps see no difference.
create or replace function private.prepare_public_photo()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
begin
  -- The owner and the server (no logged-in person) aren't checked.
  if me is null then
    return new;
  end if;
  new.sender_id := me;
  new.created_at := now();
  new.hidden := false;
  if not private.in_public_chat(me) then
    raise exception 'The public chat is only for people 18 and over'
      using errcode = '42501', hint = 'public_chat_adults';
  end if;
  perform private.check_public_chat_name(me);
  perform private.public_chat_slow_mode(me, 'photo');
  return new;
end;
$$;

revoke all on function private.prepare_public_message() from public, anon, authenticated;
revoke all on function private.prepare_public_photo() from public, anon, authenticated;
revoke all on function private.public_text_lists() from public, anon, authenticated;
revoke all on function private.public_text_problem(text) from public, anon, authenticated;
revoke all on function private.public_text_tidy(text) from public, anon, authenticated;
revoke all on function private.public_message_problem(text) from public, anon, authenticated;
revoke all on function private.public_chat_slow_mode(uuid, text) from public, anon, authenticated;
revoke all on function private.check_public_chat_name(uuid) from public, anon, authenticated;

drop trigger if exists public_messages_prepare on public.public_messages;
create trigger public_messages_prepare before insert on public.public_messages
  for each row execute function private.prepare_public_message();
-- 🔒 Peekaboo+ stickers need Peekaboo+: the very same check as friend and group chats (20261221000000_chat_stickers.sql).
-- "zzz" makes it run after public_messages_prepare has filled in the sender.
drop trigger if exists zzz_public_messages_plus_sticker on public.public_messages;
create trigger zzz_public_messages_plus_sticker before insert on public.public_messages
  for each row execute function private.check_plus_sticker();

-- New messages show up live (for apps that know about them; older apps only listen to the photos).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'public_messages') then
    alter publication supabase_realtime add table public.public_messages;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Reports: a new kind, the words kept with the report, 3 different reporters hide the message, a repeat
--    report does nothing, and a private copy that outlives an account deletion
-- ---------------------------------------------------------------------
-- Every kind there is today (the last list is in 20261226000000_livestreams.sql) plus 'public_message'.
alter table public.reports drop constraint if exists reports_content_type_check;
alter table public.reports add constraint reports_content_type_check
  check (content_type in ('user', 'post', 'story', 'message', 'comment', 'dare_idea', 'group_message', 'public_photo',
                          'live', 'live_comment', 'public_message'));

-- What goes into a report about a message: 'Message: "…"' (or 'Sticker: word-slay'), then anything the reporter
-- wrote. At most 1000 characters (the reports table's limit). Only called while the reporter can see the message.
create or replace function private.public_message_report_details(message uuid, given text)
returns text language sql stable security definer set search_path = '' as $$
  select nullif(left(concat_ws(E'\n',
    (select case when m.kind = 'text' then 'Message: "' || m.body || '"' else 'Sticker: ' || m.sticker end
       from public.public_messages m where m.id = message),
    nullif(btrim(given), '')), 1000), '');
$$;
revoke all on function private.public_message_report_details(uuid, text) from public, anon, authenticated;

create or replace function private.hide_reported_public_message()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- One report at a time per message, so two reports at the same moment are both counted.
  perform pg_advisory_xact_lock(hashtextextended('public-message-report:' || new.content_id::text, 0));
  if (select count(distinct r.reporter_id) from public.reports r
       where r.content_type = 'public_message' and r.content_id = new.content_id) >= 3 then
    update public.public_messages set hidden = true where id = new.content_id and not hidden;
  end if;
  return null;
end;
$$;
revoke all on function private.hide_reported_public_message() from public, anon, authenticated;
drop trigger if exists reports_hide_public_message on public.reports;
create trigger reports_hide_public_message after insert on public.reports
  for each row when (new.content_type = 'public_message')
  execute function private.hide_reported_public_message();

-- Reporting the same public chat photo or message again is quietly skipped: no second copy of the words and no
-- second "🚩 New report" push (one person can't flood the owner's phone). The same as lives. "once" sorts before
-- "prepare", so this runs before private.prepare_report.
create or replace function private.skip_repeat_public_chat_report()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
begin
  if me is null or new.content_id is null then
    return new;
  end if;
  -- One at a time per person and thing, so two quick taps are one report.
  perform pg_advisory_xact_lock(hashtextextended('public-chat-report:' || me::text || ':' || new.content_id::text, 0));
  if exists (select 1 from public.reports r
              where r.reporter_id = me and r.content_type = new.content_type and r.content_id = new.content_id) then
    return null;
  end if;
  return new;
end;
$$;
revoke all on function private.skip_repeat_public_chat_report() from public, anon, authenticated;
drop trigger if exists reports_once_public_chat on public.reports;
create trigger reports_once_public_chat before insert on public.reports
  for each row when (new.content_type in ('public_photo', 'public_message'))
  execute function private.skip_repeat_public_chat_report();
-- And the database itself keeps it to one report per person per message. (Not for photos: reports about photos
-- from before this change may already have repeats, and this must not fail on them.)
create unique index if not exists reports_public_message_once on public.reports (reporter_id, content_type, content_id)
  where content_type = 'public_message';

-- A private copy of every public chat report, kept for 90 days even if the message, the photo or an account is
-- deleted (the report itself goes when the account of the person it is about is deleted). It has who the report
-- is about and their name and username then, the reason and the report's details (for a message: its words).
-- Not who reported it. Only the owner can see it (Supabase → Table Editor → schema "private"); the report id is
-- the one in the "🚩 New report" push.
create table if not exists private.public_chat_report_copies (
  report_id uuid primary key,
  content_type text not null,
  content_id uuid,
  reported_user_id uuid,
  reported_username text,
  reported_name text,
  reason text not null,
  details text,
  reported_at timestamptz not null,
  keep_until timestamptz not null
);
create index if not exists public_chat_report_copies_keep_idx on private.public_chat_report_copies (keep_until);
revoke all on private.public_chat_report_copies from public, anon, authenticated;

create or replace function private.keep_public_chat_report()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    insert into private.public_chat_report_copies (report_id, content_type, content_id, reported_user_id,
      reported_username, reported_name, reason, details, reported_at, keep_until)
    select new.id, new.content_type, new.content_id, new.reported_user_id, p.username, p.display_name,
           new.reason, new.details, new.created_at, now() + interval '90 days'
      from (select 1) as one left join public.profiles p on p.id = new.reported_user_id
    on conflict (report_id) do nothing;
  exception when others then
    -- The report itself is saved either way.
    raise warning 'Public chat (report copy): %', sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function private.keep_public_chat_report() from public, anon, authenticated;
drop trigger if exists reports_keep_public_chat_copy on public.reports;
create trigger reports_keep_public_chat_copy after insert on public.reports
  for each row when (new.content_type in ('public_photo', 'public_message'))
  execute function private.keep_public_chat_report();

-- prepare_report (who a report is about, and may you report it) gets one new branch. Like the public chat and
-- livestream migrations, this reads the function as it is now, adds the branch at a known spot and saves it back.
-- If the spot isn't there exactly once, the whole migration stops and nothing is changed. Running it again does
-- nothing (it sees its own line). The public_photo and live lines stay as they are.
do $patch$
declare
  body text;
  anchor text := $a$elsif new.content_type = 'group_message' then$a$;
begin
  body := pg_get_functiondef('private.prepare_report()'::regprocedure);
  if position('public_message_report_details' in body) > 0 then
    return;
  end if;
  if (length(body) - length(replace(body, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'public chat messages: could not find the spot to change in private.prepare_report()';
  end if;
  execute replace(body, anchor, $b$elsif new.content_type = 'public_message' then
    -- A public chat message or sticker (20270102000000_public_chat_text.sql): the same rule as a public chat photo.
    -- Its words go into the report, so they are kept even if the sender deletes the message.
    select m.sender_id, (me is null or (private.in_public_chat(me) and not private.is_blocked(m.sender_id, me))) into author, visible
      from public.public_messages m where m.id = new.content_id;
    if coalesce(visible, false) then
      new.details := private.public_message_report_details(new.content_id, new.details);
    end if;
  elsif new.content_type = 'group_message' then$b$);
end;
$patch$;

-- ---------------------------------------------------------------------
-- 6. Every night: forget sends older than a day, and report copies past their 90 days
-- ---------------------------------------------------------------------
create or replace function private.public_chat_tidy()
returns void language sql security definer set search_path = '' as $$
  delete from private.public_chat_sends s where s.sent_at <= now() - interval '24 hours';
  delete from private.public_chat_report_copies c where c.keep_until < now();
$$;
revoke all on function private.public_chat_tidy() from public, anon, authenticated;

-- Once a day (Supabase's built-in pg_cron). Skipped where pg_cron isn't available.
do $$
begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'peekaboo-public-chat-tidy';
  perform cron.schedule('peekaboo-public-chat-tidy', '23 5 * * *', 'select private.public_chat_tidy()');
exception when others then
  raise notice 'pg_cron not available here – the public chat tidy-up is not scheduled: %', sqlerrm;
end $$;

commit;
