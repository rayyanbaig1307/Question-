import { randomUUID } from 'expo-crypto';
import { File } from 'expo-file-system';
import * as Location from 'expo-location';

import { deleteMedia, resizePhoto } from './media';
import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// Peek Match dating profiles: 3–6 photos, a first name, gender, a rough area, 3 prompts and who you'd like
// to see. Kept apart from your normal Peekaboo profile (photos live in "dating/<your dating id>/").
// ---------------------------------------------------------------------------

export const MIN_PHOTOS = 3;
export const MAX_PHOTOS = 6;

export const DATING_PROMPTS = [
  "A dare I'd actually do…",
  'Peek at my perfect weekend…',
  'The way to win me over…',
  "I'm secretly really good at…",
  'My most-used emoji, and why…',
  'Two truths and a lie…',
  "Don't hate me if I…",
  'Green flags I look for…',
  'My go-to karaoke song…',
  'The last thing that made me laugh out loud…',
  "Peekaboo! You'd never guess that I…",
  'Our first date: …',
];

export type Gender = 'woman' | 'man' | 'nonbinary';
export const GENDERS: { key: Gender; label: string; plural: string }[] = [
  { key: 'woman', label: 'Woman', plural: 'Women' },
  { key: 'man', label: 'Man', plural: 'Men' },
  { key: 'nonbinary', label: 'Nonbinary', plural: 'Nonbinary people' },
];

export const DISTANCES_KM = [5, 10, 25, 50, 100, 250];

export type DatingProfile = {
  name: string;
  gender: Gender;
  area: string;
  lat: number;
  lng: number;
  show_genders: Gender[];
  age_min: number;
  age_max: number;
  max_km: number;
};
export type DatingPhoto = { id: string; path: string; position: number };
export type DatingPrompt = { position: number; prompt: string; answer: string };
export type MyDating = { profile: DatingProfile | null; photos: DatingPhoto[]; prompts: DatingPrompt[] };

export async function fetchMyDating(me: string): Promise<MyDating> {
  const [profile, photos, prompts] = await Promise.all([
    supabase.from('dating_profiles').select('*').eq('user_id', me).maybeSingle(),
    supabase.from('dating_photos').select('id, path, position').eq('user_id', me).order('position').order('created_at'),
    supabase.from('dating_prompts').select('position, prompt, answer').eq('user_id', me).order('position'),
  ]);
  if (profile.error) throw profile.error;
  if (photos.error) throw photos.error;
  if (prompts.error) throw prompts.error;
  const row = profile.data as (DatingProfile & { lat: number | string; lng: number | string }) | null;
  return {
    profile: row ? { ...row, lat: Number(row.lat), lng: Number(row.lng) } : null,
    photos: (photos.data ?? []) as DatingPhoto[],
    prompts: (prompts.data ?? []) as DatingPrompt[],
  };
}

// Is the dating profile ready to be shown to others? (Same rule as the database.)
export function isComplete(dating: MyDating): boolean {
  return !!dating.profile && dating.photos.length >= MIN_PHOTOS && dating.prompts.length === 3;
}

export async function addDatingPhoto(me: string, datingId: string, localUri: string, position: number): Promise<DatingPhoto> {
  const small = await resizePhoto(localUri, 1080);
  const path = `dating/${datingId}/${randomUUID()}.jpg`;
  const { error: uploadError } = await supabase.storage
    .from('media')
    .upload(path, await new File(small).arrayBuffer(), { contentType: 'image/jpeg' });
  if (uploadError) throw uploadError;
  const { data, error } = await supabase
    .from('dating_photos')
    .insert({ user_id: me, path, position })
    .select('id, path, position')
    .single();
  if (error) {
    await deleteMedia([path]);
    throw error;
  }
  return data as DatingPhoto;
}

export async function removeDatingPhoto(photo: DatingPhoto): Promise<void> {
  const { error } = await supabase.from('dating_photos').delete().eq('id', photo.id);
  if (error) throw error;
  await deleteMedia([photo.path]);
}

// Puts a photo first (it becomes the main one).
export async function makeMainPhoto(photos: DatingPhoto[], main: DatingPhoto): Promise<void> {
  const ordered = [main, ...photos.filter((photo) => photo.id !== main.id)];
  await Promise.all(
    ordered.map((photo, position) => supabase.from('dating_photos').update({ position }).eq('id', photo.id)),
  );
}

export async function saveDatingProfile(me: string, profile: DatingProfile, prompts: DatingPrompt[]): Promise<void> {
  const { error } = await supabase
    .from('dating_profiles')
    .upsert({ user_id: me, ...profile, name: profile.name.trim(), area: profile.area.trim(), updated_at: new Date().toISOString() });
  if (error) throw error;
  const { error: promptError } = await supabase
    .from('dating_prompts')
    .upsert(prompts.map((prompt) => ({ user_id: me, ...prompt, answer: prompt.answer.trim() })));
  if (promptError) throw promptError;
}

// Where you roughly are: rounded to about 1 km before it ever leaves the phone, plus a suggested area name.
// Returns null if location permission was refused.
export async function roughLocation(): Promise<{ lat: number; lng: number; area: string } | null> {
  const permission = await Location.requestForegroundPermissionsAsync();
  if (!permission.granted) return null;
  const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  const round = (n: number) => Math.round(n * 100) / 100;
  const lat = round(position.coords.latitude);
  const lng = round(position.coords.longitude);
  let area = '';
  try {
    const [place] = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lng });
    area = place?.district || place?.city || place?.subregion || place?.region || '';
  } catch {
    // no area name – you can type one
  }
  return { lat, lng, area: area.slice(0, 40) };
}

