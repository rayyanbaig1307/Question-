-- =====================================================================
-- Main Character Mode 🌆: the pictures for the comic-poster camera (the owner, 22 Nov 2026)
--
-- The app comes with its own characters and scenes. This adds a place for NEW ones, so they show up in the app
-- by themselves, with no app update.
--
-- The owner uploads them in the Supabase dashboard (Storage → main-character), always the two small files that
-- Claude's `online` step makes (docs/MAIN_CHARACTER.md):
--   characters/<name>.webp  – a character with a see-through hole where the face goes
--   characters/<name>.json  – where the face goes in it
--   backgrounds/<name>.webp – a scene to stand in front of (.png or .jpg work too)
-- The app lists these folders, downloads a few new pictures at a time, checks them and uses the file name as
-- the name ("street-boss.webp" → "Street Boss"). Anyone logged in can see and list them (they are public
-- pictures, like avatars). Nobody can upload, change or delete them from the app – only the owner, in the
-- dashboard. Files over 1.5 MB are refused.
--
-- No new tables and no new functions. Without this update the app simply shows the pictures it comes with.
-- The app's side: src/lib/mainCharacter/library.ts. Safe to run more than once.
-- =====================================================================
begin;
set local lock_timeout = '15s';

-- The folder for the pictures: public (like avatars), at most 1.5 MB a file, pictures and the small .json only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('main-character', 'main-character', true, 1572864,
        array['image/webp', 'image/png', 'image/jpeg', 'application/json'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Anyone logged in can see and list them. There are no upload, change or delete rules for this folder on
-- purpose: without a rule, the app can't do any of those (the owner uses the dashboard, which is allowed).
drop policy if exists "Anyone logged in can see the Main Character art" on storage.objects;
create policy "Anyone logged in can see the Main Character art" on storage.objects
  for select to authenticated using (bucket_id = 'main-character');

commit;
