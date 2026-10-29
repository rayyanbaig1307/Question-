import { supabase } from './supabase';

// Which notifications you want. Saved in the database, so the server knows what to send you.
export type NotificationPrefs = {
  messages: boolean;
  friend_requests: boolean;
  likes: boolean;
  comments: boolean;
  drops: boolean;
};

export const ALL_ON: NotificationPrefs = { messages: true, friend_requests: true, likes: true, comments: true, drops: true };

export async function fetchNotificationPrefs(me: string): Promise<NotificationPrefs> {
  const { data, error } = await supabase
    .from('notification_prefs')
    .select('messages, friend_requests, likes, comments, drops')
    .eq('user_id', me)
    .maybeSingle();
  if (error) throw error;
  return (data as NotificationPrefs | null) ?? ALL_ON; // nothing saved yet = everything on
}

export async function saveNotificationPrefs(me: string, prefs: NotificationPrefs): Promise<void> {
  const { error } = await supabase
    .from('notification_prefs')
    .upsert({ user_id: me, ...prefs, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) throw error;
}
