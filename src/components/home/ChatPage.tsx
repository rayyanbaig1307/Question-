import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { FriendButton } from '@/components/FriendButton';
import { GroupFaces } from '@/components/GroupFaces';
import { useOverlays } from '@/components/Overlays';
import { PersonRow } from '@/components/PersonRow';
import { useMe } from '@/lib/auth';
import { fetchRecentMessages, subscribeToMyMessages, type Message } from '@/lib/chat';
import { fetchCloseFriendIds, setCloseFriend } from '@/lib/closeFriends';
import { friendlyError } from '@/lib/errors';
import { fetchFriends, fetchIncomingRequests, fetchMyFriendLinks, relationFrom, searchUsers, type FriendLink } from '@/lib/friends';
import { fetchFriendSettings, saveFriendSettings, type FriendSettings } from '@/lib/friendSettings';
import { counting, fetchGroups, stillToPost, type PeekGroup } from '@/lib/groups';
import { respondToHitUp, type HitUp } from '@/lib/hitups';
import { inviteFriends } from '@/lib/invite';
import { timeAgo } from '@/lib/time';
import type { Profile } from '@/lib/types';
import { supabase } from '@/lib/supabase';
import { useSafetyActions } from '@/lib/useSafetyActions';
import { colors, font, radius, space } from '@/theme';
import { useTabBarSpace } from './HomeTabBar';
import { PageHeader } from './PageHeader';

type ChatRow = {
  friend: Profile;
  last: Message | null;
  newSnaps: number;
  newChats: number;
};

