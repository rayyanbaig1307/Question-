-- =====================================================================
-- "Legit or cap?" 🔥 / 🧢
--
-- * On a dare post (or a forfeit post), friends vote: 🔥 legit (they really did it) or 🧢 cap (fake).
-- * One vote each, changeable, and anonymous: only the totals are shown, never who voted what.
-- * You can't vote on your own post. Only the poster's friends can vote.
-- * The first 🧢 on a post sends the poster a push: "Someone called cap on your dare 🧢".
-- =====================================================================

create table public.dare_verdicts (
  post_id uuid not null references public.posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  legit boolean not null,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
alter table public.dare_verdicts enable row level security;
create index dare_verdicts_post_idx on public.dare_verdicts (post_id);

create policy "You can see your own votes"
  on public.dare_verdicts for select to authenticated
  using (user_id = (select auth.uid()));
-- (Votes are written only through vote_dare below, which does the checks.)

-- Vote 🔥 (legit = true) or 🧢 (legit = false), or take your vote back (legit = null).
create or replace function public.vote_dare(post uuid, legit boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  p public.posts%rowtype;
  first_cap boolean;
begin
  if me is null then
    raise exception 'Please log in again';
  end if;
  select * into p from public.posts where id = post;
  if p.id is null or not private.can_see_post(p.id) then
    raise exception 'This post is gone';
  end if;
  if p.dare_day is null and p.forfeit_id is null then
    raise exception 'You can only vote on dares';
  end if;
  if p.user_id = me then
    raise exception 'You can''t vote on your own dare';
  end if;
  if not private.are_friends(me, p.user_id) or private.is_blocked(me, p.user_id) then
    raise exception 'Only their friends can vote';
  end if;

  if legit is null then
    delete from public.dare_verdicts v where v.post_id = p.id and v.user_id = me;
    return;
  end if;

  first_cap := not legit and not exists (select 1 from public.dare_verdicts v where v.post_id = p.id and not v.legit);
  insert into public.dare_verdicts (post_id, user_id, legit)
  values (p.id, me, legit)
  on conflict (post_id, user_id) do update set legit = excluded.legit, created_at = now();

  if first_cap then
    perform private.send_push(
      p.user_id, 'likes',
      'Someone called cap on your dare 🧢',
      'Your friends are voting: legit or cap? Go and defend yourself 👀',
      jsonb_build_object('type', 'post', 'post', p.id)
    );
  end if;
end;
$$;
revoke execute on function public.vote_dare(uuid, boolean) from public, anon;
grant execute on function public.vote_dare(uuid, boolean) to authenticated;

-- Asked for along with a post (like group_hold and peek_stats): the totals and your own vote,
-- only for dare and forfeit posts.
create or replace function public.dare_verdict(post public.posts)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when (post.dare_day is not null or post.forfeit_id is not null) and private.can_see_post(post.id)
    then jsonb_build_object(
      'legit', (select count(*) from public.dare_verdicts v where v.post_id = post.id and v.legit),
      'cap', (select count(*) from public.dare_verdicts v where v.post_id = post.id and not v.legit),
      'mine', (select v.legit from public.dare_verdicts v where v.post_id = post.id and v.user_id = auth.uid())
    )
  end;
$$;
revoke execute on function public.dare_verdict(public.posts) from public, anon;
grant execute on function public.dare_verdict(public.posts) to authenticated;
