-- =====================================================================
-- Group dares: the group votes "Legit 🔥" or "Cap 🧢" on every proof.
--
-- People can fake a proof, so the group decides:
-- * A new proof does not count yet ("⏳ Legit or cap? Vote!").
-- * Everyone in the group except the person who posted it can vote: Legit 🔥 or Cap 🧢. That includes the
--   person who sent the dare. One vote each; you can change it or take it back.
-- * Votes are anonymous (like "Legit or cap?" on daily dares, 20261122000000_legit_or_cap.sql): everyone sees
--   the totals, you see your own vote, nobody sees who voted what.
-- * A proof COUNTS when it has more Legit votes than Cap votes. No votes or a tie: not decided yet.
--   More Cap votes: it doesn't count. The doer can always post a new proof.
-- * A counting proof keeps the dare streak going between the doer and the person who sent the dare (the
--   streak shown in their one-to-one chat), unless they are the same person.
-- * The doer gets a push the first time someone calls cap, and the first time the group says legit.
--   Never more than one of each per proof.
-- * Proofs posted before this update were accepted under the old rule: they keep counting while nobody has
--   voted on them. Once someone votes, the normal rule applies for good (even if that vote is taken back).
--   Their doers don't get "The group says legit" for them: those proofs already counted.
--
-- Who can vote: a current member of the group, who isn't the poster and has no block with the poster either
-- way. (A block already hides the poster's messages from you, so you can't see the proof to judge it – the
-- same idea as "Only their friends can vote" on daily dares.) A vote only counts while you are in the group:
-- if you leave (or are removed), your votes on that group's proofs go and the totals are counted again.
-- Otherwise someone could bring spare accounts in one at a time, vote Legit and leave again, with nothing to
-- see in the member list.
--
-- How the totals stay live and exact: votes are private, so the totals are kept on the proof's own row
-- (group_messages.proof_legit / proof_cap). Members can already read that row and the app already listens to
-- it live, so everyone sees the totals change. The totals are always counted again from the votes table
-- (never added to), while the proof is locked, so two votes at the same moment can't get lost. App users
-- can't change group messages (there is no rule that lets them), so only this file's functions write them.
--
-- Safe to run again: everything is "if not exists", "or replace" or removed first.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. The totals on each proof, and the "accepted under the old rule" flag
-- ---------------------------------------------------------------------
alter table public.group_messages
  add column if not exists proof_legit integer not null default 0,
  add column if not exists proof_cap integer not null default 0;

-- Which once-only pushes a proof already had ('cap': someone called cap; 'legit': the group said legit).
create table if not exists private.group_proof_alerts (
  proof_id uuid not null references public.group_messages (id) on delete cascade,
  kind text not null check (kind in ('cap', 'legit')),
  sent_at timestamptz not null default now(),
  primary key (proof_id, kind)
);
alter table private.group_proof_alerts enable row level security;
revoke all on table private.group_proof_alerts from public, anon, authenticated;
grant all on table private.group_proof_alerts to service_role;

-- proof_legacy: true only for proofs that were already there when this update went in. It is set here, once,
-- when the column is first made (running this file again changes nothing). The app can never set it: new
-- messages always start with false (step 4), and app users can't change group messages. It goes back to false
-- for good as soon as someone votes on the proof (step 3).
-- Those old proofs already count, so they are marked as having had their "The group says legit" push.
do $$
begin
  if not exists (
    select 1 from pg_attribute
     where attrelid = 'public.group_messages'::regclass and attname = 'proof_legacy' and not attisdropped
  ) then
    alter table public.group_messages add column if not exists proof_legacy boolean not null default false;
    update public.group_messages set proof_legacy = true where kind = 'proof';
    insert into private.group_proof_alerts (proof_id, kind)
    select id, 'legit' from public.group_messages where kind = 'proof'
    on conflict do nothing;
  end if;
end;
$$;

-- For the dare streak and for deleting an account: someone's dares and proofs, quickly.
create index if not exists group_messages_dare_sender_idx on public.group_messages (sender_id) where kind in ('dare', 'proof');

-- Does this proof count? (The app has the same rule: proofOutcome in src/lib/groupChat.ts. Keep them the same;
-- tests/unit/group-proof-parity.test.mjs checks that they agree.)
create or replace function private.group_proof_counts(legit integer, cap integer, legacy boolean)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(legit, 0) > coalesce(cap, 0)
      or (coalesce(legacy, false) and coalesce(legit, 0) = 0 and coalesce(cap, 0) = 0);
$$;

