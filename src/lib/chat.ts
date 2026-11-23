import { useEffect, useState } from 'react';

import { serverFailure } from './errors';
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
  // 'sticker' = a sticker (`sticker` is its name, body a short text version – see lib/chatStickers.ts).
  kind: 'text' | 'snap' | 'screenshot' | 'voice' | 'reaction' | 'dare' | 'sticker';
  sticker?: string | null;
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

// ⚡ Each chat's last list is remembered while the app is open (only for the person logged in now, and only the
// last 30 chats), so opening a chat again shows its messages at once while it checks for new ones.
const REMEMBERED_CHATS = 30;
let rememberedChats: { me: string; lists: Map<string, Message[]> } | null = null;

export function cachedConversation(me: string, friend: string): Message[] | null {
  return rememberedChats?.me === me ? (rememberedChats.lists.get(friend) ?? null) : null;
}

// The chat screen hands back what it shows (with a message you just sent, deleted or hid), so the next time it opens
// it starts from that.
export function rememberConversation(me: string, friend: string, list: Message[]): void {
  if (rememberedChats?.me !== me) rememberedChats = { me, lists: new Map() };
  const { lists } = rememberedChats;
  lists.delete(friend);
  lists.set(friend, list);
  if (lists.size > REMEMBERED_CHATS) lists.delete(lists.keys().next().value as string);
}

