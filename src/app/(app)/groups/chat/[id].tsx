import * as Haptics from 'expo-haptics';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import { EmptyState } from '@/components/EmptyState';
import { GroupFaces } from '@/components/GroupFaces';
import { IconButton } from '@/components/IconButton';
import { useOverlays } from '@/components/Overlays';
import { RoundIconButton, ScreenHeader } from '@/components/ScreenHeader';
import { useMe } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import {
  deleteGroupMessage,
  fetchGroupChats,
  fetchGroupMessages,
  markGroupChatRead,
  sendGroupMessage,
  setGroupChatMuted,
  subscribeToGroupChat,
  type GroupMessage,
} from '@/lib/groupChat';
import { fetchGroup, type PeekGroup } from '@/lib/groups';
import { timeAgo } from '@/lib/time';
import type { Profile } from '@/lib/types';
import { useSafetyActions } from '@/lib/useSafetyActions';
import { colors, font, keyboardAppearance, radius, space } from '@/theme';

// A Group Peek group's chat 💬: everyone in the group, live. Tap the top to see the group (drops, members).
// Hold a message: your own → delete for everyone; someone else's → report them.
export default function GroupChat() {
  const { id: groupId } = useLocalSearchParams<{ id: string }>();
  const { userId } = useMe();
  const { showOptions, showToast } = useOverlays();
  const { report } = useSafetyActions();
  const insets = useSafeAreaInsets();
  const [group, setGroup] = useState<PeekGroup | null | undefined>(undefined);
  const [messages, setMessages] = useState<GroupMessage[] | null>(null);
  const [muted, setMuted] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const load = useCallback(() => {
    fetchGroupMessages(groupId)
      .then((list) => {
        setMessages(list);
        markGroupChatRead(groupId).catch(() => {});
      })
      .catch((error) => {
        console.warn('Could not load the group chat', error);
        setMessages((current) => current ?? []);
      });
  }, [groupId]);

  useFocusEffect(
    useCallback(() => {
      fetchGroup(groupId)
        .then(setGroup)
        .catch(() => setGroup(null));
      fetchGroupChats()
        .then((chats) => setMuted(chats.get(groupId)?.muted ?? false))
        .catch(() => {});
      load();
      return subscribeToGroupChat(groupId, load);
    }, [groupId, load]),
  );

  const people = new Map<string, Profile>();
  for (const member of group?.members ?? []) if (member.profile) people.set(member.userId, member.profile);

  async function send() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const sent = await sendGroupMessage(groupId, body);
      setText('');
      setMessages((current) => [sent, ...(current ?? []).filter((m) => m.id !== sent.id)]);
    } catch (error) {
      Alert.alert('Message not sent', friendlyError(error));
    } finally {
      setSending(false);
    }
  }

  function openMessageMenu(message: GroupMessage) {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const sender = people.get(message.sender_id);
    if (message.sender_id === userId) {
      showOptions({
        options: [
          {
            label: 'Delete for everyone',
            destructive: true,
            onPress: async () => {
              try {
                await deleteGroupMessage(message.id);
                setMessages((current) => current?.filter((m) => m.id !== message.id) ?? null);
                showToast('Deleted for everyone');
              } catch (error) {
                Alert.alert('Could not delete', friendlyError(error));
              }
            },
          },
        ],
      });
    } else if (sender) {
      showOptions({
        title: sender.display_name || `@${sender.username}`,
        options: [
          { label: '👤 See profile', onPress: () => router.push(`/profile/${sender.id}`) },
          { label: 'Report', onPress: () => report({ user: sender, contentType: 'user', contentId: sender.id }) },
        ],
      });
    }
  }

  function openGroupMenu() {
    showOptions({
      title: group?.name,
      options: [
        { label: '👯 Group info & drops', onPress: () => router.push(`/groups/${groupId}`) },
        {
          label: muted ? '🔔 Unmute group chat' : '🔕 Mute group chat',
          onPress: async () => {
            try {
              await setGroupChatMuted(groupId, !muted);
              setMuted(!muted);
              showToast(muted ? 'Group chat notifications are back on' : 'Group chat muted – no notifications');
            } catch (error) {
              Alert.alert('Could not save', friendlyError(error));
            }
          },
        },
      ],
    });
  }

  if (group === null) {
    return (
      <View style={styles.fill}>
        <ScreenHeader title="Group chat" />
        <EmptyState emoji="💨" title="This group is gone" message="It was deleted, or you're not in it any more." />
      </View>
    );
  }

  return (
    <View style={styles.fill}>
      <ScreenHeader
        titleContent={
          group ? (
            <Pressable style={styles.headerTitle} onPress={() => router.push(`/groups/${groupId}`)}>
              <GroupFaces members={group.members} size={22} />
              <View style={styles.headerText}>
                <Text style={styles.headerName} numberOfLines={1}>
                  {group.name}
                </Text>
                <Text style={styles.headerSub} numberOfLines={1}>
                  {muted ? '🔕 Muted · ' : ''}
                  {group.members.length} people
                </Text>
              </View>
            </Pressable>
          ) : null
        }
        right={<RoundIconButton icon="ellipsis-horizontal" label="Group chat options" onPress={openGroupMenu} />}
      />

      <KeyboardAvoidingView style={styles.fill} behavior="padding" keyboardVerticalOffset={-insets.bottom}>
        {messages === null ? (
          <ActivityIndicator color={colors.accent} style={styles.loading} />
        ) : messages.length === 0 ? (
          <View style={styles.fill}>
            <EmptyState emoji="💬" title="Say hi to the group!" message="Everyone in the group sees what you send here." />
          </View>
        ) : (
          <FlatList
            data={messages}
            inverted
            keyExtractor={(m) => m.id}
            contentContainerStyle={styles.list}
            keyboardDismissMode="interactive"
            renderItem={({ item, index }) => {
              const mine = item.sender_id === userId;
              const sender = people.get(item.sender_id);
              const name = sender ? sender.display_name || sender.username : 'Someone';
              // The list is upside down: the message "after" this one on screen is the one before it in time.
              const older = messages[index + 1];
              const firstOfRun = !older || older.sender_id !== item.sender_id;
              return (
                <View style={[styles.row, mine ? styles.right : styles.left]}>
                  {!mine ? (
                    <View style={styles.avatarSlot}>
                      {firstOfRun ? <Avatar path={sender?.avatar_path} name={name} size={28} /> : null}
                    </View>
                  ) : null}
                  <View style={[styles.bubbleWrap, mine ? styles.alignRight : styles.alignLeft]}>
                    {!mine && firstOfRun ? <Text style={styles.sender}>{name}</Text> : null}
                    <Pressable
                      onLongPress={() => openMessageMenu(item)}
                      style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
                      <Text style={[styles.bubbleText, mine && styles.bubbleTextMine]}>{item.body}</Text>
                    </Pressable>
                    <Text style={styles.time}>{timeAgo(item.created_at)}</Text>
                  </View>
                </View>
              );
            }}
          />
        )}

        <View style={[styles.inputBar, { paddingBottom: insets.bottom + space.sm }]}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Message the group"
            placeholderTextColor={colors.textFaint}
            keyboardAppearance={keyboardAppearance}
            selectionColor={colors.accent}
            multiline
            maxLength={2000}
            style={styles.input}
          />
          <IconButton icon="arrow-up" label="Send" background={text.trim() ? colors.blue : colors.card} onPress={send} />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  loading: {
    marginTop: space.xl,
  },
  headerTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    maxWidth: 240,
  },
  headerText: {
    flexShrink: 1,
  },
  headerName: {
    ...font.body,
    fontWeight: '900',
  },
  headerSub: {
    ...font.small,
  },
  list: {
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    gap: space.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
  },
  right: {
    justifyContent: 'flex-end',
  },
  left: {
    justifyContent: 'flex-start',
  },
  avatarSlot: {
    width: 28,
  },
  bubbleWrap: {
    maxWidth: '78%',
    gap: 3,
  },
  alignRight: {
    alignItems: 'flex-end',
  },
  alignLeft: {
    alignItems: 'flex-start',
  },
  sender: {
    ...font.small,
    fontWeight: '800',
    marginLeft: space.sm,
  },
  bubble: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.lg,
  },
  bubbleMine: {
    backgroundColor: colors.purple,
    borderBottomRightRadius: 6,
  },
  bubbleTheirs: {
    backgroundColor: colors.card,
    borderBottomLeftRadius: 6,
  },
  bubbleText: {
    ...font.body,
    lineHeight: 22,
  },
  bubbleTextMine: {
    color: colors.white,
  },
  time: {
    ...font.small,
    fontSize: 11,
    marginHorizontal: space.sm,
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    backgroundColor: colors.card,
    borderRadius: 22,
    paddingHorizontal: space.lg,
    paddingTop: 12,
    paddingBottom: 12,
    color: colors.text,
    fontSize: 16,
  },
});
