import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// Reactions on chat messages ❤️ 😂 🔥 😮 😢 👍 (one-on-one and group chats).
// One reaction per person per message: tap another to change it, the same one again to take it back.
// See supabase/migrations/20261212000000_chat_extras.sql.
// ---------------------------------------------------------------------------

export const REACTIONS = ['❤️', '😂', '🔥', '😮', '😢', '👍'] as const;
export type ReactionEmoji = (typeof REACTIONS)[number];
export type Reaction = { message_id: string; user_id: string; emoji: string };

const table = (group: boolean) => (group ? 'group_message_reactions' : 'message_reactions');

// The reactions on these messages, by message.
export async function fetchReactions(messageIds: string[], group: boolean): Promise<Map<string, Reaction[]>> {
  const byMessage = new Map<string, Reaction[]>();
  if (messageIds.length === 0) return byMessage;
  const { data, error } = await supabase
    .from(table(group))
    .select('message_id, user_id, emoji')
    .in('message_id', messageIds.slice(0, 300));
  // A server without reactions yet: none.
  if (error) return byMessage;
  for (const row of (data ?? []) as Reaction[]) {
    const list = byMessage.get(row.message_id) ?? [];
    list.push(row);
    byMessage.set(row.message_id, list);
  }
  return byMessage;
}

// React (or change your reaction, or take it back if it's the same one).
export async function toggleReaction(
  me: string,
  messageId: string,
  emoji: string,
  current: string | null,
  group: boolean,
): Promise<void> {
  if (current === emoji) {
    const { error } = await supabase.from(table(group)).delete().eq('message_id', messageId).eq('user_id', me);
    if (error) throw error;
    return;
  }
  const { error } = await supabase
    .from(table(group))
    .upsert({ message_id: messageId, user_id: me, emoji }, { onConflict: 'message_id,user_id' });
  if (error) throw error;
}

// Live: calls `onChange` when anyone reacts. Each listener gets its own channel name.
let listener = 0;
export function subscribeToReactions(group: boolean, onChange: () => void): () => void {
  const channel = supabase.channel(`reactions-${group ? 'group' : 'chat'}-${++listener}`);
  channel.on('postgres_changes', { event: '*', schema: 'public', table: table(group) }, onChange);
  channel.subscribe();
  return () => {
    supabase.removeChannel(channel);
  };
}
