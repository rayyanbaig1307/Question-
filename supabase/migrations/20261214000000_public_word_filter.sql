-- ---------------------------------------------------------------------------
-- The word filter, now checked by the database too.
--
-- Until now only the app checked names, bios, captions and so on (src/lib/cleanWords.ts), so someone who talked
-- to the server directly could skip it. This makes the database run exactly the same check:
-- * Slurs are blocked in everything strangers can see: usernames, display names, bios, post and Guess Who
--   captions, comments, hit ups, dare ideas and group names.
-- * Swearing is blocked in @usernames only. Display names (the name shown on a profile), bios and the rest
--   allow it. That is the owner's choice.
-- * The username check keeps the old real-name rule ("Moby Dick" with a capital letter is let through). Usernames
--   are always lowercase, so it rarely matters now; it stays so the app and the database stay exactly the same.
-- * Private chat messages (1:1 and group chat) are NOT filtered. That is the owner's choice. Dare cards in a
--   chat are chat messages too, so they aren't filtered either (the same for 1:1 and group chats). The
--   "Dare a friend" screen still checks the dare in the app before sending it.
-- Only new or changed text is checked, so older rows never get in the way of other changes.
--
-- IMPORTANT: private.blocked_word below must stay the same as findBlockedWord in src/lib/cleanWords.ts.
-- The word lists are copied here on purpose; tests/unit/word-filter-parity.test.mjs checks they match.
-- ---------------------------------------------------------------------------

-- The word lists, the same as the ones in src/lib/cleanWords.ts.
create or replace function private.word_filter_lists()
returns jsonb language sql immutable parallel safe set search_path = '' as $$
  select jsonb_build_object(
    'hateful', jsonb_build_array(
      'nigger', 'nigga', 'niggers', 'niggas', 'faggot', 'faggots', 'fag', 'fags', 'retard', 'retarded', 'retards',
      'tranny', 'trannies', 'chink', 'chinks', 'spic', 'spics', 'kike', 'kikes', 'wetback', 'wetbacks', 'beaner',
      'beaners', 'raghead', 'towelhead', 'dyke', 'dykes', 'coon', 'coons', 'gook', 'gooks', 'paki', 'pakis',
      'rapist', 'molester', 'pedo', 'pedophile', 'paedophile'),
    'crude', jsonb_build_array(
      'fuck', 'fucker', 'fucking', 'motherfucker', 'shit', 'bullshit', 'cunt', 'bitch', 'bitches', 'whore', 'slut',
      'sluts', 'asshole', 'pussy', 'cock', 'cocksucker', 'dick', 'dildo', 'porn', 'porno', 'blowjob', 'handjob',
      'jerkoff', 'wanker', 'twat', 'nazi', 'hitler'),
    'real_names', jsonb_build_array('dick', 'cock'),
    'crude_inside', jsonb_build_array('fuck', 'bitch', 'whore', 'dildo', 'asshole', 'cocksuck', 'blowjob', 'handjob', 'hitler'),
    'hateful_squashed', jsonb_build_array('nigger', 'nigga', 'faggot', 'retard', 'tranny', 'wetback', 'beaner', 'raghead',
      'towelhead', 'pedophile', 'paedophile')
  );
$$;

create or replace function private.word_filter_list(list_name text)
returns text[] language sql immutable strict parallel safe set search_path = '' as $$
  select coalesce(array(select jsonb_array_elements_text(private.word_filter_lists() -> list_name)), '{}'::text[]);
$$;

