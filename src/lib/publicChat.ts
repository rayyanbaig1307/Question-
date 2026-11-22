import { useEffect, useState } from 'react';

import { updateChannel } from './lensDiagnostics';
import { deleteMedia, uploadCapture, type Capture } from './media';
import { supabase } from './supabase';
import type { Profile } from './types';

// ---------------------------------------------------------------------------
// The public chat 📸: one room for everyone on Peekaboo who is 18 or over. Photos only.
// The rules live on the server (supabase/migrations/20261225000000_public_chat.sql): 18+ from your saved
// birthday, slow mode (one photo every 30 seconds), reports (3 different people hide a photo), blocks.
// ---------------------------------------------------------------------------

// 'ok' = you're in · 'no_birthday' = add your birthday to join · 'under_18' = there's no public chat for you ·
// 'unavailable' = this server doesn't have the public chat (or it couldn't be asked).
export type PublicChatStatus = 'ok' | 'no_birthday' | 'under_18' | 'unavailable';

export type PublicPhoto = {
  id: string;
  sender_id: string;
  media_path: string;
  created_at: string;
  // Only ever true on your own photo: 3 people reported it, so nobody else sees it any more.
  hidden: boolean;
  author?: Pick<Profile, 'id' | 'username' | 'display_name' | 'avatar_path'> | null;
};

// The name the camera and editor use for "send it to the public chat" (in place of a group's id).
export const PUBLIC_CHAT = 'public';

// The public chat is on for everyone (18+ by the server's check) since 22 Nov – the owner: "make sure public
// chats … all go up today". There is no automatic photo scanner yet: 3 reports hide a photo, and the owner
// checks the Reports screen every day. Set this to false to show it only on the `testing` update channel again
// (the owner's TestFlight builds) – a one-line update.
export const PUBLIC_CHAT_FOR_EVERYONE = true;

// Is the public chat switched on in this download? `channel` is for the tests; the app leaves it out.
export function publicChatSwitchedOn(channel?: string | null): boolean {
  return PUBLIC_CHAT_FOR_EVERYONE || (channel === undefined ? updateChannel() : channel) === 'testing';
}

export async function fetchPublicChatStatus(): Promise<PublicChatStatus> {
  if (!publicChatSwitchedOn()) return 'unavailable';
  const { data, error } = await supabase.rpc('public_chat_status');
  if (error || (data !== 'ok' && data !== 'no_birthday' && data !== 'under_18')) return 'unavailable';
  return data;
}

// Your place in the public chat, asked once when a screen opens (null while asking).
export function usePublicChatStatus(): PublicChatStatus | null {
  const [status, setStatus] = useState<PublicChatStatus | null>(null);
  useEffect(() => {
    let active = true;
    fetchPublicChatStatus().then((value) => {
      if (active) setStatus(value);
    });
    return () => {
      active = false;
    };
  }, []);
  return status;
}

// Newest first.
export async function fetchPublicPhotos(limit = 60): Promise<PublicPhoto[]> {
  const { data, error } = await supabase
    .from('public_photos')
    .select('*, author:profiles!public_photos_sender_id_fkey(id, username, display_name, avatar_path)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as unknown as PublicPhoto[];
}

// Posts one photo in the public chat. Videos aren't allowed there.
export async function sendPublicPhoto(me: string, capture: Capture): Promise<void> {
  if (capture.kind !== 'photo') throw new Error('The public chat is photos only – no videos.');
  const { fields } = await uploadCapture(me, 'public', capture);
  const { error } = await supabase.from('public_photos').insert({ media_path: fields.media_path });
  if (error) {
    // Undo the upload. If even that fails, you still see the real reason it couldn't be posted.
    await deleteMedia([fields.media_path]).catch((cleanupError) => console.warn('Could not remove an unfinished upload', cleanupError));
    throw error;
  }
}

// Deletes your own photo from the room (and its file, once nothing needs it any more).
export async function deletePublicPhoto(photo: PublicPhoto): Promise<void> {
  const { error } = await supabase.from('public_photos').delete().eq('id', photo.id);
  if (error) throw error;
  const { data: safe, error: checkError } = await supabase.rpc('can_cleanup_snap', { object_name: photo.media_path });
  if (checkError || safe !== true) return;
  await deleteMedia([photo.media_path]).catch(() => {});
}

// Calls `onChange` when a photo is posted or deleted. Each listener gets its own channel name.
let listener = 0;
export function subscribeToPublicChat(onChange: () => void): () => void {
  const channel = supabase
    .channel(`public-chat-${++listener}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'public_photos' }, onChange)
    .subscribe();
  return () => {
    supabase.removeChannel(channel);
  };
}
