import { supabase } from './supabase';
import type { Profile } from './types';

// ---------------------------------------------------------------------------
// Who Peeked: on your own drop posts you see which friends revealed them and which scrolled past.
// The app tells the database when a friend's drop is on your screen, and when you actually see it.
// ---------------------------------------------------------------------------

// What we've already told the database this time the app is open (post id → revealed?), to send each once.
const noted = new Map<string, boolean>();

export function noteDropSeen(postId: string, revealed: boolean): void {
  const before = noted.get(postId);
  if (before === true || (before === false && !revealed)) return;
  noted.set(postId, revealed);
  supabase.rpc('mark_drop_seen', { post: postId, did_reveal: revealed }).then(({ error }) => {
    if (error) noted.delete(postId); // try again next time
  });
}

export type Peeker = {
  viewer_id: string;
  revealed: boolean;
  seen_at: string;
  revealed_at: string | null;
  viewer: Profile | null;
};

// Everyone who saw one of your drops (only works for your own posts).
export async function fetchPeekers(postId: string): Promise<Peeker[]> {
  const { data, error } = await supabase
    .from('drop_views')
    .select('*, viewer:profiles!drop_views_viewer_id_fkey(*)')
    .eq('post_id', postId)
    .order('seen_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Peeker[];
}
