import { supabase } from './supabase';
import type { Profile, ReportContentType } from './types';

export const REPORT_REASONS = [
  'Bullying or harassment',
  'Nudity or sexual content',
  'Hate speech',
  'Violence or threats',
  'Spam or scam',
  'Pretending to be someone else',
  "They're under 13",
  'Something else',
] as const;

export async function reportContent(params: {
  reportedUserId: string;
  contentType: ReportContentType;
  contentId?: string;
  reason: string;
}): Promise<void> {
  const { error } = await supabase.from('reports').insert({
    reported_user_id: params.reportedUserId,
    content_type: params.contentType,
    content_id: params.contentId ?? params.reportedUserId,
    reason: params.reason,
  });
  if (error) throw error;
}

export async function blockUser(userId: string): Promise<void> {
  const { error } = await supabase.rpc('block_user', { target: userId });
  if (error) throw error;
}

export async function unblockUser(me: string, userId: string): Promise<void> {
  const { error } = await supabase.from('blocks').delete().eq('blocker_id', me).eq('blocked_id', userId);
  if (error) throw error;
}

export type BlockedUser = { blocked_id: string; created_at: string; profile: Profile | null };

export async function fetchBlockedUsers(me: string): Promise<BlockedUser[]> {
  const { data, error } = await supabase
    .from('blocks')
    .select('blocked_id, created_at, profile:profiles!blocks_blocked_id_fkey(*)')
    .eq('blocker_id', me)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as BlockedUser[];
}
