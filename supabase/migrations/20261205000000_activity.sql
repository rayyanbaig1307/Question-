-- =====================================================================
-- Activity 🔔: what happened to you in the last 30 days, newest first, shown at the top of Chat.
-- * Someone liked your post, commented on it, replied to your comment, or liked your comment.
-- * Someone added you (public account), accepted your friend request, or hit you back.
-- Nothing new is stored: it's read from the likes, comments, friendships and hit ups that already exist.
-- People you blocked (or who blocked you) never show up. Your own actions never show up.
-- =====================================================================

create or replace function public.my_activity()
returns table (
  kind text,            -- 'like' · 'comment' · 'reply' · 'comment_like' · 'added_you' · 'accepted' · 'hit_back'
  at timestamptz,
  actor_id uuid,
  actor_username text,
  actor_name text,
  actor_avatar text,
  post_id uuid,         -- the post it's about (likes and comments), so the app can open it
  snippet text          -- the start of the comment, for comments and replies
) language sql stable security definer set search_path = '' as $$
  with me as (select auth.uid() as id),
  since as (select now() - interval '30 days' as t),
  events as (
    -- Likes on your posts.
    select 'like'::text as kind, l.created_at as at, l.user_id as actor, p.id as post, null::text as snippet
      from public.likes l join public.posts p on p.id = l.post_id
     where p.user_id = (select id from me) and l.created_at > (select t from since)
    union all
    -- Comments on your posts (top-level ones and replies under them).
    select case when c.parent_id is null then 'comment' else 'reply' end, c.created_at, c.user_id, p.id, left(c.body, 80)
      from public.comments c join public.posts p on p.id = c.post_id
     where p.user_id = (select id from me) and c.created_at > (select t from since)
    union all
    -- Replies to your comments on someone else's post.
    select 'reply', c.created_at, c.user_id, c.post_id, left(c.body, 80)
      from public.comments c
      join public.comments parent on parent.id = c.parent_id
      join public.posts p on p.id = c.post_id
     where parent.user_id = (select id from me) and p.user_id <> (select id from me)
       and c.created_at > (select t from since)
    union all
    -- Likes on your comments.
    select 'comment_like', cl.created_at, cl.user_id, c.post_id, left(c.body, 80)
      from public.comment_likes cl join public.comments c on c.id = cl.comment_id
     where c.user_id = (select id from me) and cl.created_at > (select t from since)
    union all
    -- Friends: they added you (a public account is added straight away), or they accepted your request.
    -- Friendships made by a hit back are left out here (they show as 'hit_back' instead).
    select case when f.requester_id = (select id from me) then 'accepted' else 'added_you' end,
           f.accepted_at,
           case when f.requester_id = (select id from me) then f.addressee_id else f.requester_id end,
           null, null
      from public.friendships f
     where f.status = 'accepted' and f.accepted_at > (select t from since)
       and (
         -- They added you: they sent it and it was accepted straight away (no request for you to answer).
         (f.addressee_id = (select id from me) and f.accepted_at - f.created_at < interval '5 seconds')
         -- They accepted the request you sent.
         or (f.requester_id = (select id from me) and f.accepted_at - f.created_at >= interval '5 seconds')
       )
       and not exists (
         select 1 from public.hit_ups h
          where h.status = 'accepted'
            and ((h.from_user = f.requester_id and h.to_user = f.addressee_id)
              or (h.from_user = f.addressee_id and h.to_user = f.requester_id))
       )
    union all
    -- They hit you back.
    select 'hit_back', h.responded_at, h.to_user, null, null
      from public.hit_ups h
     where h.from_user = (select id from me) and h.status = 'accepted' and h.responded_at > (select t from since)
  )
  select e.kind, e.at, e.actor, pr.username, pr.display_name, pr.avatar_path, e.post, e.snippet
    from events e
    join public.profiles pr on pr.id = e.actor
   where e.actor <> (select id from me)
     and not private.is_blocked((select id from me), e.actor)
   order by e.at desc
   limit 60;
$$;
revoke execute on function public.my_activity() from public, anon;
grant execute on function public.my_activity() to authenticated;
