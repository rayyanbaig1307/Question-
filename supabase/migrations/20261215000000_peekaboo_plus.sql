-- =====================================================================
-- Peekaboo+ ⭐ ($6.99 a month, sold through the App Store, tracked by RevenueCat).
--
-- * public.plus_members: who has Peekaboo+ and until when. Only the server writes it – the
--   revenuecat-webhook Edge Function, when RevenueCat says someone bought, renewed or stopped. Nobody can
--   give themselves Peekaboo+ from the app.
-- * Everyone can read it, so the ⭐ badge shows next to Plus members' names.
-- * public.is_plus(person) / private.is_plus(person): true while their Plus hasn't run out. Features check this
--   on the server, so they can't be unlocked by changing the app.
-- =====================================================================

create table if not exists public.plus_members (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  -- Plus works until this moment (RevenueCat's expiry time; renewals push it forward).
  expires_at timestamptz not null,
  product_id text,
  updated_at timestamptz not null default now()
);
alter table public.plus_members enable row level security;

drop policy if exists "Anyone logged in can see who has Plus" on public.plus_members;
create policy "Anyone logged in can see who has Plus"
  on public.plus_members for select to authenticated
  using (true);
-- (No insert/update/delete policies: only the server, with the service role, changes this table.)

create or replace function private.is_plus(person uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.plus_members m where m.user_id = person and m.expires_at > now()
  );
$$;
-- Only other database functions use this one.
revoke all on function private.is_plus(uuid) from public, anon, authenticated;

create or replace function public.is_plus(person uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_plus(person);
$$;
revoke execute on function public.is_plus(uuid) from public, anon;
grant execute on function public.is_plus(uuid) to authenticated;

-- A log of what RevenueCat told us (handy when someone says "I paid but don't have Plus").
create table if not exists private.plus_events (
  id bigserial primary key,
  received_at timestamptz not null default now(),
  event_id text unique,
  event_type text,
  app_user_id text,
  body jsonb
);
