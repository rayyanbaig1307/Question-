import * as Location from 'expo-location';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { updateMyProfile } from './profiles';
import { supabase } from './supabase';
import type { Profile } from './types';

export type FriendLocation = {
  user_id: string;
  latitude: number;
  longitude: number;
  updated_at: string;
  profile: Profile | null;
};

// Everyone on your map: friends who are sharing, plus you while you share.
// (The privacy rules in the database only ever return those.)
export async function fetchMapLocations(): Promise<FriendLocation[]> {
  const { data, error } = await supabase
    .from('locations')
    .select('*, profile:profiles!locations_user_id_fkey(*)')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as FriendLocation[];
}

// Saves where you are right now (only works while location sharing is on).
export async function shareMyLocationNow(me: string): Promise<{ latitude: number; longitude: number } | null> {
  const permission = await Location.getForegroundPermissionsAsync();
  if (!permission.granted) return null;
  const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  const spot = { latitude: position.coords.latitude, longitude: position.coords.longitude };
  const { error } = await supabase
    .from('locations')
    .upsert({ user_id: me, ...spot, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) throw error;
  return spot;
}

// Turns location sharing on (asks for permission first) or off (= hidden).
// Returns the new profile, or null if the phone's location permission was refused.
export async function setLocationSharing(me: string, share: boolean): Promise<Profile | null> {
  if (share) {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) return null;
  }
  // Turning sharing off also deletes your spot from the map (the database does this).
  const profile = await updateMyProfile(me, { location_sharing: share });
  if (share) await shareMyLocationNow(me);
  return profile;
}

const REFRESH_EVERY_MS = 5 * 60 * 1000;

// While sharing is on: update your spot when the app opens, and every few minutes while it's open.
export function useShareLocationWhileOpen(me: string | null, sharing: boolean) {
  useEffect(() => {
    if (!me || !sharing) return;
    let lastSent = 0;
    const send = () => {
      if (Date.now() - lastSent < REFRESH_EVERY_MS) return;
      lastSent = Date.now();
      shareMyLocationNow(me).catch((error) => console.warn('Could not share location', error));
    };
    send();
    const timer = setInterval(send, REFRESH_EVERY_MS);
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') send();
    });
    return () => {
      clearInterval(timer);
      appState.remove();
    };
  }, [me, sharing]);
}