-- Fancy look-alike letters (full-width, bold maths and circled letters) become plain ones (Unicode NFKC), like plainLetters() in
-- the app. Then, the same as the app, in the same order:
-- * accents are taken off (an accented "u" in a swear word becomes a plain "u"; "Jose" with an accent becomes "Jose"): each letter is split into the plain letter plus its
--   accent mark (Unicode NFD), and the accent marks are deleted (the five blocks of "combining" marks);
-- * the "outlined" letters and digits (U+1CCD6-U+1CCF9) are only known to newer Unicode, so older PostgreSQL
--   versions (16 and earlier) would miss them; they are swapped by hand so every version agrees;
-- * characters you can't see (zero-width space, soft hyphen, joiners, direction marks, variation selectors,
--   tags...) are deleted, so "cu<invisible>nt" can't pass as two harmless pieces;
-- * Cyrillic and Greek letters that look just like Latin ones (a Russian letter that looks like "c") become the Latin
--   letter. The two lists below are LOOK_ALIKE_FROM / LOOK_ALIKE_TO in the app, in the same order.
create or replace function private.word_filter_plain_letters(value text)
returns text language sql immutable strict parallel safe set search_path = '' as $$
  select translate(
    regexp_replace(
      translate(
        regexp_replace(
          normalize(normalize(value, NFKC), NFD),
          '[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]',
          '', 'g'),
        (select string_agg(chr(c), '' order by c) from generate_series(117974, 118009) as c),
        'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'),
      '[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFF8\U0001BCA0-\U0001BCA3\U0001D173-\U0001D17A\U000E0000-\U000E0FFF]',
      '', 'g'),
    E'\u0430\u03B1\u0441\u0501\u0435\u03B5\u04BB\u0456\u03B9\u0458\u043A\u03BA\u04CF\u043E\u03BF\u0440\u03C1\u051B\u0455\u03C4\u03C5\u051D\u0445\u03C7\u0443'
      || E'\u0410\u0391\u0412\u0392\u0421\u0415\u0395\u041D\u0397\u0406\u0399\u0408\u041A\u039A\u041C\u039C\u039D\u041E\u039F\u0420\u03A1\u0405\u0422\u03A4\u0425\u03A7\u03A5\u04AE\u0396',
    'aacdeehiijkklooppqstuwxxy'
      || 'AABBCEEHHIIJKKMMNOOPPSTTXXYYZ');
$$;

-- "n1gg3r" -> "nigger", "F.A.G" -> "f a g". Same steps as tidy() in the app.
-- Lower case is done by hand (A-Z only) so the result never depends on the server's language settings.
-- The one other letter the app turns into a plain letter is the Turkish capital "I" with a dot (it becomes "i" plus a dot). Since
-- accents are now taken off first, that letter never gets this far; the swap stays only to match the app exactly.
create or replace function private.word_filter_tidy(value text)
returns text language sql immutable strict parallel safe set search_path = '' as $$
  select regexp_replace(
    translate(
      replace(translate(value, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), chr(304), 'i '),
      '0@1!|345$7', 'ooiiieasst'),
    '[^abcdefghijklmnopqrstuvwxyz]', ' ', 'g');
$$;

-- "f u c k" -> "fuck": single letters in a row are joined. Same as joinSingles() in the app.
create or replace function private.word_filter_join_singles(clean text)
returns text language plpgsql immutable strict parallel safe set search_path = '' as $$
declare
  merged text[] := '{}';
  run text := '';
  token text;
begin
  foreach token in array string_to_array(clean, ' ') loop
    -- Several spaces in a row are one gap (the app splits on any run of spaces).
    continue when token = '';
    if char_length(token) = 1 then
      run := run || token;
      continue;
    end if;
    if run <> '' then
      merged := merged || run;
      run := '';
    end if;
    merged := merged || token;
  end loop;
  if run <> '' then
    merged := merged || run;
  end if;
  return array_to_string(merged, ' ');
end;
$$;

-- The first whole word (left to right) that is on the list, or null.
create or replace function private.word_filter_first_word(clean text, words text[])
returns text language sql immutable strict parallel safe set search_path = '' as $$
  select t.word
  from unnest(string_to_array(clean, ' ')) with ordinality as t(word, n)
  where t.word <> '' and t.word = any (words)
  order by t.n
  limit 1;
$$;

-- Real names written like names ("Dick", but not "dick" or "DICK") are taken out before the swear check.
create or replace function private.word_filter_without_real_names(value text)
returns text language sql immutable strict parallel safe set search_path = '' as $$
  select regexp_replace(
    value,
    '(^|[^ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz])('
      || (select string_agg(upper(left(w, 1)) || substr(w, 2), '|') from unnest(private.word_filter_list('real_names')) w)
      || ')(?![ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz])',
    '\1 ', 'g');
$$;

-- The offending word, or null if the text is fine. Same as findBlockedWord() in the app.
-- place = 'name' (@usernames: no swearing) or 'content' (everything else, display names too: only slurs).
create or replace function private.blocked_word(value text, place text)
returns text language plpgsql immutable strict parallel safe set search_path = '' as $$
declare
  hateful text[] := private.word_filter_list('hateful');
  text_value text;
  clean text;
  squashed text;
  named text;
  found text;
