import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { FriendButton } from '@/components/FriendButton';
import { GroupFaces } from '@/components/GroupFaces';
import { useOverlays } from '@/components/Overlays';
import { PersonRow } from '@/components/PersonRow';
import { StoryAvatar } from '@/components/StoryAvatar';
import { useMe } from '@/lib/auth';
import { MAX_PINS, pinKeyForFriend, pinKeyForGroup, sortByPins, useChatPins } from '@/lib/chatPins';
import { clearChat, fetchRecentMessages, subscribeToMyMessages, type Message } from '@/lib/chat';
import { fetchCloseFriendIds, setCloseFriend } from '@/lib/closeFriends';
import { friendlyError } from '@/lib/errors';
import { fetchFriends, fetchMyFriendLinks, relationFrom, searchUsers, type FriendLink } from '@/lib/friends';
import { fetchFriendSettings, saveFriendSettings, type FriendSettings } from '@/lib/friendSettings';
import { fetchGroupChats, subscribeToGroupChat, type GroupChatSummary } from '@/lib/groupChat';
import { counting, fetchGroups, stillToPost, type PeekGroup } from '@/lib/groups';
import { inviteFriends } from '@/lib/invite';
import { timeAgo } from '@/lib/time';
import type { Profile } from '@/lib/types';
import { useSafetyActions } from '@/lib/useSafetyActions';
import { refreshStoryBadges, useStoryBadge } from '@/lib/storyRings';
import { colors, font, radius, space, pageBackground } from '@/theme';
import { useTabBarSpace } from './HomeTabBar';
import { PageHeader } from './PageHeader';

type ChatRow = {
  friend: Profile;
  last: Message | null;
  newSnaps: number;
  newChats: number;
};

