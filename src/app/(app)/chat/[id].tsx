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
import { ChatBackground, ChatInkProvider, chatInk, useChatInk } from '@/components/chat/ChatBackground';
import { ChatBackgroundPicker } from '@/components/chat/ChatBackgroundPicker';
import { DareComposer } from '@/components/DareComposer';
import { MessageActions, ReactionChips, ReplyQuote, type MessageAction } from '@/components/MessageActions';
import { EmptyState } from '@/components/EmptyState';
import { IconButton } from '@/components/IconButton';
import { PeekASaveCard } from '@/components/PeekASaveCard';
import { useOverlays } from '@/components/Overlays';
import { MicButton, VoiceBubble, type Recording } from '@/components/VoiceNote';
import { RoundIconButton, ScreenHeader } from '@/components/ScreenHeader';
import { useMe } from '@/lib/auth';
import { friendChatKey, useChatBackground } from '@/lib/chatBackgrounds';
import {
  canReplay,
  canSave,
  claimChatDare,
  cleanUpOpenedSnaps,
  confirmChatDare,
  deleteMessage,
  fetchConversation,
  fetchDareStreak,
  hideMessage,
  markChatRead,
  type Message,
  searchConversation,
  sendDare,
  sendText,
  setSnapSaved,
  subscribeToMyMessages,
} from '@/lib/chat';
import { friendlyError } from '@/lib/errors';
import { useMediaUrl } from '@/lib/media';
import { fetchRelation } from '@/lib/friends';
import { fetchPeekASaves, type BrokenStreak, type PlusAllowances } from '@/lib/plusExtras';
import { fetchProfile } from '@/lib/profiles';
import { useScreenshotNotice } from '@/lib/screenshots';
import { fetchReactions, subscribeToReactions, toggleReaction, type Reaction } from '@/lib/reactions';
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
  const { showToast, showOptions } = useOverlays();
  const { report } = useSafetyActions();
  // Your moving background for this chat (Peekaboo+ ⭐). Only you see it.
  const background = useChatBackground(friendChatKey(friendId));
  const [backgroundOpen, setBackgroundOpen] = useState(false);
  const ink = chatInk(background.shown);

  const [friend, setFriend] = useState<Profile | null>(null);
  const [areFriends, setAreFriends] = useState(true);
  const [messages, setMessages] = useState<Message[] | null>(null);
  // Your dare streak with this friend 🔥 (dares you two completed in a row).
  const [streak, setStreak] = useState(0);
  // 🙈 Your dare streak with this friend just broke (less than 24 hours ago): Peek-a-Save can bring it back.
  const [brokenStreak, setBrokenStreak] = useState<{ streak: BrokenStreak; allowances: PlusAllowances } | null>(null);
  const [savesChecked, setSavesChecked] = useState(0);
  // Reactions on the messages, the message you're holding (its menu), and the message you're replying to.
  const [reactions, setReactions] = useState<Map<string, Reaction[]>>(new Map());
  const [menuFor, setMenuFor] = useState<{ message: Message; actions: MessageAction[] } | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  // 🔎 Search: the box is open while `search` isn't null.
  const [search, setSearch] = useState<string | null>(null);
  const [results, setResults] = useState<{ query: string; list: Message[] } | null>(null);
  const searchRequest = useRef(0);
  const listRef = useRef<FlatList<Message>>(null);
  const [text, setText] = useState('');
  const draft = useRef('');
  const sendingNow = useRef(false);
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
      fetchReactions(
        list.map((m) => m.id),
        false,
      )
        .then(setReactions)
        .catch(() => {});
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
      const stopMessages = subscribeToMyMessages(`chat-${userId}-${friendId}`, loadMessages);
      const stopReactions = subscribeToReactions(false, loadMessages);
      return () => {
        stopMessages();
        stopReactions();
      };
    }, [friendId, userId, loadMessages]),
  );

  async function send() {
    const originalText = text;
    const body = text.trim();
    // Private chats between friends aren't filtered: people can say whatever they want here (the owner's
    // choice). Report and Block still work on every message.
    if (!body || sendingNow.current) return;
    sendingNow.current = true;
    const replyId = replyTo?.id;
    setSending(true);
    try {
      const sent = await sendText(userId, friendId, body, replyId);
      setReplyTo((current) => current?.id === replyId ? null : current);
      if (draft.current === originalText) {
        draft.current = '';
        setText('');
        onTextChange('');
      }
      setMessages((current) => [sent, ...(current ?? []).filter((m) => m.id !== sent.id)]);
    } catch (error) {
      Alert.alert('Message not sent', friendlyError(error));
    } finally {
      sendingNow.current = false;
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
    if (sendingNow.current) return;
    sendingNow.current = true;
    setSending(true);
    try {
      const sent = await sendVoice(userId, friendId, recording.uri, recording.durationMs, recording.waveform);
      setMessages((current) => [sent, ...(current ?? []).filter((m) => m.id !== sent.id)]);
    } catch (error) {
      Alert.alert('Voice note not sent', friendlyError(error));
    } finally {
      sendingNow.current = false;
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
    const deleteForMe = {
      label: 'Delete for me',
      onPress: async () => {
        try {
          await hideMessage(message.id);
          setMessages((current) => current?.filter((m) => m.id !== message.id) ?? null);
          showToast(`Deleted for you – ${name || 'they'} still ${message.sender_id === userId ? 'has' : 'have'} it`);
        } catch (error) {
          Alert.alert('Could not delete', friendlyError(error));
        }
      },
    };
    const reply = { label: '↩ Reply', onPress: () => setReplyTo(message) };
    if (message.sender_id === userId) {
      setMenuFor({
        message,
        actions: [
          reply,
          ...saveOptions,
          deleteForMe,
          {
            label: 'Delete for everyone',
            destructive: true,
            onPress: async () => {
              try {
                await deleteMessage(message);
                setMessages((current) => current?.filter((m) => m.id !== message.id) ?? null);
                showToast('Deleted for everyone');
              } catch (error) {
                Alert.alert('Could not delete', friendlyError(error));
              }
            },
          },
        ],
      });
    } else if (friend) {
      setMenuFor({
        message,
        actions: [
          reply,
          ...saveOptions,
          deleteForMe,
          {
            label: 'Report message',
            onPress: () => report({ user: friend, contentType: 'message', contentId: message.id }),
          },
        ],
      });
    }
  }

  async function react(message: Message, emoji: string) {
    const mine = reactions.get(message.id)?.find((r) => r.user_id === userId)?.emoji ?? null;
    try {
      await toggleReaction(userId, message.id, emoji, mine, false);
      Haptics.selectionAsync();
      loadMessages();
    } catch (error) {
      Alert.alert('Could not react', friendlyError(error));
    }
  }

  // A short description of any message, for reply quotes.
  const previewOf = (m: Message) =>
    m.kind === 'text' || m.kind === 'dare'
      ? (m.body ?? '')
      : m.kind === 'snap'
        ? '👀 Peek'
        : m.kind === 'voice'
          ? '🎤 Voice note'
          : m.kind === 'reaction'
            ? `${m.body} story reaction`
            : 'Message';

  async function runSearch(query: string) {
    const request = ++searchRequest.current;
    setSearch(query);
    if (!query.trim()) {
      setResults(null);
      return;
    }
    try {
      const list = await searchConversation(userId, friendId, query);
      if (request === searchRequest.current) setResults({ query, list });
    } catch (error) {
      if (request === searchRequest.current) Alert.alert('Search failed', friendlyError(error));
    }
  }

  // Checked when the chat opens and after a Peek-a-Save. (If the server doesn't have Peek-a-Save yet, nothing shows.)
  useEffect(() => {
    let cancelled = false;
    fetchPeekASaves().then((found) => {
      if (cancelled) return;
      const mine = found?.streaks.find((s) => s.kind === 'chat_dare' && s.friend_id === friendId);
      setBrokenStreak(found && mine ? { streak: mine, allowances: found.allowances } : null);
    });
    return () => {
      cancelled = true;
    };
  }, [friendId, savesChecked]);

  // Tap a search result: jump to it in the chat (if it's one of the loaded messages).
  function jumpTo(message: Message) {
    const index = messages?.findIndex((m) => m.id === message.id) ?? -1;
    setSearch(null);
    setResults(null);
    if (index < 0) {
      showToast(`From ${timeAgo(message.created_at)} ago – too far back to jump to`);
      return;
    }
    setTimeout(() => listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 }), 250);
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
        right={
          <RoundIconButton
            icon="ellipsis-horizontal"
            label="Chat options"
            onPress={() =>
              showOptions({
                title: name || undefined,
                options: [
                  { label: '🔎 Search this chat', onPress: () => setSearch(search === null ? '' : null) },
                  { label: '🎨 Chat background', onPress: () => setBackgroundOpen(true) },
                ],
              })
            }
          />
        }
      />

      <ChatInkProvider ink={ink}>
        <View style={styles.body}>
          <ChatBackground id={background.shown} />
          {search !== null ? (
            <View style={styles.searchBar}>
              <Ionicons name="search" size={18} color={colors.textMuted} />
              <TextInput
                value={search}
                onChangeText={runSearch}
                placeholder="Search this chat"
                placeholderTextColor={colors.textMuted}
                autoFocus
                autoCapitalize="none"
                keyboardAppearance={keyboardAppearance}
                selectionColor={colors.accent}
                style={styles.searchInput}
              />
              <Pressable
                onPress={() => {
                  setSearch(null);
                  setResults(null);
                }}
                hitSlop={10}
                accessibilityLabel="Close search">
                <Text style={styles.searchCancel}>Cancel</Text>
              </Pressable>
            </View>
          ) : null}

          {brokenStreak && search === null ? (
            <View style={styles.peekASave}>
              <PeekASaveCard
                streak={brokenStreak.streak}
                friend={friend}
                allowances={brokenStreak.allowances}
                onSaved={(restored) => {
                  setStreak(restored);
                  setSavesChecked((n) => n + 1);
                }}
              />
            </View>
          ) : null}

          {/* The negative offset stops a gap appearing between the message box and the keyboard. */}
          <KeyboardAvoidingView style={[styles.fill, background.shown ? styles.clear : null]} behavior="padding" keyboardVerticalOffset={-insets.bottom}>
            {search !== null && search.trim() ? (
              <FlatList
                data={results?.query === search ? results.list : []}
                keyExtractor={(m) => m.id}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={styles.searchList}
                ListEmptyComponent={
                  results?.query === search ? <Text style={styles.searchEmpty}>Nothing found for “{search.trim()}”</Text> : undefined
                }
                renderItem={({ item }) => (
                  <Pressable style={styles.result} onPress={() => jumpTo(item)} accessibilityRole="button">
                    <Text style={styles.resultName}>
                      {item.sender_id === userId ? 'You' : name} · {timeAgo(item.created_at)}
                    </Text>
                    <Text style={styles.resultText} numberOfLines={2}>
                      {item.kind === 'dare' ? `🎯 ${item.body}` : item.body}
                    </Text>
                  </Pressable>
                )}
              />
            ) : messages === null ? (
              <ActivityIndicator color={colors.accent} style={styles.loading} />
            ) : messages.length === 0 ? (
              <View style={styles.empty}>
                {/* On a chat background the words sit on a soft card, so they're easy to read. */}
                <View style={background.shown ? styles.emptyCard : null}>
                  <EmptyState emoji="👋" title={`Say hi to ${name || 'your friend'}!`} message="Send a message or a peek." />
                </View>
              </View>
            ) : (
              <FlatList
                ref={listRef}
                data={messages}
                inverted
                onScrollToIndexFailed={() => showToast('Scroll up a bit and try again')}
                keyExtractor={(m) => m.id}
                contentContainerStyle={styles.list}
                keyboardDismissMode="interactive"
                // The list is upside down, so this "header" sits at the very bottom, under the newest message.
                ListHeaderComponent={friendTyping ? <TypingBubble /> : undefined}
                renderItem={({ item }) => {
                  const mine = item.sender_id === userId;
                  const replied = item.reply_to ? messages.find((m) => m.id === item.reply_to) : null;
                  return (
                    <View style={styles.messageBlock}>
                      {replied ? (
                        <View style={mine ? styles.right : styles.left}>
                          <ReplyQuote
                            name={replied.sender_id === userId ? 'You' : name}
                            text={previewOf(replied)}
                            mine={mine}
                          />
                        </View>
                      ) : null}
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
                      <View style={mine ? styles.right : styles.left}>
                        <ReactionChips reactions={reactions.get(item.id)} me={userId} onToggle={(emoji) => react(item, emoji)} />
                      </View>
                    </View>
                  );
                }}
              />
            )}

            {areFriends && replyTo ? (
              <View style={styles.replyBar}>
                <View style={styles.replyBarText}>
                  <Text style={styles.replyBarName} numberOfLines={1}>
                    ↩ Replying to {replyTo.sender_id === userId ? 'yourself' : name}
                  </Text>
                  <Text style={styles.replyBarBody} numberOfLines={1}>
                    {previewOf(replyTo)}
                  </Text>
                </View>
                <Pressable onPress={() => setReplyTo(null)} hitSlop={10} accessibilityLabel="Cancel reply">
                  <Ionicons name="close" size={20} color={colors.textMuted} />
                </Pressable>
              </View>
            ) : null}
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
                    draft.current = value;
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
                    disabled={sending}
                  />
                ) : (
                  <MicButton onRecorded={sendVoiceNote} onHint={showToast} />
                )}
              </View>
            ) : (
              <Text style={[styles.notFriends, ink, { paddingBottom: insets.bottom + space.lg }]}>You need to be friends to chat.</Text>
            )}
          </KeyboardAvoidingView>
        </View>
      </ChatInkProvider>
      <ChatBackgroundPicker
        visible={backgroundOpen}
        current={background.picked}
        plus={background.plus}
        onPick={background.choose}
        onClose={() => setBackgroundOpen(false)}
      />
      <DareComposer visible={dareOpen} friendName={name} onClose={() => setDareOpen(false)} onSend={sendMyDare} />
      <MessageActions
        visible={menuFor !== null}
        myReaction={menuFor ? (reactions.get(menuFor.message.id)?.find((r) => r.user_id === userId)?.emoji ?? null) : null}
        onReact={(emoji) => menuFor && react(menuFor.message, emoji)}
        actions={menuFor?.actions ?? []}
        onClose={() => setMenuFor(null)}
      />
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
      <Text
        style={[styles.dareButtonText, quiet && styles.dareButtonTextQuiet]}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.75}>
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
  const ink = useChatInk();
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
        <Text style={[styles.time, ink]}>{time}</Text>
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
        <Text style={[styles.time, ink]}>{time}</Text>
      </View>
    );
  }

  // A dare a friend wrote, and how it ends:
  // they do it (proof peek, or "I did it") → you confirm ✅ (or ❌ "doesn't count") → "Dare completed" + dare them back.
  if (message.kind === 'dare') {
    const state = message.dare_state ?? null;
    const who = friendName || 'they';
    return (
      <View style={[styles.bubbleWrap, styles.dareWrap, mine ? styles.right : styles.left]}>
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
          <Text style={[styles.time, ink]}>{time}</Text>
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
          <Text style={[styles.time, ink]}>{time}</Text>
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
          <Text style={[styles.time, ink]}>{time}</Text>
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
        <Text style={[styles.time, ink]}>{time}</Text>
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
  const ink = useChatInk();
  const color = opened ? colors.accent : (ink?.color ?? colors.textFaint);
  return (
    <View style={styles.status} accessibilityLabel={label}>
      <Text style={[styles.time, ink]}>·</Text>
      <Ionicons
        name={message.replayed_at ? 'refresh' : opened ? 'eye' : 'checkmark'}
        size={12}
        color={color}
      />
      <Text style={[styles.time, ink, styles.statusText, { color }]}>{label}</Text>
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
  messageBlock: {
    gap: 2,
  },
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
  },
  replyBarText: {
    flex: 1,
  },
  replyBarName: {
    ...font.small,
    fontWeight: '800',
    color: colors.accent,
  },
  replyBarBody: {
    ...font.small,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: colors.card,
  },
  searchInput: {
    flex: 1,
    paddingVertical: space.sm,
    color: colors.text,
    fontSize: 16,
  },
  searchCancel: {
    ...font.small,
    color: colors.accent,
    fontWeight: '800',
  },
  searchList: {
    padding: space.md,
    gap: space.sm,
  },
  searchEmpty: {
    ...font.small,
    textAlign: 'center',
    marginTop: space.lg,
  },
  result: {
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    gap: 2,
  },
  resultName: {
    ...font.small,
    fontWeight: '800',
  },
  resultText: {
    ...font.body,
  },
  // A dare card is always the same width (never shrunk to a short dare like "say hi"), so its buttons fit
  // even with a big text size.
  dareWrap: {
    width: '80%',
  },
  dareCard: {
    alignSelf: 'stretch',
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
    alignSelf: 'stretch',
    paddingVertical: 11,
    paddingHorizontal: space.md,
    marginTop: space.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.pink,
  },
  dareButtonText: {
    flexShrink: 1,
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
  peekASave: {
    paddingHorizontal: space.md,
    paddingTop: space.sm,
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
  // Everything under the top bar. A chat background fills this space, behind the messages.
  body: {
    flex: 1,
  },
  // See-through, so the chat background shows.
  clear: {
    backgroundColor: 'transparent',
  },
  emptyCard: {
    marginHorizontal: space.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.bg + 'E6',
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
    backgroundColor: colors.bg,
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
