-- =====================================================================
-- Community dares 💡
--
-- * Anyone can suggest a dare (one a day, 10–120 letters, no dangerous words).
-- * Everyone votes 🔥. Each day, the top idea with at least 3 votes that hasn't run yet becomes that
--   day's dare for everyone, with the creator's name on it. No idea good enough → the built-in list runs.
-- * Report an idea → 3 reports from different people hide it for good.
-- =====================================================================

create table public.dare_ideas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  text text not null check (char_length(text) between 10 and 120),
  votes integer not null default 0,
  hidden boolean not null default false,
  used_on date unique,                                   -- the dare day it ran as everyone's dare
  created_at timestamptz not null default now()
);
alter table public.dare_ideas enable row level security;
create index dare_ideas_top_idx on public.dare_ideas (votes desc, created_at asc) where not hidden and used_on is null;

create table public.dare_votes (
  idea_id uuid not null references public.dare_ideas (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (idea_id, user_id)
);
alter table public.dare_votes enable row level security;

create table public.daily_dares (
  day date primary key,
  idea_id uuid not null unique references public.dare_ideas (id) on delete cascade,
  picked_at timestamptz not null default now()
);
alter table public.daily_dares enable row level security;

-- Words that make a dare unsafe (we keep it silly, never dangerous). Checked on the server, so the app
-- can't be tricked around it.
create or replace function private.safe_dare_text(words text)
returns boolean language sql immutable set search_path = '' as $$
  select words !~* '\m(fire|burn(s|ing|t)?|flame(s)?|lighter|knife|knives|blade|gun(s)?|shoot|stab|kill|suicide|die|dead|blood|bleed|choke|chok(e|ing)|strangle|hang (your|him|her|them)self|cliff|roof(top)?|balcony|railway|train track|highway|motorway|traffic|drunk|alcohol|beer|vodka|wine|whisk(e)?y|shots|drugs?|weed|cocaine|pills?|overdose|vape|vaping|smok(e|ing)|cigarette|naked|nude|nudity|underwear|strip|sex|porn|dick|pussy|boobs|tits|steal|shoplift|vandal|graffiti|punch|kick (a|the)|slap (a|the)|fight|bleach|detergent|tide pod|cinnamon challenge|electric|outlet|socket|drown|hold (your|his|her|their) breath|blackout|pass out|faint)\M'
     and words ~ '[a-zA-Z]{3,}';
$$;

-- Has this person already suggested an idea in the last 24 hours? (A helper, so the insert rule below
-- can look at the table without tripping over its own rules.)
create or replace function private.suggested_dare_recently(person uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.dare_ideas d where d.user_id = person and d.created_at > now() - interval '24 hours'
  );
$$;

-- Everyone can read ideas that aren't hidden (plus your own, hidden or not).
create policy "Ideas are public unless hidden"
  on public.dare_ideas for select to authenticated
  using (not hidden or user_id = (select auth.uid()));
-- One idea a day, safe words only.
create policy "You can suggest a dare"
  on public.dare_ideas for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and private.safe_dare_text(text)
    and not private.suggested_dare_recently((select auth.uid()))
  );
-- You can take back your own idea while it hasn't run yet.
create policy "You can delete your own idea"
  on public.dare_ideas for delete to authenticated
  using (user_id = (select auth.uid()) and used_on is null);

create policy "You can see your own votes"
  on public.dare_votes for select to authenticated
  using (user_id = (select auth.uid()));
create policy "You can vote once per idea"
  on public.dare_votes for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.dare_ideas d where d.id = idea_id and not d.hidden and d.used_on is null)
  );
create policy "You can take your vote back"
  on public.dare_votes for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "Everyone can see which idea ran on which day"
  on public.daily_dares for select to authenticated using (true);

-- Keep the vote count on the idea up to date.
create or replace function private.count_dare_votes()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.dare_ideas d
     set votes = (select count(*) from public.dare_votes v where v.idea_id = d.id)
   where d.id = coalesce(new.idea_id, old.idea_id);
  return null;
end;
$$;
create trigger dare_votes_count
  after insert or delete on public.dare_votes
  for each row execute function private.count_dare_votes();

-- Today's community dare, picked the first time anyone asks after the day starts (10:00 UTC).
-- Returns nothing when no idea has enough votes – then the built-in dare runs. Past days return what ran.
create or replace function public.pick_daily_dare(for_day date)
returns table (day date, idea_id uuid, text text, username text, display_name text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  today date := private.current_dare_day();
  chosen uuid;
begin
  if auth.uid() is null then
    raise exception 'Please log in again';
  end if;
  if for_day > today then
    return;                                           -- no peeking at tomorrow
  end if;
  if for_day = today and not exists (select 1 from public.daily_dares dd where dd.day = today) then
    select d.id into chosen
      from public.dare_ideas d
     where not d.hidden and d.used_on is null and d.votes >= 3
     order by d.votes desc, d.created_at asc
     limit 1;
    if chosen is not null then
      insert into public.daily_dares (day, idea_id) values (today, chosen) on conflict (day) do nothing;
      update public.dare_ideas set used_on = today where id = chosen and used_on is null
         and exists (select 1 from public.daily_dares dd where dd.day = today and dd.idea_id = chosen);
    end if;
  end if;
  return query
    select dd.day, dd.idea_id, d.text, p.username, p.display_name
      from public.daily_dares dd
      join public.dare_ideas d on d.id = dd.idea_id
      join public.profiles p on p.id = d.user_id
     where dd.day = for_day;
end;
$$;
revoke execute on function public.pick_daily_dare(date) from public, anon;
grant execute on function public.pick_daily_dare(date) to authenticated;

-- The community dares that ran recently (so old dare posts show the right words).
create or replace function public.recent_daily_dares(days integer default 30)
returns table (day date, text text, username text, display_name text)
language sql stable security definer set search_path = '' as $$
  select dd.day, d.text, p.username, p.display_name
    from public.daily_dares dd
    join public.dare_ideas d on d.id = dd.idea_id
    join public.profiles p on p.id = d.user_id
   where dd.day >= private.current_dare_day() - greatest(1, least(days, 365))
     and dd.day <= private.current_dare_day()
   order by dd.day;
$$;
revoke execute on function public.recent_daily_dares(integer) from public, anon;
grant execute on function public.recent_daily_dares(integer) to authenticated;

-- Report an idea. Three reports from different people hide it for good.
alter table public.reports drop constraint reports_content_type_check;
alter table public.reports
  add constraint reports_content_type_check
  check (content_type in ('user', 'post', 'story', 'message', 'comment', 'dare_idea'));

create or replace function public.report_dare_idea(idea uuid, reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  owner uuid;
  reporters integer;
begin
  select user_id into owner from public.dare_ideas where id = idea;
  if owner is null then
    raise exception 'That idea is gone';
  end if;
  if owner = me then
    raise exception 'You can delete your own idea instead';
  end if;
  if not exists (select 1 from public.reports r where r.reporter_id = me and r.content_type = 'dare_idea' and r.content_id = idea) then
    insert into public.reports (reporter_id, reported_user_id, content_type, content_id, reason, details)
    values (me, owner, 'dare_idea', idea, left(reason, 100), 'Dare idea');
  end if;
  select count(distinct r.reporter_id) into reporters
    from public.reports r where r.content_type = 'dare_idea' and r.content_id = idea;
  if reporters >= 3 then
    update public.dare_ideas set hidden = true where id = idea;
  end if;
end;
$$;
revoke execute on function public.report_dare_idea(uuid, text) from public, anon;
grant execute on function public.report_dare_idea(uuid, text) to authenticated;