// Left page: hit ups and friend requests waiting for you at the top, then your Group Peek groups, then everyone
// you can chat with, most recent first.
export function ChatPage({ visible, onCamera, hitUps, onHitUpsChanged }: {
  visible: boolean;
  onCamera: () => void;
  hitUps: HitUp[];
  onHitUpsChanged: () => void;
}) {
  const { userId, profile } = useMe();
  const { showOptions, showToast } = useOverlays();
  const { confirmBlock } = useSafetyActions();
  const tabSpace = useTabBarSpace();
  const [rows, setRows] = useState<ChatRow[] | null>(null);
  const [groups, setGroups] = useState<PeekGroup[]>([]);
  // Your per-friend options (pin, mute, hidden stories) and your close friends.
  const [settings, setSettings] = useState<Map<string, FriendSettings>>(new Map());
  const [closeFriends, setCloseFriends] = useState<Set<string>>(new Set());
  // The search bar: filters your chats and finds new people to add.
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ query: string; people: Profile[] } | null>(null);
  const [links, setLinks] = useState<FriendLink[]>([]);
  // Friend requests waiting for you (private accounts only – public ones are friends straight away).
  const [requests, setRequests] = useState<FriendLink[]>([]);
  const trimmed = query.trim().replace(/^@/, '');
  const searching = trimmed.length > 0;

  const refresh = useCallback(() => {
    fetchRows(userId)
      .then(setRows)
      .catch((error) => {
        console.warn('Could not load chats', error);
        setRows((current) => current ?? []);
      });
  }, [userId]);

  useEffect(() => {
    if (!visible) return;
    fetchGroups()
      .then(setGroups)
      .catch(() => {});
    fetchFriendSettings(userId)
      .then(setSettings)
      .catch(() => {});
    fetchCloseFriendIds(userId)
      .then(setCloseFriends)
      .catch(() => {});
    refresh();
    // Friend requests: load now, and again the moment one arrives or is answered.
    const loadRequests = () =>
      fetchIncomingRequests(userId)
        .then(setRequests)
        .catch(() => {});
    loadRequests();
    const requestChannel = supabase
      .channel(`chat-requests-${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, () => {
        loadRequests();
        refresh();
      })
      .subscribe();
    // Refresh instantly when a message arrives or gets opened.
    const stopMessages = subscribeToMyMessages(`chat-list-${userId}`, refresh);
    return () => {
      stopMessages();
      supabase.removeChannel(requestChannel);
    };
  }, [visible, userId, refresh]);

  // Look people up a moment after you stop typing (and know who you've already asked).
  useEffect(() => {
    if (!trimmed) return;
    const timer = setTimeout(() => {
      Promise.all([searchUsers(trimmed, userId), fetchMyFriendLinks(userId)])
        .then(([people, myLinks]) => {
          setFound({ query: trimmed, people });
          setLinks(myLinks);
        })
        .catch((error) => console.warn('Search failed', error));
    }, 300);
    return () => clearTimeout(timer);
  }, [trimmed, userId]);
  const reloadLinks = () => {
    fetchMyFriendLinks(userId)
      .then(setLinks)
      .catch(() => {});
    refresh();
  };

  // Pinned chats stay at the top.
  const shown = rows
    ? [...rows].sort((a, b) => Number(!!settings.get(b.friend.id)?.pinned) - Number(!!settings.get(a.friend.id)?.pinned))
    : null;
  // While searching: only the chats whose name matches, and new people (not friends yet) below.
  const needle = trimmed.toLowerCase();
  const matching = (shown ?? []).filter(
    (row) =>
      row.friend.username.toLowerCase().includes(needle) ||
      (row.friend.display_name ?? '').toLowerCase().includes(needle),
  );
  const friendIds = new Set((rows ?? []).map((row) => row.friend.id));
  const newPeople = found && found.query === trimmed ? found.people.filter((person) => !friendIds.has(person.id)) : null;
  const relationWith = (personId: string) =>
    relationFrom(links.find((link) => link.requester_id === personId || link.addressee_id === personId) ?? null, userId);

  // Hold down a chat: options for that friend.
  function openFriendMenu(friend: Profile) {
    const current = settings.get(friend.id);
    const name = friend.display_name || friend.username;
    const close = closeFriends.has(friend.id);
    const change = async (changes: Partial<Omit<FriendSettings, 'friend_id'>>, done: string) => {
      try {
        const saved = await saveFriendSettings(userId, friend.id, changes);
        setSettings((map) => new Map(map).set(friend.id, saved));
        showToast(done);
      } catch (error) {
        Alert.alert('Could not save', friendlyError(error));
      }
    };
    showOptions({
      title: name,
      options: [
        {
          label: current?.pinned ? '📌 Unpin chat' : '📌 Pin chat to top',
          onPress: () => change({ pinned: !current?.pinned }, current?.pinned ? 'Unpinned' : 'Pinned to the top 📌'),
        },
        {
          label: current?.mute_messages ? '🔔 Unmute notifications' : '🔕 Mute notifications',
          onPress: () =>
            change(
              { mute_messages: !current?.mute_messages },
              current?.mute_messages ? `Notifications from ${name} are back on` : `${name} is muted – no notifications from them`,
            ),
        },
        {
          label: current?.mute_stories ? '👀 Show their stories again' : '🙈 Hide their stories',
          onPress: () =>
            change(
              { mute_stories: !current?.mute_stories },
              current?.mute_stories ? `${name}'s stories are back on Home` : `${name}'s stories won't show on Home`,
            ),
        },
        {
          label: close ? '⭐ Remove from close friends' : '⭐ Add to close friends',
          onPress: async () => {
            try {
              await setCloseFriend(userId, friend.id, !close);
              setCloseFriends((set) => {
                const next = new Set(set);
                if (close) next.delete(friend.id);
                else next.add(friend.id);
                return next;
              });
              showToast(close ? `${name} is no longer a close friend` : `${name} is a close friend now ⭐`);
            } catch (error) {
              Alert.alert('Could not save', friendlyError(error));
            }
          },
        },
        { label: '👤 See profile', onPress: () => router.push(`/profile/${friend.id}`) },
        { label: '🚫 Block', destructive: true, onPress: () => confirmBlock(friend, refresh) },
      ],
    });
  }

  return (
    <View style={styles.fill}>
      <PageHeader title="Chat" onCamera={onCamera} />
      <View style={styles.search}>
        <Ionicons name="search" size={18} color={colors.textMuted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search friends or add someone new"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={styles.searchInput}
          accessibilityLabel="Search friends"
        />
        {query ? (
          <Pressable onPress={() => setQuery('')} hitSlop={10} accessibilityLabel="Clear search">
            <Ionicons name="close-circle" size={18} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>
      {rows === null ? (
        <ActivityIndicator color={colors.accent} style={styles.loading} />
      ) : (
        <FlatList
          data={searching ? matching : shown ?? []}
          keyExtractor={(row) => row.friend.id}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={[styles.list, { paddingBottom: tabSpace + space.lg }]}
          ListHeaderComponent={
            searching ? (
              matching.length > 0 ? <Text style={styles.sectionTitle}>💬 Chats</Text> : undefined
            ) : (
            <>
              {hitUps.length > 0 ? (
                <View style={styles.hitUps}>
                  <Text style={styles.hitUpsTitle}>Hit ups 👋</Text>
                  {hitUps.map((hitUp) => (
                    <HitUpRow key={hitUp.id} hitUp={hitUp} onDone={onHitUpsChanged} />
                  ))}
                </View>
              ) : null}
              {requests.length > 0 ? (
                <View style={styles.hitUps}>
                  <Text style={styles.hitUpsTitle}>Friend requests 💌</Text>
                  {requests.map((link) =>
                    link.requester ? (
                      <View key={link.id} style={styles.request}>
                        <PersonRow
                          person={link.requester}
                          right={<FriendButton person={link.requester} relation={relationFrom(link, userId)} onChanged={reloadLinks} small />}
                        />
                      </View>
                    ) : null,
                  )}
                </View>
              ) : null}
              {rows.length > 0 ? (
                <>
                  <GroupsSection groups={groups} />
                  <Text style={styles.sectionTitle}>💬 Chats</Text>
                </>
              ) : null}
            </>
            )
          }
          ListFooterComponent={
            searching ? (
              <View>
                <Text style={styles.sectionTitle}>👋 Add friends</Text>
                {newPeople === null ? (
                  <ActivityIndicator color={colors.accent} style={styles.searchLoading} />
                ) : newPeople.length === 0 ? (
                  <Text style={styles.searchEmpty}>Nobody new called @{trimmed}. Check the spelling, or invite them!</Text>
                ) : (
                  <View style={styles.people}>
                    {newPeople.map((person) => (
                      <PersonRow
                        key={person.id}
                        person={person}
                        right={<FriendButton person={person} relation={relationWith(person.id)} onChanged={reloadLinks} small />}
                      />
                    ))}
                  </View>
                )}
              </View>
            ) : undefined
          }
          ListEmptyComponent={
            searching ? undefined : (
            <EmptyState
              emoji="👀"
              title="It's quiet in here… too quiet"
              message="No friends yet. Invite your crew and start swapping peeks!">
              <Button title="Invite friends" icon="paper-plane" onPress={() => inviteFriends(profile?.username)} />
              <Button title="Find friends" icon="search" variant="secondary" onPress={() => router.push('/friends')} />
            </EmptyState>
            )
          }
          renderItem={({ item }) => (
            <ChatRowView
              row={item}
              me={userId}
              pinned={!!settings.get(item.friend.id)?.pinned}
              muted={!!settings.get(item.friend.id)?.mute_messages}
              onMenu={() => openFriendMenu(item.friend)}
            />
          )}
        />
      )}
    </View>
  );
}

// Group Peek: your groups (how many posted today's drop), or one row to start your first group.
function GroupsSection({ groups }: { groups: PeekGroup[] }) {
  return (
    <>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>👯 Group Peeks</Text>
        {groups.length > 0 ? (
          <Pressable onPress={() => router.push('/groups/new')} hitSlop={10} accessibilityRole="button">
            <Text style={styles.sectionAction}>＋ New</Text>
          </Pressable>
        ) : null}
      </View>
      {groups.length === 0 ? (
        <Pressable
          onPress={() => router.push('/groups/new')}
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          accessibilityRole="button">
          <View style={styles.groupIcon}>
            <Text style={styles.groupEmoji}>👯</Text>
          </View>
          <View style={styles.rowText}>
            <Text style={styles.name}>Make a group</Text>
            <Text style={styles.statusText}>Your group&apos;s drops stay hidden until everyone posts</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.textFaint} />
        </Pressable>
      ) : (
        groups.map((group) => {
          const total = counting(group).length;
          const left = stillToPost(group).length;
          return (
            <Pressable
              key={group.id}
              onPress={() => router.push(`/groups/${group.id}`)}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
              <View style={styles.groupIcon}>
                <GroupFaces members={group.members} size={24} />
              </View>
              <View style={styles.rowText}>
                <Text style={styles.name} numberOfLines={1}>
                  {group.name}
                </Text>
                <Text style={[styles.statusText, left === 0 && styles.groupDone]}>
                  {left === 0 ? "Everyone posted today's drop 🎉" : `${total - left} of ${total} posted today's drop`}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.textFaint} />
            </Pressable>
          );
        })
      )}
    </>
  );
}

