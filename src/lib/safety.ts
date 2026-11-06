import { supabase } from './supabase';
import type { Profile, ReportContentType } from './types';

// What you can pick when reporting something. The short code is what's saved (the server takes any short text,
// so a new reason needs no database change).
export const REPORT_REASONS = [
  { code: 'spam', label: 'Spam 🗑️' },
  { code: 'bullying', label: 'Bullying 😢' },
  { code: 'nudity', label: 'Nudity 🔞' },
  { code: 'dangerous_dare', label: 'Dangerous dare 🚑' },
  { code: 'self_harm', label: 'Self-harm' },
  { code: 'other', label: 'Something else 🤔' },
] as const;

export async function reportContent(params: {
  reporterUserId?: string;
  reportedUserId: string;
  contentType: ReportContentType;
  contentId?: string;
  reason: string;
}): Promise<void> {
  const { error } = await supabase.from('reports').insert({
    ...(params.reporterUserId ? { reporter_id: params.reporterUserId } : {}),
    reported_user_id: params.reportedUserId,
    content_type: params.contentType,
    content_id: params.contentId ?? params.reportedUserId,
    reason: params.reason,
  });
  if (error) throw error;
}

export async function blockUser(userId: string, expectedUserId?: string): Promise<void> {
  const { error } = await supabase.rpc('block_user', {
    target: userId,
    ...(expectedUserId ? { expected_user_id: expectedUserId } : {}),
  });
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
