import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { ChatSticker } from '@/components/chat/ChatSticker';
import { StickerPicker } from '@/components/editor/StickerPicker';
import { EmptyState } from '@/components/EmptyState';
import { IconButton } from '@/components/IconButton';
import { KeyboardSafeView } from '@/components/KeyboardSafeView';
import { useOverlays } from '@/components/Overlays';
import { ScreenHeader } from '@/components/ScreenHeader';
import { StoryAvatar } from '@/components/StoryAvatar';
import { ZoomableImage } from '@/components/ZoomableImage';
import { useMe } from '@/lib/auth';
import { canSendSticker, isKnownSticker, stickerName, wordStickerId } from '@/lib/chatStickers';
import { friendlyError } from '@/lib/errors';
import { useMediaUrls } from '@/lib/media';
import { usePlus } from '@/lib/plus';
import {
  checkPublicName,
  deletePublicMessage,
  deletePublicPhoto,
  fetchPublicChat,
  hasPublicText,
  PUBLIC_CHAT,
  PUBLIC_TEXT_MAX,
  publicChatName,
  sendPublicSticker,
  sendPublicText,
  subscribeToPublicChat,
  usePublicChatStatus,
  type PublicChatItem,
  type PublicMessage,
  type PublicPhoto,
} from '@/lib/publicChat';
import { timeAgo } from '@/lib/time';
import { useSafetyActions } from '@/lib/useSafetyActions';
import { colors, font, keyboardAppearance, radius, space } from '@/theme';

type RoomPhoto = PublicPhoto & { kind: 'photo' };

// Photos and messages have their own ids, so the list keys say which is which.
const keyOf = (item: PublicChatItem) => `${item.kind === 'photo' ? 'photo' : 'message'}:${item.id}`;