// Someone hit you up: Hit back (friends + the chat opens with their message) or Ignore (they're never told).
function HitUpRow({ hitUp, onDone }: { hitUp: HitUp; onDone: () => void }) {
  const { showOptions, showToast } = useOverlays();
  const { report, confirmBlock } = useSafetyActions();
  const [busy, setBusy] = useState<'back' | 'ignore' | null>(null);
  const sender = hitUp.sender;
  const name = sender.display_name || sender.username;

  async function respond(hitBack: boolean) {
    setBusy(hitBack ? 'back' : 'ignore');
    try {
      await respondToHitUp(hitUp.id, hitBack);
      onDone();
      if (hitBack) {
        showToast(`You and ${name} can chat now 🎉`);
        router.push(`/chat/${sender.id}`);
      } else {
        showToast("Ignored – they won't be told");
      }
    } catch (error) {
      Alert.alert('Oops', friendlyError(error));
      onDone();
    } finally {
      setBusy(null);
    }
  }

  function openMenu() {
    showOptions({
      title: `@${sender.username}`,
      options: [
        { label: 'See profile', onPress: () => router.push(`/profile/${sender.id}`) },
        { label: 'Report', onPress: () => report({ user: sender, contentType: 'user', contentId: sender.id, onBlocked: onDone }) },
        { label: 'Block', destructive: true, onPress: () => confirmBlock(sender, onDone) },
      ],
    });
  }

  return (
    <View style={styles.hitUp}>
      <View style={styles.hitUpTop}>
        <Pressable onPress={() => router.push(`/profile/${sender.id}`)} accessibilityLabel={`See ${name}'s profile`}>
          <Avatar path={sender.avatar_path} name={name} size={48} />
        </Pressable>
        <View style={styles.rowText}>
          <Text style={styles.name} numberOfLines={1}>
            {name}
          </Text>
          <Text style={styles.statusText}>
            @{sender.username} · {timeAgo(hitUp.created_at)}
          </Text>
        </View>
        <Pressable onPress={openMenu} hitSlop={10} accessibilityLabel="Report or block">
          <Ionicons name="ellipsis-horizontal" size={22} color={colors.textMuted} />
        </Pressable>
      </View>
      <Text style={styles.hitUpMessage}>{hitUp.message ? `“${hitUp.message}”` : '👋 Hit you up'}</Text>
      <View style={styles.hitUpButtons}>
        <Button
          title="Hit back"
          icon="hand-right"
          small
          style={styles.hitUpButton}
          loading={busy === 'back'}
          disabled={busy !== null}
          onPress={() => respond(true)}
        />
        <Button
          title="Ignore"
          variant="secondary"
          small
          style={styles.hitUpButton}
          loading={busy === 'ignore'}
          disabled={busy !== null}
          onPress={() => respond(false)}
        />
      </View>
    </View>
  );
}

