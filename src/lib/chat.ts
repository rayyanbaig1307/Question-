import { useEffect, useState } from 'react';

import { deleteMedia, mediaFiles, uploadCapture, type Capture } from './media';
import type { MediaFields, Profile } from './types';
import { supabase } from './supabase';

// A "peek" is a photo sent in chat that disappears once opened (stored with kind 'snap').
// You get one replay within a day of opening it, and either of you can save it in the chat to keep it.
export type Message = {
  id: string;
  sender_id: string;
  recipient_id: string;
  // 'screenshot' = a notice that someone took a screenshot; body is 'chat' or 'peek'.
  // 'voice' = a voice note (media_path is the recording); 'reaction' = an emoji sent from your story.
  // 'dare' = a dare you wrote yourself (body is the dare).
  kind: 'text' | 'snap' | 'screenshot' | 'voice' | 'reaction' | 'dare';
  body: string | null;
  // Peeks: the photo or video (see MediaFields).
  media_path: string | null;
  media_type: MediaFields['media_type'];
  poster_path: string | null;
  overlay_path: string | null;
  created_at: string;
  // When the other person read the message / opened the peek.
  opened_at: string | null;
  // Peeks only: when the one replay was used, and when (and by whom) it was saved in the chat.
  replayed_at: string | null;
  saved_at: string | null;
  saved_by: string | null;
  // Voice notes: how long it is, and its waveform (bars from 0 to 100).
  audio_ms: number | null;
  waveform: number[] | null;
  // Reactions: the story it was for (empty once the story is gone), and – in a chat – a little bit of it to show.
  story_id: string | null;
  story?: Pick<MediaFields, 'media_path' | 'media_type' | 'poster_path'> | null;
  // Dares: null = not done yet · 'claimed' = they say they did it · 'done' = you confirmed ✅ ·
  // 'nope' = you said it didn't count (they can try again).
  dare_state?: 'claimed' | 'done' | 'nope' | null;
  // The earlier message in this chat that this one replies to.
  reply_to?: string | null;
  dare_done_at?: string | null;
};

// The emojis you can send while watching a friend's story.
export const STORY_REACTIONS = ['😂', '🔥', '😍', '😮', '👀'] as const;

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
  const [{ data, error }, hidden] = await Promise.all([
    supabase
      .from('messages')
      .select('*, story:stories(media_path, media_type, poster_path)')
      .or(pairFilter(me, friend))
      .order('created_at', { ascending: false })
      .limit(limit),
    fetchHiddenIds(me),
  ]);
  if (error) throw error;
  return ((data ?? []) as Message[]).filter((m) => !hidden.has(m.id));
}

// 🔎 Messages in your chat with a friend containing `text` (newest first, hidden ones left out).
export async function searchConversation(me: string, friend: string, text: string): Promise<Message[]> {
  const needle = text.trim().replace(/[%_,()]/g, ' ');
  if (!needle) return [];
  const [{ data, error }, hidden] = await Promise.all([
    supabase
      .from('messages')
      .select('*')
      .or(pairFilter(me, friend))
      .in('kind', ['text', 'dare'])
      .ilike('body', `%${needle}%`)
      .order('created_at', { ascending: false })
      .limit(50),
    fetchHiddenIds(me),
  ]);
  if (error) throw error;
  return ((data ?? []) as Message[]).filter((m) => !hidden.has(m.id));
}

// Messages you deleted "for me" (or cleared): hidden from your side only.
async function fetchHiddenIds(me: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('message_hides')
    .select('message_id')
    .eq('user_id', me)
    .order('hidden_at', { ascending: false })
    .limit(5000);
  // A failed privacy check must not make cleared messages reappear.
  if (error) throw error;
  return new Set((data ?? []).map((row) => row.message_id as string));
}

// "Delete for me": hides a message (yours or theirs) from your chat only. Your friend still sees it.
export async function hideMessage(messageId: string): Promise<void> {
  const { error } = await supabase.rpc('hide_message', { message: messageId });
  if (error) throw error;
}

// "Clear chat": hides every message in your chat with a friend, from your side only.
export async function clearChat(friend: string): Promise<void> {
  const { error } = await supabase.rpc('clear_chat', { friend });
  if (error) throw error;
}

// Your recent messages with everyone, newest first (for the chat list).
export async function fetchRecentMessages(me: string): Promise<Message[]> {
  const [{ data, error }, hidden] = await Promise.all([
    supabase
      .from('messages')
      .select('*')
      .or(`sender_id.eq.${me},recipient_id.eq.${me}`)
      .order('created_at', { ascending: false })
      .limit(500),
    fetchHiddenIds(me),
  ]);
  if (error) throw error;
  return ((data ?? []) as Message[]).filter((m) => !hidden.has(m.id));
}

export async function fetchMessage(id: string): Promise<Message | null> {
  const { data, error } = await supabase.from('messages').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data as Message | null;
}

export async function sendText(me: string, friend: string, body: string, replyTo?: string | null): Promise<Message> {
  const { data, error } = await supabase
    .from('messages')
    .insert({ sender_id: me, recipient_id: friend, kind: 'text', body: body.trim(), ...(replyTo ? { reply_to: replyTo } : {}) })
    .select('*')
    .single();
  if (error) throw error;
  return data as Message;
}

