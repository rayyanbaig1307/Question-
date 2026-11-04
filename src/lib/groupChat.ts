import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// Group chat 💬: every Group Peek group has its own chat (supabase/migrations/20261210000000_group_chat.sql).
// Members read and write; you can delete your own messages; everyone else gets a push unless they muted it.
// ---------------------------------------------------------------------------

export type GroupMessage = {
  id: string;
  group_id: string;
  sender_id: string;
  body: string;
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

// Deletes your own message for everyone in the group.
export async function deleteGroupMessage(id: string): Promise<void> {
  const { error } = await supabase.from('group_messages').delete().eq('id', id);
  if (error) throw error;
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
