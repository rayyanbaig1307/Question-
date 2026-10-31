import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { onNotificationArrived } from './notifications';
import { supabase } from './supabase';
import type { Profile } from './types';

// ---------------------------------------------------------------------------
// Hit ups 👋: tap "Hit up" on someone's profile (with a short message if you want). They see it at the top
// of Chat. If they hit back you're friends and your message is the first one in your chat; if they ignore it,
// it just goes away (you're never told). Nothing else can be sent until they hit back.
// Safety (checked by the database, see supabase/migrations/20261123000000_hit_ups.sql): teens and adults
// can't hit each other up, 10 a day, and everyone picks who can hit them up in Settings.
// ---------------------------------------------------------------------------

export const HIT_UP_MAX_LENGTH = 150;

export type HitUp = {
  id: string;
  message: string | null;
  created_at: string;
  sender: Profile;
};

// What the Hit up button on someone's profile shows.
export type HitUpStatus = 'can' | 'sent' | 'theirs' | 'friends' | 'self' | 'no_birthday' | 'unavailable';

// Hit ups waiting for you, newest first.
export async function fetchHitUpsForMe(me: string): Promise<HitUp[]> {
  const { data, error } = await supabase
    .from('hit_ups')
    .select('id, message, created_at, sender:profiles!hit_ups_from_user_fkey(*)')
    .eq('to_user', me)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) throw error;
  // (Someone who's since blocked you, or deleted their account, has no profile here – skip them.)
  return ((data ?? []) as unknown as HitUp[]).filter((hitUp) => hitUp.sender);
}

export async function fetchHitUpStatus(target: string): Promise<HitUpStatus> {
  const { data, error } = await supabase.rpc('hit_up_status', { target });
  if (error) throw error;
  return data as HitUpStatus;
}

// 'connected' when they had already hit you up – then you're friends straight away.
export async function sendHitUp(target: string, note: string): Promise<'sent' | 'connected'> {
  const { data, error } = await supabase.rpc('hit_up', { target, note: note.trim() || null });
  if (error) throw error;
  return data as 'sent' | 'connected';
}

// Hit back (you're friends and can chat) or ignore (it goes away, and they're never told).
export async function respondToHitUp(hit: string, hitBack: boolean): Promise<void> {
  const { error } = await supabase.rpc('respond_hit_up', { hit, accept: hitBack });
  if (error) throw error;
}

// Your hit ups, fresh whenever `active` turns on, the app comes back to the front, or a new one arrives.
export function useHitUps(me: string, active: boolean) {
  const [hitUps, setHitUps] = useState<HitUp[]>([]);

  const reload = useCallback(() => {
    fetchHitUpsForMe(me)
      .then(setHitUps)
      .catch((error) => console.warn('Could not load hit ups', error));
  }, [me]);

  useEffect(() => {
    if (!active) return;
    reload();
    const app = AppState.addEventListener('change', (state) => {
      if (state === 'active') reload();
    });
    const stopListening = onNotificationArrived('hitups', reload);
    return () => {
      app.remove();
      stopListening();
    };
  }, [active, reload]);

  return { hitUps, reload };
}
