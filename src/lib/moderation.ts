import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// Looking after reports – only for admins (added in the database, never from the app).
// The Reports screen (Settings → Reports) lists every report and lets an admin remove the content,
// ban the account, dismiss the report or mark it reviewed.
// ---------------------------------------------------------------------------

export type Report = {
  id: string;
  created_at: string;
  status: 'open' | 'reviewed' | 'dismissed';
  reason: string;
  details: string | null;
  content_type: 'user' | 'post' | 'story' | 'message' | 'comment' | 'dare_idea';
  content_id: string | null;
  reporter_username: string | null;
  reported_id: string | null;
  reported_username: string | null;
  reported_name: string | null;
  reported_avatar: string | null;
  // The reported text (caption, message, comment…), if there is any.
  preview: string | null;
  content_exists: boolean;
  reported_banned: boolean;
};

export type ReviewAction = 'dismiss' | 'reviewed' | 'remove_content' | 'ban' | 'unban';

// Am I an admin? (You can only ever see your own row.)
export async function fetchAmIAdmin(me: string): Promise<boolean> {
  const { data, error } = await supabase.from('admins').select('user_id').eq('user_id', me).maybeSingle();
  if (error) throw error;
  return !!data;
}

export async function fetchReports(onlyOpen: boolean): Promise<Report[]> {
  const { data, error } = await supabase.rpc('admin_reports', { only_open: onlyOpen });
  if (error) throw error;
  return (data ?? []) as Report[];
}

export async function reviewReport(report: string, action: ReviewAction): Promise<void> {
  const { error } = await supabase.rpc('admin_review', { report, action });
  if (error) throw error;
}