begin
  if place not in ('name', 'content') then
    raise exception 'Unknown place for the word filter: %', place;
  end if;
  -- Fancy look-alike letters (full-width and bold maths letters) are turned into plain ones first.
  text_value := private.word_filter_plain_letters(value);
  clean := private.word_filter_tidy(text_value);
  squashed := replace(clean, ' ', '');
  found := coalesce(
    private.word_filter_first_word(clean, hateful),
    private.word_filter_first_word(private.word_filter_join_singles(clean), hateful),
    (select w from unnest(private.word_filter_list('hateful_squashed')) with ordinality as l(w, n)
      where strpos(squashed, w) > 0 order by strpos(squashed, w), n limit 1)
  );
  if found is not null then
    return found;
  end if;
  if place = 'name' then
    named := private.word_filter_tidy(private.word_filter_without_real_names(text_value));
    squashed := replace(named, ' ', '');
    found := coalesce(
      private.word_filter_first_word(named, private.word_filter_list('crude')),
      private.word_filter_first_word(private.word_filter_join_singles(named), private.word_filter_list('crude')),
      (select w from unnest(private.word_filter_list('crude_inside')) with ordinality as l(w, n)
        where strpos(squashed, w) > 0 order by n limit 1)
    );
  end if;
  return found;
end;
$$;

-- The same friendly sentences the app shows.
create or replace function private.word_filter_message(place text)
returns text language sql immutable strict parallel safe set search_path = '' as $$
  select case when place = 'name'
    then E'Let''s keep it clean \u2013 that word can''t be in a username or name.'
    else 'That word isn''t allowed on Peekaboo.' end;
$$;

