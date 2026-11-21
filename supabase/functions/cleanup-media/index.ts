// Cleanup: deletes old photo and video files nobody can see any more (expired stories and Guess Who posts,
// opened peeks nobody saved – after 7 days). Which files is decided by the database
// (public.media_cleanup_candidates in supabase/migrations/20261208000000_media_cleanup.sql).
// It also deletes old group pictures (a deleted group's picture, or one that was changed) from the "avatars"
// storage – the database keeps that list (public.claim_avatar_cleanup in 20261229000000_group_snaps.sql).
// Started once a day by a pg_cron job that sends the secret "x-cleanup-key" from the Vault.
import { createClient } from 'npm:@supabase/supabase-js@2';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// The database doesn't have this function yet (this cleanup was updated before the database).
const functionMissing = (error: { code?: string | null }) => error.code === 'PGRST202' || error.code === '42883';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  let removed = 0;
  let found = 0;
  let pictures = 0;
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

    // Old group pictures. The list only has pictures nothing uses any more; a picture deleted here drops off the
    // list on the next run.
    const { data: old, error: oldError } = await admin.rpc('claim_avatar_cleanup', { max_files: 1000 });
    if (oldError && !functionMissing(oldError)) throw oldError;
    const pictureNames = [...new Set(((old ?? []) as { name: string }[]).map((row) => row.name).filter(Boolean))];
    for (let i = 0; i < pictureNames.length; i += 100) {
      const { data: gone, error: removeError } = await admin.storage.from('avatars').remove(pictureNames.slice(i, i + 100));
      if (removeError) throw removeError;
      pictures += gone?.length ?? 0;
    }
    console.log(`Media cleanup: ${removed} of ${found} files removed, ${pictures} old group pictures removed`);
    return json({ removed, found, pictures });
  } catch (error) {
    console.warn('Media cleanup could not finish', error);
    return json({ error: 'Could not finish media cleanup. Please retry.', removed, found, pictures }, 503);
  }
});
