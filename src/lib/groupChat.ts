import { deleteMedia, mediaFiles, uploadCapture, uploadMedia, type Capture } from './media';
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
  created_at: string;
};

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

export async function sendGroupMessage(groupId: string, body: string): Promise<GroupMessage> {
  const { data, error } = await supabase
    .from('group_messages')
    .insert({ group_id: groupId, body: body.trim() })
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
    await deleteMedia(mediaFiles(fields));
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
    await deleteMedia([media_path]);
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
  const files = [message.media_path, message.poster_path, message.overlay_path].filter((f): f is string => !!f);
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

// Each listener gets its own channel name (two listeners on one name crash the realtime library).
let listener = 0;
export function subscribeToGroupChat(groupId: string | null, onChange: () => void): () => void {
  const channel = supabase.channel(`group-chat-${groupId ?? 'all'}-${++listener}`);
  channel.on(
    'postgres_changes',
    groupId
      ? { event: '*', schema: 'public', table: 'group_messages', filter: `group_id=eq.${groupId}` }
      : { event: '*', schema: 'public', table: 'group_messages' },
    onChange,
  );
  channel.subscribe();
  return () => {
    supabase.removeChannel(channel);
  };
}
