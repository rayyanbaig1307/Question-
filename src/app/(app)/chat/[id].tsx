import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useCallback, useRef, useState } from 'react';
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
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import { EmptyState } from '@/components/EmptyState';
import { IconButton } from '@/components/IconButton';
import { useOverlays } from '@/components/Overlays';
import { useMe } from '@/lib/auth';
import {
  cleanUpOpenedSnaps,
  deleteMessage,
  fetchConversation,
  markChatRead,
  sendText,
  subscribeToMyMessages,
  type Message,
} from '@/lib/chat';
import { friendlyError } from '@/lib/errors';
import { fetchRelation } from '@/lib/friends';
import { fetchProfile } from '@/lib/profiles';
import { timeAgo } from '@/lib/time';
import type { Profile } from '@/lib/types';
import { useSafetyActions } from '@/lib/useSafetyActions';
import { colors, font, radius, space } from '@/theme';

// A 1-on-1 chat with a friend. New messages pop in live.
export default function ChatScreen() {
  const { id: friendId } = useLocalSearchParams<{ id: string }>();
  const { userId } = useMe();
  const { showOptions, showToast } = useOverlays();
  const { report } = useSafetyActions();

  const [friend, setFriend] = useState<Profile | null>(null);
  const [areFriends, setAreFriends] = useState(true);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const cleanedUp = useRef(false);
  const headerHeight = useHeaderHeight();

  const loadMessages = useCallback(async () => {
    try {
      const list = await fetchConversation(userId, friendId);
      setMessages(list);
      // Opening the chat means you've read their messages.
      if (list.some((m) => m.sender_id === friendId && m.kind === 'text' && !m.opened_at)) {
        markChatRead(friendId).catch(() => {});
      }
      if (!cleanedUp.current) {
        cleanedUp.current = true;
        cleanUpOpenedSnaps(userId, list);
      }
    } catch (error) {
      console.warn('Could not load chat', error);
      setMessages((current) => current ?? []);
    }
  }, [friendId, userId]);

  useFocusEffect(
    useCallback(() => {
      loadMessages();
      fetchProfile(friendId).then(setFriend).catch(() => {});
      fetchRelation(userId, friendId)
        .then((relation) => setAreFriends(relation.kind === 'friends'))
        .catch(() => {});
      return subscribeToMyMessages(`chat-${userId}-${friendId}`, loadMessages);
    }, [friendId, userId, loadMessages]),
  );

  async function send() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const sent = await sendText(userId, friendId, body);
      setText('');
      setMessages((current) => [sent, ...(current ?? []).filter((m) => m.id !== sent.id)]);
    } catch (error) {
      Alert.alert('Message not sent', friendlyError(error));
    } finally {
      setSending(false);
    }
  }

  function openMenu(message: Message) {
    if (message.sender_id === userId) {
      showOptions({
        options: [
          {
            label: 'Unsend',
            destructive: true,
            onPress: async () => {
              try {
                await deleteMessage(message);
                setMessages((current) => current?.filter((m) => m.id !== message.id) ?? null);
                showToast('Unsent');
              } catch (error) {
                Alert.alert('Could not unsend', friendlyError(error));
              }
            },
          },
        ],
      });
    } else if (friend) {
      showOptions({
        options: [
          {
            label: 'Report message',
            onPress: () => report({ user: friend, contentType: 'message', contentId: message.id }),
          },
        ],
      });
    }
  }

  const name = friend ? friend.display_name || friend.username : '';
  // Show "Delivered / Opened" under your most recent message only.
  const myLatestId = messages?.find((m) => m.sender_id === userId)?.id;

  return (
    <SafeAreaView style={styles.fill} edges={['bottom']}>
      <Stack.Screen
        options={{
          headerShown: true,
          headerTitle: () =>
            friend ? (
              <Pressable style={styles.headerTitle} onPress={() => router.push(`/profile/${friend.id}`)}>
                <Avatar path={friend.avatar_path} name={name} size={32} />
                <Text style={styles.headerName} numberOfLines={1}>
                  {name}
                </Text>
              </Pressable>
            ) : null,
        }}
      />

      <KeyboardAvoidingView style={styles.fill} behavior="padding" keyboardVerticalOffset={headerHeight}>
        {messages === null ? (
          <ActivityIndicator color={colors.accent} style={styles.loading} />
        ) : messages.length === 0 ? (
          <View style={styles.empty}>
            <EmptyState emoji="👋" title={`Say hi to ${name || 'your friend'}!`} message="Send a message or a peek." />
          </View>
        ) : (
          <FlatList
            data={messages}
            inverted
            keyExtractor={(m) => m.id}
            contentContainerStyle={styles.list}
            keyboardDismissMode="interactive"
            renderItem={({ item }) => (
              <MessageView
                message={item}
                mine={item.sender_id === userId}
                showStatus={item.id === myLatestId}
                onLongPress={() => openMenu(item)}
              />
            )}
          />
        )}

        {areFriends ? (
          <View style={styles.inputBar}>
            <IconButton
              icon="camera"
              label="Send a peek"
              background={colors.accent}
              color={colors.onAccent}
              onPress={() => router.push({ pathname: '/camera', params: { to: friendId } })}
            />
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="Send a chat"
              placeholderTextColor={colors.textFaint}
              keyboardAppearance="dark"
              selectionColor={colors.accent}
              multiline
              maxLength={2000}
              style={styles.input}
            />
            <IconButton
              icon="arrow-up"
              label="Send"
              background={text.trim() ? colors.blue : colors.card}
              onPress={send}
            />
          </View>
        ) : (
          <Text style={styles.notFriends}>You need to be friends to chat.</Text>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function MessageView({ message, mine, showStatus, onLongPress }: {
  message: Message;
  mine: boolean;
  showStatus: boolean;
  onLongPress: () => void;
}) {
  const time = timeAgo(message.created_at);
  const status = mine && showStatus ? ` · ${message.opened_at ? 'Opened' : 'Delivered'}` : '';

  if (message.kind === 'snap') {
    const canOpen = !mine && message.opened_at === null;
    return (
      <Pressable
        onPress={canOpen ? () => router.push(`/snap/${message.id}`) : undefined}
        onLongPress={onLongPress}
        style={[styles.snap, mine ? styles.right : styles.left, canOpen && styles.snapNew]}>
        <Ionicons
          name={canOpen ? 'square' : mine ? 'paper-plane' : 'square-outline'}
          size={18}
          color={canOpen ? colors.white : colors.accent}
        />
        <Text style={[styles.snapText, canOpen && styles.snapTextNew]}>
          {mine ? 'You sent a peek' : canOpen ? 'New peek · tap to view' : 'Peek opened'}
        </Text>
        <Text style={[styles.time, canOpen && styles.snapTextNew]}>
          {time}
          {status}
        </Text>
      </Pressable>
    );
  }

  return (
    <View style={[styles.bubbleWrap, mine ? styles.right : styles.left]}>
      <Pressable onLongPress={onLongPress} style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
        <Text style={[styles.bubbleText, mine && styles.bubbleTextMine]}>{message.body}</Text>
      </Pressable>
      <Text style={styles.time}>
        {time}
        {status}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  loading: {
    flex: 1,
  },
  headerTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    maxWidth: 240,
  },
  headerName: {
    ...font.body,
    fontWeight: '800',
  },
  list: {
    padding: space.lg,
    gap: space.md,
    flexGrow: 1,
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
  },
  left: {
    alignSelf: 'flex-start',
    alignItems: 'flex-start',
  },
  right: {
    alignSelf: 'flex-end',
    alignItems: 'flex-end',
  },
  bubbleWrap: {
    maxWidth: '80%',
    gap: 3,
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
    color: colors.textFaint,
  },
  snap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.lg,
    borderWidth: 2,
    borderColor: colors.accent,
    maxWidth: '85%',
  },
  snapNew: {
    backgroundColor: colors.accent,
  },
  snapText: {
    ...font.body,
    fontWeight: '800',
    color: colors.accent,
  },
  snapTextNew: {
    color: colors.white,
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.sm,
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
  notFriends: {
    ...font.small,
    textAlign: 'center',
    padding: space.lg,
  },
});
