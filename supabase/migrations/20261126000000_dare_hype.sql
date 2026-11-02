-- =====================================================================
-- Hype rating on dares: 🔥 Iconic · 😬 Mid · 💀 Unhinged
--
-- Replaces "Legit or cap?" in the app (the video already shows whether they did it,
-- so friends now rate how bold the dare was instead).
-- * On a dare post (or a forfeit post), friends pick one rating. One each, changeable, anonymous:
--   only the totals are shown, never who picked what.
-- * You can't rate your own post. Only the poster's friends can rate.
-- * The first rating on a post sends the poster a push.
-- The old dare_verdicts table and its functions stay, so older copies of the app keep working.
-- =====================================================================

create table public.dare_hype_votes (
  post_id uuid not null references public.posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  rating text not null check (rating in ('iconic', 'mid', 'unhinged')),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
alter table public.dare_hype_votes enable row level security;
create index dare_hype_votes_post_idx on public.dare_hype_votes (post_id);

create policy "You can see your own hype ratings"
  on public.dare_hype_votes for select to authenticated
  using (user_id = (select auth.uid()));
-- (Ratings are written only through rate_dare below, which does the checks.)

-- Rate a dare 'iconic' / 'mid' / 'unhinged', or take your rating back (rating = null).
create or replace function public.rate_dare(post uuid, rating text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  p public.posts%rowtype;
  first_rating boolean;
begin
  if me is null then
    raise exception 'Please log in again';
  end if;
  select * into p from public.posts where id = post;
  if p.id is null or not private.can_see_post(p.id) then
    raise exception 'This post is gone';
  end if;
  if p.dare_day is null and p.forfeit_id is null then
    raise exception 'You can only rate dares';
  end if;
  if p.user_id = me then
    raise exception 'You can''t rate your own dare';
  end if;
  if not private.are_friends(me, p.user_id) or private.is_blocked(me, p.user_id) then
    raise exception 'Only their friends can rate';
  end if;

  if rating is null then
    delete from public.dare_hype_votes h where h.post_id = p.id and h.user_id = me;
    return;
  end if;
  if rating not in ('iconic', 'mid', 'unhinged') then
    raise exception 'Pick 🔥, 😬 or 💀';
  end if;

  first_rating := not exists (select 1 from public.dare_hype_votes h where h.post_id = p.id);
  insert into public.dare_hype_votes (post_id, user_id, rating)
  values (p.id, me, rating)
  on conflict (post_id, user_id) do update set rating = excluded.rating, created_at = now();

  if first_rating then
    perform private.send_push(
      p.user_id, 'likes',
      'Your friends are rating your dare 👀',
      'Iconic, mid or unhinged? Go and see.',
      jsonb_build_object('type', 'post', 'post', p.id)
    );
  end if;
end;
$$;
revoke execute on function public.rate_dare(uuid, text) from public, anon;
grant execute on function public.rate_dare(uuid, text) to authenticated;

-- Asked for along with a post (like dare_verdict): the totals and your own rating,
-- only for dare and forfeit posts.
create or replace function public.dare_hype(post public.posts)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when (post.dare_day is not null or post.forfeit_id is not null) and private.can_see_post(post.id)
    then jsonb_build_object(
      'iconic', (select count(*) from public.dare_hype_votes h where h.post_id = post.id and h.rating = 'iconic'),
      'mid', (select count(*) from public.dare_hype_votes h where h.post_id = post.id and h.rating = 'mid'),
      'unhinged', (select count(*) from public.dare_hype_votes h where h.post_id = post.id and h.rating = 'unhinged'),
      'mine', (select h.rating from public.dare_hype_votes h where h.post_id = post.id and h.user_id = auth.uid())
    )
  end;
$$;
revoke execute on function public.dare_hype(public.posts) from public, anon;
grant execute on function public.dare_hype(public.posts) to authenticated;
