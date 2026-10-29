-- =====================================================================
-- Profile song
--
-- Pick a song for your profile. Only the song's details are saved – its name, artist,
-- cover art link, Apple's free 30-second preview link and the link to the full song on
-- Apple Music. No music files are ever uploaded or stored.
-- The links must point to Apple, so nobody can put a strange link on their profile.
-- =====================================================================

alter table public.profiles
  add column if not exists song_title text check (char_length(song_title) <= 200),
  add column if not exists song_artist text check (char_length(song_artist) <= 200),
  add column if not exists song_artwork_url text
    check (song_artwork_url ~ '^https://[a-z0-9.-]+\.mzstatic\.com/'),
  add column if not exists song_preview_url text
    check (song_preview_url ~ '^https://[a-z0-9.-]+\.(apple|mzstatic)\.com/'),
  add column if not exists song_link_url text
    check (song_link_url ~ '^https://(music|itunes|geo\.music)\.apple\.com/');