// Your age from the date of birth on your ID.
export function ageFrom(birthday: string | null | undefined): number | null {
  if (!birthday) return null;
  const [y, m, d] = birthday.split('-').map(Number);
  const now = new Date();
  let age = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) age -= 1;
  return age;
}

// ---------------------------------------------------------------------------
// Finding people (step 3)
// ---------------------------------------------------------------------------

// Someone else's dating profile, as Peek Match shows it: only their dating id, never their normal account.
export type DatingCard = {
  dating_id: string;
  name: string;
  age: number;
  area: string;
  // Rough distance: 2 means "less than 2 km".
  km: number;
  photos: { id: string; path: string }[];
  prompts: DatingPrompt[];
};

export function roughDistance(km: number): string {
  return km <= 2 ? 'Less than 2 km away' : `${km} km away`;
}

export async function fetchDatingFeed(): Promise<DatingCard[]> {
  const { data, error } = await supabase.rpc('peek_match_feed', { how_many: 10 });
  if (error) throw error;
  return (data ?? []) as DatingCard[];
}

// Like one photo or one prompt (with an optional comment).
export async function likeDatingProfile(
  target: string,
  what: { photoId: string } | { prompt: number },
  comment: string,
): Promise<string> {
  const { data, error } = await supabase.rpc('peek_match_like', {
    target,
    liked_photo: 'photoId' in what ? what.photoId : null,
    liked_prompt: 'prompt' in what ? what.prompt : null,
    note: comment.trim() || null,
  });
  if (error) throw error;
  return data as string;
}

export async function skipDatingProfile(target: string): Promise<void> {
  const { error } = await supabase.rpc('peek_match_skip', { target });
  if (error) throw error;
}

export async function blockDatingProfile(target: string): Promise<void> {
  const { error } = await supabase.rpc('peek_match_block', { target });
  if (error) throw error;
}

export async function reportDatingProfile(target: string, reason: string, what: 'profile' | 'message' = 'profile'): Promise<void> {
  const { error } = await supabase.rpc('peek_match_report', { target, reason, what });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Matches and the match chat (step 4)
// ---------------------------------------------------------------------------

// Photos in a match chat start blurred and unblur once you've both sent this many messages.
export const UNBLUR_AFTER = 5;

export type DatingMatch = {
  match_id: string;
  created_at: string;
  person: DatingCard;
  my_count: number;
  their_count: number;
  unread: number;
  last: { body: string; mine: boolean; created_at: string } | null;
  // Becoming Peekaboo friends: nobody asked yet, you asked, they asked, or you're friends.
  friendship: 'none' | 'sent' | 'received' | 'friends';
};

export const photosRevealed = (match: Pick<DatingMatch, 'my_count' | 'their_count'>) =>
  match.my_count >= UNBLUR_AFTER && match.their_count >= UNBLUR_AFTER;

export type LikeForMe = {
  person: DatingCard;
  comment: string | null;
  liked_photo: string | null; // which of your photos they liked (its path)
  liked_prompt: string | null; // …or which of your prompts
  created_at: string;
};

export type DatingMessage = {
  id: string;
  match_id: string;
  sender: string;
  body: string;
  // 'friend_request' / 'friends' are little notices about becoming Peekaboo friends (they don't count to 5).
  kind: 'text' | 'friend_request' | 'friends';
  created_at: string;
  read_at: string | null;
};

export async function fetchMatches(only?: string): Promise<DatingMatch[]> {
  const { data, error } = await supabase.rpc('peek_match_matches', only ? { only_match: only } : {});
  if (error) throw error;
  return (data ?? []) as DatingMatch[];
}

export async function fetchLikesForMe(): Promise<LikeForMe[]> {
  const { data, error } = await supabase.rpc('peek_match_likes_me');
  if (error) throw error;
  return (data ?? []) as LikeForMe[];
}

// Newest first.
export async function fetchDatingMessages(matchId: string): Promise<DatingMessage[]> {
  const { data, error } = await supabase
    .from('dating_messages')
    .select('*')
    .eq('match_id', matchId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data ?? []) as DatingMessage[];
}

export async function sendDatingMessage(matchId: string, message: string): Promise<void> {
  const { error } = await supabase.rpc('peek_match_send', { match: matchId, message: message.trim() });
  if (error) throw error;
}

export async function markDatingChatRead(matchId: string): Promise<void> {
  const { error } = await supabase.rpc('peek_match_read', { match: matchId });
  if (error) throw error;
}

export async function unmatch(matchId: string): Promise<void> {
  const { error } = await supabase.rpc('peek_match_unmatch', { match: matchId });
  if (error) throw error;
}

// Calls `onChange` when a message arrives in this match chat.
export function subscribeToDatingChat(matchId: string, onChange: () => void): () => void {
  const channel = supabase
    .channel(`dating-chat-${matchId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'dating_messages', filter: `match_id=eq.${matchId}` }, onChange)
    .subscribe();
  return () => {
    supabase.removeChannel(channel);
  };
}

// ---------------------------------------------------------------------------
// "Add as friend" (step 5): sends a normal Peekaboo friend request to your match. You only become friends –
// and see each other's normal profiles – once they say yes too.
// ---------------------------------------------------------------------------

export async function addMatchAsFriend(matchId: string): Promise<'requested' | 'friends' | 'already'> {
  const { data, error } = await supabase.rpc('peek_match_add_friend', { match: matchId });
  if (error) throw error;
  return data as 'requested' | 'friends' | 'already';
}

// Their normal Peekaboo account (only once you're friends).
export async function fetchMatchFriendId(matchId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('peek_match_friend_id', { match: matchId });
  if (error) throw error;
  return (data as string | null) ?? null;
}
