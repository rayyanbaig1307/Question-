import { supabase } from './supabase';

// Your close friends (only you can see this list). Stories and posts shared with "Close friends ⭐" are
// only for them.
export async function fetchCloseFriendIds(me: string): Promise<Set<string>> {
  const { data, error } = await supabase.from('close_friends').select('friend').eq('owner', me);
  if (error) throw error;
  return new Set((data ?? []).map((row) => row.friend as string));
}

export async function setCloseFriend(me: string, friend: string, on: boolean): Promise<void> {
  const { error } = on
    ? await supabase.from('close_friends').upsert({ owner: me, friend }, { onConflict: 'owner,friend', ignoreDuplicates: true })
    : await supabase.from('close_friends').delete().eq('owner', me).eq('friend', friend);
  if (error) throw error;
}