-- ---------------------------------------------------------------------
-- 2. The votes (private: you can only see your own)
-- ---------------------------------------------------------------------
create table if not exists public.group_proof_votes (
  proof_id uuid not null references public.group_messages (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  legit boolean not null,
  created_at timestamptz not null default now(),
  primary key (proof_id, user_id)
);
-- Quick clean-up when an account is deleted.
create index if not exists group_proof_votes_user_idx on public.group_proof_votes (user_id);
alter table public.group_proof_votes enable row level security;

drop policy if exists "You can see your own group proof votes" on public.group_proof_votes;
create policy "You can see your own group proof votes"
  on public.group_proof_votes for select to authenticated
  using (user_id = (select auth.uid()));
-- (No rules for adding, changing or removing votes: only vote_group_proof below writes them. The table rights
-- are taken away too, as a second lock.)
revoke all on table public.group_proof_votes from anon;
revoke insert, update, delete, truncate, references, trigger on table public.group_proof_votes from authenticated;

-- ---------------------------------------------------------------------
-- 3. Count a proof's votes again (whenever a vote is added, changed or removed)
-- ---------------------------------------------------------------------
create or replace function private.recount_group_proof(proof uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  legit_votes integer;
  cap_votes integer;
begin
  -- Wait for anyone else who is changing this proof's votes, so the count below includes theirs.
  perform 1 from public.group_messages g where g.id = proof and g.kind = 'proof' for no key update;
  if not found then
    return;   -- the proof is gone (or being deleted): nothing to count
  end if;
  select count(*) filter (where v.legit), count(*) filter (where not v.legit) into legit_votes, cap_votes
    from public.group_proof_votes v where v.proof_id = proof;
  -- An old proof (from before this update) that now has a vote follows the normal rule from now on.
  update public.group_messages g
     set proof_legit = legit_votes, proof_cap = cap_votes,
         proof_legacy = g.proof_legacy and legit_votes + cap_votes = 0
   where g.id = proof
     and (g.proof_legit, g.proof_cap, g.proof_legacy)
         is distinct from (legit_votes, cap_votes, g.proof_legacy and legit_votes + cap_votes = 0);
end;
$$;

-- This also keeps the totals right when votes disappear without anyone voting: someone who leaves the group,
-- or a deleted account, takes their votes with them, and the proofs they voted on are counted again.
create or replace function private.recount_group_proof_votes()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform private.recount_group_proof(old.proof_id);
  end if;
  if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.proof_id is distinct from old.proof_id) then
    perform private.recount_group_proof(new.proof_id);
  end if;
  return null;
end;
$$;
drop trigger if exists group_proof_votes_recount on public.group_proof_votes;
create trigger group_proof_votes_recount after insert or update or delete on public.group_proof_votes
  for each row execute function private.recount_group_proof_votes();

-- ---------------------------------------------------------------------
-- 4. A new message never arrives with votes, or as an old proof
-- ---------------------------------------------------------------------
-- Same as 20261213102659 (the server sets the time), plus the vote totals. This runs before the content rules
-- (zz_group_messages_content_rules stays last).
create or replace function private.prepare_group_message()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.created_at := now();
  new.proof_legit := 0;
  new.proof_cap := 0;
  new.proof_legacy := false;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Vote: legit = true (🔥), false (🧢), or null to take your vote back
-- ---------------------------------------------------------------------
-- expected_user_id: the account the app had on screen when you tapped (like block_user), so a vote never lands
-- on a different account after a log-in change. Returns the new totals, your vote and whether it still counts
-- as an old proof (from before this update).
create or replace function public.vote_group_proof(proof uuid, legit boolean, expected_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  p public.group_messages%rowtype;
  legit_votes integer;
  cap_votes integer;
  old_proof boolean;
  doer_listens boolean;
  group_name text;
  dare_text text;
begin
  if me is null then
    raise exception 'Please log in again';
  end if;
  if expected_user_id is null or me is distinct from expected_user_id then
    raise exception 'Your login has changed - please try again';
  end if;
  select * into p from public.group_messages g where g.id = proof;
  if p.id is null then
    raise exception 'This proof is gone';
  end if;
  if not private.is_group_member(p.group_id, me) then
    raise exception 'Only people in this group can vote';
  end if;
  -- A block (either way) hides the poster's messages from you, so the proof is "gone" for you.
  if private.is_blocked(p.sender_id, me) then
    raise exception 'This proof is gone';
  end if;
  if p.kind <> 'proof' then
    raise exception 'You can only vote on proof for a group dare';
  end if;
  if p.sender_id = me then
    raise exception 'You can''t vote on your own proof';
  end if;

  -- Your account, then your place in the group, then the proof: the same order as deleting an account and as
  -- leaving the group (both take your votes away), so a vote and one of those can't wait for each other
  -- forever. Holding your place in the group also means you can't leave halfway through a vote: leaving waits
  -- for the vote, and then takes it away again.
  perform 1 from public.profiles pr where pr.id = me for key share;
  if not found then
    raise exception 'Please log in again';
  end if;
  perform 1 from public.peek_group_members m where m.group_id = p.group_id and m.user_id = me for key share;
  if not found then
    raise exception 'Only people in this group can vote';
  end if;
  -- Votes on one proof take turns from here on (see recount_group_proof).
  perform 1 from public.group_messages g where g.id = p.id for no key update;
  if not found then
    raise exception 'This proof is gone';
  end if;

  if legit is null then
    delete from public.group_proof_votes v where v.proof_id = p.id and v.user_id = me;
  else
    insert into public.group_proof_votes as v (proof_id, user_id, legit)
    values (p.id, me, legit)
    on conflict (proof_id, user_id) do update set legit = excluded.legit, created_at = now()
      where v.legit is distinct from excluded.legit;
  end if;
  -- (The trigger above has counted the votes again.)
  select g.proof_legit, g.proof_cap, g.proof_legacy into legit_votes, cap_votes, old_proof
    from public.group_messages g where g.id = p.id;

  -- Once-only pushes for the person who posted the proof (only while they're in the group and haven't muted it).
  doer_listens := exists (
    select 1 from public.peek_group_members m
     where m.group_id = p.group_id and m.user_id = p.sender_id and not m.chat_muted
  );
  select g.name into group_name from public.peek_groups g where g.id = p.group_id;
  if legit is false then
    insert into private.group_proof_alerts (proof_id, kind) values (p.id, 'cap') on conflict do nothing;
    if found and doer_listens then
      perform private.send_push(p.sender_id, 'messages', 'Someone called cap on your proof 🧢',
        '👯 ' || coalesce(group_name, 'Your group') || ' is voting: legit or cap? Go and defend yourself 👀',
        jsonb_build_object('type', 'group_chat', 'group', p.group_id));
    end if;
  end if;
  if legit_votes > cap_votes then
    insert into private.group_proof_alerts (proof_id, kind) values (p.id, 'legit') on conflict do nothing;
    if found and doer_listens then
      -- (Not the dare's words if the doer and the dare's sender have a block: the doer can't see that dare now.)
      select d.body into dare_text from public.group_messages d
       where d.id = p.dare_id and not private.is_blocked(d.sender_id, p.sender_id);
      perform private.send_push(p.sender_id, 'messages', 'The group says legit 🔥',
        '👯 ' || coalesce(group_name, 'Your group') || ': your proof for "' || left(coalesce(dare_text, 'the dare'), 60)
          || '" counts ✅',
        jsonb_build_object('type', 'group_chat', 'group', p.group_id));
    end if;
  end if;

  return jsonb_build_object('legit', legit_votes, 'cap', cap_votes, 'mine', legit, 'legacy', old_proof);
end;
$$;
revoke execute on function public.vote_group_proof(uuid, boolean, uuid) from public, anon;
grant execute on function public.vote_group_proof(uuid, boolean, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 6. Leaving the group takes your votes with you
-- ---------------------------------------------------------------------
-- A vote only counts while the voter is in the group. When someone leaves or is removed, their votes on that
-- group's proofs go, and the trigger in step 3 counts the totals again (everyone sees them change live).
create or replace function private.drop_votes_of_leaver()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- The whole group is being deleted: its proofs and their votes go with it anyway.
  if not exists (select 1 from public.peek_groups g where g.id = old.group_id) then
    return null;
  end if;
  -- The proofs first, in id order, then the votes (the same order as voting and as deleting an account).
  perform 1 from public.group_messages g
   where g.group_id = old.group_id and g.kind = 'proof'
     and exists (select 1 from public.group_proof_votes v where v.proof_id = g.id and v.user_id = old.user_id)
   order by g.id
     for no key update;
  delete from public.group_proof_votes v using public.group_messages g
   where g.id = v.proof_id and g.group_id = old.group_id and v.user_id = old.user_id;
  return null;
end;
$$;
drop trigger if exists group_proof_votes_leaver on public.peek_group_members;
create trigger group_proof_votes_leaver after delete on public.peek_group_members
  for each row execute function private.drop_votes_of_leaver();

-- ---------------------------------------------------------------------
-- 7. Deleting an account: take its group places and proofs in a fixed order first
-- ---------------------------------------------------------------------
-- Deleting an account removes its group places, its votes, its proofs and the proofs for its dares, and the
-- totals are counted again. Each of those steps locks proofs. Taking them all here first – the account's
-- places in groups, then the proofs in id order – is the same order as voting and leaving a group. So a
-- deletion and someone voting, leaving, deleting a proof or deleting their own account at the same moment take
-- turns instead of waiting for each other forever. (A dare with several proofs, deleted at that very moment,
-- can still clash once; trying again works.)
create or replace function private.lock_group_proofs_of_account()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  r record;
begin
  perform 1 from public.peek_group_members m where m.user_id = old.id order by m.group_id for update;
  for r in
    select x.id, bool_or(x.goes) as goes from (
      -- Their proofs, and everyone's proofs for their dares: these are deleted.
      select g.id, true as goes from public.group_messages g where g.kind = 'proof' and g.sender_id = old.id
      union all
      select g.id, true from public.group_messages d
        join public.group_messages g on g.dare_id = d.id and g.kind = 'proof'
       where d.kind = 'dare' and d.sender_id = old.id
      union all
      -- Proofs they voted on: these are counted again.
      select v.proof_id, false from public.group_proof_votes v where v.user_id = old.id
    ) x
    group by x.id
    order by x.id
  loop
    if r.goes then
      perform 1 from public.group_messages g where g.id = r.id for update;
    else
      perform 1 from public.group_messages g where g.id = r.id for no key update;
    end if;
  end loop;
  return old;
end;
$$;
drop trigger if exists group_proofs_lock_before_delete on public.profiles;
create trigger group_proofs_lock_before_delete before delete on public.profiles
  for each row execute function private.lock_group_proofs_of_account();

-- ---------------------------------------------------------------------
-- 8. The dare streak also counts group dares
-- ---------------------------------------------------------------------
-- Same as 20261206000000 (one-to-one chat dares confirmed ✅, no gap longer than 3 days), plus group dares that
-- one of the two sent and the other did, with a proof that counts right now. Its time is when the proof was
-- posted. Several counting proofs for one dare count once (the first one). Your own dare never counts.
-- When the votes change and a proof stops counting, it stops counting here too.
create or replace function private.dare_streak(a uuid, b uuid)
returns int language plpgsql stable security definer set search_path = '' as $$
declare
  streak int := 0;
  previous timestamptz := now();
  d record;
begin
  for d in
    select m.dare_done_at as at from public.messages m
     where m.kind = 'dare' and m.dare_state = 'done'
       and ((m.sender_id = a and m.recipient_id = b) or (m.sender_id = b and m.recipient_id = a))
    union all
    select min(pr.created_at) as at from public.group_messages pr
      join public.group_messages dr on dr.id = pr.dare_id and dr.kind = 'dare'
     where pr.kind = 'proof' and pr.sender_id in (a, b) and dr.sender_id in (a, b) and pr.sender_id <> dr.sender_id
       and private.group_proof_counts(pr.proof_legit, pr.proof_cap, pr.proof_legacy)
     group by pr.dare_id, pr.sender_id
    order by at desc
  loop
    exit when previous - d.at > interval '3 days';
    streak := streak + 1;
    previous := d.at;
  end loop;
  return streak;
end;
$$;

-- ---------------------------------------------------------------------
-- 9. A proof's push and Chat list line no longer say the dare is done
-- ---------------------------------------------------------------------
-- Same as 20261211000000, except for 'proof'.
create or replace function private.group_message_preview(kind text, body text)
returns text language sql immutable set search_path = '' as $$
  select case kind
    when 'photo' then '📷 Photo'
    when 'video' then '🎬 Video'
    when 'voice' then '🎤 Voice note'
    when 'dare' then '🎯 Dared the group: ' || left(body, 100)
    when 'proof' then '📸 Posted proof – legit or cap?'
    else left(body, 120)
  end;
$$;

-- ---------------------------------------------------------------------
-- 10. App users never call these helpers themselves (the functions above still use them)
-- ---------------------------------------------------------------------
revoke execute on function private.group_proof_counts(integer, integer, boolean) from public, anon, authenticated;
revoke execute on function private.recount_group_proof(uuid) from public, anon, authenticated;
revoke execute on function private.recount_group_proof_votes() from public, anon, authenticated;
revoke execute on function private.drop_votes_of_leaver() from public, anon, authenticated;
revoke execute on function private.lock_group_proofs_of_account() from public, anon, authenticated;

commit;
