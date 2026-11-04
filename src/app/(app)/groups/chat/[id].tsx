import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { Image } from 'expo-image';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { DareComposer } from '@/components/DareComposer';
import { MessageActions, ReactionChips, ReplyQuote, type MessageAction } from '@/components/MessageActions';
import { EmptyState } from '@/components/EmptyState';
import { GroupFaces } from '@/components/GroupFaces';
import { IconButton } from '@/components/IconButton';
import { useOverlays } from '@/components/Overlays';
import { RoundIconButton, ScreenHeader } from '@/components/ScreenHeader';
import { SafeEdge } from '@/components/SafeEdge';
import { ZoomableImage } from '@/components/ZoomableImage';
import { VideoClip } from '@/components/VideoClipSafe';
import { MicButton, VoiceBubble, type Recording } from '@/components/VoiceNote';
import { useMe } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import {
  deleteGroupMessage,
  fetchGroupChats,
  fetchGroupMessages,
  fetchGroupReads,
  markGroupChatRead,
  pinGroupMessage,
  searchGroupMessages,
  sendGroupDare,
  sendGroupMessage,
  sendGroupVoice,
  setGroupChatMuted,
  setGroupPhoto,
  subscribeToGroup,
  subscribeToGroupChat,
  type GroupMessage,
} from '@/lib/groupChat';
import { fetchGroup, type PeekGroup } from '@/lib/groups';
import { useMediaUrls } from '@/lib/media';
import { fetchReactions, subscribeToReactions, toggleReaction, type Reaction } from '@/lib/reactions';
import { timeAgo } from '@/lib/time';
import type { Profile } from '@/lib/types';
import { useGroupTyping } from '@/lib/typing';
import { useSafetyActions } from '@/lib/useSafetyActions';
import { Audio } from '@/lib/voice';
import { colors, font, keyboardAppearance, radius, space } from '@/theme';

// How often to check who has read the chat (for "Seen by …") while it's open.
const READS_EVERY_MS = 15_000;

