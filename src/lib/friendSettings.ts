import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// Per-friend options (hold down a chat): mute their notifications, hide their stories, pin the chat.
// Only you can see your own settings.
// ---------------------------------------------------------------------------

export type FriendSettings = {
  friend_id: string;
  mute_messages: boolean; // no notifications for their messages and peeks
  mute_stories: boolean; // their stories stay out of the row on Home
  pinned: boolean; // their chat stays at the top of Chat
};

const COLUMNS = 'friend_id, mute_messages, mute_stories, pinned';

export async function fetchFriendSettings(me: string): Promise<Map<string, FriendSettings>> {
  const { data, error } = await supabase.from('friend_settings').select(COLUMNS).eq('user_id', me);
  if (error) throw error;
  return new Map(((data ?? []) as FriendSettings[]).map((row) => [row.friend_id, row]));
}

// Changes one or more options for a friend (the others stay as they were).
export async function saveFriendSettings(
  me: string,
  friend: string,
  changes: Partial<Omit<FriendSettings, 'friend_id'>>,
): Promise<FriendSettings> {
  const { data, error } = await supabase
    .from('friend_settings')
    .upsert({ user_id: me, friend_id: friend, ...changes, updated_at: new Date().toISOString() }, { onConflict: 'user_id,friend_id' })
    .select(COLUMNS)
    .single();
  if (error) throw error;
  return data as FriendSettings;
}

// Friends whose stories you've hidden.
export async function fetchHiddenStoryAuthors(me: string): Promise<Set<string>> {
  const { data, error } = await supabase.from('friend_settings').select('friend_id').eq('user_id', me).eq('mute_stories', true);
  if (error) throw error;
  return new Set((data ?? []).map((row) => row.friend_id as string));
}
