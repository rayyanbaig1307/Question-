-- =====================================================================
-- The Inbox 🔔 updates live while it's open: likes, comments, comment likes and hit ups are now sent to the
-- app the moment they happen (friendships and messages already were). Row level security still decides who
-- receives what: you only hear about rows you're allowed to see.
-- =====================================================================

do $$
declare
  t text;
begin
  foreach t in array array['likes', 'comments', 'comment_likes', 'hit_ups'] loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