// A group's chat 💬: texts, photos and videos (📷), voice notes (hold 🎤), and group dares (🚩) where everyone
// posts their proof. "Typing…" and "Seen by" like a one-on-one chat. 🔎 searches the chat.
// Tap the top to see the group (drops, members). Hold a message: yours → delete for everyone; theirs → report.
export default function GroupChat() {
  const { id: groupId } = useLocalSearchParams<{ id: string }>();
  const { userId } = useMe();
  const { showOptions, showToast } = useOverlays();
  const { report } = useSafetyActions();
  const insets = useSafeAreaInsets();
  const [group, setGroup] = useState<PeekGroup | null | undefined>(undefined);
  const [messages, setMessages] = useState<GroupMessage[] | null>(null);
  const [reads, setReads] = useState<Map<string, string>>(new Map());
  const [muted, setMuted] = useState(false);
  const [text, setText] = useState('');
  const draft = useRef('');
  const sendingNow = useRef(false);
  const [sending, setSending] = useState(false);
  const [dareOpen, setDareOpen] = useState(false);
  // Search: the box is open while `search` isn't null.
  const [search, setSearch] = useState<string | null>(null);
  const [results, setResults] = useState<{ query: string; list: GroupMessage[] } | null>(null);
  const searchRequest = useRef(0);
  const listRef = useRef<FlatList<GroupMessage>>(null);
  // Reactions, the message you're holding (its menu), and the message you're replying to.
  const [reactions, setReactions] = useState<Map<string, Reaction[]>>(new Map());
  const [menuFor, setMenuFor] = useState<{ message: GroupMessage; actions: MessageAction[] } | null>(null);
  const [replyTo, setReplyTo] = useState<GroupMessage | null>(null);
  const [viewing, setViewing] = useState<GroupMessage | null>(null);
  const { typing, onTextChange, clearTyping } = useGroupTyping(userId, groupId, group !== null);

  const load = useCallback(() => {
    fetchGroupMessages(groupId)
      .then((list) => {
        setMessages(list);
        fetchReactions(
          list.map((m) => m.id),
          true,
        )
          .then(setReactions)
          .catch(() => {});
        // Their message arrived: they've stopped typing.
        if (list[0]) clearTyping(list[0].sender_id);
        markGroupChatRead(groupId).catch(() => {});
      })
      .catch((error) => {
        console.warn('Could not load the group chat', error);
        setMessages((current) => current ?? []);
      });
    fetchGroupReads(groupId)
      .then(setReads)
      .catch(() => {});
  }, [groupId, clearTyping]);

  useFocusEffect(
    useCallback(() => {
      fetchGroup(groupId)
        .then(setGroup)
        .catch(() => setGroup(null));
      fetchGroupChats()
        .then((chats) => setMuted(chats.get(groupId)?.muted ?? false))
        .catch(() => {});
      load();
      const stop = subscribeToGroupChat(groupId, load);
      const stopReactions = subscribeToReactions(true, load);
      const stopGroup = subscribeToGroup(groupId, () => {
        fetchGroup(groupId)
          .then(setGroup)
          .catch(() => {});
      });
      const readsTimer = setInterval(() => {
        fetchGroupReads(groupId)
          .then(setReads)
          .catch(() => {});
      }, READS_EVERY_MS);
      return () => {
        stop();
        stopReactions();
        stopGroup();
        clearInterval(readsTimer);
      };
    }, [groupId, load]),
  );

  const people = new Map<string, Profile>();
  for (const member of group?.members ?? []) if (member.profile) people.set(member.userId, member.profile);
  const nameOf = (id: string) => {
    const person = people.get(id);
    return person ? person.display_name || person.username : 'Someone';
  };

  // Photos, videos and proofs need their links.
  const paths = (messages ?? []).flatMap((m) => [m.media_path, m.poster_path, m.overlay_path]).filter(
    (p): p is string => !!p && !p.includes('/voice/'),
  );
  const urls = useMediaUrls(paths);

  // Group dares: who has posted proof for each one.
  const proofsByDare = new Map<string, Set<string>>();
  for (const m of messages ?? []) {
    if (m.kind === 'proof' && m.dare_id) {
      const set = proofsByDare.get(m.dare_id) ?? new Set<string>();
      set.add(m.sender_id);
      proofsByDare.set(m.dare_id, set);
    }
  }

  async function send() {
    const originalText = text;
    const body = text.trim();
    if (!body || sendingNow.current) return;
    sendingNow.current = true;
    const replyId = replyTo?.id;
    setSending(true);
    try {
      const sent = await sendGroupMessage(groupId, body, replyId);
      setReplyTo((current) => current?.id === replyId ? null : current);
      // Leave the next draft alone if you started typing while this message was sending.
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

  async function sendVoiceNote(recording: Recording) {
    if (sendingNow.current) return;
    sendingNow.current = true;
    setSending(true);
    try {
      const sent = await sendGroupVoice(userId, groupId, recording.uri, recording.durationMs, recording.waveform);
      setMessages((current) => [sent, ...(current ?? []).filter((m) => m.id !== sent.id)]);
    } catch (error) {
      Alert.alert('Voice note not sent', friendlyError(error));
    } finally {
      sendingNow.current = false;
      setSending(false);
    }
  }

  async function sendDare(dare: string): Promise<boolean> {
    try {
      const sent = await sendGroupDare(groupId, dare);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setMessages((current) => [sent, ...(current ?? []).filter((m) => m.id !== sent.id)]);
      showToast('Dared the whole group 🎯');
      return true;
    } catch (error) {
      Alert.alert('Dare not sent', friendlyError(error));
      return false;
    }
  }

  const openCamera = (dareId?: string) =>
    router.push({ pathname: '/camera', params: { group: groupId, ...(dareId ? { groupDare: dareId } : {}) } });

  const pinnedId = group?.pinned_message_id ?? null;

  async function pin(message: GroupMessage | null) {
    try {
      await pinGroupMessage(groupId, message?.id ?? null);
      setGroup((current) => (current ? { ...current, pinned_message_id: message?.id ?? null } : current));
      showToast(message ? 'Pinned to the top 📌' : 'Unpinned');
    } catch (error) {
      Alert.alert('Could not pin', friendlyError(error));
    }
  }

  function openMessageMenu(message: GroupMessage) {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const sender = people.get(message.sender_id);
    const actions: MessageAction[] = [
      { label: '↩ Reply', onPress: () => setReplyTo(message) },
      pinnedId === message.id
        ? { label: '📌 Unpin', onPress: () => pin(null) }
        : { label: '📌 Pin to the top', onPress: () => pin(message) },
    ];
    if (message.sender_id === userId) {
      actions.push({
        label: 'Delete for everyone',
        destructive: true,
        onPress: async () => {
          try {
            await deleteGroupMessage(message);
            setMessages((current) => current?.filter((m) => m.id !== message.id) ?? null);
            showToast('Deleted for everyone');
          } catch (error) {
            Alert.alert('Could not delete', friendlyError(error));
          }
        },
      });
    } else if (sender) {
      actions.push(
        { label: '👤 See profile', onPress: () => router.push(`/profile/${sender.id}`) },
        { label: 'Report', onPress: () => report({ user: sender, contentType: 'group_message', contentId: message.id }) },
      );
    }
    setMenuFor({ message, actions });
  }

  async function react(message: GroupMessage, emoji: string) {
    const mine = reactions.get(message.id)?.find((r) => r.user_id === userId)?.emoji ?? null;
    try {
      await toggleReaction(userId, message.id, emoji, mine, true);
      Haptics.selectionAsync();
      load();
    } catch (error) {
      Alert.alert('Could not react', friendlyError(error));
    }
  }

  // The group's picture: choose one (square), or remove it.
  async function changePhoto(remove = false) {
    try {
      if (remove) {
        await setGroupPhoto(userId, groupId, null);
      } else {
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          allowsEditing: true,
          aspect: [1, 1],
          quality: 0.9,
        });
        if (result.canceled || !result.assets[0]) return;
        await setGroupPhoto(userId, groupId, result.assets[0].uri);
      }
      setGroup(await fetchGroup(groupId));
      showToast(remove ? 'Group photo removed' : 'New group photo 📷');
    } catch (error) {
      Alert.alert('Could not change the photo', friendlyError(error));
    }
  }

  // A short description of any group message, for reply quotes and the pinned banner.
  const previewOf = (m: GroupMessage) =>
    m.kind === 'text'
      ? (m.body ?? '')
      : m.kind === 'photo'
        ? '📷 Photo'
        : m.kind === 'video'
          ? '🎬 Video'
          : m.kind === 'voice'
            ? '🎤 Voice note'
            : m.kind === 'dare'
              ? `🎯 ${m.body ?? ''}`
              : '✅ Did the dare';

  function openGroupMenu() {
    showOptions({
      title: group?.name,
      options: [
        { label: '🔎 Search this chat', onPress: () => setSearch('') },
        { label: '📷 Change group photo', onPress: () => changePhoto() },
        ...(group?.photo_path ? [{ label: 'Remove group photo', onPress: () => changePhoto(true) }] : []),
        { label: '✏️ Change name & people', onPress: () => router.push({ pathname: '/groups/new', params: { group: groupId } }) },
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

  async function runSearch(query: string) {
    const request = ++searchRequest.current;
    setSearch(query);
    if (!query.trim()) {
      setResults(null);
      return;
    }
    try {
      const list = await searchGroupMessages(groupId, query);
      if (request === searchRequest.current) setResults({ query, list });
    } catch (error) {
      if (request === searchRequest.current) Alert.alert('Search failed', friendlyError(error));
    }
  }

  // Tap a search result: jump to it in the chat (if it's one of the loaded messages).
  function jumpTo(message: GroupMessage) {
    const index = messages?.findIndex((m) => m.id === message.id) ?? -1;
    setSearch(null);
    setResults(null);
    if (index < 0) {
      showToast(`From ${timeAgo(message.created_at)} ago – too far back to jump to`);
      return;
    }
    setTimeout(() => listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 }), 250);
  }

  if (group === null) {
    return (
      <View style={styles.fill}>
        <ScreenHeader title="Group chat" />
        <EmptyState emoji="💨" title="This group is gone" message="It was deleted, or you're not in it any more." />
      </View>
    );
  }

  // "Seen by": under your newest message, who has read the chat since.
  const myLatest = messages?.find((m) => m.sender_id === userId);
  const seenBy = myLatest
    ? [...reads.entries()].filter(([id, at]) => id !== userId && at >= myLatest.created_at).map(([id]) => nameOf(id))
    : [];
  const memberCount = group?.members.length ?? 0;
  const pinnedMessage = pinnedId ? (messages?.find((m) => m.id === pinnedId) ?? null) : null;
  const openedMedia = viewing && messages?.some((m) => m.id === viewing.id) ? viewing : null;

  return (
    <View style={styles.fill}>
      <ScreenHeader
        titleContent={
          group ? (
            <Pressable style={styles.headerTitle} onPress={() => router.push(`/groups/${groupId}`)}>
              {group.photo_path ? (
                <Avatar path={group.photo_path} name={group.name} size={32} />
              ) : (
                <GroupFaces members={group.members} size={22} />
              )}
              <View style={styles.headerText}>
                <Text style={styles.headerName} numberOfLines={1}>
                  {group.name}
                </Text>
                <Text style={[styles.headerSub, typing.length > 0 && styles.headerTyping]} numberOfLines={1}>
                  {typing.length > 0
                    ? `${typing.map(nameOf).join(', ')} ${typing.length === 1 ? 'is' : 'are'} typing…`
                    : `${muted ? '🔕 Muted · ' : ''}${memberCount} people`}
                </Text>
              </View>
            </Pressable>
          ) : null
        }
        right={<RoundIconButton icon="ellipsis-horizontal" label="Group chat options" onPress={openGroupMenu} />}
      />

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

      {pinnedMessage && search === null ? (
        <Pressable style={styles.pinned} onPress={() => jumpTo(pinnedMessage)} accessibilityRole="button" accessibilityLabel="Go to the pinned message">
          <Text style={styles.pinnedIcon}>📌</Text>
          <Text style={styles.pinnedText} numberOfLines={1}>
            <Text style={styles.pinnedName}>{pinnedMessage.sender_id === userId ? 'You' : nameOf(pinnedMessage.sender_id)}: </Text>
            {previewOf(pinnedMessage)}
          </Text>
          <Pressable onPress={() => pin(null)} hitSlop={10} accessibilityLabel="Unpin">
            <Ionicons name="close" size={18} color={colors.textMuted} />
          </Pressable>
        </Pressable>
      ) : null}

      <KeyboardAvoidingView style={styles.fill} behavior="padding" keyboardVerticalOffset={-insets.bottom}>
        {search !== null && search.trim() ? (
          <FlatList
            data={results?.query === search ? results.list : []}
            keyExtractor={(m) => m.id}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.list}
            ListEmptyComponent={
              results?.query === search ? <Text style={styles.searchEmpty}>Nothing found for “{search.trim()}”</Text> : undefined
            }
            renderItem={({ item }) => (
              <Pressable style={styles.result} onPress={() => jumpTo(item)} accessibilityRole="button">
                <Text style={styles.resultName}>
                  {item.sender_id === userId ? 'You' : nameOf(item.sender_id)} · {timeAgo(item.created_at)}
                </Text>
                <Text style={styles.resultText} numberOfLines={2}>
                  {item.body}
                </Text>
              </Pressable>
            )}
          />
        ) : messages === null ? (
          <ActivityIndicator color={colors.accent} style={styles.loading} />
        ) : messages.length === 0 ? (
          <View style={styles.fill}>
            <EmptyState emoji="💬" title="Say hi to the group!" message="Text, send a photo 📷, a voice note 🎤, or dare everyone 🚩." />
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            inverted
            keyExtractor={(m) => m.id}
            contentContainerStyle={styles.list}
            keyboardDismissMode="interactive"
            onScrollToIndexFailed={() => showToast('Scroll up a bit and try again')}
            renderItem={({ item, index }) => {
              const mine = item.sender_id === userId;
              const sender = people.get(item.sender_id);
              const name = nameOf(item.sender_id);
              // The list is upside down: the message "after" this one on screen is the one before it in time.
              const older = messages[index + 1];
              const firstOfRun = !older || older.sender_id !== item.sender_id;
              const proofs = item.kind === 'dare' ? proofsByDare.get(item.id) ?? new Set<string>() : null;
              const replied = item.reply_to ? messages.find((m) => m.id === item.reply_to) : null;
              return (
                <View style={[styles.row, mine ? styles.right : styles.left]}>
                  {!mine ? (
                    <View style={styles.avatarSlot}>
                      {firstOfRun ? <Avatar path={sender?.avatar_path} name={name} size={28} /> : null}
                    </View>
                  ) : null}
                  <View style={[styles.bubbleWrap, item.kind === 'dare' && styles.dareWrap, mine ? styles.alignRight : styles.alignLeft]}>
                    {!mine && firstOfRun ? <Text style={styles.sender}>{name}</Text> : null}
                    {replied ? (
                      <ReplyQuote name={replied.sender_id === userId ? 'You' : nameOf(replied.sender_id)} text={previewOf(replied)} mine={mine} />
                    ) : null}
                    <Pressable
                      onLongPress={() => openMessageMenu(item)}
                      onPress={item.media_path && item.kind !== 'voice' ? () => setViewing(item) : undefined}
                      accessibilityRole={item.media_path && item.kind !== 'voice' ? 'button' : undefined}
                      accessibilityLabel={item.media_path && item.kind !== 'voice' ? `Open ${item.media_type === 'video' ? 'video' : 'photo'}` : undefined}
                      style={styles.stretch}>
                      {item.kind === 'text' ? (
                        <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
                          <Text style={[styles.bubbleText, mine && styles.bubbleTextMine]}>{item.body}</Text>
                        </View>
                      ) : item.kind === 'voice' ? (
                        <VoiceBubble path={item.media_path} durationMs={item.audio_ms ?? 0} waveform={item.waveform} mine={mine} />
                      ) : item.kind === 'dare' && proofs ? (
                        <View style={[styles.dareCard, proofs.size >= memberCount && memberCount > 0 && styles.dareCardDone]}>
                          <Text style={styles.dareLabel}>
                            🎯 {mine ? 'YOU DARED THE GROUP' : `${name.toUpperCase()} DARED THE GROUP`}
                          </Text>
                          <Text style={styles.dareText}>{item.body}</Text>
                          <Text style={styles.dareNote}>
                            {proofs.size >= memberCount && memberCount > 0
                              ? '🔥 Everyone did it!'
                              : proofs.size === 0
                                ? 'Nobody has done it yet'
                                : `${proofs.size} of ${memberCount} did it: ${[...proofs].map((id) => (id === userId ? 'you' : nameOf(id))).join(', ')}`}
                          </Text>
                          {proofs.has(userId) ? (
                            <Text style={styles.dareDone}>✅ You did it</Text>
                          ) : (
                            <Pressable
                              onPress={() => openCamera(item.id)}
                              style={({ pressed }) => [styles.dareButton, pressed && styles.pressed]}
                              accessibilityRole="button"
                              accessibilityLabel="Do it and post proof">
                              <Ionicons name="camera" size={16} color={colors.onAccent} />
                              <Text style={styles.dareButtonText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
                                Do it · post proof
                              </Text>
                            </Pressable>
                          )}
                        </View>
                      ) : item.media_path ? (
                        <View>
                          {item.kind === 'proof' ? <Text style={styles.proofTag}>✅ Did the dare</Text> : null}
                          {item.media_type === 'video' ? (
                            <VideoClip
                              uri={urls[item.media_path] ?? ''}
                              posterUri={item.poster_path ? urls[item.poster_path] : null}
                              overlayUri={item.overlay_path ? urls[item.overlay_path] : null}
                              playing={false}
                              muted
                              style={styles.media}
                            />
                          ) : (
                            <Image source={{ uri: urls[item.media_path] }} style={styles.media} contentFit="cover" transition={150} />
                          )}
                        </View>
                      ) : null}
                    </Pressable>
                    <ReactionChips reactions={reactions.get(item.id)} me={userId} onToggle={(emoji) => react(item, emoji)} />
                    <Text style={styles.time}>
                      {pinnedId === item.id ? '📌 ' : ''}
                      {timeAgo(item.created_at)}
                      {mine && item.id === myLatest?.id && seenBy.length > 0
                        ? ` · 👁 Seen by ${seenBy.length === memberCount - 1 ? 'everyone' : seenBy.join(', ')}`
                        : ''}
                    </Text>
                  </View>
                </View>
              );
            }}
          />
        )}

        {replyTo ? (
          <View style={styles.replyBar}>
            <View style={styles.replyBarText}>
              <Text style={styles.replyBarName} numberOfLines={1}>
                ↩ Replying to {replyTo.sender_id === userId ? 'yourself' : nameOf(replyTo.sender_id)}
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
        <View style={[styles.inputBar, { paddingBottom: insets.bottom + space.sm }]}>
          <IconButton icon="camera" label="Send a photo or video" background={colors.accent} color={colors.onAccent} onPress={() => openCamera()} />
          <IconButton icon="flag" label="Dare the group" background={colors.card} color={colors.pink} onPress={() => setDareOpen(true)} />
          <TextInput
            value={text}
            onChangeText={(value) => {
              draft.current = value;
              setText(value);
              onTextChange(value);
            }}
            placeholder="Message the group"
            placeholderTextColor={colors.textFaint}
            keyboardAppearance={keyboardAppearance}
            selectionColor={colors.accent}
            multiline
            maxLength={2000}
            style={styles.input}
          />
          {text.trim() || !Audio ? (
            <IconButton icon="arrow-up" label="Send" background={text.trim() ? colors.blue : colors.card} onPress={send} disabled={sending} />
          ) : (
            <MicButton onRecorded={sendVoiceNote} onHint={showToast} />
          )}
        </View>
      </KeyboardAvoidingView>
      <DareComposer visible={dareOpen} friendName="the group" onClose={() => setDareOpen(false)} onSend={sendDare} />
      <MessageActions
        visible={menuFor !== null}
        myReaction={menuFor ? (reactions.get(menuFor.message.id)?.find((r) => r.user_id === userId)?.emoji ?? null) : null}
        onReact={(emoji) => menuFor && react(menuFor.message, emoji)}
        actions={menuFor?.actions ?? []}
        onClose={() => setMenuFor(null)}
      />
      <Modal visible={openedMedia !== null} animationType="fade" onRequestClose={() => setViewing(null)}>
        <View style={styles.mediaViewer}>
          {openedMedia?.media_path && urls[openedMedia.media_path] ? (
            openedMedia.media_type === 'video' ? (
              <VideoClip
                uri={urls[openedMedia.media_path]}
                posterUri={openedMedia.poster_path ? urls[openedMedia.poster_path] : null}
                overlayUri={openedMedia.overlay_path ? urls[openedMedia.overlay_path] : null}
                playing
                muted={false}
                contentFit="contain"
                style={styles.fill}
              />
            ) : (
              <ZoomableImage uri={urls[openedMedia.media_path]} contentFit="contain" style={styles.fill} />
            )
          ) : <ActivityIndicator color={colors.white} />}
          <SafeEdge edge="top" style={styles.mediaClose}>
            <Button title="Close media" variant="secondary" small onPress={() => setViewing(null)} />
          </SafeEdge>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  mediaViewer: { flex: 1, backgroundColor: colors.black },
  mediaClose: { position: 'absolute', top: 0, right: 0, padding: space.lg },
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
  headerTyping: {
    color: colors.accent,
    fontWeight: '700',
  },
  pinned: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    backgroundColor: colors.card,
  },
  pinnedIcon: {
    fontSize: 16,
  },
  pinnedText: {
    ...font.small,
    flex: 1,
    color: colors.text,
  },
  pinnedName: {
    fontWeight: '800',
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
  dareWrap: {
    width: '78%',
  },
  stretch: {
    alignSelf: 'stretch',
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
  media: {
    width: 220,
    height: 300,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
    overflow: 'hidden',
  },
  proofTag: {
    ...font.small,
    color: colors.green,
    fontWeight: '900',
    marginBottom: 4,
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
  dareCardDone: {
    borderColor: colors.green,
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
  dareNote: {
    ...font.small,
    lineHeight: 18,
  },
  dareDone: {
    ...font.small,
    color: colors.green,
    fontWeight: '900',
  },
  dareButton: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingVertical: 11,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: colors.pink,
  },
  dareButtonText: {
    flexShrink: 1,
    color: colors.onAccent,
    fontSize: 14,
    fontWeight: '800',
  },
  pressed: {
    opacity: 0.8,
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
