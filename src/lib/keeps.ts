import { requireOptionalNativeModule } from 'expo';
import { File, Paths } from 'expo-file-system';

import { deleteMedia, mediaFiles, uploadCapture, type Capture } from './media';
import { supabase } from './supabase';
import type { MediaFields } from './types';

// ---------------------------------------------------------------------------
// Keeps 📦: photos and videos you save from the editor. They go to your phone's Photos and to your own
// private library in Peekaboo (only you can see it). Our own take on "memories".
// ---------------------------------------------------------------------------

export type Keep = MediaFields & { id: string; user_id: string; created_at: string };

// Saving to the phone's Photos is a native part of the app: Expo Go and new downloads have it, older
// downloads don't – then only the in-app Keeps copy is saved.
// (The "legacy" part of the library: its old saveToLibraryAsync now throws "deprecated" when loaded from the
// main entry, so saving silently failed.)
const MediaLibrary: typeof import('expo-media-library/legacy') | null = requireOptionalNativeModule('ExpoMediaLibrary')
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('expo-media-library/legacy')
  : null;

export const CAN_SAVE_TO_PHOTOS = MediaLibrary !== null;

// Puts a photo or video file into the phone's Photos (asks for permission the first time).
// Returns false if the phone said no.
export async function saveToPhotos(localUri: string): Promise<boolean> {
  if (!MediaLibrary) return false;
  const { granted } = await MediaLibrary.requestPermissionsAsync(true);
  if (!granted) return false;
  await MediaLibrary.saveToLibraryAsync(localUri);
  return true;
}

export async function addKeep(userId: string, capture: Capture): Promise<Keep> {
  const { fields } = await uploadCapture(userId, 'keeps', capture);
  const { data, error } = await supabase.from('keeps').insert({ user_id: userId, ...fields }).select('*').single();
  if (error) {
    await deleteMedia(mediaFiles(fields));
    throw error;
  }
  return data as Keep;
}

export async function fetchKeeps(userId: string): Promise<Keep[]> {
  const { data, error } = await supabase.from('keeps').select('*').eq('user_id', userId).order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Keep[];
}

export async function deleteKeep(keep: Keep): Promise<void> {
  const { error } = await supabase.from('keeps').delete().eq('id', keep.id);
  if (error) throw error;
  await deleteMedia(mediaFiles(keep)).catch((cleanupError) => console.warn('Keep removed; its files could not be cleaned up yet', cleanupError));
}

// Downloads a keep's file to the phone (for saving to Photos or posting it again).
export async function downloadKeepFile(url: string, name: string): Promise<string> {
  const target = new File(Paths.cache, name);
  if (target.exists) target.delete();
  const file = await File.downloadFileAsync(url, target);
  return file.uri;
}
