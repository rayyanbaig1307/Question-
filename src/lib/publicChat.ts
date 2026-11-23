import { useEffect, useState } from 'react';

import { WORD_NOT_ALLOWED } from './cleanWords';
import { serverFailure } from './errors';
import { updateChannel } from './lensDiagnostics';
import { deleteMedia, uploadCapture, type Capture } from './media';
import { hasLinkOrPhone, publicMessageProblem, tidyPublicText } from './publicText';
import { supabase } from './supabase';
import type { Profile } from './types';

// ---------------------------------------------------------------------------
// The public chat 📸: one room for everyone on Peekaboo who is 18 or over. Photos, messages and stickers.
// The rules live on the server: photos in supabase/migrations/20261225000000_public_chat.sql (18+ from your saved
// birthday, one photo every 30 seconds, 3 different people reporting hide a photo, blocks), messages and stickers
// in 20270102000000_public_chat_text.sql (the same, plus 1–300 characters, no slurs, no links or phone numbers,
// one every 5 seconds and 300 a day, and no link or phone number in the name you post with). Messages live in
// their own table so older app versions, which draw every row of public_photos as a photo, keep working exactly
// as before.
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

// A message (words) or a sticker (its name, like 'googly-eyes' or 'word-slay') in the public chat.
export type PublicMessage = {
  id: string;
  sender_id: string;
  kind: 'text' | 'sticker';
  body: string | null;
  sticker: string | null;
  created_at: string;
  // Only ever true on your own message: 3 people reported it, so nobody else sees it any more.
  hidden: boolean;
  author?: Pick<Profile, 'id' | 'username' | 'display_name' | 'avatar_path'> | null;
};

// Everything in the room, newest first. A photo gets kind 'photo' here (the photos table has no kind).
export type PublicChatItem = (PublicPhoto & { kind: 'photo' }) | PublicMessage;
export type PublicChatRoom = {
  items: PublicChatItem[];
  // false when this server doesn't have messages yet (then the room is photos only, as before).
  textOn: boolean;
};

// The name the camera and editor use for "send it to the public chat" (in place of a group's id).
export const PUBLIC_CHAT = 'public';

// The public chat is on for everyone (18+ by the server's check) since 22 Nov – the owner: "make sure public
// chats … all go up today". There is no automatic photo scanner yet: 3 reports hide a photo, and the owner
// checks new reports every day (a 🚩 push for each; Supabase → Table Editor → reports). Set this to false to show it only on the `testing` update channel again
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

const AUTHOR = 'id, username, display_name, avatar_path';

// Newest first.
export async function fetchPublicPhotos(limit = 60): Promise<PublicPhoto[]> {
  const { data, error } = await supabase
    .from('public_photos')
    .select(`*, author:profiles!public_photos_sender_id_fkey(${AUTHOR})`)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as unknown as PublicPhoto[];
}

// The answers that mean "this server has no public chat messages": the table isn't there yet (PGRST205 or
// 42P01, HTTP 404), or the owner switched messages off by taking away access (42501, the emergency off switch).
// Anything else (no signal, a time-out, a server hiccup) is a real error, so the room doesn't fall back to
// photos only by mistake.
const NO_MESSAGES = new Set(['PGRST205', '42P01', '42501']);
export function serverHasNoMessages(error: { code?: string } | null | undefined, status?: number): boolean {
  return status === 404 || NO_MESSAGES.has(error?.code ?? '');
}

// Newest first, or null when this server has no messages (see serverHasNoMessages).
export async function fetchPublicMessages(limit = 100): Promise<PublicMessage[] | null> {
  const { data, error, status } = await supabase
    .from('public_messages')
    .select(`*, author:profiles!public_messages_sender_id_fkey(${AUTHOR})`)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    if (serverHasNoMessages(error, status)) return null;
    throw error;
  }
  return (data ?? []) as unknown as PublicMessage[];
}

// Puts photos and messages in one list, newest first. Each list is only the newest few, so the room stops where
// one of them ran out (older things from the other list would leave a gap).
export function mergePublicChat(
  photos: PublicPhoto[],
  messages: PublicMessage[],
  photoLimit = 60,
  messageLimit = 100,
): PublicChatItem[] {
  const items: PublicChatItem[] = [...photos.map((photo) => ({ ...photo, kind: 'photo' as const })), ...messages];
  const time = (item: { created_at: string }) => Date.parse(item.created_at);
  items.sort((a, b) => time(b) - time(a));
  // The newer of the two "oldest one we got" times, for each list that was cut short.
  let cutoff = -Infinity;
  if (photos.length >= photoLimit) cutoff = Math.max(cutoff, time(photos[photos.length - 1]));
  if (messages.length >= messageLimit) cutoff = Math.max(cutoff, time(messages[messages.length - 1]));
  return items.filter((item) => time(item) >= cutoff);
}

