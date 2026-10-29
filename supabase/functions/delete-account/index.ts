// Delete account: permanently deletes the person calling it – their photo files, then their login.
// Deleting the login also removes their profile, posts, stories, chats, friends, likes and comments
// (the database's "on delete cascade" links do that part).
import { createClient } from 'npm:@supabase/supabase-js@2';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Every file in a folder (and its sub-folders) of a storage bucket.
async function listAll(bucket: string, prefix: string): Promise<string[]> {
  const { data, error } = await admin.storage.from(bucket).list(prefix, { limit: 1000 });
  if (error || !data) return [];
  const paths: string[] = [];
  for (const item of data) {
    const path = `${prefix}/${item.name}`;
    if (item.id) paths.push(path);
    else paths.push(...(await listAll(bucket, path))); // a sub-folder
  }
  return paths;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);

  // Who is asking? Only ever delete the logged-in person themselves.
  const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Not logged in' }, 401);
  const { data: who, error: whoError } = await admin.auth.getUser(token);
  if (whoError || !who.user) return json({ error: 'Not logged in' }, 401);
  const userId = who.user.id;

  // 1. Their photo files – in their own folders, plus their Guess Who files (kept in a shared "mystery"
  // folder so the file names don't give away who posted them)…
  const { data: mystery } = await admin
    .from('mystery_posts')
    .select('media_path, poster_path, overlay_path')
    .eq('user_id', userId);
  const sharedFolderPaths = (mystery ?? [])
    .flatMap((row) => [row.media_path, row.poster_path, row.overlay_path])
    .filter((path): path is string => !!path);
  // …and their Peek Match (dating) photos, kept under their separate dating id.
  const { data: dating } = await admin.from('dating_members').select('dating_id').eq('user_id', userId).maybeSingle();
  if (dating) sharedFolderPaths.push(...(await listAll('media', `dating/${dating.dating_id}`)));
  for (const bucket of ['media', 'avatars']) {
    const paths = [...(await listAll(bucket, userId)), ...(bucket === 'media' ? sharedFolderPaths : [])];
    for (let i = 0; i < paths.length; i += 100) {
      await admin.storage.from(bucket).remove(paths.slice(i, i + 100));
    }
  }

  // 2. Their login – and with it everything else.
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) return json({ error: error.message }, 500);
  return json({ deleted: true });
});
