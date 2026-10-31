-- =====================================================================
-- Legal acceptance records
--
-- * When someone agrees to the Terms of Service (at sign-up, or when the Terms change) or to the
--   Dare Safety Rules (before their first dare, drop or forfeit), we keep a record: who, which
--   document, which version, and when (the database's clock, not the phone's).
-- * Records can't be edited or deleted by users; they go away only if the account is deleted.
-- =====================================================================

create table public.legal_acceptances (
  user_id uuid not null references public.profiles (id) on delete cascade,
  document text not null check (document in ('terms', 'dare_rules')),
  version text not null check (char_length(version) between 1 and 40),
  accepted_at timestamptz not null default now(),
  primary key (user_id, document, version)
);
alter table public.legal_acceptances enable row level security;

create policy "You can see what you agreed to"
  on public.legal_acceptances for select to authenticated
  using (user_id = (select auth.uid()));
-- (No insert/update/delete rules: records are only written by accept_legal below.)

create or replace function public.accept_legal(doc text, ver text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Please log in again';
  end if;
  insert into public.legal_acceptances (user_id, document, version)
  values (auth.uid(), doc, ver)
  on conflict do nothing;
end;
$$;
revoke execute on function public.accept_legal(text, text) from public, anon;
grant execute on function public.accept_legal(text, text) to authenticated;
