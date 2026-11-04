// Cleanup: deletes old photo and video files nobody can see any more (expired stories and Guess Who posts,
// opened peeks nobody saved – after 7 days). Which files is decided by the database
// (public.media_cleanup_candidates in supabase/migrations/20261208000000_media_cleanup.sql).
// Started once a day by a pg_cron job that sends the secret "x-cleanup-key" from the Vault.
import { createClient } from 'npm:@supabase/supabase-js@2';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  let removed = 0;
  let found = 0;
  try {
    // Only the daily job (it knows the key) may start a cleanup.
    const { data: ok, error: keyError } = await admin.rpc('media_cleanup_key_ok', { given: req.headers.get('x-cleanup-key') ?? '' });
    if (keyError) throw keyError;
    if (ok !== true) return json({ error: 'Not allowed' }, 401);

    // A claim makes Storage recheck eligibility at deletion, so a new report or shared file wins the race.
    const { data, error } = await admin.rpc('claim_media_cleanup', { max_files: 1000 });
    if (error || !data) throw error ?? new Error('Could not check old files');
    const names = [...new Set((data as { name: string }[]).map((row) => row.name).filter(Boolean))];
    found = names.length;
    for (let i = 0; i < names.length; i += 100) {
      const { data: gone, error: removeError } = await admin.storage.from('media').remove(names.slice(i, i + 100));
      if (removeError) throw removeError;
      removed += gone?.length ?? 0;
    }
    console.log(`Media cleanup: ${removed} of ${found} files removed`);
    return json({ removed, found });
  } catch (error) {
    console.warn('Media cleanup could not finish', error);
    return json({ error: 'Could not finish media cleanup. Please retry.', removed, found }, 503);
  }
});
