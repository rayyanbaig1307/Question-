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
import { DareComposer } from '@/components/DareComposer';
import { EmptyState } from '@/components/EmptyState';
import { IconButton } from '@/components/IconButton';
import { useOverlays } from '@/components/Overlays';
import { MicButton, VoiceBubble, type Recording } from '@/components/VoiceNote';
import { ScreenHeader } from '@/components/ScreenHeader';
import { useMe } from '@/lib/auth';
import {
  canReplay,
  canSave,
  claimChatDare,
  cleanUpOpenedSnaps,
  confirmChatDare,
  deleteMessage,
  fetchConversation,
  fetchDareStreak,
  markChatRead,
  type Message,
  sendDare,
  sendText,
  setSnapSaved,
  subscribeToMyMessages,
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
  // Your dare streak with this friend 🔥 (dares you two completed in a row).
  const [streak, setStreak] = useState(0);
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
      fetchDareStreak(friendId)
        .then(setStreak)
        .catch(() => {});
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
    // Private chats between friends aren't filtered: people can say whatever they want here (the owner's
    // choice). Report and Block still work on every message.
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

  // Their dare: open the camera – the peek you send is the proof, and the dare counts as done for you.
  function doDare(dare: Message) {
    router.push({ pathname: '/camera', params: { to: friendId, chatDare: dare.id } });
  }
  // Their dare, done some other way (e.g. "say hi" in the chat): tell them you did it.
  async function claimDare(dare: Message) {
    try {
      await claimChatDare(dare.id);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showToast(`Sent! Now ${name || 'they'} confirms it 🎯`);
      loadMessages();
    } catch (error) {
      Alert.alert('Oops', friendlyError(error));
    }
  }
  // Your dare: they say they did it – does it count?
  async function confirmDare(dare: Message, ok: boolean) {
    try {
      const newStreak = await confirmChatDare(dare.id, ok);
      Haptics.notificationAsync(ok ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning);
      if (ok) {
        setStreak(newStreak);
        showToast(newStreak > 1 ? `Dare completed ✅ 🔥 ${newStreak} dare streak!` : 'Dare completed ✅');
      } else {
        showToast("Told them it doesn't count ❌");
      }
      loadMessages();
    } catch (error) {
      Alert.alert('Oops', friendlyError(error));
    }
  }

  // Your own dare for this friend, sent as a dare card (private, so not word-filtered like the chat).
  const [dareOpen, setDareOpen] = useState(false);
  async function sendMyDare(dare: string): Promise<boolean> {
    try {
      const sent = await sendDare(userId, friendId, dare);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setMessages((current) => [sent, ...(current ?? []).filter((m) => m.id !== sent.id)]);
      return true;
    } catch (error) {
      Alert.alert('Dare not sent', friendlyError(error));
      return false;
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
                {friendTyping ? (
                  <Text style={styles.headerTyping}>typing…</Text>
                ) : streak > 0 ? (
                  <Text style={styles.headerStreak}>🔥 {streak} dare streak</Text>
                ) : null}
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
                dareActions={{ doDare, claimDare, confirmDare, dareBack: () => setDareOpen(true) }}
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
            <IconButton icon="flag" label="Write a dare" background={colors.card} color={colors.pink} onPress={() => setDareOpen(true)} />
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
      <DareComposer visible={dareOpen} friendName={name} onClose={() => setDareOpen(false)} onSend={sendMyDare} />
    </View>
  );
}

// The pink pill buttons on a dare card.
function DareButton({ icon, title, onPress, grow = false, quiet = false }: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  title: string;
  onPress: () => void;
  grow?: boolean;
  quiet?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.dareButton, grow && styles.dareButtonGrow, quiet && styles.dareButtonQuiet, pressed && styles.snapPressed]}
      accessibilityRole="button"
      accessibilityLabel={title}>
      <Ionicons name={icon} size={16} color={quiet ? colors.text : colors.onAccent} />
      <Text style={[styles.dareButtonText, quiet && styles.dareButtonTextQuiet]} numberOfLines={1}>
        {title}
      </Text>
    </Pressable>
  );
}

type DareActions = {
  doDare: (dare: Message) => void;
  claimDare: (dare: Message) => void;
  confirmDare: (dare: Message, ok: boolean) => void;
  dareBack: () => void;
};

