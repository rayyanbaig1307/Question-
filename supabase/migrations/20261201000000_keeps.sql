-- =====================================================================
-- Keeps 📦 – photos and videos you saved from the editor, kept just for you (like a private camera roll in
-- Peekaboo). Files live under {you}/keeps/… – only you can read them (see private.can_read_media: own folder).
-- =====================================================================

create table public.keeps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  media_path text not null,
  media_type text not null check (media_type in ('photo', 'video')),
  poster_path text,
  overlay_path text,
  created_at timestamptz not null default now()
);
alter table public.keeps enable row level security;
create index keeps_user_idx on public.keeps (user_id, created_at desc);
create policy "Your keeps are yours alone"
  on public.keeps for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and split_part(media_path, '/', 1) = (select auth.uid())::text);

-- Keeps files go to your own "keeps" folder.
alter policy "You can upload your own photos" on storage.objects
  with check (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (storage.foldername(name))[2] in ('posts', 'stories', 'snaps', 'blurs', 'voice', 'keeps')
  );
