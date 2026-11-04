-- Read-only checks to run on a DISPOSABLE TEST COPY of the live database
-- BEFORE the QA migrations are applied (20261213102659 and every later one).
-- Do not run the QA test suite against the live project.
--
-- Every query here only reads (select). Nothing is changed.
-- Each query has a label:
--   [HARD BLOCKER] must return NO rows. If it returns rows, a migration
--                  would stop with an error. Sort those rows out first.
--   [INFO]         lists older rows for the owner to look at. The migrations
--                  still run and these rows keep working; nothing is deleted.
-- All of them work on a database where the QA migrations have NOT run yet,
-- except the word filter one at the end (read its note).
-- Run each query on its own: the SQL editor only shows the result of the last
-- query when several are run together.

-- [HARD BLOCKER] Two or more posts paying the same forfeit.
-- The hardening migration adds a rule "one payment per forfeit" (the unique
-- index posts_one_payment_per_forfeit). Old duplicates make that step fail,
-- so the whole migration stops. Decide by hand which post to keep; the
-- migration deliberately never deletes or changes these posts itself.
select forfeit_id, count(*) as payments, array_agg(id order by created_at) as post_ids
from public.posts
where forfeit_id is not null
group by forfeit_id
having count(*)>1;

-- [HARD BLOCKER] Names the new migrations create must still be free.
-- The migrations from 20261213102659 on create these tables, indexes, a
-- column, checks, triggers and storage rules without "if not exists". If one
-- of them already exists (for example made by hand in the SQL editor), that
-- migration stops with "already exists". The "migration" column says which
-- one. Expected: no rows.
-- Not listed, because they never stop a migration: names made with
-- "if not exists" or "or replace" (for example the table
-- private.media_path_locks and the functions), and names a migration first
-- removes itself ("drop ...").
-- Not checked here: a function made by hand with the same name and inputs
-- but a different result type, and things the migrations need to find (the
-- live app's own tables, rules and checks, such as reports_content_type_check).
-- (On a copy where some QA migrations already ran, their names are listed -
-- that is normal there. The seven message checks are removed again by
-- 20261213210000, so a finished database does not list them.)
select x.migration, x.kind, x.name from (
  select v.migration, v.kind,
         case when v.kind in ('table', 'index') then v.sch || '.' || v.obj
              when v.kind = 'column' then v.sch || '.' || v.tbl || '.' || v.obj
              else v.obj || ' on ' || v.sch || '.' || v.tbl end as name,
         case v.kind
           when 'table' then to_regclass(v.sch || '.' || v.obj) is not null or to_regtype(v.sch || '.' || v.obj) is not null
           when 'index' then to_regclass(v.sch || '.' || v.obj) is not null
           when 'column' then exists (
             select 1 from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = v.sch and c.relname = v.tbl and a.attname = v.obj and a.attnum > 0 and not a.attisdropped)
           when 'check' then exists (
             select 1 from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = v.sch and c.relname = v.tbl and k.conname = v.obj)
           when 'trigger' then exists (
             select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = v.sch and c.relname = v.tbl and t.tgname = v.obj)
           when 'storage rule' then exists (
             select 1 from pg_policies p where p.schemaname = v.sch and p.tablename = v.tbl and p.policyname = v.obj)
         end as taken
  from (values
    ('20261213102659_qa_round2_security_hardening.sql', 'column', 'public', 'reports', 'anonymous_content'),
    ('20261213102659_qa_round2_security_hardening.sql', 'trigger', 'public', 'mystery_posts', 'mystery_posts_set_expiry'),
    ('20261213102659_qa_round2_security_hardening.sql', 'trigger', 'public', 'posts', 'posts_prepare_timestamp'),
    ('20261213102659_qa_round2_security_hardening.sql', 'trigger', 'public', 'reports', 'reports_prepare'),
    ('20261213102659_qa_round2_security_hardening.sql', 'trigger', 'public', 'messages', 'messages_prepare_state'),
    ('20261213102659_qa_round2_security_hardening.sql', 'index', 'public', 'posts', 'posts_one_payment_per_forfeit'),
    ('20261213102659_qa_round2_security_hardening.sql', 'check', 'public', 'messages', 'messages_voice_content_required'),
    ('20261213102659_qa_round2_security_hardening.sql', 'check', 'public', 'messages', 'messages_screenshot_content_required'),
    ('20261213102659_qa_round2_security_hardening.sql', 'check', 'public', 'messages', 'messages_waveform_values'),
    ('20261213102659_qa_round2_security_hardening.sql', 'trigger', 'public', 'dare_ideas', 'dare_ideas_prepare'),
    ('20261213102659_qa_round2_security_hardening.sql', 'trigger', 'public', 'hit_ups', 'hit_ups_enforce_quota'),
    ('20261213102659_qa_round2_security_hardening.sql', 'trigger', 'public', 'peek_group_members', 'peek_group_members_enforce_size'),
    ('20261213102659_qa_round2_security_hardening.sql', 'trigger', 'public', 'nudges', 'nudges_enforce_cooldown'),
    ('20261213102659_qa_round2_security_hardening.sql', 'trigger', 'public', 'group_messages', 'group_messages_prepare'),
    ('20261213102659_qa_round2_security_hardening.sql', 'check', 'public', 'group_messages', 'group_messages_voice_required'),
    ('20261213102659_qa_round2_security_hardening.sql', 'check', 'public', 'group_messages', 'group_messages_waveform_valid'),
    ('20261213102659_qa_round2_security_hardening.sql', 'check', 'public', 'group_messages', 'group_messages_body_size'),
    ('20261213102659_qa_round2_security_hardening.sql', 'check', 'public', 'group_messages', 'group_messages_media_kind'),
    ('20261213102659_qa_round2_security_hardening.sql', 'table', 'private', null, 'media_cleanup_claims'),
    ('20261213102659_qa_round2_security_hardening.sql', 'table', 'private', null, 'account_media_deletions'),
    ('20261213102659_qa_round2_security_hardening.sql', 'table', 'private', null, 'report_media_evidence'),
    ('20261213102659_qa_round2_security_hardening.sql', 'index', 'private', 'report_media_evidence', 'report_media_evidence_path'),
    ('20261213102659_qa_round2_security_hardening.sql', 'trigger', 'storage', 'objects', 'objects_guard_claimed_cleanup'),
    ('20261213102659_qa_round2_security_hardening.sql', 'trigger', 'storage', 'objects', 'objects_guard_cleaned_path'),
    ('20261213102659_qa_round2_security_hardening.sql', 'storage rule', 'storage', 'objects', 'An existing profile is required for uploads'),
    ('20261213102659_qa_round2_security_hardening.sql', 'storage rule', 'storage', 'objects', 'An existing profile is required to replace uploads'),
    ('20261213102659_qa_round2_security_hardening.sql', 'trigger', 'public', 'posts', 'guard_cleanup_reference'),
    ('20261213102659_qa_round2_security_hardening.sql', 'trigger', 'public', 'stories', 'guard_cleanup_reference'),
    ('20261213102659_qa_round2_security_hardening.sql', 'trigger', 'public', 'mystery_posts', 'guard_cleanup_reference'),
    ('20261213102659_qa_round2_security_hardening.sql', 'trigger', 'public', 'messages', 'guard_cleanup_reference'),
    ('20261213102659_qa_round2_security_hardening.sql', 'trigger', 'public', 'keeps', 'guard_cleanup_reference'),
    ('20261213102659_qa_round2_security_hardening.sql', 'trigger', 'public', 'group_messages', 'guard_cleanup_reference'),
    ('20261213102659_qa_round2_security_hardening.sql', 'trigger', 'public', 'posts', 'lock_deleted_content_media'),
    ('20261213102659_qa_round2_security_hardening.sql', 'trigger', 'public', 'stories', 'lock_deleted_content_media'),
    ('20261213102659_qa_round2_security_hardening.sql', 'trigger', 'public', 'mystery_posts', 'lock_deleted_content_media'),
    ('20261213102659_qa_round2_security_hardening.sql', 'trigger', 'public', 'messages', 'lock_deleted_content_media'),
    ('20261213102659_qa_round2_security_hardening.sql', 'trigger', 'public', 'keeps', 'lock_deleted_content_media'),
    ('20261213102659_qa_round2_security_hardening.sql', 'trigger', 'public', 'group_messages', 'lock_deleted_content_media'),
    ('20261213200000_qa_review_media_fixes.sql', 'trigger', 'public', 'keeps', 'keeps_files_are_own'),
    ('20261213200000_qa_review_media_fixes.sql', 'table', 'private', null, 'media_deferred_deletions'),
    ('20261213200000_qa_review_media_fixes.sql', 'storage rule', 'storage', 'objects', 'Files waiting for the daily cleanup look deleted'),
    ('20261213200000_qa_review_media_fixes.sql', 'trigger', 'public', 'posts', 'guard_deferred_reference'),
    ('20261213200000_qa_review_media_fixes.sql', 'trigger', 'public', 'stories', 'guard_deferred_reference'),
    ('20261213200000_qa_review_media_fixes.sql', 'trigger', 'public', 'mystery_posts', 'guard_deferred_reference'),
    ('20261213200000_qa_review_media_fixes.sql', 'trigger', 'public', 'messages', 'guard_deferred_reference'),
    ('20261213200000_qa_review_media_fixes.sql', 'trigger', 'public', 'keeps', 'guard_deferred_reference'),
    ('20261213200000_qa_review_media_fixes.sql', 'trigger', 'public', 'group_messages', 'guard_deferred_reference'),
    ('20261213200000_qa_review_media_fixes.sql', 'trigger', 'public', 'reports', 'reports_capture_evidence'),
    ('20261213200000_qa_review_media_fixes.sql', 'trigger', 'public', 'reports', 'reports_release_dismissed_evidence'),
    ('20261213210000_qa_review_robustness_fixes.sql', 'trigger', 'public', 'messages', 'zz_messages_content_rules'),
    ('20261213210000_qa_review_robustness_fixes.sql', 'trigger', 'public', 'group_messages', 'zz_group_messages_content_rules')
  ) as v(migration, kind, sch, tbl, obj)
) x
where x.taken
order by 1, 2, 3;

-- [INFO] Old chat messages that break the new message rules.
-- The hardening migration added rules for chat messages (a voice note needs
-- its recording, a screenshot notice needs its text, sound bars 0-100).
-- Since 20261213210000 these rules are checked by triggers, not by table
-- checks: older messages that break them are kept and keep working (they can
-- still be opened, marked read, replied to and deleted). Only new messages,
-- and changes to one of the checked fields, are checked. Nothing needs to be
-- "validated" later. Listed only so the owner can look at them.
select id, kind
from public.messages
where (kind='voice' and (media_path is null or media_path not like '%/voice/%' or audio_ms is null))
   or (kind='screenshot' and (body is null or body not in ('chat','peek') or media_path is not null))
   or cardinality(waveform)>64
   or exists (select 1 from unnest(waveform) bar where bar is null or bar<0 or bar>100);

-- [INFO] Old group chat messages that break the new group message rules.
-- Same as above for group chats (also: text at most 2,000 letters, a photo,
-- video or proof needs the right media type). Older rows are kept and keep
-- working; only new rows and changes to the checked fields are checked.
select id,kind from public.group_messages
where(kind='voice' and(media_path is null or media_path not like '%/voice/%' or audio_ms is null or audio_ms not between 0 and 120000))
  or char_length(body)>2000
  or cardinality(waveform)>64
  or exists(select 1 from unnest(waveform) bar where bar is null or bar<0 or bar>100)
  or(kind='photo' and(media_type is null or media_type<>'photo'))
  or(kind='video' and(media_type is null or media_type<>'video'))
  or(kind='proof' and(media_type is null or media_type not in('photo','video')));

-- [INFO] Old keeps that point at a file outside their owner's own folder.
-- After 20261213200000 a keep can only use files from your own folder. These
-- older keeps stay, but they no longer stop the other person's file from
-- being deleted (so the saved picture may stop loading once its real owner
-- deletes it). A new or changed keep with such a file is refused.
select k.id, k.user_id, k.media_path, k.poster_path, k.overlay_path
from public.keeps k
where split_part(k.media_path, '/', 1) is distinct from k.user_id::text
   or (k.poster_path is not null and split_part(k.poster_path, '/', 1) is distinct from k.user_id::text)
   or (k.overlay_path is not null and split_part(k.overlay_path, '/', 1) is distinct from k.user_id::text)
order by k.created_at;

-- [INFO] Report evidence that 20261213200000 lets go of once, when it runs.
-- Only matters if the hardening migration (20261213102659) already ran on
-- this database; otherwise there is no evidence yet and this returns no rows.
-- The new rules: a comment report keeps nothing of the post above it, and a
-- dismissed report keeps nothing. These files are then no longer kept for a
-- report; the daily cleanup deletes them later if nothing else needs them.
-- (Written as text inside query_to_xml so it still runs when the evidence
-- table does not exist yet.)
select x.report_id, x.content_type, x.status, x.object_name
from xmltable('/table/row' passing (
  select case when to_regclass('private.report_media_evidence') is not null then query_to_xml($q$
    select r.id as report_id, r.content_type, r.status, e.object_name
      from private.report_media_evidence e join public.reports r on r.id = e.report_id
     where r.content_type = 'comment' or r.status = 'dismissed'
     order by r.created_at, e.object_name
  $q$, true, false, '') end)
  columns report_id text, content_type text, status text, object_name text) as x;

-- [INFO] Old open or reviewed reports made by someone who cannot see that content today.
-- Before the release anyone could report anything, even a post they could
-- not see (for example a stranger reporting a private account's post). After
-- the release an open or reviewed report keeps the files of what it reports,
-- so the daily cleanup does not delete them, even when their owner deletes
-- them. New reports like this are refused; old ones stay and keep their files.
-- This lists those old reports so the owner can look at each one. To let go
-- of the files one report keeps (the report itself stays, and is still listed
-- here), after the release run in the SQL editor:
--   select public.release_report_evidence('<report id>')
-- Best effort: it uses today's friends, close friends and private/public
-- settings, not the ones from the day of the report. So someone who was a
-- friend then but is not now is listed too - check before you let go. Blocks
-- and time limits are left out on purpose (people often block right after
-- reporting, and stories and Guess Who posts run out). Reports about a person,
-- a comment or a dare idea keep no files after the release, and content that
-- is already deleted has nothing to keep, so those are not listed.
-- Save this list from the run BEFORE the release. After the release, a report
-- about content its owner then deletes still keeps its files, but drops out
-- of this list (the list only looks at content that still exists).
select x.id, x.content_type, x.status, x.reporter_id, x.owner_id, x.files
from (
  -- Posts: you see your own; a public account's or a friend's; close-friends
  -- posts only if you are on the poster's close friends list.
  select r.id, r.content_type, r.status, r.reporter_id, r.created_at, p.user_id as owner_id,
         array_remove(array[p.media_path, p.poster_path, p.overlay_path, p.blur_path], null) as files,
         r.reporter_id = p.user_id
           or ((private.are_friends(p.user_id, r.reporter_id)
                or exists (select 1 from public.profiles o where o.id = p.user_id and not o.is_private))
               and (p.audience = 'everyone'
                    or exists (select 1 from public.close_friends f where f.owner = p.user_id and f.friend = r.reporter_id))) as can_see
    from public.reports r join public.posts p on p.id = r.content_id
   where r.content_type = 'post'
  union all
  -- Guess Who posts (reported as posts): friends of the poster.
  select r.id, r.content_type, r.status, r.reporter_id, r.created_at, g.user_id,
         array_remove(array[g.media_path, g.poster_path, g.overlay_path], null),
         r.reporter_id = g.user_id or private.are_friends(g.user_id, r.reporter_id)
    from public.reports r join public.mystery_posts g on g.id = r.content_id
   where r.content_type = 'post'
  union all
  -- Stories: friends only; close-friends stories only for close friends.
  select r.id, r.content_type, r.status, r.reporter_id, r.created_at, s.user_id,
         array_remove(array[s.media_path, s.poster_path, s.overlay_path], null),
         r.reporter_id = s.user_id
           or (private.are_friends(s.user_id, r.reporter_id)
               and (s.audience = 'everyone'
                    or exists (select 1 from public.close_friends f where f.owner = s.user_id and f.friend = r.reporter_id)))
    from public.reports r join public.stories s on s.id = r.content_id
   where r.content_type = 'story'
  union all
  -- Chat messages: only the two people in the chat.
  select r.id, r.content_type, r.status, r.reporter_id, r.created_at, m.sender_id,
         array_remove(array[m.media_path, m.poster_path, m.overlay_path], null),
         r.reporter_id in (m.sender_id, m.recipient_id)
    from public.reports r join public.messages m on m.id = r.content_id
   where r.content_type = 'message'
  union all
  -- Group chat messages: only members of that group.
  select r.id, r.content_type, r.status, r.reporter_id, r.created_at, gm.sender_id,
         array_remove(array[gm.media_path, gm.poster_path, gm.overlay_path], null),
         private.is_group_member(gm.group_id, r.reporter_id)
    from public.reports r join public.group_messages gm on gm.id = r.content_id
   where r.content_type = 'group_message'
) x
where x.status in ('open', 'reviewed') and not coalesce(x.can_see, false) and cardinality(x.files) > 0
order by x.created_at, x.id;

-- [INFO] Old public text the word filter would now refuse (see the note below).
-- OPEN-01 word filter (20261214000000_public_word_filter.sql). Run this one on a
-- disposable copy AFTER that migration is applied (it uses private.blocked_word).
-- It only reads. It lists older rows that the new filter would now refuse, so
-- the owner can review them; nothing is changed, and these rows keep working
-- (only new or changed text is checked). Private chat (1:1 and group, dares
-- included) is never checked, so it is never listed.
select 'profiles' as source, id::text as row_id, 'username' as field, username as value, private.blocked_word(username,'name') as word
  from public.profiles where private.blocked_word(username,'name') is not null
union all
select 'profiles', id::text, 'display_name', display_name, private.blocked_word(display_name,'name')
  from public.profiles where private.blocked_word(display_name,'name') is not null
union all
select 'profiles', id::text, 'bio', bio, private.blocked_word(bio,'content')
  from public.profiles where private.blocked_word(bio,'content') is not null
union all
select 'posts', id::text, 'caption', caption, private.blocked_word(caption,'content')
  from public.posts where private.blocked_word(caption,'content') is not null
union all
select 'mystery_posts', id::text, 'caption', caption, private.blocked_word(caption,'content')
  from public.mystery_posts where private.blocked_word(caption,'content') is not null
union all
select 'comments', id::text, 'body', body, private.blocked_word(body,'content')
  from public.comments where private.blocked_word(body,'content') is not null
union all
select 'hit_ups', id::text, 'message', message, private.blocked_word(message,'content')
  from public.hit_ups where private.blocked_word(message,'content') is not null
union all
select 'dare_ideas', id::text, 'text', text, private.blocked_word(text,'content')
  from public.dare_ideas where private.blocked_word(text,'content') is not null
union all
select 'peek_groups', id::text, 'name', name, private.blocked_word(name,'content')
  from public.peek_groups where private.blocked_word(name,'content') is not null
order by 1, 3, 2;
