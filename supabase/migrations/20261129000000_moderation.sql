-- =====================================================================
-- Looking after reports (the owner promises to act within 24 hours).
-- Admins – added only in the database, never from the app – get a Reports screen in Settings:
-- every report with who's involved and what was said, and buttons to remove the content, ban the
-- account (they can't log in any more), dismiss, or mark it reviewed.
-- =====================================================================

create table public.admins (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;
-- You can only see whether you're an admin yourself (that's how the app knows to show the screen).
create policy "You can see if you are an admin"
  on public.admins for select to authenticated
  using (user_id = (select auth.uid()));

create or replace function private.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- Every report (open ones, or all), newest first, with the people involved and the reported text.
create or replace function public.admin_reports(only_open boolean default true)
returns table (
  id uuid, created_at timestamptz, status text, reason text, details text, content_type text, content_id uuid,
  reporter_username text, reported_id uuid, reported_username text, reported_name text, reported_avatar text,
  preview text, content_exists boolean, reported_banned boolean
) language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_admin() then
    raise exception 'Admins only';
  end if;
  return query
  select r.id, r.created_at, r.status, r.reason, r.details, r.content_type, r.content_id,
    rp.username, r.reported_user_id, tp.username, tp.display_name, tp.avatar_path,
    case r.content_type
      when 'post' then coalesce(
        (select nullif(p.caption, '') from public.posts p where p.id = r.content_id),
        (select 'Guess Who: ' || coalesce(nullif(m.caption, ''), '(no caption)') from public.mystery_posts m where m.id = r.content_id))
      when 'story' then (select 'Story from ' || to_char(s.created_at, 'DD Mon') from public.stories s where s.id = r.content_id)
      when 'message' then (select case m.kind when 'text' then m.body else '(' || m.kind || ')' end from public.messages m where m.id = r.content_id)
      when 'comment' then (select c.body from public.comments c where c.id = r.content_id)
      when 'dare_idea' then (select d.text from public.dare_ideas d where d.id = r.content_id)
      else null
    end,
    case r.content_type
      when 'post' then exists (select 1 from public.posts p where p.id = r.content_id) or exists (select 1 from public.mystery_posts m where m.id = r.content_id)
      when 'story' then exists (select 1 from public.stories s where s.id = r.content_id)
      when 'message' then exists (select 1 from public.messages m where m.id = r.content_id)
      when 'comment' then exists (select 1 from public.comments c where c.id = r.content_id)
      when 'dare_idea' then exists (select 1 from public.dare_ideas d where d.id = r.content_id and not d.hidden)
      else false
    end,
    coalesce((select u.banned_until > now() from auth.users u where u.id = r.reported_user_id), false)
  from public.reports r
  left join public.profiles rp on rp.id = r.reporter_id
  left join public.profiles tp on tp.id = r.reported_user_id
  where (not only_open) or r.status = 'open'
  order by r.created_at desc
  limit 200;
end;
$$;
revoke execute on function public.admin_reports(boolean) from public, anon;
grant execute on function public.admin_reports(boolean) to authenticated;

-- What to do about a report: 'dismiss', 'reviewed', 'remove_content', 'ban' or 'unban'.
create or replace function public.admin_review(report uuid, action text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  r public.reports%rowtype;
begin
  if not private.is_admin() then
    raise exception 'Admins only';
  end if;
  select * into r from public.reports where id = report;
  if r.id is null then
    raise exception 'That report is gone';
  end if;
  if action = 'dismiss' then
    update public.reports set status = 'dismissed' where id = r.id;
  elsif action = 'reviewed' then
    update public.reports set status = 'reviewed' where id = r.id;
  elsif action = 'remove_content' then
    -- (Photo and video files stay in storage but nobody else can open them once the row is gone.)
    if r.content_type = 'post' then
      delete from public.posts where id = r.content_id;
      delete from public.mystery_posts where id = r.content_id;
    elsif r.content_type = 'story' then
      delete from public.stories where id = r.content_id;
    elsif r.content_type = 'message' then
      delete from public.messages where id = r.content_id;
    elsif r.content_type = 'comment' then
      delete from public.comments where id = r.content_id;
    elsif r.content_type = 'dare_idea' then
      update public.dare_ideas set hidden = true where id = r.content_id;
    else
      raise exception 'There is no content to remove on this report';
    end if;
    update public.reports set status = 'reviewed' where id = r.id;
  elsif action in ('ban', 'unban') then
    if r.reported_user_id is null then
      raise exception 'This report has no account to ban';
    end if;
    if r.reported_user_id = auth.uid() then
      raise exception 'You cannot ban yourself';
    end if;
    -- Banned = can't log in or stay logged in (Supabase checks banned_until on every token refresh).
    update auth.users set banned_until = case when action = 'ban' then 'infinity'::timestamptz else null end
     where id = r.reported_user_id;
    if action = 'ban' then
      delete from public.push_tokens where user_id = r.reported_user_id;
      update public.reports set status = 'reviewed' where id = r.id;
    end if;
  else
    raise exception 'Unknown action';
  end if;
end;
$$;
revoke execute on function public.admin_review(uuid, text) from public, anon;
grant execute on function public.admin_review(uuid, text) to authenticated;
