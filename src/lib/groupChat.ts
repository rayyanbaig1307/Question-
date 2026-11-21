import { deleteAvatar, deleteMedia, mediaFiles, uploadAvatar, uploadCapture, uploadMedia, type Capture } from './media';
import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// Group chat 💬: every Group Peek group has its own chat (supabase/migrations/20261210000000_group_chat.sql).
// Members read and write; you can delete your own messages; everyone else gets a push unless they muted it.
// ---------------------------------------------------------------------------

// 'text' · 'photo' / 'video' (stay in the chat) · 'voice' · 'dare' (a dare for the whole group) ·
// 'sticker' (body is a short text version) · 'proof' (someone's photo/video for a group dare – dare_id says which) ·
// 'snap' (a photo/video from the chat's camera: each person opens it once, then it's gone unless it's saved).
export type GroupMessage = {
  id: string;
  group_id: string;
  sender_id: string;
  kind: 'text' | 'photo' | 'video' | 'voice' | 'dare' | 'proof' | 'sticker' | 'snap';
  body: string | null;
  // Stickers: which one (see lib/chatStickers.ts).
  sticker?: string | null;
  media_path: string | null;
  media_type: 'photo' | 'video' | null;
  poster_path: string | null;
  overlay_path: string | null;
  audio_ms: number | null;
  waveform: number[] | null;
  dare_id: string | null;
  // The earlier message in this group chat that this one replies to.
  reply_to?: string | null;
  // A snap: when it was saved in the chat and by whom (null = not saved). A saved snap is a normal photo everyone in
  // the group can open again. Missing on a server without group snaps yet.
  saved_at?: string | null;
  saved_by?: string | null;
  // A proof: the group's votes (anonymous totals, see voteGroupProof), and whether it was posted before voting
  // existed (those keep counting while nobody has a vote on them). Missing on a server without votes yet.
  proof_legit?: number;
  proof_cap?: number;
  proof_legacy?: boolean;
  created_at: string;
};

// What the group decided about a proof:
// 'counts' (more Legit 🔥 than Cap 🧢 votes) · 'legacy' (posted before voting existed, and nobody has voted on
// it yet: it counts, like before) · 'waiting' (no votes yet) · 'tie' · 'cap' (more Cap votes: it doesn't count).
// The database has the same rule (private.group_proof_counts in
// supabase/migrations/20261216000000_group_dare_votes.sql) for dare streaks. Keep the two the same
// (tests/unit/group-proof-parity.test.mjs checks that they agree).
export type ProofOutcome = 'counts' | 'legacy' | 'waiting' | 'tie' | 'cap';

export function proofOutcome(proof: Pick<GroupMessage, 'proof_legit' | 'proof_cap' | 'proof_legacy'>): ProofOutcome {
  // A server without votes yet (no totals at all): the old rule, a proof counts at once.
  if (proof.proof_legit === undefined && proof.proof_cap === undefined) return 'legacy';
  const legit = proof.proof_legit ?? 0;
  const cap = proof.proof_cap ?? 0;
  if (legit === 0 && cap === 0) return proof.proof_legacy ? 'legacy' : 'waiting';
  if (legit > cap) return 'counts';
  return legit === cap ? 'tie' : 'cap';
}

// Does this proof count as doing the dare (for "X of N did it", "✅ You did it" and dare streaks)?
export function proofCounts(proof: Pick<GroupMessage, 'proof_legit' | 'proof_cap' | 'proof_legacy'>): boolean {
  const outcome = proofOutcome(proof);
  return outcome === 'counts' || outcome === 'legacy';
}

// Can you vote Legit / Cap on this proof? Never on your own. Only people who were already in the group when it
// was posted can vote: someone added later can't vote on older proofs (the server checks this too, in
// public.vote_group_proof). `joinedAt` is when you joined the group (fetchMyGroupJoin); null if that isn't known
// yet or couldn't be loaded – then the buttons show and the server decides.
export function canVoteOnProof(proof: Pick<GroupMessage, 'sender_id' | 'created_at'>, me: string, joinedAt: string | null): boolean {
  if (proof.sender_id === me) return false;
  if (!joinedAt) return true;
  // A time that can't be read counts as "not known" too (NaN > anything is false).
  return !(Date.parse(joinedAt) > Date.parse(proof.created_at));
}

