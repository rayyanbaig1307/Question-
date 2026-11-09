-- =====================================================================
-- Dare safety 🛡️ (the owner's rule, 9 Nov 2026): nobody can write a dare that asks someone to hurt anyone
-- (or themselves), rape, abuse, do sexual stuff, be hateful, or that is spam. Safe to run more than once.
--
-- Covers every dare people write: dares in friend chats (messages, kind 'dare'), group dares (group_messages,
-- kind 'dare') and community dare ideas (dare_ideas). The app checks first so people see why straight away
-- (src/lib/dareSafety.ts); this is the second lock, so an old or changed app can't skip it. The patterns are
-- copied word for word from src/lib/dareSafety.ts – change both together
-- (tests/support/dare-safety-cases.json runs against both).
--
-- Also: no more than 40 dares in 10 minutes from one person (spam).
-- Dares already sent stay as they are.
-- =====================================================================
begin;
set local lock_timeout = '15s';

-- "K1LL  @ll" → "kill all" (same steps as tidyDare in the app).
create or replace function private.dare_tidy(value text)
returns text language sql immutable strict parallel safe set search_path = '' as $$
  select btrim(regexp_replace(
    translate(lower(private.word_filter_plain_letters(value)), '01!|34@5$7', 'oiiieaasst'),
    '[^a-z]+', ' ', 'g'));
$$;

-- What's wrong with a dare ('harm', 'sexual', 'hate' or 'spam'), or null when it's fine.
create or replace function private.dare_problem(value text)
returns text language plpgsql immutable strict parallel safe set search_path = '' as $$
declare
  harm text[] := array[' (kill|kills|killed|killing|murder|murders|murdered|murdering|stab|stabs|stabbed|stabbing|strangle|strangles|strangled|strangling|behead|beheaded|beheading|suffocate|suffocating|massacre|kidnap|kidnaps|kidnapped|kidnapping|torture|tortures|tortured|torturing|shoot up|set fire to|arson|bomb threat) ',
    ' (kys|suicide|suicidal|selfharm|self harm|cut yourself|cut urself|hang yourself|hang urself|end your life|end ur life|slit your|slit ur|go die|drink bleach|overdose|starve yourself) ',
    ' (rape|rapes|raped|raping|rapist|molest|molests|molested|molesting|grope|gropes|groped|groping|abuse|abuses|abused|abusing|abuser|assault|assaulted|assaulting) ',
    ' (shoot|shot|punch|punched|kick|kicked|slap|slapped|hit|beat|choke|choked|hurt|attack|attacked|burn|burned|trip|push|pushed|poison|poisoned|drown|drowned|spit on|pee on|piss on) (him|her|them|someone|somebody|anyone|people|a person|a stranger|strangers|a kid|kids|a child|children|a baby|an animal|a dog|a cat|your sister|ur sister|your brother|ur brother|your mom|ur mom|your mum|ur mum|your dad|ur dad|a girl|a boy|yourself|urself|a teacher|your teacher|ur teacher|a homeless person) ',
    ' beat (up|the shit out of|the crap out of) '];
  sexual text[] := array[' (nude|nudes|naked|nudity|sex|sexting|porn|porno|pornhub|blowjob|handjob|masturbate|masturbating|jerk off|jerking off|jerkoff|cum|horny|onlyfans|strip|stripping|striptease|boob|boobs|tits|titties|dickpic|dick pic|nipple|nipples|pussy|vagina|penis|asshole|condom|panties) ',
    ' (show|send|flash|pic of|picture of|photo of|video of|touch|lick|grab) ([a-z]+ ){0,2}(ass|butt|bum|dick|cock|crotch|privates|private parts|chest|body|boobs|tits|penis|vagina) ',
    ' (take off|remove) ([a-z]+ ){0,2}(clothes|underwear|bra|boxers|panties) '];
  hate text[] := array[' (nazi|nazis|hitler|heil|kkk|white power|hate crime|n word|nword|terrorist|terrorists) ',
    ' (bully|bullies|bullied|bullying|cyberbully|harass|harassing|harassment|stalk|stalking|dox|doxx|doxxing) ',
    ' (call|tell) ([a-z]+ ){0,3}(ugly|fat|fatty|stupid|loser|worthless|disgusting|slut|whore|bitch) '];
  spam_raw text[] := array['https?://',
    'www\.',
    '[a-z0-9-]+\.(com|net|org|io|ly|gg|xyz|me|co|app|link|ru|tk|info|biz)( |/|$)',
    '[0-9][0-9 -]{6,}[0-9]'];
  spam_tidy text[] := array['([a-z])\1\1\1\1\1\1\1\1\1',
    '( [a-z]+)\1\1\1\1 '];
  safe_phrases text := ' (kill|kills|killed|killing|slay|slays|slayed|slaying) it ';
  tidied text := private.dare_tidy(value);
  versions text[];
  rule text;
  version text;
begin
  versions := array[
    regexp_replace(' ' || tidied || ' ', safe_phrases, ' ', 'g'),
    regexp_replace(' ' || private.word_filter_join_singles(tidied) || ' ', safe_phrases, ' ', 'g')
  ];
  -- Slurs (the word filter's list), as whole words only, so "be an errand" isn't mistaken for one.
  foreach version in array versions loop
    if version ~ (' (' || array_to_string(private.word_filter_list('hateful'), '|') || ') ') then return 'hate'; end if;
  end loop;
  foreach version in array versions loop
    foreach rule in array harm loop
      if version ~ rule then return 'harm'; end if;
    end loop;
  end loop;
  foreach version in array versions loop
    foreach rule in array sexual loop
      if version ~ rule then return 'sexual'; end if;
    end loop;
  end loop;
  foreach version in array versions loop
    foreach rule in array hate loop
      if version ~ rule then return 'hate'; end if;
    end loop;
  end loop;
  foreach rule in array spam_raw loop
    if lower(value) ~ rule then return 'spam'; end if;
  end loop;
  foreach rule in array spam_tidy loop
    if ' ' || tidied || ' ' ~ rule then return 'spam'; end if;
  end loop;
  return null;
end;
$$;

-- The sentences people see (the same as DARE_NOT_ALLOWED in the app).
create or replace function private.dare_problem_message(problem text)
returns text language sql immutable strict parallel safe set search_path = '' as $$
  select case problem
    when 'harm' then 'That dare isn''t allowed – no hurting anyone (or yourself), no violence and no abuse. 🙏'
    when 'sexual' then 'That dare isn''t allowed – nothing sexual and no nudity. 🙏'
    when 'hate' then 'That dare isn''t allowed – no hate, bullying or slurs. 🙏'
    else 'That dare looks like spam – no links, phone numbers or the same thing over and over. 🙏'
  end;
$$;

-- Runs before a dare is saved.
create or replace function private.enforce_dare_safety()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  dare text;
  problem text;
  sender uuid;
begin
  if tg_table_name = 'dare_ideas' then
    dare := new.text;
  elsif new.kind = 'dare' then
    dare := new.body;
    sender := new.sender_id;
  else
    return new;
  end if;
  -- Over 2000 characters: the table's own length rules refuse it (like the word filter, this skips it).
  if dare is null or char_length(dare) > 2000 then
    return new;
  end if;
  problem := private.dare_problem(dare);
  if problem is not null then
    raise exception '%', private.dare_problem_message(problem)
      using errcode = '23514', hint = 'dare_' || problem;
  end if;
  -- Spam: 40 dares in 10 minutes is plenty (chats and groups together). The owner and the server
  -- (no logged-in person) aren't limited.
  if sender is not null and (select auth.uid()) is not null and (
    (select count(*) from public.messages m
      where m.sender_id = sender and m.kind = 'dare' and m.created_at > now() - interval '10 minutes')
    + (select count(*) from public.group_messages g
      where g.sender_id = sender and g.kind = 'dare' and g.created_at > now() - interval '10 minutes')
  ) >= 40 then
    raise exception 'Slow down! You''ve sent lots of dares – try again in a few minutes. 🙏'
      using errcode = '23514', hint = 'dare_spam';
  end if;
  return new;
end;
$$;

revoke all on function private.dare_tidy(text) from public, anon, authenticated;
revoke all on function private.dare_problem(text) from public, anon, authenticated;
revoke all on function private.dare_problem_message(text) from public, anon, authenticated;
revoke all on function private.enforce_dare_safety() from public, anon, authenticated;

-- "zzz" so it runs after the other "before insert" steps (group_messages_prepare fills in the sender first).
drop trigger if exists zzz_dare_safety on public.messages;
create trigger zzz_dare_safety before insert or update of body, kind on public.messages
  for each row execute function private.enforce_dare_safety();
drop trigger if exists zzz_dare_safety on public.group_messages;
create trigger zzz_dare_safety before insert or update of body, kind on public.group_messages
  for each row execute function private.enforce_dare_safety();
drop trigger if exists zzz_dare_safety on public.dare_ideas;
create trigger zzz_dare_safety before insert or update of text on public.dare_ideas
  for each row execute function private.enforce_dare_safety();

commit;
