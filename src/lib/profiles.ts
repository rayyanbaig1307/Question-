import { supabase } from './supabase';
import type { Profile } from './types';

export const USERNAME_RULES = '3–20 characters: lowercase letters, numbers, . and _';

// Returns an error message, or null if the username looks fine.
export function checkUsernameFormat(username: string): string | null {
  if (username.length < 3) return 'Username needs at least 3 characters.';
  if (username.length > 20) return 'Username can be at most 20 characters.';
  if (!/^[a-z0-9_.]+$/.test(username)) return 'Only lowercase letters, numbers, dots and underscores.';
  return null;
}

// Makes whatever someone types into a valid-looking username.
export function cleanUsername(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9_.]/g, '').slice(0, 20);
}

export async function isUsernameAvailable(username: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('username_available', { name: username });
  if (error) throw error;
  return data === true;
}

export async function fetchProfile(id: string): Promise<Profile | null> {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data as Profile | null;
}

export type ProfileStats = { posts: number; friends: number };

export async function fetchProfileStats(id: string): Promise<ProfileStats> {
  const { data, error } = await supabase.rpc('get_profile_stats', { target: id });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as { posts: number; friends: number } | undefined;
  return { posts: Number(row?.posts ?? 0), friends: Number(row?.friends ?? 0) };
}

export async function updateMyProfile(
  id: string,
  changes: Partial<
    Pick<
      Profile,
      | 'username'
      | 'display_name'
      | 'bio'
      | 'avatar_path'
      | 'is_private'
      | 'location_sharing'
      | 'song_title'
      | 'song_artist'
      | 'song_artwork_url'
      | 'song_preview_url'
      | 'song_link_url'
    >
  >,
): Promise<Profile> {
  const { data, error } = await supabase.from('profiles').update(changes).eq('id', id).select('*').single();
  if (error) throw error;
  return data as Profile;
}

// Deletes your account for good: your photo files, your login, and with it your profile, posts, stories,
// chats, friends and likes. Done by the "delete-account" server helper (supabase/functions/delete-account),
// which only ever deletes the person who's logged in.
export async function deleteMyAccount(): Promise<void> {
  const { data, error } = await supabase.functions.invoke('delete-account', { method: 'POST' });
  if (error) throw error;
  if (!data?.deleted) throw new Error(data?.error ?? 'Could not delete your account');
}
