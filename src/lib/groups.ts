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

// Leave a group yourself, or (if you made it) take someone out of it.
export async function removeFromGroup(groupId: string, userId: string): Promise<void> {
  const { error } = await supabase.from('peek_group_members').delete().eq('group_id', groupId).eq('user_id', userId);
  if (error) throw error;
}

export async function deleteGroup(groupId: string): Promise<void> {
  const { error } = await supabase.from('peek_groups').delete().eq('id', groupId);
  if (error) throw error;
}

// Send someone in the group a "post your drop!" notification.
export async function nudge(groupId: string, userId: string): Promise<void> {
  const { error } = await supabase.rpc('nudge_group_member', { grp: groupId, target: userId, day: localDay() });
  if (error) throw error;
}
