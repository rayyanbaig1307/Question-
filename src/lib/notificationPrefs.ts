import { supabase } from './supabase';

// Which notifications you want. Saved in the database, so the server knows what to send you.
export type NotificationPrefs = {
  messages: boolean;
  friend_requests: boolean;
  likes: boolean;
  comments: boolean;
  drops: boolean;
  // "🔴 Sam is live" (only sent to phones that can open a live).
  lives: boolean;
};

export const ALL_ON: NotificationPrefs = { messages: true, friend_requests: true, likes: true, comments: true, drops: true, lives: true };

export async function fetchNotificationPrefs(me: string): Promise<NotificationPrefs> {
  // Every column ('*'), so a server from before lives (no `lives` column yet) still answers.
  const { data, error } = await supabase.from('notification_prefs').select('*').eq('user_id', me).maybeSingle();
  if (error) throw error;
  if (!data) return ALL_ON; // nothing saved yet = everything on
  const row = data as Partial<NotificationPrefs>;
  const on = (value: unknown) => value !== false;
  return {
    messages: on(row.messages),
    friend_requests: on(row.friend_requests),
    likes: on(row.likes),
    comments: on(row.comments),
    drops: on(row.drops),
    lives: on(row.lives), // missing (an older server) = on
  };
}

export async function saveNotificationPrefs(me: string, prefs: NotificationPrefs): Promise<void> {
  const { error } = await supabase
    .from('notification_prefs')
    .upsert({ user_id: me, ...prefs, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) throw error;
}
