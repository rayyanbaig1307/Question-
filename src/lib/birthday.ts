import AsyncStorage from '@react-native-async-storage/async-storage';

import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// Your birthday: saved once, only you see it, and it can't be changed. Hit ups use it so teens (13–17) and
// adults (18+) can't hit each other up.
// ---------------------------------------------------------------------------

// Your saved birthday ('YYYY-MM-DD'), or null if you haven't added it.
export async function fetchMyBirthday(me: string): Promise<string | null> {
  const { data, error } = await supabase.from('age_checks').select('birthday').eq('user_id', me).maybeSingle();
  if (error) throw error;
  return data?.birthday ?? null;
}

// We ask for your birthday once when you open Peekaboo (you can also add it in Settings).
const birthdayAskedKey = (me: string) => `peekaboo-birthday-asked:${me}`;

export async function wasAskedForBirthday(me: string): Promise<boolean> {
  return (await AsyncStorage.getItem(birthdayAskedKey(me)).catch(() => null)) === 'yes';
}

export function markAskedForBirthday(me: string) {
  AsyncStorage.setItem(birthdayAskedKey(me), 'yes').catch(() => {});
}

// Saves your birthday (once, for good).
export async function setBirthday(day: string): Promise<void> {
  const { error } = await supabase.rpc('set_birthday', { day });
  if (error) throw error;
}