async function fetchRows(me: string): Promise<ChatRow[]> {
  const [friends, messages] = await Promise.all([fetchFriends(me), fetchRecentMessages(me)]);
  return buildRows(friends, messages);
}

function buildRows(friends: Profile[], messages: Message[]): ChatRow[] {
  const rows = friends.map((friend) => {
    const withFriend = messages.filter((m) => m.sender_id === friend.id || m.recipient_id === friend.id);
    const unopened = withFriend.filter((m) => m.sender_id === friend.id && m.opened_at === null);
    return {
      friend,
      last: withFriend[0] ?? null,
      newSnaps: unopened.filter((m) => m.kind === 'snap').length,
      newChats: unopened.filter((m) => m.kind === 'text' || m.kind === 'voice' || m.kind === 'reaction' || m.kind === 'dare').length,
    };
  });
  // Most recent conversations first; friends you haven't talked to yet at the bottom.
  return rows.sort((a, b) => (b.last?.created_at ?? '').localeCompare(a.last?.created_at ?? ''));
}

function describe(row: ChatRow, me: string): {
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  label: string;
  bold: boolean;
} {
  const { last } = row;
  if (row.newSnaps > 0) return { icon: 'square', color: colors.accent, label: 'New Peek', bold: true };
  if (row.newChats > 0) return { icon: 'chatbubble', color: colors.blue, label: 'New Chat', bold: true };
  if (!last) return { icon: 'chatbubble-outline', color: colors.textFaint, label: 'Tap to chat', bold: false };
  if (last.kind === 'screenshot') {
    const theyDidIt = last.sender_id !== me;
    return {
      icon: 'camera',
      color: colors.purple,
      label: theyDidIt ? 'Took a screenshot! 📸' : 'You took a screenshot',
      bold: theyDidIt && !last.opened_at,
    };
  }
  if (last.kind === 'reaction') {
    const theyDidIt = last.sender_id !== me;
    return {
      icon: 'happy',
      color: colors.pink,
      label: theyDidIt ? `Reacted ${last.body} to your story` : `You reacted ${last.body}`,
      bold: theyDidIt && !last.opened_at,
    };
  }
  if (last.kind === 'dare') {
    const theyDidIt = last.sender_id !== me;
    return {
      icon: 'flag',
      color: colors.pink,
      label: theyDidIt ? 'Dared you 🎯' : 'You sent a dare',
      bold: theyDidIt && !last.opened_at,
    };
  }
  if (last.kind === 'voice') {
    return { icon: 'mic', color: colors.pink, label: last.sender_id === me ? 'You sent a voice note' : 'Voice note 🎤', bold: false };
  }
  const color = last.kind === 'snap' ? colors.accent : colors.blue;
  if (last.sender_id === me) {
    return { icon: last.opened_at ? 'paper-plane-outline' : 'paper-plane', color, label: last.opened_at ? 'Opened' : 'Delivered', bold: false };
  }
  return { icon: last.kind === 'snap' ? 'square-outline' : 'chatbubble-outline', color, label: 'Received', bold: false };
}

