import { localDay } from './drop';
import { supabase } from './supabase';
import type { Post, Profile } from './types';

// ---------------------------------------------------------------------------
// Group Peek: a group of friends whose Peekaboo drops stay hidden from each other until the whole group
// has posted that day's drop. (The database does the hiding – see supabase/migrations/…_group_peek.sql.)
// ---------------------------------------------------------------------------

export type GroupMember = {
  userId: string;
  // null if we can't load their profile (e.g. one of you blocked the other).
  profile: Profile | null;
  posted: boolean;
  postId: string | null;
  postedAt: string | null;
  // Joined after the day being looked at, so they don't count for it.
  late: boolean;
};

export type PeekGroup = {
  id: string;
  name: string;
  created_by: string | null;
  created_at: string;
  // The group's picture (in the profile-pictures storage), and the message pinned in its chat.
  photo_path?: string | null;
  pinned_message_id?: string | null;
  members: GroupMember[];
};

type StatusRow = {
  group_id: string;
  user_id: string;
  joined_day: string;
  posted: boolean;
  post_id: string | null;
  posted_at: string | null;
};

// Your groups (or just one), with who has posted the drop for `day`.
export async function fetchGroups(only?: string, day = localDay()): Promise<PeekGroup[]> {
  let groupsQuery = supabase.from('peek_groups').select('*').order('created_at', { ascending: false });
  if (only) groupsQuery = groupsQuery.eq('id', only);
  const [groups, status] = await Promise.all([
    groupsQuery,
    supabase.rpc('peek_group_status', only ? { day, only_group: only } : { day }),
  ]);
  if (groups.error) throw groups.error;
  if (status.error) throw status.error;

  const rows = (status.data ?? []) as StatusRow[];
  const ids = [...new Set(rows.map((row) => row.user_id))];
  const profiles = new Map<string, Profile>();
  if (ids.length > 0) {
    const { data, error } = await supabase.from('profiles').select('*').in('id', ids);
    if (error) throw error;
    for (const profile of (data ?? []) as Profile[]) profiles.set(profile.id, profile);
  }

  return ((groups.data ?? []) as Omit<PeekGroup, 'members'>[]).map((group) => ({
    ...group,
    members: rows
      .filter((row) => row.group_id === group.id)
      .map((row) => ({
        userId: row.user_id,
        profile: profiles.get(row.user_id) ?? null,
        posted: row.posted,
        postId: row.post_id,
        postedAt: row.posted_at,
        late: row.joined_day > day,
      })),
  }));
}

export async function fetchGroup(groupId: string): Promise<PeekGroup | null> {
  const [group] = await fetchGroups(groupId);
  return group ?? null;
}

// The group members who count for the day, and the ones still to post.
export function counting(group: PeekGroup): GroupMember[] {
  return group.members.filter((member) => !member.late);
}

export function stillToPost(group: PeekGroup): GroupMember[] {
  return counting(group).filter((member) => !member.posted);
}

export function memberName(member: GroupMember, me: string): string {
  if (member.userId === me) return 'you';
  return member.profile ? member.profile.display_name || member.profile.username : 'someone';
}

// "Waiting on Sam 👀", "Waiting on you and Sam 👀", "Waiting on Sam, Alex and 2 more 👀" – or "Everyone posted! 🎉"
export function waitingText(group: PeekGroup, me: string): string {
  const missing = stillToPost(group).sort((a, b) => (a.userId === me ? -1 : b.userId === me ? 1 : 0));
  if (missing.length === 0) return 'Everyone posted! 🎉';
  const names = missing.map((member) => memberName(member, me));
  if (names.length === 1) return `Waiting on ${names[0]} 👀`;
  if (names.length === 2) return `Waiting on ${names[0]} and ${names[1]} 👀`;
  if (names.length === 3) return `Waiting on ${names[0]}, ${names[1]} and ${names[2]} 👀`;
  return `Waiting on ${names[0]}, ${names[1]} and ${names.length - 2} more 👀`;
}

// The drop posts of the people in a group (only the ones you're allowed to see come back).
export async function fetchGroupDrops(postIds: string[]): Promise<Post[]> {
  if (postIds.length === 0) return [];
  const { data, error } = await supabase.from('posts').select('*, group_hold').in('id', postIds);
  if (error) throw error;
  return (data ?? []) as Post[];
}

export async function createGroup(name: string, memberIds: string[]): Promise<string> {
  const { data, error } = await supabase.rpc('create_peek_group', {
    group_name: name.trim(),
    members: memberIds,
    today: localDay(),
  });
  if (error) throw error;
  return data as string;
}