// Left page: your chats, most recent first, with your Group Peek groups above them. Hit ups, friend requests
// and activity live in the Inbox (the 🔔 bell), so the chat list stays clean. Pull down to refresh.
export function ChatPage({ visible, inboxCount, onRefreshInbox }: {
  visible: boolean;
  // New things waiting in your Inbox 🔔 (hit ups, friend requests, activity) – the bell's red number.
  inboxCount: number;
  onRefreshInbox: () => void;
}) {
  const { userId, profile } = useMe();
  const { showOptions, showToast } = useOverlays();
  const { confirmBlock } = useSafetyActions();
  const tabSpace = useTabBarSpace();
  const [rows, setRows] = useState<ChatRow[] | null>(null);
  const [groups, setGroups] = useState<PeekGroup[]>([]);
  // Each group's chat: unread count and latest message.
  const [groupChats, setGroupChats] = useState<Map<string, GroupChatSummary>>(new Map());
  // Your per-friend options (pin, mute, hidden stories) and your close friends.
  const [settings, setSettings] = useState<Map<string, FriendSettings>>(new Map());
  const [closeFriends, setCloseFriends] = useState<Set<string>>(new Set());
  // The search bar: filters your chats and finds new people to add.
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ query: string; people: Profile[] } | null>(null);
  const [links, setLinks] = useState<FriendLink[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  // Your pinned chats (Peekaboo+ ⭐, up to 3), kept on this phone.
  const { pins, plus, toggle: togglePinned } = useChatPins();
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
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
    const loadGroupChats = () =>
      fetchGroupChats()
        .then(setGroupChats)
        .catch(() => {});
    loadGroupChats();
    // A vote on a group dare proof changes a message's totals ('UPDATE'), not the Chat list.
    const stopGroupChats = subscribeToGroupChat(null, (change) => {
      if (change.event !== 'UPDATE') loadGroupChats();
    });
    fetchFriendSettings(userId)
      .then(setSettings)
      .catch(() => {});
    fetchCloseFriendIds(userId)
      .then(setCloseFriends)
      .catch(() => {});
    refresh();
    // Who has a new story (the rings on the pictures below).
    void refreshStoryBadges(userId);
    // Refresh instantly when a message arrives or gets opened.
    const stopMessages = subscribeToMyMessages(`chat-list-${userId}`, refresh);
    return () => {
      stopMessages();
      stopGroupChats();
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

  // Pull down: fresh chats, groups and Inbox.
  async function pullToRefresh() {
    setRefreshing(true);
    onRefreshInbox();
    fetchGroups()
      .then(setGroups)
      .catch(() => {});
    fetchGroupChats()
      .then(setGroupChats)
      .catch(() => {});
    try {
      setRows(await fetchRows(userId));
    } catch {
      // Keep what's on screen.
    }
    setRefreshing(false);
  }

  // Pinned chats stay at the top, in the order you pinned them.
  const shown = rows ? sortByPins(rows, (row) => pinKeyForFriend(row.friend.id), pins) : null;
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

  // A pinned chat whose friend or group is gone (unfriended, left) doesn't use up one of the 3 places.
  const stillThere = (key: string) =>
    key.startsWith('group:')
      ? groups.length === 0 || groups.some((group) => pinKeyForGroup(group.id) === key)
      : (rows ?? []).some((row) => pinKeyForFriend(row.friend.id) === key);

  // "📌 Pin to top" / "Unpin" in a chat's hold-down menu. Pinning is Peekaboo+ ⭐ – without it, this shows
  // what Peekaboo+ is.
  function pinOption(key: string) {
    const isPinned = pins.includes(key);
    return {
      label: isPinned ? '📌 Unpin' : '📌 Pin to top',
      onPress: async () => {
        if (!plus) {
          router.push('/plus');
          return;
        }
        const result = await togglePinned(key, stillThere);
        if (!active.current) return;
        if (result === 'pinned') showToast('Pinned to the top 📌');
        else if (result === 'unpinned') showToast('Unpinned');
        else if (result === 'full') showToast(`You can pin up to ${MAX_PINS} chats. Unpin one first.`);
        else router.push('/plus');
      },
    };
  }

  // Hold down a group: pin it to the top, or open its chat.
  function openGroupMenu(group: PeekGroup) {
    if (!active.current) return;
    showOptions({
      title: group.name,
      options: [
        pinOption(pinKeyForGroup(group.id)),
        { label: '💬 Open group chat', onPress: () => router.push(`/groups/chat/${group.id}`) },
      ],
    });
  }

  // Hold down a chat: options for that friend.
  function openFriendMenu(friend: Profile) {
    if (!active.current) return;
    const current = settings.get(friend.id);
    const name = friend.display_name || friend.username;
    const close = closeFriends.has(friend.id);
    const change = async (changes: Partial<Omit<FriendSettings, 'friend_id'>>, done: string) => {
      if (!active.current) return;
      try {
        const saved = await saveFriendSettings(userId, friend.id, changes);
        if (!active.current) return;
        setSettings((map) => new Map(map).set(friend.id, saved));
        // Hiding (or showing) their stories takes their ring away (or brings it back) straight away.
        if ('mute_stories' in changes) void refreshStoryBadges(userId, true);
        showToast(done);
      } catch (error) {
        Alert.alert('Could not save', friendlyError(error));
      }
    };
    showOptions({
      title: name,
      options: [
        pinOption(pinKeyForFriend(friend.id)),
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
            if (!active.current) return;
            try {
              await setCloseFriend(userId, friend.id, !close);
              if (!active.current) return;
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
        {
          label: '🧹 Clear chat',
          destructive: true,
          onPress: () =>
            Alert.alert(`Clear your chat with ${name}?`, `It's only cleared for you – ${name} still has it.`, [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Clear',
                style: 'destructive',
                onPress: async () => {
                  if (!active.current) return;
                  try {
                    await clearChat(friend.id);
                    if (!active.current) return;
                    showToast('Chat cleared 🧹');
                    refresh();
                  } catch (error) {
                    Alert.alert('Could not clear', friendlyError(error));
                  }
                },
              },
            ]),
        },
        { label: '🚫 Block', destructive: true, onPress: () => confirmBlock(friend, refresh) },
      ],
    });
  }

  return (
    <View style={styles.fill}>
      <PageHeader title="Chat" inbox={{ count: inboxCount, onPress: () => router.push('/inbox') }} />
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
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pullToRefresh} tintColor={colors.accent} />}
          contentContainerStyle={[styles.list, { paddingBottom: tabSpace + space.lg }]}
          ListHeaderComponent={
            searching ? (
              matching.length > 0 ? <Text style={styles.sectionTitle}>💬 Chats</Text> : undefined
            ) : (
            <>
              {inboxCount > 0 ? (
                <Pressable style={styles.inboxRow} onPress={() => router.push('/inbox')} accessibilityRole="button">
                  <Text style={styles.inboxEmoji}>🔔</Text>
                  <Text style={styles.inboxText}>
                    {inboxCount} new in your Inbox
                  </Text>
                  <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
                </Pressable>
              ) : null}
              {rows.length > 0 ? (
                <>
                  <GroupsSection groups={groups} chats={groupChats} pins={pins} onMenu={openGroupMenu} />
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
              pinned={pins.includes(pinKeyForFriend(item.friend.id))}
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
// Pinned groups (Peekaboo+) come first, with a 📌. Hold a group for its menu.
function GroupsSection({ groups, chats, pins, onMenu }: {
  groups: PeekGroup[];
  chats: Map<string, GroupChatSummary>;
  pins: string[];
  onMenu: (group: PeekGroup) => void;
}) {
  return (
    <>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>👯 Groups</Text>
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
        sortByPins(groups, (group) => pinKeyForGroup(group.id), pins).map((group) => {
          const pinned = pins.includes(pinKeyForGroup(group.id));
          const total = counting(group).length;
          const left = stillToPost(group).length;
          const chat = chats.get(group.id);
          const lastSender = chat?.last_sender ? group.members.find((m) => m.userId === chat.last_sender)?.profile : null;
          const unread = chat?.unread ?? 0;
          return (
            <Pressable
              key={group.id}
              // Opens the group chat (its drops and members are one tap away from there).
              onPress={() => router.push(`/groups/chat/${group.id}`)}
              onLongPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                onMenu(group);
              }}
              accessibilityHint="Hold for options"
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
              <View style={styles.groupIcon}>
                {group.photo_path ? (
                  <Avatar path={group.photo_path} name={group.name} size={48} />
                ) : (
                  <GroupFaces members={group.members} size={24} />
                )}
              </View>
              <View style={styles.rowText}>
                <Text style={styles.name} numberOfLines={1}>
                  {group.name}
                  {pinned ? <Text style={styles.pin}> 📌</Text> : null}
                </Text>
                {chat?.last_body ? (
                  <Text style={[styles.statusText, unread > 0 && styles.groupUnreadText]} numberOfLines={1}>
                    {chat.muted ? '🔕 ' : ''}
                    {lastSender ? `${lastSender.display_name || lastSender.username}: ` : ''}
                    {chat.last_body}
                  </Text>
                ) : (
                  <Text style={[styles.statusText, left === 0 && styles.groupDone]}>
                    {left === 0 ? "Everyone posted today's drop 🎉" : `${total - left} of ${total} posted today's drop`}
                  </Text>
                )}
              </View>
              {unread > 0 ? (
                <View style={styles.groupUnread}>
                  <Text style={styles.groupUnreadCount}>{unread > 99 ? '99+' : unread}</Text>
                </View>
              ) : (
                <Ionicons name="chevron-forward" size={20} color={colors.textFaint} />
              )}
            </Pressable>
          );
        })
      )}
    </>
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
  if (last.kind === 'sticker') {
    const theyDidIt = last.sender_id !== me;
    return {
      icon: 'happy',
      color: colors.yellow,
      label: theyDidIt ? 'Sent you a sticker ✨' : 'You sent a sticker',
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
  // Screen readers treat the row as one button, so their story is offered as an extra action on it.
  const story = useStoryBadge(me, row.friend.id);
  return (
    <Pressable
      onPress={() => router.push(`/chat/${row.friend.id}`)}
      accessibilityActions={story ? [{ name: 'watchStory', label: 'Watch their story' }] : undefined}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'watchStory') {
          router.push({ pathname: '/stories/[user]', params: { user: row.friend.id } });
        }
      }}
      onLongPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        onMenu();
      }}
      accessibilityHint="Hold for options"
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
      {/* With a story: a ring, and tapping the picture opens the story. Otherwise it opens the chat like the row. */}
      <StoryAvatar
        person={row.friend}
        size={52}
        onPress={() => router.push(`/chat/${row.friend.id}`)}
        onLongPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          onMenu();
        }}
      />
      <View style={styles.rowText}>
        <View style={styles.nameRow}>
          <Text style={[styles.name, styles.nameText]} numberOfLines={1}>
            {row.friend.display_name || row.friend.username}
          </Text>
          {pinned ? <Text style={styles.pin}>📌</Text> : null}
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
  inboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.lg,
    marginBottom: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
  },
  inboxEmoji: {
    fontSize: 18,
  },
  inboxText: {
    ...font.body,
    fontWeight: '800',
    flex: 1,
  },
  // See-through on a Peekaboo+ theme with a moving picture behind (theme.ts pageBackground).
  fill: {
    flex: 1,
    backgroundColor: pageBackground,
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
  pin: {
    fontSize: 12,
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
  groupUnread: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.blue,
  },
  groupUnreadCount: {
    color: colors.white,
    fontSize: 12,
    fontWeight: '900',
  },
  groupUnreadText: {
    color: colors.text,
    fontWeight: '800',
  },
  groupDone: {
    color: colors.green,
    fontWeight: '800',
  },
});
