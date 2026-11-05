import { deleteAvatar, deleteMedia, mediaFiles, uploadAvatar, uploadCapture, uploadMedia, type Capture } from './media';
import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// Group chat 💬: every Group Peek group has its own chat (supabase/migrations/20261210000000_group_chat.sql).
// Members read and write; you can delete your own messages; everyone else gets a push unless they muted it.
// ---------------------------------------------------------------------------

// 'text' · 'photo' / 'video' (stay in the chat) · 'voice' · 'dare' (a dare for the whole group) ·
// 'proof' (someone's photo/video for a group dare – dare_id says which).
export type GroupMessage = {
  id: string;
  group_id: string;
  sender_id: string;
  kind: 'text' | 'photo' | 'video' | 'voice' | 'dare' | 'proof';
  body: string | null;
  media_path: string | null;
  media_type: 'photo' | 'video' | null;
  poster_path: string | null;
  overlay_path: string | null;
  audio_ms: number | null;
  waveform: number[] | null;
  dare_id: string | null;
  // The earlier message in this group chat that this one replies to.
  reply_to?: string | null;
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