function ChatRowView({ row, me, pinned, muted, onMenu }: {
  row: ChatRow;
  me: string;
  pinned: boolean;
  muted: boolean;
  onMenu: () => void;
}) {
  const status = describe(row, me);
  return (
    <Pressable
      onPress={() => router.push(`/chat/${row.friend.id}`)}
      onLongPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        onMenu();
      }}
      accessibilityHint="Hold for options"
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
      <Avatar path={row.friend.avatar_path} name={row.friend.display_name || row.friend.username} size={52} />
      <View style={styles.rowText}>
        <View style={styles.nameRow}>
          <Text style={[styles.name, styles.nameText]} numberOfLines={1}>
            {row.friend.display_name || row.friend.username}
          </Text>
          {pinned ? <Ionicons name="pin" size={14} color={colors.textMuted} /> : null}
          {muted ? <Ionicons name="notifications-off" size={14} color={colors.textMuted} /> : null}
        </View>
        <View style={styles.status}>
          <Ionicons name={status.icon} size={14} color={status.color} />
          <Text style={[styles.statusText, status.bold && { color: status.color, fontWeight: '900' }]}>
            {status.label}
            {row.last ? ` · ${timeAgo(row.last.created_at)}` : ''}
          </Text>
        </View>
      </View>
      <Ionicons name="chevron-forward" size={20} color={colors.textFaint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  loading: {
    marginTop: space.xxl,
  },
  list: {
    paddingBottom: space.xxl,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  rowPressed: {
    backgroundColor: colors.card,
  },
  rowText: {
    flex: 1,
    gap: 3,
  },
  name: {
    ...font.body,
    fontSize: 17,
    fontWeight: '800',
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  nameText: {
    flexShrink: 1,
  },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusText: {
    ...font.small,
  },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    paddingHorizontal: space.md,
    height: 42,
    borderRadius: radius.pill,
    backgroundColor: colors.card,
  },
  searchInput: {
    flex: 1,
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
    paddingVertical: 0,
  },
  searchLoading: {
    marginTop: space.md,
  },
  searchEmpty: {
    ...font.small,
    paddingHorizontal: space.lg,
    paddingTop: space.xs,
  },
  people: {
    paddingHorizontal: space.lg,
    gap: space.sm,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingRight: space.lg,
  },
  sectionTitle: {
    ...font.label,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xs,
  },
  sectionAction: {
    ...font.small,
    color: colors.accent,
    fontWeight: '800',
    paddingTop: space.md,
  },
  groupIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  groupEmoji: {
    fontSize: 26,
  },
  groupDone: {
    color: colors.green,
    fontWeight: '800',
  },
  hitUps: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.md,
    gap: space.sm,
  },
  hitUpsTitle: {
    ...font.label,
  },
  request: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    paddingHorizontal: space.md,
  },
  hitUp: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: space.md,
    gap: space.sm,
  },
  hitUpTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  hitUpMessage: {
    ...font.body,
    fontWeight: '700',
  },
  hitUpButtons: {
    flexDirection: 'row',
    gap: space.sm,
  },
  hitUpButton: {
    flex: 1,
  },
});
