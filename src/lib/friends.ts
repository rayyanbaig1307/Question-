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

// In a search pattern "_" means "any one letter" and "%" means "anything", so typing "a_b" would also find
// "axb". Putting a "\" in front of them makes the search look for the real letters only.
export function likePrefix(text: string): string {
  return text.replace(/[\\%_]/g, (letter) => `\\${letter}`);
}

// Finds people whose username starts with what you typed (only letters, numbers, "_" and "." are kept;
// "*" is dropped too, because the server would read it as "anything").
export async function searchUsers(query: string, me: string): Promise<Profile[]> {
  const clean = query.toLowerCase().replace(/[^a-z0-9_.]/g, '');
  if (clean.length === 0) return [];
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .ilike('username', `${likePrefix(clean)}%`)
    .neq('id', me)
    .order('username')
    .limit(20);
  if (error) throw error;
  return (data ?? []) as Profile[];
}

// Tapping "Add". The server decides (supabase/migrations/20261220000000_launch_safety.sql):
// - 'accepted': you're friends now. That happens when they had already asked you, or when they're 18 or over
//   and their account is public.
// - 'pending': a friend request they must accept (the button shows "Requested"). That happens for private
//   accounts and for anyone under 18 or without a birthday saved, even if their account is public.
// Anything else the server might answer counts as 'pending', so the app never shows "Friends" by mistake.
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

// Each place that listens gets its own channel name. Two listeners on the same name share one channel, and
// adding a listener to a channel that's already subscribed makes the realtime library throw (that crashed the
// app on launch once, when the Camera and the Chat tab both listened as `friend-requests-<me>`).
let listenerNumber = 0;

// Live number of friend requests waiting for you (updates instantly when someone adds you).
export function useIncomingRequestCount(me: string, active: boolean): number {
  const [count, setCount] = useState(0);
  const [channelName] = useState(() => `friend-requests-${me}-${++listenerNumber}`);

  useEffect(() => {
    if (!active) return;
    const refresh = () =>
      countIncomingRequests(me)
        .then(setCount)
        .catch(() => {});
    refresh();
    const channel = supabase
      .channel(channelName)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, refresh)
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [me, active, channelName]);

  return count;
}

// Someone's friends (their own, a public account's, or a friend's). Empty for a private stranger.
export async function fetchFriendsOf(person: string): Promise<Profile[]> {
  const { data, error } = await supabase.rpc('friends_of', { person });
  if (error) throw error;
  return (data ?? []) as Profile[];
}

// Friend requests waiting for you, newest first.
export async function fetchIncomingRequests(me: string): Promise<FriendLink[]> {
  const links = await fetchMyFriendLinks(me);
  return links.filter((link) => link.status === 'pending' && link.addressee_id === me && link.requester);
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