export async function addToGroup(groupId: string, memberIds: string[]): Promise<void> {
  if (memberIds.length === 0) return;
  const { error } = await supabase.rpc('add_to_peek_group', { grp: groupId, members: memberIds, today: localDay() });
  if (error) throw error;
}

export async function renameGroup(groupId: string, name: string): Promise<void> {
  const { error } = await supabase.rpc('rename_peek_group', { grp: groupId, group_name: name.trim() });
  if (error) throw error;
}

// The person who made a group takes someone out of it. (Leaving yourself: leaveGroup.)
// The database quietly skips a removal it doesn't allow (nothing is removed, and no error), so the count is checked.
export async function removeFromGroup(groupId: string, userId: string): Promise<void> {
  const { error, count } = await supabase
    .from('peek_group_members')
    .delete({ count: 'exact' })
    .eq('group_id', groupId)
    .eq('user_id', userId);
  if (error) throw error;
  if (count === 0) throw new Error(ONLY_MAKER_REMOVES);
}

const ONLY_MAKER_REMOVES = 'Only the person who made this group can take people out of it.';
export const ONLY_MAKER_DELETES = 'Only the person who made this group can delete it. You can leave it instead.';

// Who counts as the group's maker: the person who made it while they're still in it. If they left (or deleted their
// account), whoever has been in the group longest counts instead. The members list (public.peek_group_status) is in
// joining order, and people who joined at the very same moment – everyone picked when the group was made – are in
// order of their user id, exactly like the server's rule (private.group_maker, used by public.delete_peek_group), so
// the app shows "Delete group" to the same person the server lets delete it.
export function groupMaker(group: Pick<PeekGroup, 'created_by' | 'members'>): string | null {
  if (group.created_by && group.members.some((member) => member.userId === group.created_by)) return group.created_by;
  return group.members[0]?.userId ?? null;
}

// Can you delete this group? The maker can, any time. Anyone who is the only person left in it can too.
export function canDeleteGroup(group: Pick<PeekGroup, 'created_by' | 'members'>, me: string): boolean {
  if (!group.members.some((member) => member.userId === me)) return false;
  return groupMaker(group) === me || group.members.length === 1;
}

// Are you the only person left in this group? Then there's nobody to leave it to: you delete it instead.
export function aloneInGroup(group: Pick<PeekGroup, 'members'>, me: string): boolean {
  return group.members.length === 1 && group.members[0].userId === me;
}

// The server doesn't have this function yet (PostgREST: PGRST202; the database itself: 42883).
function functionMissing(error: { code?: string | null }): boolean {
  return error.code === 'PGRST202' || error.code === '42883';
}

// Deletes the group for everyone: the group, its chat (messages, photos, videos, voice notes), its dares and Guess
// Whos. Nobody's own posts or drops are deleted. The server decides who may (see canDeleteGroup) and queues the
// chat's files for the daily clean-up.
export async function deleteGroup(groupId: string): Promise<void> {
  const { error } = await supabase.rpc('delete_peek_group', { grp: groupId });
  if (!error) return;
  if (!functionMissing(error)) throw error;
  // A server without delete_peek_group yet: the old way, where only the maker can. Make sure it really went.
  const old = await supabase.from('peek_groups').delete({ count: 'exact' }).eq('id', groupId);
  if (old.error) throw old.error;
  if (old.count === 0) throw new Error(ONLY_MAKER_DELETES);
}

// Leave a group. If you were the last one in it, the group is deleted (nobody is left to see it) and this gives back
// 'deleted'; otherwise 'left'. If you made it, the person who has been in it longest takes over. (Both happen on the
// server: public.leave_peek_group.)
export async function leaveGroup(groupId: string, me: string): Promise<'left' | 'deleted'> {
  const { data, error } = await supabase.rpc('leave_peek_group', { grp: groupId });
  if (!error) return data === 'deleted' ? 'deleted' : 'left';
  if (!functionMissing(error)) throw error;
  // A server without leave_peek_group yet: take yourself out the old way.
  const old = await supabase.from('peek_group_members').delete({ count: 'exact' }).eq('group_id', groupId).eq('user_id', me);
  if (old.error) throw old.error;
  return 'left';
}

// Send someone in the group a "post your drop!" notification.
export async function nudge(groupId: string, userId: string): Promise<void> {
  const { error } = await supabase.rpc('nudge_group_member', { grp: groupId, target: userId, day: localDay() });
  if (error) throw error;
}
