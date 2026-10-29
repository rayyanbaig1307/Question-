-- =====================================================================
-- Who Peeked
--
-- On your own Peekaboo drop posts you can see who held to reveal them and who
-- just scrolled past. Nobody else can see this list.
-- * "Seen" = the drop was on their screen (still covered, or they couldn't unlock it).
-- * "Revealed" = they actually saw it (scratched it clear, or opened it full screen).
-- =====================================================================

create table public.drop_views (
  post_id uuid not null references public.posts (id) on delete cascade,
  viewer_id uuid not null references public.profiles (id) on delete cascade,
  revealed boolean not null default false,
  seen_at timestamptz not null default now(),
  revealed_at timestamptz,
  primary key (post_id, viewer_id)
);
alter table public.drop_views enable row level security;

create policy "Only the poster sees who peeked at their drop"
  on public.drop_views for select to authenticated
  using (exists (select 1 from public.posts p where p.id = post_id and p.user_id = (select auth.uid())));
-- (Views are only written through public.mark_drop_seen.)

-- The app calls this when a friend's drop is on your screen (did_reveal = false) and when you see it
-- properly (did_reveal = true). "Revealed" only counts if the drop really was unlocked for you.
create or replace function public.mark_drop_seen(post uuid, did_reveal boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  owner uuid;
  day date;
begin
  select p.user_id, p.drop_day into owner, day from public.posts p where p.id = post;
  if me is null or owner is null or day is null or owner = me or not private.can_see_posts(owner) then
    return;
  end if;
  if did_reveal and (
    not exists (select 1 from public.posts mine where mine.user_id = me and mine.drop_day = day)
    or private.group_holds_drop(me, owner, day)
  ) then
    did_reveal := false;
  end if;
  insert into public.drop_views as v (post_id, viewer_id, revealed, revealed_at)
  values (post, me, did_reveal, case when did_reveal then now() end)
  on conflict (post_id, viewer_id) do update
    set revealed = true, revealed_at = now()
    where excluded.revealed and not v.revealed;
end;
$$;
revoke execute on function public.mark_drop_seen(uuid, boolean) from public, anon;
grant execute on function public.mark_drop_seen(uuid, boolean) to authenticated;

-- Lets the app ask for `peek_stats` along with a post: on your own drops, how many revealed it and how many
-- scrolled past (empty for everyone else's posts).
create or replace function public.peek_stats(post public.posts)
returns jsonb language sql stable set search_path = '' as $$
  select case when post.drop_day is not null and post.user_id = (select auth.uid()) then jsonb_build_object(
    'revealed', (select count(*) from public.drop_views v where v.post_id = post.id and v.revealed),
    'passed', (select count(*) from public.drop_views v where v.post_id = post.id and not v.revealed)
  ) end;
$$;
revoke execute on function public.peek_stats(public.posts) from public, anon;
grant execute on function public.peek_stats(public.posts) to authenticated;