// Your groups' chat summaries for the Chat list: unread count, latest message, muted or not.
export type GroupChatSummary = {
  group_id: string;
  unread: number;
  last_body: string | null;
  last_at: string | null;
  last_sender: string | null;
  muted: boolean;
};

export async function fetchGroupMessages(groupId: string, limit = 150): Promise<GroupMessage[]> {
  const { data, error } = await supabase
    .from('group_messages')
    .select('*')
    .eq('group_id', groupId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as GroupMessage[];
}

export async function sendGroupMessage(groupId: string, body: string, replyTo?: string | null): Promise<GroupMessage> {
  const { data, error } = await supabase
    .from('group_messages')
    .insert({ group_id: groupId, body: body.trim(), ...(replyTo ? { reply_to: replyTo } : {}) })
    .select('*')
    .single();
  if (error) throw error;
  return data as GroupMessage;
}

// A sticker 🏷️ for the group (`text` is its short text version, from stickerText in
// lib/chatStickers.ts). Peekaboo+ stickers only go through while you have Peekaboo+ (the server checks).
export async function sendGroupSticker(groupId: string, sticker: string, text: string, replyTo?: string | null): Promise<GroupMessage> {
  const { data, error } = await supabase
    .from('group_messages')
    .insert({ group_id: groupId, kind: 'sticker', sticker, body: text, ...(replyTo ? { reply_to: replyTo } : {}) })
    .select('*')
    .single();
  if (error) throw error;
  return data as GroupMessage;
}

// A photo or video for the group chat (or, with `dareId`, your proof for a group dare).
export async function sendGroupCapture(me: string, groupId: string, capture: Capture, dareId?: string): Promise<void> {
  const { fields } = await uploadCapture(me, 'group', capture);
  const { error } = await supabase
    .from('group_messages')
    .insert({ group_id: groupId, kind: dareId ? 'proof' : fields.media_type, dare_id: dareId ?? null, ...fields });
  if (error) {
    // Undo the upload. If even that fails, you still see the real reason it couldn't be sent.
    await deleteMedia(mediaFiles(fields)).catch((cleanupError) => console.warn('Could not remove an unfinished upload', cleanupError));
    throw error;
  }
}

// 👀 A snap for the group chat: a photo or video taken with the chat's camera. Everyone else in the group can open it
// once (and replay it once); then it's gone for them – unless someone saves it in the chat (see setGroupSnapSaved),
// then it stays as a normal photo everyone can open. The file goes in your "snaps" folder: the server only lets
// someone download it for a few minutes after they open it, so an older copy of the app (which doesn't know snaps)
// can never show it as a normal photo. Pictures picked from Photos go with sendGroupCapture instead.
export async function sendGroupSnap(me: string, groupId: string, capture: Capture): Promise<void> {
  const { fields } = await uploadCapture(me, 'snaps', capture);
  const { error } = await supabase.from('group_messages').insert({ group_id: groupId, kind: 'snap', ...fields });
  if (error) {
    // Undo the upload. If even that fails, you still see the real reason it couldn't be sent.
    await deleteMedia(mediaFiles(fields)).catch((cleanupError) => console.warn('Could not remove an unfinished upload', cleanupError));
    throw snapsNotReady(error) ? new Error(SNAPS_NOT_READY) : error;
  }
}

// The server doesn't take group snaps yet (its list of message kinds doesn't have 'snap'). Then the snap isn't
// sent as a normal photo instead – it was meant to disappear – and you're told what you can do.
export const SNAPS_NOT_READY =
  "Snaps in group chats aren't switched on yet. Try again a bit later, or pick the photo from your camera roll to send it as a normal photo.";
function snapsNotReady(error: { code?: string | null; message?: string | null }): boolean {
  return error.code === '23514' && /group_messages_(kind_check|content)/.test(error.message ?? '');
}

// ---------------------------------------------------------------------------
// 👀 Group snaps: who opened what, and opening / replaying / saving one.
// (Server: supabase/migrations/20261229000000_group_snaps.sql.)
// ---------------------------------------------------------------------------

// A group snap can be opened (and replayed) for 24 hours after it was sent. Then it's gone – unless it's saved.
export const GROUP_SNAP_LIFETIME_MS = 24 * 60 * 60 * 1000;

// Someone opened a snap: when, when they used their one replay (null = not yet), and when they took a screenshot of
// it (null = they didn't – or a server that doesn't say).
export type GroupSnapOpen = {
  message_id: string;
  user_id: string;
  opened_at: string;
  replayed_at: string | null;
  screenshot_at?: string | null;
};

// Who opened these snaps. You only get your own opens – and, for snaps YOU sent, everyone's (so you can see
// "Opened by …"). Snap id → its opens. A server without group snaps yet gives an error (the screen keeps what it has).
export async function fetchGroupSnapOpens(messageIds: string[]): Promise<Map<string, GroupSnapOpen[]>> {
  const opens = new Map<string, GroupSnapOpen[]>();
  if (messageIds.length === 0) return opens;
  const { data, error } = await supabase
    .from('group_snap_opens')
    .select('message_id,user_id,opened_at,replayed_at,screenshot_at')
    .in('message_id', messageIds);
  if (error) throw error;
  for (const row of (data ?? []) as GroupSnapOpen[]) opens.set(row.message_id, [...(opens.get(row.message_id) ?? []), row]);
  return opens;
}

// One group message (null if it's gone, or you can't see it).
export async function fetchGroupMessage(messageId: string): Promise<GroupMessage | null> {
  const { data, error } = await supabase.from('group_messages').select('*').eq('id', messageId).maybeSingle();
  if (error) throw error;
  return (data as GroupMessage | null) ?? null;
}

// Opens a snap: true = go, you may download it for the next 5 minutes (it's now marked as opened by you). A saved
// snap always says true while you're in the group. false = no view left (you already opened it – replay it – or
// it's over 24 hours old, or you joined the group after it was sent).
export async function openGroupSnap(messageId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('open_group_snap', { message: messageId });
  if (error) throw error;
  return data === true;
}

// Your one replay of a snap you opened: true = go (download it within 5 minutes); false = already used, or too late.
export async function replayGroupSnap(messageId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('replay_group_snap', { message: messageId });
  if (error) throw error;
  return data === true;
}

// Saves a snap in the chat (it becomes a normal photo everyone in the group can open again), or unsaves it.
// Saving: whoever sent it, or anyone who opened it, within 24 hours of it being sent. Unsaving: whoever saved it,
// or whoever sent it. false = not allowed (or nothing changed).
export async function setGroupSnapSaved(messageId: string, save: boolean): Promise<boolean> {
  const { data, error } = await supabase.rpc('set_group_snap_saved', { message: messageId, save });
  if (error) throw error;
  return data === true;
}

// 📸 You took a screenshot of a group snap you opened: its sender is told (a push, and "📸 Screenshot by …" under the
// snap in their chat), like with a 1:1 peek. Once per snap. true = they were told; false = nothing to tell (it's
// saved, it's yours, you didn't open it, or you already took one).
export async function groupSnapScreenshot(messageId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('group_snap_screenshot', { message: messageId });
  if (error) throw error;
  return data === true;
}

// 👀 A group snap is opened first and downloaded after (the server only lets you download it for 5 minutes after you
// open it, on this phone). If the download fails, or you go back while it's still downloading, you never saw it: for
// the next few minutes, tapping it again shows it without using up your replay. This phone remembers which ones –
// only while the app is open (after that, the chat says "Tap to replay" and that's what a tap does).
export const UNSHOWN_RETRY_MS = 4 * 60 * 1000;
type UnshownMode = 'first' | 'replay';
// (Per login: someone else signing in on this phone has their own.)
const unshownGroupSnaps = new Map<string, { at: number; mode: UnshownMode }>();
const unshownKey = (me: string, messageId: string) => `${me}:${messageId}`;

// You opened (or replayed) it just now, and it isn't shown yet.
export function noteGroupSnapUnshown(me: string, messageId: string, mode: UnshownMode, now = Date.now()): void {
  unshownGroupSnaps.set(unshownKey(me, messageId), { at: now, mode });
}

// It was shown: nothing to try again.
export function forgetGroupSnapUnshown(me: string, messageId: string): void {
  unshownGroupSnaps.delete(unshownKey(me, messageId));
}

// Opened on this phone a moment ago but never shown: which view it was ('first' or 'replay'), or null. `extraMs`: the
// snap viewer allows half a minute more than the chat shows "Tap to view" (the chat's clock moves every 15 seconds),
// still well inside the server's 5 minutes.
export function groupSnapUnshown(me: string, messageId: string, now = Date.now(), extraMs = 0): UnshownMode | null {
  const unshown = unshownGroupSnaps.get(unshownKey(me, messageId));
  return unshown && now - unshown.at < UNSHOWN_RETRY_MS + extraMs ? unshown.mode : null;
}

// How a snap in the group chat looks for you:
// 'saved' – saved in the chat: a normal photo for everyone · 'sent' – you sent it (not saved) ·
// 'new' – you haven't opened it yet · 'retry' – you opened it on this phone a moment ago but it didn't load, so a tap
// shows it without using your replay (see UNSHOWN_RETRY_MS) · 'replay' – opened, your one replay is left ·
// 'opened' – opened and replayed · 'expired' – over 24 hours old and you never opened it ·
// 'before-joined' – sent before you joined the group.
export type GroupSnapLook = 'saved' | 'sent' | 'new' | 'retry' | 'replay' | 'opened' | 'expired' | 'before-joined';

export function groupSnapLook(
  snap: Pick<GroupMessage, 'sender_id' | 'created_at' | 'saved_at'>,
  me: string,
  myOpen: Pick<GroupSnapOpen, 'replayed_at'> | undefined,
  joinedAt: string | null,
  now: number,
  // Opened on this phone but not shown yet (groupSnapUnshown).
  unshown = false,
): GroupSnapLook {
  if (snap.saved_at) return 'saved';
  if (snap.sender_id === me) return 'sent';
  if (unshown) return 'retry';
  const over = !(now - Date.parse(snap.created_at) < GROUP_SNAP_LIFETIME_MS);
  if (myOpen) return !over && myOpen.replayed_at === null ? 'replay' : 'opened';
  if (over) return 'expired';
  // Someone added after it was sent can't open it (the server says no too). A join time that isn't known yet
  // (or can't be read) lets you try: the server decides.
  if (joinedAt && Date.parse(joinedAt) > Date.parse(snap.created_at)) return 'before-joined';
  return 'new';
}

// Is a snap still in its 24 hours?
export function groupSnapLive(snap: Pick<GroupMessage, 'created_at'>, now: number): boolean {
  return now - Date.parse(snap.created_at) < GROUP_SNAP_LIFETIME_MS;
}

// Can you save this snap in the chat? Whoever sent it, or anyone who opened it, within its 24 hours.
export function canSaveGroupSnap(
  snap: Pick<GroupMessage, 'kind' | 'sender_id' | 'created_at' | 'saved_at'>,
  me: string,
  myOpen: unknown,
  now: number,
): boolean {
  return snap.kind === 'snap' && !snap.saved_at && groupSnapLive(snap, now) && (snap.sender_id === me || !!myOpen);
}

// Can you unsave it? Whoever saved it, or whoever sent it.
export function canUnsaveGroupSnap(snap: Pick<GroupMessage, 'kind' | 'sender_id' | 'saved_at' | 'saved_by'>, me: string): boolean {
  return snap.kind === 'snap' && !!snap.saved_at && (snap.saved_by === me || snap.sender_id === me);
}

// A voice note for the group chat.
export async function sendGroupVoice(
  me: string,
  groupId: string,
  uri: string,
  durationMs: number,
  waveform: number[],
): Promise<GroupMessage> {
  const media_path = await uploadMedia(me, 'voice', uri, 'audio');
  const { data, error } = await supabase
    .from('group_messages')
    .insert({ group_id: groupId, kind: 'voice', media_path, audio_ms: Math.round(durationMs), waveform })
    .select('*')
    .single();
  if (error) {
    // Undo the upload. If even that fails, you still see the real reason it couldn't be sent.
    await deleteMedia([media_path]).catch((cleanupError) => console.warn('Could not remove an unfinished upload', cleanupError));
    throw error;
  }
  return data as GroupMessage;
}

// 🎯 Dare the whole group: everyone can post their proof in the chat.
export async function sendGroupDare(groupId: string, dare: string): Promise<GroupMessage> {
  const { data, error } = await supabase
    .from('group_messages')
    .insert({ group_id: groupId, kind: 'dare', body: dare.trim() })
    .select('*')
    .single();
  if (error) throw error;
  return data as GroupMessage;
}

// 🔥 / 🧢 Vote on someone's proof for a group dare: legit = true (it's real), false (cap, it's fake), or null to
// take your vote back. Everyone who was in the group when the proof was posted, except the poster, can vote,
// once each (see canVoteOnProof). `me` is the account on screen: the server refuses the vote if a different
// account is logged in by now. Gives back the new totals, your vote, and whether it still counts as a proof from
// before voting existed (false once anyone has voted).
export async function voteGroupProof(
  me: string,
  proofId: string,
  legit: boolean | null,
): Promise<{ legit: number; cap: number; mine: boolean | null; legacy?: boolean }> {
  const { data, error } = await supabase.rpc('vote_group_proof', { proof: proofId, legit, expected_user_id: me });
  if (error) throw error;
  const result = (data ?? {}) as { legit?: number; cap?: number; mine?: boolean | null; legacy?: boolean };
  return {
    legit: result.legit ?? 0,
    cap: result.cap ?? 0,
    mine: result.mine ?? null,
    ...(typeof result.legacy === 'boolean' ? { legacy: result.legacy } : {}),
  };
}

// Your own votes on these proofs (proof id → true for legit, false for cap). Votes are anonymous: the server only
// ever shows you your own. If it fails, the screen keeps what it already shows.
export async function fetchMyProofVotes(me: string, proofIds: string[]): Promise<Map<string, boolean>> {
  if (proofIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from('group_proof_votes')
    .select('proof_id, legit')
    .eq('user_id', me)
    .in('proof_id', proofIds);
  if (error) throw error;
  return new Map((data ?? []).map((row) => [row.proof_id as string, row.legit as boolean]));
}

// When you joined this group (only people who were in the group when a proof was posted can vote on it).
// null if you're not in it. Only the server sets this time.
export async function fetchMyGroupJoin(groupId: string, me: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('peek_group_members')
    .select('joined_at')
    .eq('group_id', groupId)
    .eq('user_id', me)
    .maybeSingle();
  if (error) throw error;
  return (data as { joined_at?: string } | null)?.joined_at ?? null;
}

// 📌 Pin a message to the top of the group chat (null = unpin). Any member can.
export async function pinGroupMessage(groupId: string, messageId: string | null): Promise<void> {
  const { error } = await supabase.rpc('pin_group_message', { grp: groupId, message: messageId });
  if (error) throw error;
}

// The group's picture: uploaded like a profile picture (your own folder), then set for the group. null removes it.
export async function setGroupPhoto(me: string, groupId: string, localUri: string | null): Promise<void> {
  const photo = localUri ? await uploadAvatar(me, localUri) : null;
  let failure: unknown = null;
  let refused = false;
  try {
    const { error, status } = await supabase.rpc('set_group_photo', { grp: groupId, photo });
    failure = error;
    refused = !!error && serverSaidNo(error, status);
  } catch (error) {
    // The request never got an answer (no internet, timed out…).
    failure = error;
  }
  if (!failure) return;
  // Only remove the new upload when the server clearly said no. If the answer got lost on the way (bad
  // signal), the server may still have saved the picture – even a moment later – so the file is kept
  // (better a spare file, which the daily clean-up can deal with, than a broken group picture).
  if (photo && refused) {
    await deleteAvatar(photo).catch((cleanupError) => console.warn('Could not remove an unfinished group photo', cleanupError));
  }
  throw failure;
}

// Did the server clearly refuse (rather than the answer getting lost)? The database's own errors carry a code
// (like "P0001"), and a refusal comes with an HTTP status from 400 to 499. A network failure has neither
// (status 0). A 5xx status without a code usually comes from a gateway that gave up waiting, while the
// database may still have saved the change, so that doesn't count as a clear "no".
function serverSaidNo(error: { code?: string | null }, status: number | undefined): boolean {
  if (typeof error.code === 'string' && error.code !== '') return true;
  return typeof status === 'number' && status >= 400 && status < 500;
}

// Live: the group itself changed (new pin, photo or name). Own channel name per listener.
export function subscribeToGroup(groupId: string, onChange: () => void): () => void {
  const channel = supabase.channel(`group-${groupId}-${++listener}`);
  channel.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'peek_groups', filter: `id=eq.${groupId}` }, onChange);
  channel.subscribe();
  return () => {
    supabase.removeChannel(channel);
  };
}

