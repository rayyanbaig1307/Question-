import { useEffect, useState } from 'react';

import { supabase } from './supabase';
import type { Profile } from './types';

export type FriendLink = {
  id: string;
  requester_id: string;
  addressee_id: string;
  status: 'pending' | 'accepted';
  created_at: string;
  requester: Profile | null;
  addressee: Profile | null;
};

// How you and another person are connected.
export type Relation =
  | { kind: 'none' }
  | { kind: 'friends'; linkId: string }
  | { kind: 'sent'; linkId: string } // you asked them
  | { kind: 'received'; linkId: string }; // they asked you

export function relationFrom(link: Pick<FriendLink, 'id' | 'status' | 'requester_id'> | null, me: string): Relation {
  if (!link) return { kind: 'none' };
  if (link.status === 'accepted') return { kind: 'friends', linkId: link.id };
  return link.requester_id === me ? { kind: 'sent', linkId: link.id } : { kind: 'received', linkId: link.id };
}

// The other person in a friendship row.
export function otherPerson(link: FriendLink, me: string): Profile | null {
  return link.requester_id === me ? link.addressee : link.requester;
}

// Every friend, request you sent, and request you received.
export async function fetchMyFriendLinks(me: string): Promise<FriendLink[]> {
  const { data, error } = await supabase
    .from('friendships')
    .select(
      '*, requester:profiles!friendships_requester_id_fkey(*), addressee:profiles!friendships_addressee_id_fkey(*)',
    )
    .or(`requester_id.eq.${me},addressee_id.eq.${me}`)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as FriendLink[];
}

export async function fetchRelation(me: string, other: string): Promise<Relation> {
  const { data, error } = await supabase
    .from('friendships')
    .select('id, status, requester_id')
    .or(`and(requester_id.eq.${me},addressee_id.eq.${other}),and(requester_id.eq.${other},addressee_id.eq.${me})`)
    .maybeSingle();
  if (error) throw error;
  return relationFrom(data, me);
}

// Finds people whose username starts with what you typed.
export async function searchUsers(query: string, me: string): Promise<Profile[]> {
  const clean = query.toLowerCase().replace(/[^a-z0-9_.]/g, '');
  if (clean.length === 0) return [];
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .ilike('username', `${clean}%`)
    .neq('id', me)
    .order('username')
    .limit(20);
  if (error) throw error;
  return (data ?? []) as Profile[];
}

// Returns 'accepted' if they had already asked you (so you're now friends), else 'pending'.
export async function sendFriendRequest(target: string): Promise<'pending' | 'accepted'> {
  const { data, error } = await supabase.rpc('send_friend_request', { target });
  if (error) throw error;
  return data === 'accepted' ? 'accepted' : 'pending';
}

export async function respondToRequest(linkId: string, accept: boolean): Promise<void> {
  const { error } = await supabase.rpc('respond_to_friend_request', { request_id: linkId, accept });
  if (error) throw error;
}

// Cancels a request you sent, or unfriends.
export async function removeFriendLink(linkId: string): Promise<void> {
  const { error } = await supabase.from('friendships').delete().eq('id', linkId);
  if (error) throw error;
}

async function countIncomingRequests(me: string): Promise<number> {
  const { count, error } = await supabase
    .from('friendships')
    .select('id', { count: 'exact', head: true })
    .eq('addressee_id', me)
    .eq('status', 'pending');
  if (error) throw error;
  return count ?? 0;
}

// Live number of friend requests waiting for you (updates instantly when someone adds you).
export function useIncomingRequestCount(me: string, active: boolean): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!active) return;
    const refresh = () =>
      countIncomingRequests(me)
        .then(setCount)
        .catch(() => {});
    refresh();
    const channel = supabase
      .channel(`friend-requests-${me}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, refresh)
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [me, active]);

  return count;
}

// Just your friends (not pending requests), sorted by name.
export async function fetchFriends(me: string): Promise<Profile[]> {
  const links = await fetchMyFriendLinks(me);
  return links
    .filter((link) => link.status === 'accepted')
    .map((link) => otherPerson(link, me))
    .filter((person): person is Profile => person !== null)
    .sort((a, b) => (a.display_name || a.username).localeCompare(b.display_name || b.username));
}