// A dare you wrote yourself, sent to a friend in your chat.
export async function sendDare(me: string, friend: string, dare: string): Promise<Message> {
  const { data, error } = await supabase
    .from('messages')
    .insert({ sender_id: me, recipient_id: friend, kind: 'dare', body: dare.trim() })
    .select('*')
    .single();
  if (error) throw error;
  return data as Message;
}

// "I did it": you did the dare a friend sent you (also done for you after you send the proof peek).
export async function claimChatDare(dare: string): Promise<void> {
  const { error } = await supabase.rpc('claim_chat_dare', { dare });
  if (error) throw error;
}

// You sent the dare: confirm they did it (true) or say it doesn't count (false). Returns your dare streak.
export async function confirmChatDare(dare: string, ok: boolean): Promise<number> {
  const { data, error } = await supabase.rpc('confirm_chat_dare', { dare, ok });
  if (error) throw error;
  return (data as number) ?? 0;
}

// Your dare streak with a friend 🔥: dares you two completed in a row (no gap longer than 3 days).
export async function fetchDareStreak(friend: string): Promise<number> {
  const { data, error } = await supabase.rpc('chat_dare_streak', { friend });
  if (error) throw error;
  return (data as number) ?? 0;
}

// The same dare to several friends at once (each gets it in their chat with you).
export async function sendDareTo(me: string, friends: string[], dare: string): Promise<void> {
  if (friends.length === 0) return;
  const { error } = await supabase
    .from('messages')
    .insert(friends.map((friend) => ({ sender_id: me, recipient_id: friend, kind: 'dare', body: dare.trim() })));
  if (error) throw error;
}

// Dares friends wrote for you in the last week, newest first, with who sent them.
export type DareForMe = { id: string; body: string; created_at: string; from: Profile };
export async function fetchDaresForMe(me: string): Promise<DareForMe[]> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('messages')
    .select('id, body, created_at, sender:profiles!messages_sender_id_fkey(*)')
    .eq('recipient_id', me)
    .eq('kind', 'dare')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  return ((data ?? []) as unknown as { id: string; body: string; created_at: string; sender: Profile | null }[])
    .filter((row) => row.sender)
    .map((row) => ({ id: row.id, body: row.body, created_at: row.created_at, from: row.sender as Profile }));
}

// A reaction to a friend's story. It shows up in your chat with them.
export async function sendReaction(me: string, friend: string, emoji: string, storyId: string): Promise<void> {
  const { error } = await supabase
    .from('messages')
    .insert({ sender_id: me, recipient_id: friend, kind: 'reaction', body: emoji, story_id: storyId });
  if (error) throw error;
}

// Lets your friend know you took a screenshot of the chat or of their peek.
export async function sendScreenshotNotice(me: string, friend: string, what: 'chat' | 'peek'): Promise<void> {
  const { error } = await supabase
    .from('messages')
    .insert({ sender_id: me, recipient_id: friend, kind: 'screenshot', body: what });
  if (error) throw error;
}

// One photo or video, sent as a peek to one or more friends.
export async function sendSnap(me: string, friendIds: string[], capture: Capture): Promise<void> {
  const { fields } = await uploadCapture(me, 'snaps', capture);
  const { error } = await supabase
    .from('messages')
    .insert(friendIds.map((friend) => ({ sender_id: me, recipient_id: friend, kind: 'snap', ...fields })));
  if (error) {
    await deleteMedia(mediaFiles(fields));
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
  if (message.media_path) await cleanUpSnapFile(message);
}

// A peek's photo is no longer needed once it was opened over a day ago (no replay or save left) and isn't saved.
const photoNoLongerNeeded = (row: Pick<Message, 'opened_at' | 'saved_at'>) =>
  row.opened_at !== null &&
  row.saved_at === null &&
  Date.now() - new Date(row.opened_at).getTime() >= KEEP_AFTER_OPENING_MS;

// Deletes a peek's files you sent once nobody you sent it to needs them any more (or it was unsent).
async function cleanUpSnapFile(peek: Pick<Message, 'media_path' | 'poster_path' | 'overlay_path'>): Promise<void> {
  if (!peek.media_path) return;
  // The server checks every recipient, including rows hidden from this person's chat.
  // It also claims the path so Storage can recheck if a report or another use appears before deletion.
  const paths = [...new Set(mediaFiles({ ...peek, media_path: peek.media_path }))];
  for (const path of paths) {
    const { data, error } = await supabase.rpc('can_cleanup_snap', { object_name: path });
    if (error || data !== true) return;
  }
  await deleteMedia(paths);
}

// Called when you open a chat: tidies up photos of your peeks that nobody needs any more.
export async function cleanUpOpenedSnaps(me: string, messages: Message[]): Promise<void> {
  const peeks = new Map<string, Message>();
  for (const message of messages) {
    if (message.sender_id === me && message.kind === 'snap' && message.media_path && photoNoLongerNeeded(message)) {
      peeks.set(message.media_path, message);
    }
  }
  for (const peek of peeks.values()) {
    await cleanUpSnapFile(peek).catch(() => {});
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
let messageListener = 0;
export function subscribeToMyMessages(name: string, onChange: () => void): () => void {
  const channel = supabase
    .channel(`${name}-${++messageListener}`)
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