// When each member last read the chat (for "Seen by …").
export async function fetchGroupReads(groupId: string): Promise<Map<string, string>> {
  const { data, error } = await supabase.from('peek_group_members').select('user_id, chat_read_at').eq('group_id', groupId);
  if (error) return new Map();
  return new Map((data ?? []).map((row) => [row.user_id as string, row.chat_read_at as string]));
}

// 🔎 Messages in this group chat containing `text` (newest first).
export async function searchGroupMessages(groupId: string, text: string): Promise<GroupMessage[]> {
  const needle = text.trim().replace(/[%_,()]/g, ' ');
  if (!needle) return [];
  const { data, error } = await supabase
    .from('group_messages')
    .select('*')
    .eq('group_id', groupId)
    .ilike('body', `%${needle}%`)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as GroupMessage[];
}

// Deletes your own message for everyone in the group.
export async function deleteGroupMessage(message: GroupMessage): Promise<void> {
  const { error } = await supabase.from('group_messages').delete().eq('id', message.id);
  if (error) throw error;
  const files = [...new Set([message.media_path, message.poster_path, message.overlay_path].filter((f): f is string => !!f))];
  for (const path of files) {
    const { data: safe, error: checkError } = await supabase.rpc('can_cleanup_snap', { object_name: path });
    if (checkError || safe !== true) return;
  }
  if (files.length > 0) await deleteMedia(files).catch(() => {});
}

