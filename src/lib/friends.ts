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

// Requests for your friends that are on their way right now (per person). When the app opens, Home, Chat and the
// badges all ask at the same moment: they now share the request that's already going instead of each sending their
// own (the logs showed the friends list fetched up to 6 times on one app open, each one waiting its turn on a weak
// signal). As soon as an answer is in, the next ask is a fresh request again.
const linksOnTheWay = new Map<string, Promise<FriendLink[]>>();
const idsOnTheWay = new Map<string, Promise<string[]>>();

// You just added, answered or removed someone: a request that started before that may not have it, so don't share it.
function friendsChanged() {
  linksOnTheWay.clear();
  idsOnTheWay.clear();
}

// Shares `load` with anyone else asking for the same person while it's on its way.
function shared<T>(onTheWay: Map<string, Promise<T>>, me: string, load: () => Promise<T>): Promise<T> {
  const already = onTheWay.get(me);
  if (already) return already;
  const request = load().finally(() => {
    if (onTheWay.get(me) === request) onTheWay.delete(me);
  });
  onTheWay.set(me, request);
  return request;
}

// Every friend, request you sent, and request you received. (Don't change the list you get back: other screens may
// have been given the very same one.)
export function fetchMyFriendLinks(me: string): Promise<FriendLink[]> {
  return shared(linksOnTheWay, me, async () => {
    const { data, error } = await supabase
      .from('friendships')
      .select(
        '*, requester:profiles!friendships_requester_id_fkey(*), addressee:profiles!friendships_addressee_id_fkey(*)',
      )
      .or(`requester_id.eq.${me},addressee_id.eq.${me}`)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []) as FriendLink[];
  });
}

// Just the ids of your friends – a small request with no profiles in it (Home's feed only needs to know whose posts
// are your friends'). Shared like the one above.
export function fetchFriendIds(me: string): Promise<string[]> {
  return shared(idsOnTheWay, me, async () => {
    const { data, error } = await supabase
      .from('friendships')
      .select('requester_id, addressee_id')
      .eq('status', 'accepted')
      .or(`requester_id.eq.${me},addressee_id.eq.${me}`);
    if (error) throw error;
    return ((data ?? []) as { requester_id: string; addressee_id: string }[]).map((row) =>
      row.requester_id === me ? row.addressee_id : row.requester_id,
    );
  });
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
  friendsChanged();
  const { data, error } = await supabase.rpc('send_friend_request', { target });
  if (error) throw error;
  return data === 'accepted' ? 'accepted' : 'pending';
}

export async function respondToRequest(linkId: string, accept: boolean): Promise<void> {
  friendsChanged();
  const { error } = await supabase.rpc('respond_to_friend_request', { request_id: linkId, accept });
  if (error) throw error;
}

// Cancels a request you sent, or unfriends.
export async function removeFriendLink(linkId: string): Promise<void> {
  friendsChanged();
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

// Just your friends (not pending requests), sorted by name. The last list is remembered while the app is open, so
// "Send to…" can show your friends at once while it checks for changes. Only the last person's list is kept: after a
// different login, the one before is gone.
let lastFriends: { me: string; list: Profile[] } | null = null;

export async function fetchFriends(me: string): Promise<Profile[]> {
  const links = await fetchMyFriendLinks(me);
  const list = links
    .filter((link) => link.status === 'accepted')
    .map((link) => otherPerson(link, me))
    .filter((person): person is Profile => person !== null)
    .sort((a, b) => (a.display_name || a.username).localeCompare(b.display_name || b.username));
  lastFriends = { me, list };
  return list;
}

// Your friends as last loaded (null if they weren't loaded yet while the app was open, or for someone else).
export function cachedFriends(me: string): Profile[] | null {
  return lastFriends?.me === me ? lastFriends.list : null;
}

// Loads your friends in the background if this phone doesn't have the list yet, so "Send to…" can show them the
// moment it opens. (Called a moment after the app opens – see src/app/(app)/_layout.tsx.)
export function warmFriends(me: string): void {
  if (cachedFriends(me)) return;
  fetchFriends(me).catch(() => {
    // No problem: "Send to…" loads them itself.
  });
}
