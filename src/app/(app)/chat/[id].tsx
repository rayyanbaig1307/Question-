import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { router, useFocusEffect, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import { EmptyState } from '@/components/EmptyState';
import { IconButton } from '@/components/IconButton';
import { useOverlays } from '@/components/Overlays';
import { ScreenHeader } from '@/components/ScreenHeader';
import { useMe } from '@/lib/auth';
import {
  canReplay,
  canSave,
  cleanUpOpenedSnaps,
  deleteMessage,
  fetchConversation,
  markChatRead,
  sendText,
  setSnapSaved,
  subscribeToMyMessages,
  type Message,
} from '@/lib/chat';
import { friendlyError } from '@/lib/errors';
import { fetchRelation } from '@/lib/friends';
import { fetchProfile } from '@/lib/profiles';
import { useScreenshotNotice } from '@/lib/screenshots';
import { timeAgo } from '@/lib/time';
import { useTyping } from '@/lib/typing';
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
  const insets = useSafeAreaInsets();
  const { friendTyping, onTextChange, clearFriendTyping } = useTyping(userId, friendId, areFriends);
  // Screenshot this chat → your friend sees a notice. (Only while you're looking at it, not a peek on top of it.)
  const focused = useIsFocused();
  useScreenshotNotice(userId, friendId, 'chat', focused && areFriends);

  const loadMessages = useCallback(async () => {
    try {
      const list = await fetchConversation(userId, friendId);
      setMessages(list);
      // Their message just arrived, so they're not typing any more.
      if (list[0]?.sender_id === friendId) clearFriendTyping();
      // Opening the chat means you've read their messages.
      if (list.some((m) => m.sender_id === friendId && m.kind !== 'snap' && !m.opened_at)) {
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
  }, [friendId, userId, clearFriendTyping]);

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
      onTextChange('');
      setMessages((current) => [sent, ...(current ?? []).filter((m) => m.id !== sent.id)]);
    } catch (error) {
      Alert.alert('Message not sent', friendlyError(error));
    } finally {
      setSending(false);
    }
  }

  // Save a peek in the chat (or unsave it). Either of you can.
  async function toggleSaved(message: Message, save: boolean) {
    try {
      if (!(await setSnapSaved(message.id, save))) {
        Alert.alert("Can't save this one", 'Peeks can only be saved up to a day after they were opened.');
        return;
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showToast(save ? 'Saved in chat 📌' : 'Unsaved – it will disappear');
      const savedAt = save ? new Date().toISOString() : null;
      setMessages(
        (current) =>
          current?.map((m) => (m.id === message.id ? { ...m, saved_at: savedAt, saved_by: save ? userId : null } : m)) ??
          null,
      );
    } catch (error) {
      Alert.alert('Something went wrong', friendlyError(error));
    }
  }

  // Press and hold a message: save/unsave a peek, unsend your own, or report theirs.
  function openMenu(message: Message) {
    // Screenshot notices can't be unsent or reported.
    if (message.kind === 'screenshot') return;
    const saveOptions =
      message.kind !== 'snap'
        ? []
        : message.saved_at
          ? [{ label: 'Unsave', onPress: () => toggleSaved(message, false) }]
          : canSave(message)
            ? [{ label: 'Save in chat 📌', onPress: () => toggleSaved(message, true) }]
            : [];
    if (message.sender_id === userId) {
      showOptions({
        options: [
          ...saveOptions,
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
          ...saveOptions,
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
  const myLatestId = messages?.find((m) => m.sender_id === userId && m.kind !== 'screenshot')?.id;

  return (
    <View style={styles.fill}>
      <ScreenHeader
        titleContent={
          friend ? (
            <Pressable style={styles.headerTitle} onPress={() => router.push(`/profile/${friend.id}`)}>
              <Avatar path={friend.avatar_path} name={name} size={32} />
              <View>
                <Text style={styles.headerName} numberOfLines={1}>
                  {name}
                </Text>
                {friendTyping ? <Text style={styles.headerTyping}>typing…</Text> : null}
              </View>
            </Pressable>
          ) : null
        }
      />

      {/* The negative offset stops a gap appearing between the message box and the keyboard. */}
      <KeyboardAvoidingView style={styles.fill} behavior="padding" keyboardVerticalOffset={-insets.bottom}>
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
            // The list is upside down, so this "header" sits at the very bottom, under the newest message.
            ListHeaderComponent={friendTyping ? <TypingBubble /> : undefined}
            renderItem={({ item }) => (
              <MessageView
                message={item}
                me={userId}
                friendName={name}
                showStatus={item.id === myLatestId}
                onLongPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  openMenu(item);
                }}
              />
            )}
          />
        )}

        {areFriends ? (
          <View style={[styles.inputBar, { paddingBottom: insets.bottom + space.sm }]}>
            <IconButton
              icon="camera"
              label="Send a peek"
              background={colors.accent}
              color={colors.onAccent}
              onPress={() => router.push({ pathname: '/camera', params: { to: friendId } })}
            />
            <TextInput
              value={text}
              onChangeText={(value) => {
                setText(value);
                onTextChange(value);
              }}
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
          <Text style={[styles.notFriends, { paddingBottom: insets.bottom + space.lg }]}>You need to be friends to chat.</Text>
        )}
      </KeyboardAvoidingView>
    </View>
  );
}

function MessageView({ message, me, friendName, showStatus, onLongPress }: {
  message: Message;
  me: string;
  friendName: string;
  showStatus: boolean;
  onLongPress: () => void;
}) {
  const mine = message.sender_id === me;
  const time = timeAgo(message.created_at);
  const seen = message.replayed_at ? 'Replayed 🔁' : message.opened_at ? 'Opened' : 'Delivered';
  const status = mine && showStatus ? ` · ${seen}` : '';

  if (message.kind === 'screenshot') {
    const who = mine ? 'You' : friendName || 'They';
    const what = message.body === 'peek' ? (mine ? 'their peek' : 'your peek') : 'the chat';
    return (
      <View style={styles.notice}>
        <Text style={styles.noticeText}>
          📸 {who} took a screenshot of {what}!
        </Text>
        <Text style={styles.time}>{time}</Text>
      </View>
    );
  }

  if (message.kind === 'snap') {
    // What this peek looks like and does, from your side.
    const isNew = !mine && message.opened_at === null;
    const saved = message.saved_at !== null;
    const replay = canReplay(message, me);
    const look: { icon: keyof typeof Ionicons.glyphMap; text: string } = isNew
      ? { icon: 'square', text: 'New peek · tap to view' }
      : saved
        ? { icon: 'bookmark', text: 'Saved peek · tap to view' }
        : mine
          ? { icon: 'paper-plane', text: 'You sent a peek' }
          : replay
            ? { icon: 'refresh', text: 'Tap to replay' }
            : { icon: 'square-outline', text: 'Peek opened' };
    const tappable = isNew || saved || replay;
    const tint = saved && !isNew ? colors.purple : colors.accent;

    return (
      <Pressable
        onPress={tappable ? () => router.push(`/snap/${message.id}`) : undefined}
        onLongPress={onLongPress}
        style={[
          styles.snap,
          mine ? styles.right : styles.left,
          { borderColor: tint },
          isNew && styles.snapNew,
        ]}>
        <Ionicons name={look.icon} size={18} color={isNew ? colors.white : tint} />
        <Text style={[styles.snapText, { color: tint }, isNew && styles.snapTextNew]}>{look.text}</Text>
        <Text style={[styles.time, isNew && styles.snapTextNew]}>
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

// Three little dots that bounce while your friend is typing.
function TypingBubble() {
  return (
    <Animated.View
      entering={FadeIn.duration(150)}
      exiting={FadeOut.duration(150)}
      style={[styles.bubble, styles.bubbleTheirs, styles.typing]}
      accessibilityLabel="Typing">
      {[0, 1, 2].map((i) => (
        <TypingDot key={i} delay={i * 150} />
      ))}
    </Animated.View>
  );
}

function TypingDot({ delay }: { delay: number }) {
  const up = useSharedValue(0);
  useEffect(() => {
    up.set(
      withDelay(
        delay,
        withRepeat(withSequence(withTiming(1, { duration: 300 }), withTiming(0, { duration: 300 })), -1),
      ),
    );
  }, [up, delay]);
  const style = useAnimatedStyle(() => ({
    opacity: 0.4 + up.get() * 0.6,
    transform: [{ translateY: -up.get() * 4 }],
  }));
  return <Animated.View style={[styles.dot, style]} />;
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
  notice: {
    alignSelf: 'center',
    alignItems: 'center',
    gap: 2,
    paddingVertical: space.xs,
  },
  noticeText: {
    ...font.small,
    color: colors.purple,
    fontWeight: '800',
    textAlign: 'center',
  },
  headerTyping: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '700',
  },
  typing: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 16,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.textMuted,
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