export async function markGroupChatRead(groupId: string): Promise<void> {
  const { error } = await supabase.rpc('mark_group_chat_read', { grp: groupId });
  if (error) throw error;
}

export async function setGroupChatMuted(groupId: string, muted: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_group_chat_muted', { grp: groupId, muted });
  if (error) throw error;
}

// A server without group chat yet: no summaries (the Chat list then shows the groups as before).
export async function fetchGroupChats(): Promise<Map<string, GroupChatSummary>> {
  const { data, error } = await supabase.rpc('my_group_chats');
  if (error) return new Map();
  return new Map(((data ?? []) as GroupChatSummary[]).map((row) => [row.group_id, row]));
}

// What changed in a group chat: a new message, a deleted one, or an 'UPDATE' (a proof's vote totals changed).
// `message` is the changed row as the server sent it (only its id for a deleted one).
export type GroupChatChange = { event: 'INSERT' | 'UPDATE' | 'DELETE'; message: Partial<GroupMessage> };

// Each listener gets its own channel name (two listeners on one name crash the realtime library).
let listener = 0;
export function subscribeToGroupChat(groupId: string | null, onChange: (change: GroupChatChange) => void): () => void {
  const channel = supabase.channel(`group-chat-${groupId ?? 'all'}-${++listener}`);
  channel.on(
    'postgres_changes',
    groupId
      ? { event: '*', schema: 'public', table: 'group_messages', filter: `group_id=eq.${groupId}` }
      : { event: '*', schema: 'public', table: 'group_messages' },
    (payload) =>
      onChange({
        event: payload.eventType,
        message: ((payload.eventType === 'DELETE' ? payload.old : payload.new) ?? {}) as Partial<GroupMessage>,
      }),
  );
  channel.subscribe();
  return () => {
    supabase.removeChannel(channel);
  };
}