// The whole room. Messages are skipped (photos only, like before) only if this server doesn't have them yet, so
// the app never breaks while the database change is on its way. Any other error (no signal…) is thrown, so the
// screen can keep what it shows and offer to try again.
export async function fetchPublicChat(): Promise<PublicChatRoom> {
  const [photos, messages] = await Promise.all([fetchPublicPhotos(60), fetchPublicMessages(100)]);
  return { items: mergePublicChat(photos, messages ?? [], 60, 100), textOn: messages !== null };
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

// Saves a photo (already uploaded into your public/ folder) in the room – for the outbox (lib/outbox.ts).
// The app can't choose the row's id here, so the file name is what makes it unique: trying the same file again
// is refused with "duplicate key" (23505), which means the first try did save it (findPublicPhoto looks it up).
export async function insertPublicPhoto(mediaPath: string): Promise<void> {
  const { error, status } = await supabase.from('public_photos').insert({ media_path: mediaPath });
  if (error) throw serverFailure(error, status);
}

// Is your photo with this file in the room? (A retry after a lost answer looks first: the room's slow mode would
// refuse the second try before it could say "already there".)
export async function findPublicPhoto(mediaPath: string): Promise<{ id: string } | null> {
  const { data, error, status } = await supabase.from('public_photos').select('id').eq('media_path', mediaPath).maybeSingle();
  if (error) throw serverFailure(error, status);
  return (data as { id: string } | null) ?? null;
}

// Deletes your own photo from the room, then its file – the same way a deleted post's files go (lib/posts.ts).
// The storage rules keep the file for now if something still needs it (for example a report about it).
export async function deletePublicPhoto(photo: PublicPhoto): Promise<void> {
  const { error } = await supabase.from('public_photos').delete().eq('id', photo.id);
  if (error) throw error;
  await deleteMedia([photo.media_path]).catch((cleanupError) => console.warn('Photo removed; its file could not be cleaned up yet', cleanupError));
}

// ---- Messages and stickers ----

export { hasPublicText, PUBLIC_TEXT_MAX, tidyPublicText } from './publicText';

// The sentences people see. The server sends the very same ones (20270102000000_public_chat_text.sql).
export const PUBLIC_TEXT_WORDS = {
  size: 'Messages can be 1 to 300 characters.',
  marks: 'Too many accent marks on one letter.',
  word: WORD_NOT_ALLOWED,
  link: "Links aren't allowed in the public chat.",
  phone: "Phone numbers aren't allowed in the public chat.",
  name: 'Your name or username looks like a link or a phone number. Change it in Edit profile to post in the public chat.',
} as const;

// A friendly sentence when a message can't be sent, or null when it's fine. Same order as the server: length
// (and something you can see), piled-up accent marks, slurs, then links and phone numbers. (Slow mode and the
// daily limit only the server knows.)
export function checkPublicText(text: string): string | null {
  const problem = publicMessageProblem(text);
  return problem ? PUBLIC_TEXT_WORDS[problem] : null;
}

// Your name and username show with everything you post, so they can't hold a link or a phone number while you
// post in the public chat. The sentence to show, or null when they're fine.
export function checkPublicName(person: Pick<Profile, 'username' | 'display_name'> | null | undefined): string | null {
  return person && hasLinkOrPhone(person.username, person.display_name) ? PUBLIC_TEXT_WORDS.name : null;
}

// The name shown with a photo or message in the room. A name (or username) with a link or a phone number in it
// isn't shown – it could have been changed after posting – so the next one is used, or "Someone".
export function publicChatName(author: Pick<Profile, 'username' | 'display_name'> | null | undefined): string {
  if (author?.display_name && !hasLinkOrPhone(author.display_name)) return author.display_name;
  if (author?.username && !hasLinkOrPhone(author.username)) return author.username;
  return 'Someone';
}

// Sends a message. The server fills in who and when, and checks everything again.
export async function sendPublicText(text: string): Promise<PublicMessage> {
  const problem = checkPublicText(text);
  if (problem) throw new Error(problem);
  const { data, error } = await supabase
    .from('public_messages')
    .insert({ kind: 'text', body: tidyPublicText(text) })
    .select(`*, author:profiles!public_messages_sender_id_fkey(${AUTHOR})`)
    .single();
  if (error) throw error;
  return data as unknown as PublicMessage;
}

// Sends a sticker: only its name goes to the server (no words). The screen checks Peekaboo+ first, and the
// server checks it again.
export async function sendPublicSticker(sticker: string): Promise<PublicMessage> {
  const { data, error } = await supabase
    .from('public_messages')
    .insert({ kind: 'sticker', sticker })
    .select(`*, author:profiles!public_messages_sender_id_fkey(${AUTHOR})`)
    .single();
  if (error) throw error;
  return data as unknown as PublicMessage;
}

// Deletes your own message or sticker.
export async function deletePublicMessage(id: string): Promise<void> {
  const { error } = await supabase.from('public_messages').delete().eq('id', id);
  if (error) throw error;
}

// Calls `onChange` when something is posted or deleted. Each listener gets its own channel names. Messages get
// their own channel, and only when the server has them, so photos keep working live either way.
let listener = 0;
export function subscribeToPublicChat(onChange: () => void, { text = false }: { text?: boolean } = {}): () => void {
  const n = ++listener;
  const channels = [
    supabase
      .channel(`public-chat-${n}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'public_photos' }, onChange)
      .subscribe(),
  ];
  if (text) {
    channels.push(
      supabase
        .channel(`public-chat-text-${n}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'public_messages' }, onChange)
        .subscribe(),
    );
  }
  return () => {
    for (const channel of channels) supabase.removeChannel(channel);
  };
}
