import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { onNotificationArrived } from './notifications';
import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// Activity 🔔: what happened to you in the last 30 days, at the top of Chat.
// Likes and comments on your posts, replies to your comments, likes on your comments, people who added you,
// accepted your friend request, or hit you back. Worked out by the database
// (supabase/migrations/20261205000000_activity.sql) – nothing extra is saved.
// "New" means newer than the last time you looked at your Inbox (remembered on this phone).
// ---------------------------------------------------------------------------

export type ActivityKind = 'like' | 'comment' | 'reply' | 'comment_like' | 'added_you' | 'accepted' | 'hit_back';

export type ActivityItem = {
  kind: ActivityKind;
  at: string;
  actor_id: string;
  actor_username: string;
  actor_name: string | null;
  actor_avatar: string | null;
  post_id: string | null;
  snippet: string | null;
};

export async function fetchActivity(): Promise<ActivityItem[]> {
  const { data, error } = await supabase.rpc('my_activity');
  if (error) throw error;
  return (data ?? []) as ActivityItem[];
}

// What each kind of activity says after the person's name.
export function describeActivity(item: ActivityItem): string {
  const quote = item.snippet ? `: “${item.snippet}”` : '';
  switch (item.kind) {
    case 'like':
      return 'liked your post ❤️';
    case 'comment':
      return `commented on your post${quote}`;
    case 'reply':
      return `replied to your comment${quote}`;
    case 'comment_like':
      return `liked your comment${quote}`;
    case 'added_you':
      return 'added you as a friend 🎉';
    case 'accepted':
      return 'accepted your friend request 🎉';
    case 'hit_back':
      return 'hit you back 👋';
    default:
      return '';
  }
}

const seenKey = (me: string) => `peekaboo-activity-seen:${me}`;
const clearedKey = (me: string) => `peekaboo-activity-cleared:${me}`;

// Your activity, fresh whenever `active` turns on, the app comes back to the front, or a like / comment /
// friend notification arrives. No live database listener on purpose (one less thing that can break at launch).
// "Seen" (no dot, not counted) and "Cleared" (gone from the Inbox) are remembered on this phone.
export function useActivity(me: string, active: boolean) {
  const [all, setAll] = useState<ActivityItem[]>([]);
  const [seenAt, setSeenAt] = useState<string | null>(null);
  const [clearedAt, setClearedAt] = useState<string | null>(null);
  // The newest item, for "seen" / "clear" (kept out of render so the callbacks below never change).
  const newest = useRef<string | null>(null);

  const reload = useCallback(() => {
    fetchActivity()
      .then((items) => {
        newest.current = items[0]?.at ?? null;
        setAll(items);
      })
      .catch((error) => console.warn('Could not load activity', error));
    // Another screen may have marked things seen or cleared since.
    AsyncStorage.multiGet([seenKey(me), clearedKey(me)])
      .then(([[, seen], [, cleared]]) => {
        setSeenAt(seen ?? new Date(0).toISOString());
        setClearedAt(cleared ?? new Date(0).toISOString());
      })
      .catch(() => {
        setSeenAt(new Date(0).toISOString());
        setClearedAt(new Date(0).toISOString());
      });
  }, [me]);

  useEffect(() => {
    if (!active) return;
    reload();
    const app = AppState.addEventListener('change', (state) => {
      if (state === 'active') reload();
    });
    const stops = ['post', 'comments', 'friends', 'message'].map((type) => onNotificationArrived(type, reload));
    return () => {
      app.remove();
      stops.forEach((stop) => stop());
    };
  }, [active, reload]);

  // Everything up to now counts as seen (called when you leave the Inbox).
  const markSeen = useCallback(() => {
    const at = newest.current;
    if (!at) return;
    setSeenAt((current) => (current && current >= at ? current : at));
    AsyncStorage.setItem(seenKey(me), at).catch(() => {});
  }, [me]);

  // "Clear": everything up to now disappears from the Inbox (and counts as seen).
  const clear = useCallback(() => {
    const at = newest.current;
    if (!at) return;
    setClearedAt(at);
    setSeenAt(at);
    AsyncStorage.multiSet([
      [clearedKey(me), at],
      [seenKey(me), at],
    ]).catch(() => {});
  }, [me]);

  const items = clearedAt === null ? [] : all.filter((item) => item.at > clearedAt);
  // While we don't know yet when you last looked, nothing counts as new.
  const unseen = seenAt === null ? 0 : items.filter((item) => item.at > seenAt).length;
  return { items, unseen, seenAt, markSeen, clear, reload };
}