-- Checks the columns named in the trigger: pairs of (column, place). Only new or changed text is checked.
-- * Text over 2000 characters is not checked: every checked column has its own length limit of 2000 or less,
--   which refuses the row anyway. This runs before the access rules, so without the skip anyone could make the
--   database read through megabytes of text in a request that is refused anyway.
-- * A trigger set up wrongly (a column name that doesn't exist, for example after a rename) fails loudly
--   instead of quietly checking nothing.
create or replace function private.enforce_word_filter()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  new_row jsonb := to_jsonb(new);
  old_row jsonb;
  i integer := 0;
  column_name text;
  place text;
  value text;
begin
  if tg_nargs = 0 or tg_nargs % 2 <> 0 then
    raise exception 'The word filter on %.% needs pairs of (column, place), not %', tg_table_schema, tg_table_name, tg_nargs;
  end if;
  if tg_op = 'UPDATE' then
    old_row := to_jsonb(old);
  end if;
  while i + 1 < tg_nargs loop
    column_name := tg_argv[i];
    place := tg_argv[i + 1];
    i := i + 2;
    if not (new_row ? column_name) then
      raise exception 'The word filter on %.% checks a column that does not exist: %', tg_table_schema, tg_table_name, column_name;
    end if;
    if place not in ('name', 'content') then
      raise exception 'Unknown place for the word filter on %.%: %', tg_table_schema, tg_table_name, place;
    end if;
    value := new_row ->> column_name;
    continue when value is null;
    continue when char_length(value) > 2000;
    continue when tg_op = 'UPDATE' and value is not distinct from (old_row ->> column_name);
    if private.blocked_word(value, place) is not null then
      raise exception using errcode = 'check_violation', message = private.word_filter_message(place);
    end if;
  end loop;
  return new;
end;
$$;

revoke all on function private.word_filter_lists() from public;
revoke all on function private.word_filter_list(text) from public;
revoke all on function private.word_filter_plain_letters(text) from public;
revoke all on function private.word_filter_tidy(text) from public;
revoke all on function private.word_filter_join_singles(text) from public;
revoke all on function private.word_filter_first_word(text, text[]) from public;
revoke all on function private.word_filter_without_real_names(text) from public;
revoke all on function private.blocked_word(text, text) from public;
revoke all on function private.word_filter_message(text) from public;
revoke all on function private.enforce_word_filter() from public;

-- The public places the app checks today (see the checkClean calls in src). Private chat tables have no trigger. The "word_filter" name sorts after the
-- other triggers on these tables, so it sees the final text.
drop trigger if exists word_filter on public.profiles;
create trigger word_filter before insert or update on public.profiles
  for each row execute function private.enforce_word_filter('username', 'name', 'display_name', 'content', 'bio', 'content');
drop trigger if exists word_filter on public.posts;
create trigger word_filter before insert or update on public.posts
  for each row execute function private.enforce_word_filter('caption', 'content');
drop trigger if exists word_filter on public.mystery_posts;
create trigger word_filter before insert or update on public.mystery_posts
  for each row execute function private.enforce_word_filter('caption', 'content');
drop trigger if exists word_filter on public.comments;
create trigger word_filter before insert or update on public.comments
  for each row execute function private.enforce_word_filter('body', 'content');
drop trigger if exists word_filter on public.hit_ups;
create trigger word_filter before insert or update on public.hit_ups
  for each row execute function private.enforce_word_filter('message', 'content');
drop trigger if exists word_filter on public.dare_ideas;
create trigger word_filter before insert or update on public.dare_ideas
  for each row execute function private.enforce_word_filter('text', 'content');
-- Group names are limited to 40 characters after spaces are trimmed off both ends, so a name padded with lots
-- of spaces could be longer than 2000 and skip the check above. The app's functions trim the name before
-- saving it, so this never refuses a real name; it just makes the limit hold for every way in.
alter table public.peek_groups drop constraint if exists peek_groups_name_size;
alter table public.peek_groups add constraint peek_groups_name_size check (char_length(name) <= 2000) not valid;
drop trigger if exists word_filter on public.peek_groups;
create trigger word_filter before insert or update on public.peek_groups
  for each row execute function private.enforce_word_filter('name', 'content');

-- For the username sign-up server (supabase/functions/username-auth): true when both names pass the filter.
-- The same rules as the profiles table: no swearing in the username; the display name may swear, but no slurs.
-- Only the server can call it, so it says nothing to anyone else.
create or replace function public.public_name_allowed(username text, display_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.blocked_word(coalesce(username, ''), 'name') is null
     and private.blocked_word(coalesce(display_name, ''), 'content') is null;
$$;
revoke all on function public.public_name_allowed(text, text) from public, anon, authenticated;
grant execute on function public.public_name_allowed(text, text) to service_role;

-- New accounts: the same as the 20261213 version, plus the word filter. Signing up must never fail because of a
-- name from Apple or Google, so a name that isn't allowed is swapped for a safe one ("user" + numbers). The
-- person then picks their own name in the app. The same rules as the profiles table: the username can't have
-- swearing or slurs; the shown name may swear, so only a slur swaps it.
create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  base text;
  candidate text;
  attempts int := 0;
  safe_name text := 'user' || substr(replace(new.id::text, '-', ''), 1, 6);
  shown_name text;
  -- The app sends display_name; Google sends full_name / name.
  shared_name text := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'name'), '')
  );
begin
  base := lower(coalesce(new.raw_user_meta_data ->> 'username', shared_name, ''));
  base := regexp_replace(base, '[^a-z0-9_.]', '', 'g');
  base := left(base, 20);
  if char_length(base) < 3 or private.blocked_word(base, 'name') is not null then
    base := safe_name;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('profile-username:' || base,0));
  candidate := base;

  -- If the username got taken in the meantime (or the added numbers spell a bad word), add other numbers.
  while exists (select 1 from public.profiles where username = candidate)
        or private.blocked_word(candidate, 'name') is not null loop
    attempts := attempts + 1;
    if attempts > 20 then
      -- "user" + letters a-f and numbers can never spell a blocked word.
      candidate := 'user' || substr(replace(new.id::text, '-', ''), 1, 12);
      exit;
    end if;
    candidate := left(base, 16) || (floor(random() * 9000) + 1000)::int::text;
  end loop;

  shown_name := left(coalesce(shared_name, candidate), 40);
  -- Swearing is fine in a shown name; a slur is not.
  if private.blocked_word(shown_name, 'content') is not null then
    shown_name := candidate;
  end if;

  insert into public.profiles (id, username, display_name)
  values (new.id, candidate, shown_name);
  return new;
end;
$$;
