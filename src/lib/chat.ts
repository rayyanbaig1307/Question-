import { useEffect, useState } from 'react';

import { deleteMedia, uploadMedia } from './media';
import { supabase } from './supabase';

// A "peek" is a photo sent in chat that disappears once opened (stored with kind 'snap').
// You get one replay within a day of opening it, and either of you can save it in the chat to keep it.
export type Message = {
  id: string;
  sender_id: string;
  recipient_id: string;
  // 'screenshot' = a notice that someone took a screenshot; body is 'chat' or 'peek'.
  kind: 'text' | 'snap' | 'screenshot';
  body: string | null;
  media_path: string | null;
  created_at: string;
  // When the other person read the message / opened the peek.
  opened_at: string | null;
  // Peeks only: when the one replay was used, and when (and by whom) it was saved in the chat.
  replayed_at: string | null;
  saved_at: string | null;
  saved_by: string | null;
};

// How long after opening a peek it can still be replayed or saved (same as the database rule).
const KEEP_AFTER_OPENING_MS = 24 * 60 * 60 * 1000;

const openedAgo = (message: Message) =>
  message.opened_at ? Date.now() - new Date(message.opened_at).getTime() : 0;

// Can you (the person it was sent to) still use your one replay of this peek?
export function canReplay(message: Message, me: string): boolean {
  return (
    message.kind === 'snap' &&
    message.recipient_id === me &&
    message.opened_at !== null &&
    message.replayed_at === null &&
    message.saved_at === null &&
    openedAgo(message) < KEEP_AFTER_OPENING_MS
  );
}

// Can this peek still be saved in the chat? (Its photo is kept until a day after it was opened.)
export function canSave(message: Message): boolean {
  return (
    message.kind === 'snap' &&
    message.saved_at === null &&
    (message.opened_at === null || openedAgo(message) < KEEP_AFTER_OPENING_MS)
  );
}

const pairFilter = (me: string, friend: string) =>
  `and(sender_id.eq.${me},recipient_id.eq.${friend}),and(sender_id.eq.${friend},recipient_id.eq.${me})`;

// Newest first.
export async function fetchConversation(me: string, friend: string, limit = 100): Promise<Message[]> {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .or(pairFilter(me, friend))
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as Message[];
}

// Your recent messages with everyone, newest first (for the chat list).
export async function fetchRecentMessages(me: string): Promise<Message[]> {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .or(`sender_id.eq.${me},recipient_id.eq.${me}`)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  return (data ?? []) as Message[];
}

export async function fetchMessage(id: string): Promise<Message | null> {
  const { data, error } = await supabase.from('messages').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data as Message | null;
}

export async function sendText(me: string, friend: string, body: string): Promise<Message> {
  const { data, error } = await supabase
    .from('messages')
    .insert({ sender_id: me, recipient_id: friend, kind: 'text', body: body.trim() })
    .select('*')
    .single();
  if (error) throw error;
  return data as Message;
}

// Lets your friend know you took a screenshot of the chat or of their peek.
export async function sendScreenshotNotice(me: string, friend: string, what: 'chat' | 'peek'): Promise<void> {
  const { error } = await supabase
    .from('messages')
    .insert({ sender_id: me, recipient_id: friend, kind: 'screenshot', body: what });
  if (error) throw error;
}

// One photo, sent as a peek to one or more friends.
export async function sendSnap(me: string, friendIds: string[], photoUri: string): Promise<void> {
  const mediaPath = await uploadMedia(me, 'snaps', photoUri);
  const { error } = await supabase
    .from('messages')
    .insert(friendIds.map((friend) => ({ sender_id: me, recipient_id: friend, kind: 'snap', media_path: mediaPath })));
  if (error) {
    await deleteMedia([mediaPath]);
    throw error;
  }
}

// Marks a peek as opened. After this you only have your one replay left (unless it's saved).
export async function openSnap(messageId: string): Promise<void> {
  const { error } = await supabase.rpc('open_snap', { message_id: messageId });
  if (error) throw error;
}

// Uses your one replay. Returns false if it was already used (or it's too late).
export async function replaySnap(messageId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('replay_snap', { message_id: messageId });
  if (error) throw error;
  return data === true;
}

// Saves a peek in the chat (or unsaves it). Returns false if that's no longer possible.
export async function setSnapSaved(messageId: string, save: boolean): Promise<boolean> {
  const { data, error } = await supabase.rpc('set_snap_saved', { message_id: messageId, save });
  if (error) throw error;
  return data === true;
}

// A link to a peek's photo that only works for one minute.
export async function getSnapUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from('media').createSignedUrl(path, 60);
  if (error) return null;
  return data.signedUrl;
}

export async function markChatRead(friend: string): Promise<void> {
  const { error } = await supabase.rpc('mark_chat_read', { friend });
  if (error) throw error;
}

export async function deleteMessage(message: Message): Promise<void> {
  const { error } = await supabase.from('messages').delete().eq('id', message.id);
  if (error) throw error;
  if (message.media_path) await cleanUpSnapFile(message.sender_id, message.media_path);
}

// A peek's photo is no longer needed once it was opened over a day ago (no replay or save left) and isn't saved.
const photoNoLongerNeeded = (row: Pick<Message, 'opened_at' | 'saved_at'>) =>
  row.opened_at !== null &&
  row.saved_at === null &&
  Date.now() - new Date(row.opened_at).getTime() >= KEEP_AFTER_OPENING_MS;

// Deletes a peek photo you sent once nobody you sent it to needs it any more (or it was unsent).
async function cleanUpSnapFile(me: string, mediaPath: string): Promise<void> {
  const { data } = await supabase
    .from('messages')
    .select('opened_at, saved_at')
    .eq('sender_id', me)
    .eq('media_path', mediaPath);
  if ((data ?? []).every(photoNoLongerNeeded)) {
    await deleteMedia([mediaPath]);
  }
}

// Called when you open a chat: tidies up photos of your peeks that nobody needs any more.
export async function cleanUpOpenedSnaps(me: string, messages: Message[]): Promise<void> {
  const paths = new Set(
    messages
      .filter((message) => message.sender_id === me && message.kind === 'snap' && message.media_path && photoNoLongerNeeded(message))
      .map((message) => message.media_path as string),
  );
  for (const path of paths) {
    await cleanUpSnapFile(me, path).catch(() => {});
  }
}

async function countUnread(me: string): Promise<number> {
  const { count, error } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('recipient_id', me)
    .is('opened_at', null);
  if (error) throw error;
  return count ?? 0;
}

// Calls `onChange` whenever one of your messages is sent, read, opened or unsent.
export function subscribeToMyMessages(name: string, onChange: () => void): () => void {
  const channel = supabase
    .channel(name)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, onChange)
    .subscribe();
  return () => {
    supabase.removeChannel(channel);
  };
}

// Live number of unread chats + unopened peeks waiting for you.
export function useUnreadCount(me: string, active: boolean): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!active) return;
    const refresh = () =>
      countUnread(me)
        .then(setCount)
        .catch(() => {});
    refresh();
    return subscribeToMyMessages(`unread-${me}`, refresh);
  }, [me, active]);

  return count;
}