// Newest first.
export async function fetchConversation(me: string, friend: string, limit = 100): Promise<Message[]> {
  let askedAt = hiddenVersion;
  const [{ data, error }, hiddenFirst] = await Promise.all([
    supabase
      .from('messages')
      .select('*, story:stories(media_path, media_type, poster_path)')
      .or(pairFilter(me, friend))
      .order('created_at', { ascending: false })
      .limit(limit),
    fetchHiddenIds(me),
  ]);
  if (error) throw error;
  // You deleted a message "for me" or cleared a chat on this phone while this was loading: the hidden list may be
  // from before that, so ask for it again. (A cleared message must never come back, not even for a moment.)
  let hidden = hiddenFirst;
  while (askedAt !== hiddenVersion) {
    askedAt = hiddenVersion;
    hidden = await fetchHiddenIds(me);
  }
  const list = ((data ?? []) as Message[]).filter((m) => !hidden.has(m.id));
  rememberConversation(me, friend, list);
  return list;
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
// ⚡ The list is remembered while the app is open (for the person logged in now) and asked for again every few
// minutes, instead of being downloaded with every chat load. "Delete for me" and "Clear chat" on this phone make the
// next load ask again straight away. (A message hidden on another phone shows here until the next check.)
const HIDDEN_FRESH_MS = 3 * 60 * 1000;
let hiddenKnown: { me: string; ids: Set<string>; at: number } | null = null;
let hiddenOnTheWay: { me: string; version: number; request: Promise<Set<string>> } | null = null;
// Goes up whenever you hide something here: an answer to a question asked before that is never kept.
let hiddenVersion = 0;

function fetchHiddenIds(me: string): Promise<Set<string>> {
  if (hiddenKnown?.me === me && Date.now() - hiddenKnown.at < HIDDEN_FRESH_MS) return Promise.resolve(hiddenKnown.ids);
  if (hiddenOnTheWay?.me === me && hiddenOnTheWay.version === hiddenVersion) return hiddenOnTheWay.request;
  const version = hiddenVersion;
  const request = (async () => {
    const { data, error } = await supabase
      .from('message_hides')
      .select('message_id')
      .eq('user_id', me)
      .order('hidden_at', { ascending: false })
      .limit(5000);
    // A failed privacy check must not make cleared messages reappear.
    if (error) throw error;
    const ids = new Set((data ?? []).map((row) => row.message_id as string));
    if (version === hiddenVersion) hiddenKnown = { me, ids, at: Date.now() };
    return ids;
  })().finally(() => {
    if (hiddenOnTheWay?.request === request) hiddenOnTheWay = null;
  });
  hiddenOnTheWay = { me, version, request };
  return request;
}

// You just hid something: the next load asks for the hidden list again.
function hiddenChanged() {
  hiddenVersion += 1;
  hiddenKnown = null;
}

// "Delete for me": hides a message (yours or theirs) from your chat only. Your friend still sees it.
export async function hideMessage(messageId: string): Promise<void> {
  try {
    const { error } = await supabase.rpc('hide_message', { message: messageId });
    if (error) throw error;
  } finally {
    // Even when we can't tell if it worked: the remembered chats lose it, so it's never drawn again from them.
    hiddenChanged();
    if (rememberedChats) {
      for (const [friend, list] of rememberedChats.lists) {
        if (list.some((m) => m.id === messageId)) rememberedChats.lists.set(friend, list.filter((m) => m.id !== messageId));
      }
    }
  }
}

// "Clear chat": hides every message in your chat with a friend, from your side only.
export async function clearChat(friend: string): Promise<void> {
  try {
    const { error } = await supabase.rpc('clear_chat', { friend });
    if (error) throw error;
  } finally {
    // Even when we can't tell if it worked: the remembered list for this chat is forgotten, so opening it again
    // never shows the cleared messages (it waits for a fresh load, and shows an empty chat if that fails).
    hiddenChanged();
    rememberedChats?.lists.delete(friend);
  }
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

// A sticker 🏷️ (`text` is its short text version, from stickerText in
// lib/chatStickers.ts). Peekaboo+ stickers only go through while you have Peekaboo+ (the server checks).
export async function sendSticker(me: string, friend: string, sticker: string, text: string, replyTo?: string | null): Promise<Message> {
  const { data, error } = await supabase
    .from('messages')
    .insert({ sender_id: me, recipient_id: friend, kind: 'sticker', sticker, body: text, ...(replyTo ? { reply_to: replyTo } : {}) })
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
    // Undo the upload. If even that fails, you still see the real reason it couldn't be sent.
    await deleteMedia(mediaFiles(fields)).catch((cleanupError) => console.warn('Could not remove an unfinished upload', cleanupError));
    throw error;
  }
}

// 📷 A photo (or video) picked from your Photos, sent in a one-on-one chat: a peek that is SAVED in the chat from the
// start, so it never disappears and opens like a normal photo any time. (A picture taken with the chat's camera
// goes with sendSnap and disappears.) Old copies of the app already know saved peeks, so they show it too.
// The server marks it as saved by you, at the moment it was sent (see isChatPhoto). A server from before this
// clears saved_at on a new message: then it's saved straight after, the normal way.
export async function sendChatPhoto(me: string, friend: string, capture: Capture): Promise<void> {
  const { fields } = await uploadCapture(me, 'snaps', capture);
  const { data, error } = await supabase
    .from('messages')
    .insert({ sender_id: me, recipient_id: friend, kind: 'snap', ...fields, saved_at: new Date().toISOString() })
    .select('id,saved_at')
    .single();
  if (error) {
    // Undo the upload. If even that fails, you still see the real reason it couldn't be sent.
    await deleteMedia(mediaFiles(fields)).catch((cleanupError) => console.warn('Could not remove an unfinished upload', cleanupError));
    throw error;
  }
  const row = data as { id: string; saved_at: string | null } | null;
  if (row && !row.saved_at) {
    // The photo is sent either way. If saving fails, it's a normal peek – never sent twice.
    await setSnapSaved(row.id, true).catch((saveError) => console.warn('Could not save the photo in the chat', saveError));
  }
}

// ---------------------------------------------------------------------------
// Saving messages for the outbox (lib/outbox.ts). Each row gets its id on the phone BEFORE the first try, so a
// try repeated after a lost answer can look the row up first, and a second copy is impossible (the server says
// "duplicate key", 23505). They throw an error that keeps the server's code and status (lib/errors.ts), so the
// outbox can tell a clear "no" from a lost answer.
// ---------------------------------------------------------------------------

// Peeks (one photo or video, already uploaded) to one or more friends: one row each, with the ids given.
// `savedPhoto`: a photo picked from Photos, saved in the chat from the start (see sendChatPhoto).
export async function insertSnaps(
  me: string,
  rows: { id: string; friendId: string }[],
  fields: MediaFields,
  options: { savedPhoto?: boolean } = {},
): Promise<Message[]> {
  const savedAt = options.savedPhoto ? new Date().toISOString() : null;
  const { data, error, status } = await supabase
    .from('messages')
    .insert(
      rows.map((row) => ({
        id: row.id,
        sender_id: me,
        recipient_id: row.friendId,
        kind: 'snap',
        ...fields,
        ...(savedAt ? { saved_at: savedAt } : {}),
      })),
    )
    .select('*');
  if (error) throw serverFailure(error, status);
  return (data ?? []) as Message[];
}

// One text, sticker, dare or voice note, with the id given.
export type NewMessage = {
  id: string;
  friendId: string;
  kind: 'text' | 'sticker' | 'dare' | 'voice';
  body?: string | null;
  sticker?: string | null;
  replyTo?: string | null;
  media_path?: string | null;
  audio_ms?: number | null;
  waveform?: number[] | null;
};

export async function insertMessage(me: string, row: NewMessage): Promise<Message> {
  const { data, error, status } = await supabase
    .from('messages')
    .insert({
      id: row.id,
      sender_id: me,
      recipient_id: row.friendId,
      kind: row.kind,
      ...(row.body !== undefined ? { body: row.kind === 'text' || row.kind === 'dare' ? (row.body ?? '').trim() : row.body } : {}),
      ...(row.sticker ? { sticker: row.sticker } : {}),
      ...(row.replyTo ? { reply_to: row.replyTo } : {}),
      ...(row.media_path ? { media_path: row.media_path } : {}),
      ...(row.audio_ms !== undefined && row.audio_ms !== null ? { audio_ms: row.audio_ms } : {}),
      ...(row.waveform ? { waveform: row.waveform } : {}),
    })
    .select('*')
    .single();
  if (error) throw serverFailure(error, status);
  return data as Message;
}

// The messages with these ids that you can see (the ones that really were saved).
export async function findMessages(ids: string[]): Promise<Message[]> {
  if (ids.length === 0) return [];
  const { data, error, status } = await supabase.from('messages').select('*').in('id', ids);
  if (error) throw serverFailure(error, status);
  return (data ?? []) as Message[];
}

// Was this sent as a photo (picked from Photos), not as a peek? It's a peek saved by whoever sent it, at the very
// moment it was sent. (A peek someone saved later is a "saved peek".)
export function isChatPhoto(message: Pick<Message, 'kind' | 'sender_id' | 'created_at' | 'saved_at' | 'saved_by'>): boolean {
  return (
    message.kind === 'snap' &&
    !!message.saved_at &&
    message.saved_by === message.sender_id &&
    Date.parse(message.saved_at) === Date.parse(message.created_at)
  );
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

// One-minute links for all of a peek's files (its photo or video, a video's still picture and its text layer) in ONE
// request instead of one each. A file that couldn't be signed is simply left out.
export async function getSnapUrls(paths: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(paths.filter(Boolean))];
  if (unique.length === 0) return {};
  const { data, error } = await supabase.storage.from('media').createSignedUrls(unique, 60);
  if (error || !data) return {};
  const links: Record<string, string> = {};
  for (const item of data) {
    if (item.path && item.signedUrl && !item.error) links[item.path] = item.signedUrl;
  }
  return links;
}

export async function markChatRead(friend: string): Promise<void> {
  const { error } = await supabase.rpc('mark_chat_read', { friend });
  if (error) throw error;
}

export async function deleteMessage(message: Message): Promise<void> {
  const { error } = await supabase.from('messages').delete().eq('id', message.id);
  if (error) throw error;
  // The message is deleted now. Tidying up its photo or voice file is extra: if that fails, it is only
  // noted (the daily clean-up can still remove the file), and the delete still counts as done.
  if (message.media_path) {
    await cleanUpSnapFile(message).catch((cleanupError) => console.warn('Could not remove the file of a deleted message', cleanupError));
  }
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

// What changed: a new or changed message comes with its row; an unsent (deleted) one only says its id.
export type MessageChange = {
  eventType?: string;
  new?: Partial<Pick<Message, 'id' | 'sender_id' | 'recipient_id'>> | null;
  old?: Partial<Pick<Message, 'id' | 'sender_id' | 'recipient_id'>> | null;
};

// Calls `onChange` whenever one of your messages is sent, read, opened or unsent (in any of your chats).
let messageListener = 0;
export function subscribeToMyMessages(name: string, onChange: (change?: MessageChange) => void): () => void {
  const channel = supabase
    .channel(`${name}-${++messageListener}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, (change) => onChange(change as MessageChange))
    .subscribe();
  return () => {
    supabase.removeChannel(channel);
  };
}

// Is this change about your chat with `friend`? `shown(id)` says whether a message is on screen there (an unsent
// message only says its id). Anything unclear counts: better one load too many than a missed message.
function changeIsForChat(change: MessageChange | undefined, me: string, friend: string, shown: (id: string) => boolean): boolean {
  const row = change?.new && Object.keys(change.new).length > 0 ? change.new : change?.old;
  if (!row) return true;
  if (row.sender_id && row.recipient_id) {
    return (row.sender_id === me && row.recipient_id === friend) || (row.sender_id === friend && row.recipient_id === me);
  }
  return row.id ? shown(row.id) : true;
}

// ⚡ Calls `onChange` only when a message between you and `friend` is sent, read, opened or unsent. Before, a message in
// ANY of your chats reloaded the chat on screen (4–6 requests each time; the logs showed 8 reloads in 25 seconds).
export function subscribeToChat(me: string, friend: string, shown: (id: string) => boolean, onChange: () => void): () => void {
  return subscribeToMyMessages(`chat-${me}-${friend}`, (change) => {
    if (changeIsForChat(change, me, friend, shown)) onChange();
  });
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
