import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { useMe } from '@/lib/auth';
import { fetchRecentMessages, subscribeToMyMessages, type Message } from '@/lib/chat';
import { fetchFriends } from '@/lib/friends';
import { inviteFriends } from '@/lib/invite';
import { timeAgo } from '@/lib/time';
import type { Profile } from '@/lib/types';
import { colors, font, space } from '@/theme';
import { useTabBarSpace } from './HomeTabBar';
import { PageHeader } from './PageHeader';

type ChatRow = {
  friend: Profile;
  last: Message | null;
  newSnaps: number;
  newChats: number;
};

// Left page: everyone you can chat with, most recent first.
export function ChatPage({ visible, onCamera }: { visible: boolean; onCamera: () => void }) {
  const { userId, profile } = useMe();
  const tabSpace = useTabBarSpace();
  const [rows, setRows] = useState<ChatRow[] | null>(null);

  useEffect(() => {
    if (!visible) return;
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
});