function MessageView({ message, me, friendName, showStatus, onLongPress, dareActions }: {
  dareActions: DareActions;
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

  // A dare a friend wrote, and how it ends:
  // they do it (proof peek, or "I did it") → you confirm ✅ (or ❌ "doesn't count") → "Dare completed" + dare them back.
  if (message.kind === 'dare') {
    const state = message.dare_state ?? null;
    const who = friendName || 'they';
    return (
      <View style={[styles.bubbleWrap, mine ? styles.right : styles.left]}>
        <Pressable onLongPress={onLongPress} style={[styles.dareCard, state === 'done' && styles.dareCardDone]}>
          <Text style={[styles.dareLabel, state === 'done' && styles.dareLabelDone]}>
            {state === 'done' ? '✅ DARE COMPLETED' : `🎯 ${mine ? `YOU DARED ${(friendName || 'them').toUpperCase()}` : 'YOU GOT DARED'}`}
          </Text>
          <Text style={styles.dareText}>{message.body}</Text>

          {/* The one who got the dare */}
          {!mine && (state === null || state === 'nope') ? (
            <>
              {state === 'nope' ? <Text style={styles.dareNote}>❌ {who} says that didn&apos;t count – try again!</Text> : null}
              <DareButton icon="camera" title="Do it · send proof" onPress={() => dareActions.doDare(message)} />
              <Pressable onPress={() => dareActions.claimDare(message)} hitSlop={8} accessibilityRole="button">
                <Text style={styles.dareLink}>Already did it? Tap ✅</Text>
              </Pressable>
            </>
          ) : null}
          {!mine && state === 'claimed' ? <Text style={styles.dareNote}>⏳ Waiting for {who} to confirm…</Text> : null}
          {!mine && state === 'done' ? (
            <DareButton icon="flag" title={`Dare ${friendName || 'them'} back 🎯`} onPress={dareActions.dareBack} />
          ) : null}

          {/* The one who sent the dare */}
          {mine && state === null ? <Text style={styles.dareNote}>⏳ Waiting for {who} to do it…</Text> : null}
          {mine && state === 'claimed' ? (
            <>
              <Text style={styles.dareNote}>🎯 {friendName || 'They'} says they did it! Check the proof, then:</Text>
              <View style={styles.dareChoice}>
                <DareButton icon="checkmark" title="Confirm" onPress={() => dareActions.confirmDare(message, true)} grow />
                <DareButton icon="close" title="Nope" onPress={() => dareActions.confirmDare(message, false)} grow quiet />
              </View>
            </>
          ) : null}
          {mine && state === 'nope' ? <Text style={styles.dareNote}>You said it didn&apos;t count. They can try again.</Text> : null}
          {mine && state === 'done' ? <Text style={styles.dareNote}>Nice! Now it&apos;s {friendName || 'their'}&apos;s turn to dare you 😈</Text> : null}
        </Pressable>
        <View style={styles.metaRow}>
          <Text style={styles.time}>{time}</Text>
          {statusLine(showStatus)}
        </View>
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
            isNew && styles.snapNew,
            pressed && tappable && styles.snapPressed,
          ]}>
          <Ionicons name={look.icon} size={16} color={isNew ? colors.white : tint} />
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
  dareCard: {
    // Never narrower than the button needs, even for a short dare like "say hi".
    minWidth: 250,
    maxWidth: '80%',
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: colors.pink,
    backgroundColor: colors.card,
    padding: space.md,
    gap: space.sm,
  },
  dareLabel: {
    color: colors.pink,
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  dareText: {
    ...font.body,
    fontWeight: '700',
  },
  dareButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingVertical: 11,
    paddingHorizontal: space.lg,
    marginTop: space.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.pink,
  },
  dareButtonText: {
    color: colors.onAccent,
    fontSize: 14,
    fontWeight: '800',
  },
  dareButtonGrow: {
    flex: 1,
    paddingHorizontal: space.md,
  },
  dareButtonQuiet: {
    backgroundColor: colors.bg,
  },
  dareButtonTextQuiet: {
    color: colors.text,
  },
  dareChoice: {
    flexDirection: 'row',
    gap: space.sm,
  },
  dareCardDone: {
    borderColor: colors.green,
  },
  dareLabelDone: {
    color: colors.green,
  },
  dareNote: {
    ...font.small,
    lineHeight: 18,
  },
  dareLink: {
    ...font.small,
    color: colors.pink,
    fontWeight: '800',
    textAlign: 'center',
  },
  headerStreak: {
    color: colors.orange,
    fontSize: 12,
    fontWeight: '800',
  },
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
  // A peek is a small, quiet pill: an icon and a few words. A new one you haven't opened is filled pink.
  snap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: space.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.card,
  },
  snapNew: {
    backgroundColor: colors.accent,
  },
  snapPressed: {
    opacity: 0.7,
  },
  snapText: {
    ...font.small,
    fontWeight: '700',
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
