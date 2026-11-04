-- Read-only checks to run on a DISPOSABLE TEST DATABASE before applying the
-- hardening migration. Do not use a production connection for the QA suite.
-- All result sets should be empty before a later, separately reviewed release.

-- Existing duplicates would stop the new unique index. Review them manually;
-- the migration deliberately never deletes or rewrites these posts.
select forfeit_id, count(*) as payments, array_agg(id order by created_at) as post_ids
from public.posts
where forfeit_id is not null
group by forfeit_id
having count(*)>1;

-- Existing malformed messages are preserved. The NOT VALID constraints reject
-- new invalid rows; validate them after any older rows have been reviewed.
select id, kind
from public.messages
where (kind='voice' and (media_path is null or media_path not like '%/voice/%' or audio_ms is null))
   or (kind='screenshot' and (body is null or body not in ('chat','peek') or media_path is not null))
   or cardinality(waveform)>64
   or exists (select 1 from unnest(waveform) bar where bar is null or bar<0 or bar>100);

-- Newly added group content guards also preserve older rows for review.
select id,kind from public.group_messages
where(kind='voice' and(media_path is null or media_path not like '%/voice/%' or audio_ms is null or audio_ms not between 0 and 120000))
  or char_length(body)>2000
  or cardinality(waveform)>64
  or exists(select 1 from unnest(waveform) bar where bar is null or bar<0 or bar>100)
  or(kind='photo' and(media_type is null or media_type<>'photo'))
  or(kind='video' and(media_type is null or media_type<>'video'))
  or(kind='proof' and(media_type is null or media_type not in('photo','video')));
