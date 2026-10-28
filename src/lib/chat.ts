import { useEffect, useState } from 'react';

import { deleteMedia, uploadMedia } from './media';
import { supabase } from './supabase';

export type Message = {
  id: string;
  sender_id: string;
  recipient_id: string;
  kind: 'text' | 'snap';
  body: string | null;
  media_path: string | null;
  created_at: string;
  // When the other person read the message / opened the snap.
  opened_at: string | null;
};

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

// One photo, sent as a snap to one or more friends.
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

// Marks a snap as opened. After this the photo can never be loaded again.
export async function openSnap(messageId: string): Promise<void> {
  const { error } = await supabase.rpc('open_snap', { message_id: messageId });
  if (error) throw error;
}

// A link to a snap's photo that only works for one minute.
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

// Deletes a snap photo you sent once every friend you sent it to has opened it (or it was unsent).
async function cleanUpSnapFile(me: string, mediaPath: string): Promise<void> {
  const { data } = await supabase
    .from('messages')
    .select('opened_at')
    .eq('sender_id', me)
    .eq('media_path', mediaPath);
  if ((data ?? []).every((row) => row.opened_at !== null)) {
    await deleteMedia([mediaPath]);
  }
}

// Called when you open a chat: tidies up photos of your snaps that were already opened.
export async function cleanUpOpenedSnaps(me: string, messages: Message[]): Promise<void> {
  const paths = new Set(
    messages
      .filter((message) => message.sender_id === me && message.kind === 'snap' && message.opened_at && message.media_path)
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

// Live number of unread chats + unopened snaps waiting for you.
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
