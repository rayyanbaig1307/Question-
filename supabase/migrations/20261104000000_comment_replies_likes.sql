-- =====================================================================
-- Comments: replies (one level deep) and likes on comments.
-- =====================================================================

-- A reply points at the comment it answers. Replies to replies are attached to the
-- top comment instead, so there's only ever one level.
alter table public.comments
  add column if not exists parent_id uuid references public.comments (id) on delete cascade;
create index if not exists comments_parent_idx on public.comments (parent_id);

create or replace function private.check_comment_reply()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  parent_post uuid;
  grandparent uuid;
begin
  if new.parent_id is null then
    return new;
  end if;
  select post_id, parent_id into parent_post, grandparent from public.comments where id = new.parent_id;
  if parent_post is distinct from new.post_id then
    raise exception 'You can only reply to a comment on the same post';
  end if;
  if grandparent is not null then
    new.parent_id := grandparent;                 -- keep it one level deep
  end if;
  return new;
end;
$$;
create trigger comments_check_reply before insert on public.comments
  for each row execute function private.check_comment_reply();

-- Which post a comment belongs to.
create or replace function private.comment_post(target_comment uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select post_id from public.comments where id = target_comment;
$$;

create table public.comment_likes (
  comment_id uuid not null references public.comments (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);
create index comment_likes_user_idx on public.comment_likes (user_id);
alter table public.comment_likes enable row level security;

create policy "Comment likes are visible on posts you can see"
  on public.comment_likes for select to authenticated
  using (private.can_see_post(private.comment_post(comment_id)));
create policy "You can like comments on posts you can see"
  on public.comment_likes for insert to authenticated
  with check (user_id = (select auth.uid()) and private.can_see_post(private.comment_post(comment_id)));
create policy "You can unlike a comment"
  on public.comment_likes for delete to authenticated
  using (user_id = (select auth.uid()));

-- Notifications: a reply tells the person you replied to (and the post owner, as before).
create or replace function private.push_comment()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  owner uuid;
  replied_to uuid;
begin
  select user_id into owner from public.posts where id = new.post_id;
  if new.parent_id is not null then
    select user_id into replied_to from public.comments where id = new.parent_id;
    if replied_to is distinct from new.user_id then
      perform private.send_push(replied_to, 'comments', private.push_name(new.user_id),
        'Replied: ' || left(new.body, 120), jsonb_build_object('type', 'comments', 'post', new.post_id));
    end if;
  end if;
  if owner is distinct from new.user_id and owner is distinct from replied_to then
    perform private.send_push(owner, 'comments', private.push_name(new.user_id),
      'Commented: ' || left(new.body, 120), jsonb_build_object('type', 'comments', 'post', new.post_id));
  end if;
  return new;
end;
$$;

-- Someone liked your comment.
create or replace function private.push_comment_like()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  author uuid;
  post uuid;
begin
  select user_id, post_id into author, post from public.comments where id = new.comment_id;
  if author is distinct from new.user_id then
    perform private.send_push(author, 'likes', private.push_name(new.user_id), 'Liked your comment ❤️',
      jsonb_build_object('type', 'comments', 'post', post));
  end if;
  return new;
end;
$$;
create trigger comment_likes_push after insert on public.comment_likes
  for each row execute function private.push_comment_like();