// The public chat 📸: one room for everyone on Peekaboo who is 18 or over. Photos, messages and stickers.
// Rules (checked by the server): 18+, no slurs, no links or phone numbers, slow mode, report → 3 reports hide a
// photo or message, blocks. Newest at the bottom, next to the message box, like the other chats.
export default function PublicChatScreen() {
  const { userId, profile } = useMe();
  const insets = useSafeAreaInsets();
  const { showToast, showOptions } = useOverlays();
  const { report } = useSafetyActions();
  const status = usePublicChatStatus();
  const plus = usePlus();
  const [items, setItems] = useState<PublicChatItem[] | null>(null);
  // Can this server take messages? false: the room stays photos only, like before. null: not known yet.
  const [textOn, setTextOn] = useState<boolean | null>(null);
  // The room couldn't be loaded (no signal…). What's on screen stays; with nothing yet, "Try again" shows.
  const [loadFailed, setLoadFailed] = useState(false);
  const [text, setText] = useState('');
  // Is there anything to send? Not when the box holds only spaces or invisible characters.
  const canSend = hasPublicText(text);
  const [sending, setSending] = useState(false);
  const sendingNow = useRef(false);
  const [stickersOpen, setStickersOpen] = useState(false);
  const [viewing, setViewing] = useState<RoomPhoto | null>(null);
  const urls = useMediaUrls((items ?? []).flatMap((item) => (item.kind === 'photo' ? [item.media_path] : [])));
  // Stickers this version of the app doesn't know aren't shown at all (they have no words to show instead).
  const shown = (items ?? []).filter((item) => item.kind !== 'sticker' || (item.sticker !== null && isKnownSticker(item.sticker)));

  const load = useCallback(async () => {
    try {
      const room = await fetchPublicChat();
      setItems(room.items);
      setTextOn(room.textOn);
      setLoadFailed(false);
    } catch (error) {
      // Keep what's on screen (and whether this server has messages); live changes and coming back to the app try
      // again. Nothing loaded yet: the "Try again" screen.
      console.warn('The public chat could not be loaded', error);
      setLoadFailed(true);
    }
  }, []);
  const tryAgain = () => {
    setLoadFailed(false);
    load();
  };

  // A busy room changes all the time: reload at most twice a second.
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadSoon = useCallback(() => {
    if (reloadTimer.current) return;
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = null;
      load();
    }, 500);
  }, [load]);
  useEffect(
    () => () => {
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
    },
    [],
  );

  useFocusEffect(
    useCallback(() => {
      if (status !== 'ok') return;
      load();
    }, [status, load]),
  );
  // Live changes, once we know whether this server has messages.
  useFocusEffect(
    useCallback(() => {
      if (status !== 'ok' || textOn === null) return;
      return subscribeToPublicChat(reloadSoon, { text: textOn });
    }, [status, reloadSoon, textOn]),
  );
  // Back in the app (after the phone was locked, or another app): load again, in case something was missed.
  useFocusEffect(
    useCallback(() => {
      if (status !== 'ok') return;
      const subscription = AppState.addEventListener('change', (state) => {
        if (state === 'active') reloadSoon();
      });
      return () => subscription.remove();
    }, [status, reloadSoon]),
  );

  const addSent = (sent: PublicMessage) =>
    setItems((current) => [sent, ...(current ?? []).filter((item) => keyOf(item) !== keyOf(sent))]);

  // Your name or username with a link or phone number in it: you can't post until it's changed (the server checks too).
  function nameStopsYou(): boolean {
    const problem = checkPublicName(profile);
    if (problem) Alert.alert('Change your name first', problem);
    return problem !== null;
  }

  const openCamera = () => {
    if (nameStopsYou()) return;
    router.push({ pathname: '/camera', params: { group: PUBLIC_CHAT } });
  };

  async function send() {
    if (sendingNow.current || !canSend || nameStopsYou()) return;
    const sent = text;
    sendingNow.current = true;
    setSending(true);
    try {
      addSent(await sendPublicText(sent));
      // Only empty the box if it still holds what was sent (not words typed while it was sending).
      setText((current) => (current === sent ? '' : current));
    } catch (error) {
      // The words stay in the box, so they can be fixed and sent again.
      Alert.alert('Message not sent', friendlyError(error));
    } finally {
      sendingNow.current = false;
      setSending(false);
    }
  }

  // 🏷️ Stickers: the same ones as in chats. Peekaboo+ ones are locked in the picker without Peekaboo+ (and the
  // server says no too).
  async function sendSticker(sticker: string) {
    setStickersOpen(false);
    if (!canSendSticker(sticker, plus)) {
      router.push('/plus');
      return;
    }
    if (nameStopsYou()) return;
    try {
      addSent(await sendPublicSticker(sticker));
    } catch (error) {
      Alert.alert('Sticker not sent', friendlyError(error));
    }
  }
  // An emoji from the sticker picker goes as a normal message.
  async function sendEmoji(emoji: string) {
    setStickersOpen(false);
    if (nameStopsYou()) return;
    try {
      addSent(await sendPublicText(emoji));
    } catch (error) {
      Alert.alert('Message not sent', friendlyError(error));
    }
  }

  function openMenu(item: PublicChatItem) {
    const author = item.author;
    if (item.sender_id === userId) {
      showOptions({
        title: item.kind === 'photo' ? 'Your photo' : 'Your message',
        options: [
          {
            label: 'Delete',
            destructive: true,
            onPress: async () => {
              try {
                if (item.kind === 'photo') await deletePublicPhoto(item);
                else await deletePublicMessage(item.id);
                setItems((current) => current?.filter((other) => keyOf(other) !== keyOf(item)) ?? null);
                showToast('Deleted');
              } catch (error) {
                Alert.alert('Could not delete', friendlyError(error));
              }
            },
          },
        ],
      });
      return;
    }
    if (!author) return;
    const reportIt = (contentType: 'public_photo' | 'public_message') =>
      report({
        user: { id: author.id, username: author.username },
        contentType,
        contentId: item.id,
        // Blocked: their photos and messages leave your room straight away.
        onBlocked: () => setItems((current) => current?.filter((other) => other.sender_id !== author.id) ?? null),
      });
    showOptions({
      title: `@${author.username}`,
      options: [
        item.kind === 'photo'
          ? { label: 'Report photo', onPress: () => reportIt('public_photo') }
          : { label: 'Report message', onPress: () => reportIt('public_message') },
        { label: 'See profile', onPress: () => router.push(`/profile/${author.id}`) },
      ],
    });
  }

  const header = <ScreenHeader title="Public chat 📸" />;

  if (status === null) {
    return (
      <View style={styles.fill}>
        {header}
        <ActivityIndicator color={colors.accent} style={styles.loading} />
      </View>
    );
  }
  if (status === 'no_birthday') {
    return (
      <View style={styles.fill}>
        {header}
        <EmptyState emoji="🎂" title="Add your birthday to join" message="The public chat is only for people 18 and over. Your birthday stays private.">
          <Button title="Add my birthday" onPress={() => router.push('/birthday')} />
        </EmptyState>
      </View>
    );
  }
  if (status !== 'ok') {
    return (
      <View style={styles.fill}>
        {header}
        <EmptyState emoji="🔒" title="Not available" message="The public chat is only for people 18 and over." />
      </View>
    );
  }

  function renderPhoto(item: RoomPhoto) {
    const name = publicChatName(item.author);
    const url = urls[item.media_path];
    return (
      <View style={styles.card}>
        <View style={styles.cardTop}>
          <Pressable
            style={styles.author}
            onPress={() => item.author && router.push(`/profile/${item.author.id}`)}
            accessibilityLabel={`Open ${name}'s profile`}>
            <StoryAvatar person={item.author} size={34} />
            <View>
              <Text style={styles.name} numberOfLines={1}>
                {item.sender_id === userId ? 'You' : name}
              </Text>
              <Text style={styles.time}>{timeAgo(item.created_at)}</Text>
            </View>
          </Pressable>
          <Pressable onPress={() => openMenu(item)} hitSlop={10} accessibilityLabel="More">
            <Ionicons name="ellipsis-horizontal" size={22} color={colors.textMuted} />
          </Pressable>
        </View>
        <Pressable
          onPress={url ? () => setViewing(item) : undefined}
          onLongPress={() => openMenu(item)}
          accessibilityRole="button"
          accessibilityLabel={`Open ${name}'s photo`}>
          {url ? (
            <Image source={{ uri: url, cacheKey: item.media_path }} style={styles.photo} contentFit="cover" transition={150} />
          ) : (
            <View style={[styles.photo, styles.photoLoading]} />
          )}
        </Pressable>
        {item.hidden ? <Text style={styles.hidden}>🙈 Hidden: several people reported this photo. Only you can see it.</Text> : null}
      </View>
    );
  }

  function renderMessage(item: PublicMessage) {
    const mine = item.sender_id === userId;
    const name = publicChatName(item.author);
    const who = mine ? 'You' : name;
    const label = item.kind === 'sticker' ? `${who}: ${stickerName(item.sticker ?? '')} sticker` : `${who}: ${item.body}`;
    return (
      <View style={[styles.messageRow, mine && styles.messageRowMine]}>
        {mine ? null : (
          <Pressable onPress={() => item.author && router.push(`/profile/${item.author.id}`)} accessibilityLabel={`Open ${name}'s profile`}>
            <StoryAvatar person={item.author} size={28} />
          </Pressable>
        )}
        <View style={[styles.messageColumn, mine && styles.messageColumnMine]}>
          {mine ? null : (
            <Text style={styles.messageName} numberOfLines={1}>
              {name}
            </Text>
          )}
          <Pressable
            onLongPress={() => openMenu(item)}
            delayLongPress={300}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityHint="Hold for options">
            {item.kind === 'sticker' && item.sticker ? (
              <ChatSticker id={item.sticker} />
            ) : (
              <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
                <Text style={[styles.bubbleText, mine && styles.bubbleTextMine]}>{item.body}</Text>
              </View>
            )}
          </Pressable>
          <Text style={styles.time}>{timeAgo(item.created_at)}</Text>
          {item.hidden ? <Text style={styles.hidden}>🙈 Hidden: several people reported this message. Only you can see it.</Text> : null}
        </View>
      </View>
    );
  }

  const left = PUBLIC_TEXT_MAX - text.length;

  return (
    <View style={styles.fill}>
      {header}
      {/* Keeps the message box above the keyboard (the same as the other chats). */}
      <KeyboardSafeView style={styles.fill} bottomInset={insets.bottom} androidBehavior="padding">
        <Text style={styles.rules}>
          {/* "By the birthday they saved": we can't check ages, so we don't say it as fact. */}
          {textOn === false
            ? 'For people 18 and over (by the birthday they saved – we can’t check ages). Photos only · one every 30 seconds · be kind. Hold a photo to report it.'
            : 'For people 18 and over (by the birthday they saved – we can’t check ages). Be kind · no links or phone numbers. Hold a message or photo to report it.'}
          {' Public account? Anyone here can become your friend straight away – turn on Private account in Settings to approve people first.'}
        </Text>
        {items === null && loadFailed ? (
          <View style={styles.fill}>
            <EmptyState emoji="📡" title="Couldn't load the room" message="Check your connection and try again.">
              <Button title="Try again" onPress={tryAgain} />
            </EmptyState>
          </View>
        ) : items === null ? (
          <ActivityIndicator color={colors.accent} style={styles.loading} />
        ) : shown.length === 0 ? (
          <View style={styles.fill}>
            {textOn === false ? (
              <EmptyState emoji="📸" title="Nobody has posted yet" message="Be the first – take a photo for everyone on Peekaboo." />
            ) : (
              <EmptyState emoji="👋" title="Nobody has said anything yet" message="Be the first – say hi or post a photo for everyone on Peekaboo." />
            )}
          </View>
        ) : (
          <FlatList
            data={shown}
            inverted
            keyExtractor={keyOf}
            // Photos only: room for the big 📷 button over the newest photo (the list is upside down, so its top
            // is at the bottom of the screen).
            contentContainerStyle={[styles.content, textOn === false && { paddingTop: insets.bottom + 96 }]}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (item.kind === 'photo' ? renderPhoto(item) : renderMessage(item))}
          />
        )}
        {textOn === true && left <= 50 ? <Text style={styles.counter}>{`${left} left`}</Text> : null}
        {textOn === true ? (
          <View style={[styles.inputBar, { paddingBottom: insets.bottom + space.sm }]}>
            <IconButton icon="camera" label="Post a photo" background={colors.accent} color={colors.onAccent} onPress={openCamera} />
            <View style={styles.field}>
              <TextInput
                value={text}
                onChangeText={setText}
                placeholder="Say something to everyone"
                placeholderTextColor={colors.textFaint}
                keyboardAppearance={keyboardAppearance}
                selectionColor={colors.accent}
                multiline
                maxLength={PUBLIC_TEXT_MAX}
                style={styles.input}
                accessibilityLabel="Message for the public chat"
              />
              {canSend ? null : (
                <IconButton
                  icon="happy"
                  label="Send a sticker"
                  size={34}
                  background="transparent"
                  color={colors.yellow}
                  onPress={() => setStickersOpen(true)}
                  style={styles.fieldButton}
                />
              )}
            </View>
            <IconButton
              icon="arrow-up"
              label="Send"
              background={canSend ? colors.blue : colors.card}
              onPress={send}
              disabled={sending || !canSend}
            />
          </View>
        ) : textOn === false ? (
          <View style={[styles.cameraButton, { bottom: insets.bottom + space.lg }]}>
            <IconButton icon="camera" label="Post a photo" size={64} background={colors.accent} color={colors.onAccent} onPress={openCamera} />
          </View>
        ) : null}
      </KeyboardSafeView>

      <StickerPicker
        visible={stickersOpen}
        onClose={() => setStickersOpen(false)}
        onPickEmoji={sendEmoji}
        onPickWord={(word) => sendSticker(wordStickerId(word))}
        onPickSpecial={sendSticker}
      />
      <Modal visible={viewing !== null} animationType="fade" onRequestClose={() => setViewing(null)} statusBarTranslucent>
        <View style={styles.viewer}>
          {viewing && urls[viewing.media_path] ? (
            <ZoomableImage uri={urls[viewing.media_path]} cacheKey={viewing.media_path} style={StyleSheet.absoluteFill} />
          ) : null}
          <View style={[styles.viewerClose, { top: insets.top + space.sm }]}>
            <IconButton icon="close" label="Close" onPress={() => setViewing(null)} />
          </View>
        </View>
      </Modal>
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
  content: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    gap: space.lg,
  },
  rules: {
    ...font.small,
    textAlign: 'center',
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
  },
  card: {
    gap: space.sm,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  author: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    flexShrink: 1,
  },
  name: {
    ...font.label,
  },
  time: {
    ...font.small,
    fontSize: 12,
  },
  photo: {
    width: '100%',
    aspectRatio: 3 / 4,
    borderRadius: radius.lg,
  },
  photoLoading: {
    backgroundColor: colors.card,
  },
  hidden: {
    ...font.small,
    color: colors.orange,
  },
  messageRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
  },
  messageRowMine: {
    justifyContent: 'flex-end',
  },
  messageColumn: {
    maxWidth: '80%',
    alignItems: 'flex-start',
    gap: 2,
  },
  messageColumnMine: {
    alignItems: 'flex-end',
  },
  messageName: {
    ...font.small,
    fontWeight: '700',
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
    borderTopLeftRadius: 6,
  },
  bubbleText: {
    ...font.body,
    lineHeight: 22,
  },
  bubbleTextMine: {
    color: colors.white,
  },
  inputBar: {
    backgroundColor: colors.bg,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  field: {
    flex: 1,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: colors.card,
    borderRadius: 22,
    paddingLeft: space.lg,
    paddingRight: 4,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    paddingHorizontal: 0,
    paddingTop: 12,
    paddingBottom: 12,
    color: colors.text,
    fontSize: 16,
  },
  fieldButton: {
    marginBottom: 5,
  },
  counter: {
    ...font.small,
    fontSize: 12,
    textAlign: 'center',
    paddingBottom: space.xs,
  },
  cameraButton: {
    position: 'absolute',
    alignSelf: 'center',
  },
  viewer: {
    flex: 1,
    backgroundColor: colors.black,
  },
  viewerClose: {
    position: 'absolute',
    right: space.lg,
  },
});
