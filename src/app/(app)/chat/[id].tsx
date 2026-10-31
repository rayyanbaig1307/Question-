import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
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
import { MicButton, VoiceBubble, type Recording } from '@/components/VoiceNote';
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
import { useMediaUrl } from '@/lib/media';
import { fetchRelation } from '@/lib/friends';
import { fetchProfile } from '@/lib/profiles';
import { useScreenshotNotice } from '@/lib/screenshots';
import { timeAgo } from '@/lib/time';
import { useTyping } from '@/lib/typing';
import { Audio, sendVoice } from '@/lib/voice';
import type { Profile } from '@/lib/types';
import { useSafetyActions } from '@/lib/useSafetyActions';
import { colors, font, keyboardAppearance, radius, space } from '@/theme';

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

  async function sendVoiceNote(recording: Recording) {
    setSending(true);
    try {
      const sent = await sendVoice(userId, friendId, recording.uri, recording.durationMs, recording.waveform);
      setMessages((current) => [sent, ...(current ?? []).filter((m) => m.id !== sent.id)]);
    } catch (error) {
      Alert.alert('Voice note not sent', friendlyError(error));
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
  // Show "Delivered / Seen" under your most recent message (peeks always show theirs).
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
              keyboardAppearance={keyboardAppearance}
              selectionColor={colors.accent}
              multiline
              maxLength={2000}
              style={styles.input}
            />
            {/* Nothing typed: hold the mic for a voice note. Typing: the send button. */}
            {text.trim() || !Audio ? (
              <IconButton
                icon="arrow-up"
                label="Send"
                background={text.trim() ? colors.blue : colors.card}
                onPress={send}
              />
            ) : (
              <MicButton onRecorded={sendVoiceNote} onHint={showToast} />
            )}
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
  const statusLine = (show: boolean) =>
    mine && show ? <MessageStatus message={message} /> : null;

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

  if (message.kind === 'reaction') {
    return (
      <View style={[styles.bubbleWrap, mine ? styles.right : styles.left]}>
        <Pressable onLongPress={onLongPress} style={[styles.reaction, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
          {message.story ? <StoryThumb story={message.story} /> : null}
          <Text style={styles.reactionEmoji}>{message.body}</Text>
          <Text style={[styles.reactionText, mine && styles.bubbleTextMine]}>
            {mine ? `You reacted to ${friendName || 'their'}'s story` : 'Reacted to your story'}
          </Text>
        </Pressable>
        <Text style={styles.time}>{time}</Text>
      </View>
    );
  }

  if (message.kind === 'voice') {
    return (
      <Pressable onLongPress={onLongPress} style={[styles.bubbleWrap, mine ? styles.right : styles.left]}>
        <VoiceBubble path={message.media_path} durationMs={message.audio_ms ?? 0} waveform={message.waveform} mine={mine} />
        <View style={styles.metaRow}>
          <Text style={styles.time}>{time}</Text>
          {statusLine(showStatus)}
        </View>
      </Pressable>
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
      <View style={[styles.bubbleWrap, mine ? styles.right : styles.left]}>
        <Pressable
          onPress={tappable ? () => router.push(`/snap/${message.id}`) : undefined}
          onLongPress={onLongPress}
          accessibilityRole={tappable ? 'button' : undefined}
          accessibilityLabel={look.text}
          style={({ pressed }) => [
            styles.snap,
            mine ? styles.snapMine : styles.snapTheirs,
            { borderColor: tint },
            isNew && styles.snapNew,
            pressed && tappable && styles.snapPressed,
          ]}>
          <View style={[styles.snapIcon, { backgroundColor: isNew ? colors.white : tint }]}>
            <Ionicons name={look.icon} size={15} color={isNew ? colors.accent : colors.white} />
          </View>
          <Text style={[styles.snapText, { color: tint }, isNew && styles.snapTextNew]} numberOfLines={1}>
            {look.text}
          </Text>
        </Pressable>
        <View style={styles.metaRow}>
          <Text style={styles.time}>{time}</Text>
          {/* Every peek you send shows whether it was opened. */}
          {statusLine(true)}
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.bubbleWrap, mine ? styles.right : styles.left]}>
      <Pressable onLongPress={onLongPress} style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
        <Text style={[styles.bubbleText, mine && styles.bubbleTextMine]}>{message.body}</Text>
      </Pressable>
      <View style={styles.metaRow}>
        <Text style={styles.time}>{time}</Text>
        {statusLine(showStatus)}
      </View>
    </View>
  );
}

// Under your own messages: ✓ Delivered (sent, not looked at yet) or 👁 Seen (Opened / Replayed for peeks).
function MessageStatus({ message }: { message: Message }) {
  const opened = message.opened_at !== null;
  const label = message.replayed_at
    ? 'Replayed'
    : !opened
      ? 'Delivered'
      : message.kind === 'snap'
        ? 'Opened'
        : 'Seen';
  const color = opened ? colors.accent : colors.textFaint;
  return (
    <View style={styles.status} accessibilityLabel={label}>
      <Text style={styles.time}>·</Text>
      <Ionicons
        name={message.replayed_at ? 'refresh' : opened ? 'eye' : 'checkmark'}
        size={12}
        color={color}
      />
      <Text style={[styles.time, styles.statusText, { color }]}>{label}</Text>
    </View>
  );
}

// A tiny picture of the story a reaction was for (while the story is still up).
function StoryThumb({ story }: { story: NonNullable<Message['story']> }) {
  const path = story.media_type === 'video' ? story.poster_path : story.media_path;
  const url = useMediaUrl(path);
  return (
    <View style={styles.storyThumb}>
      {url ? <Image source={{ uri: url, cacheKey: path ?? undefined }} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
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
  reaction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.lg,
  },
  reactionEmoji: {
    fontSize: 34,
  },
  reactionText: {
    ...font.small,
    color: colors.text,
    fontWeight: '700',
    flexShrink: 1,
  },
  storyThumb: {
    width: 36,
    height: 56,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  time: {
    ...font.small,
    fontSize: 11,
    color: colors.textFaint,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  statusText: {
    fontWeight: '700',
  },
  // A peek looks like a message bubble (same shape and corner), with a round icon and a coloured outline.
  snap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingLeft: space.sm,
    paddingRight: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: colors.accent,
    backgroundColor: colors.card,
  },
  snapMine: {
    borderBottomRightRadius: 6,
  },
  snapTheirs: {
    borderBottomLeftRadius: 6,
  },
  snapPressed: {
    opacity: 0.7,
  },
  snapIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
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
