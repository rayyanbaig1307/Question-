import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { GroupFaces } from '@/components/GroupFaces';
import { useOverlays } from '@/components/Overlays';
import { useMe } from '@/lib/auth';
import { fetchRecentMessages, subscribeToMyMessages, type Message } from '@/lib/chat';
import { friendlyError } from '@/lib/errors';
import { fetchFriends } from '@/lib/friends';
import { counting, fetchGroups, stillToPost, type PeekGroup } from '@/lib/groups';
import { respondToHitUp, type HitUp } from '@/lib/hitups';
import { inviteFriends } from '@/lib/invite';
import { timeAgo } from '@/lib/time';
import type { Profile } from '@/lib/types';
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

// Left page: hit ups waiting for you at the top, then your Group Peek groups, then everyone you can chat with,
// most recent first.
export function ChatPage({ visible, onCamera, hitUps, onHitUpsChanged }: {
  visible: boolean;
  onCamera: () => void;
  hitUps: HitUp[];
  onHitUpsChanged: () => void;
}) {
  const { userId, profile } = useMe();
  const tabSpace = useTabBarSpace();
  const [rows, setRows] = useState<ChatRow[] | null>(null);
  const [groups, setGroups] = useState<PeekGroup[]>([]);

  useEffect(() => {
    if (!visible) return;
    fetchGroups()
      .then(setGroups)
      .catch(() => {});
    const load = async () => {
      try {
        const [friends, messages] = await Promise.all([fetchFriends(userId), fetchRecentMessages(userId)]);
        setRows(buildRows(friends, messages));
      } catch (error) {
        console.warn('Could not load chats', error);
        setRows((current) => current ?? []);
      }
    };
    load();
    // Refresh instantly when a message arrives or gets opened.
    return subscribeToMyMessages(`chat-list-${userId}`, load);
  }, [visible, userId]);

  return (
    <View style={styles.fill}>
      <PageHeader title="Chat" onCamera={onCamera} />
      {rows === null ? (
        <ActivityIndicator color={colors.accent} style={styles.loading} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(row) => row.friend.id}
          contentContainerStyle={[styles.list, { paddingBottom: tabSpace + space.lg }]}
          ListHeaderComponent={
            <>
              {hitUps.length > 0 ? (
                <View style={styles.hitUps}>
                  <Text style={styles.hitUpsTitle}>Hit ups 👋</Text>
                  {hitUps.map((hitUp) => (
                    <HitUpRow key={hitUp.id} hitUp={hitUp} onDone={onHitUpsChanged} />
                  ))}
                </View>
              ) : null}
              {rows.length > 0 ? (
                <>
                  <GroupsSection groups={groups} />
                  <Text style={styles.sectionTitle}>💬 Chats</Text>
                </>
              ) : null}
            </>
          }
          ListEmptyComponent={
            <EmptyState
              emoji="👀"
              title="It's quiet in here… too quiet"
              message="No friends yet. Invite your crew and start swapping peeks!">
              <Button title="Invite friends" icon="paper-plane" onPress={() => inviteFriends(profile?.username)} />
              <Button title="Find friends" icon="search" variant="secondary" onPress={() => router.push('/friends')} />
            </EmptyState>
          }
          renderItem={({ item }) => <ChatRowView row={item} me={userId} />}
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

function buildRows(friends: Profile[], messages: Message[]): ChatRow[] {
  const rows = friends.map((friend) => {
    const withFriend = messages.filter((m) => m.sender_id === friend.id || m.recipient_id === friend.id);
    const unopened = withFriend.filter((m) => m.sender_id === friend.id && m.opened_at === null);
    return {
      friend,
      last: withFriend[0] ?? null,
      newSnaps: unopened.filter((m) => m.kind === 'snap').length,
      newChats: unopened.filter((m) => m.kind === 'text' || m.kind === 'voice' || m.kind === 'reaction').length,
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
  if (last.kind === 'voice') {
    return { icon: 'mic', color: colors.pink, label: last.sender_id === me ? 'You sent a voice note' : 'Voice note 🎤', bold: false };
  }
  const color = last.kind === 'snap' ? colors.accent : colors.blue;
  if (last.sender_id === me) {
    return { icon: last.opened_at ? 'paper-plane-outline' : 'paper-plane', color, label: last.opened_at ? 'Opened' : 'Delivered', bold: false };
  }
  return { icon: last.kind === 'snap' ? 'square-outline' : 'chatbubble-outline', color, label: 'Received', bold: false };
}

function ChatRowView({ row, me }: { row: ChatRow; me: string }) {
  const status = describe(row, me);
  return (
    <Pressable
      onPress={() => router.push(`/chat/${row.friend.id}`)}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
      <Avatar path={row.friend.avatar_path} name={row.friend.display_name || row.friend.username} size={52} />
      <View style={styles.rowText}>
        <Text style={styles.name} numberOfLines={1}>
          {row.friend.display_name || row.friend.username}
        </Text>
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
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusText: {
    ...font.small,
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
