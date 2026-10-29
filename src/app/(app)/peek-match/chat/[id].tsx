import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, { ZoomIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DatingProfileView } from '@/components/DatingProfileView';
import { EmptyState } from '@/components/EmptyState';
import { IconButton } from '@/components/IconButton';
import { useOverlays } from '@/components/Overlays';
import { RoundIconButton, ScreenHeader } from '@/components/ScreenHeader';
import { useMe } from '@/lib/auth';
import {
  fetchDatingMessages,
  fetchMatches,
  markDatingChatRead,
  photosRevealed,
  sendDatingMessage,
  subscribeToDatingChat,
  unmatch,
  UNBLUR_AFTER,
  type DatingMatch,
  type DatingMessage,
} from '@/lib/dating';
import { friendlyError } from '@/lib/errors';
import { useMediaUrls } from '@/lib/media';
import { fetchPeekMatchStatus } from '@/lib/peekMatch';
import { timeAgo } from '@/lib/time';
import { useDatingSafety } from '@/lib/useDatingSafety';
import { colors, font, radius, space } from '@/theme';

// A Peek Match chat with one match. Their photos stay blurred until you've both sent 5 messages.
export default function DatingChat() {
  const { id: matchId } = useLocalSearchParams<{ id: string }>();
  const { userId } = useMe();
  const { showToast } = useOverlays();
  const safety = useDatingSafety();
  const insets = useSafeAreaInsets();

  const [match, setMatch] = useState<DatingMatch | null | undefined>(undefined);
  const [myDatingId, setMyDatingId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DatingMessage[] | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const wasRevealed = useRef<boolean | null>(null);

  const load = useCallback(async () => {
    try {
      const [found, list] = await Promise.all([fetchMatches(matchId), fetchDatingMessages(matchId)]);
      setMatch(found[0] ?? null);
      setMessages(list);
      if (found[0]?.unread) markDatingChatRead(matchId).catch(() => {});
    } catch {
      setMatch((current) => current ?? null);
      setMessages((current) => current ?? []);
    }
  }, [matchId]);

  useFocusEffect(
    useCallback(() => {
      load();
      fetchPeekMatchStatus(userId)
        .then((status) => setMyDatingId(status.member?.dating_id ?? null))
        .catch(() => {});
      return subscribeToDatingChat(matchId, load);
    }, [load, matchId, userId]),
  );

  const revealed = match ? photosRevealed(match) : false;
  // The moment you both reach 5: a happy buzz and a toast.
  useEffect(() => {
    if (!match) return;
    if (wasRevealed.current === false && revealed) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showToast('📸 Photos unblurred! Peekaboo 👀');
    }
    wasRevealed.current = revealed;
  }, [match, revealed, showToast]);

  const urls = useMediaUrls(match ? match.person.photos.map((photo) => photo.path) : []);

  async function send() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await sendDatingMessage(matchId, body);
      setText('');
      await load();
    } catch (error) {
      Alert.alert('Message not sent', friendlyError(error));
    } finally {
      setSending(false);
    }
  }

  function openMenu() {
    if (!match) return;
    const person = match.person;
    safety.openMenu(person, 'message', () => router.back(), [
      {
        label: `Unmatch ${person.name}`,
        destructive: true,
        onPress: () =>
          Alert.alert(`Unmatch ${person.name}?`, 'This chat disappears for both of you.', [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Unmatch',
              style: 'destructive',
              onPress: async () => {
                try {
                  await unmatch(matchId);
                  showToast(`Unmatched ${person.name}`);
                  router.back();
                } catch (error) {
                  Alert.alert('Could not unmatch', friendlyError(error));
                }
              },
            },
          ]),
      },
    ]);
  }

  if (match === undefined) {
    return (
      <View style={styles.fill}>
        <ScreenHeader title="Peek Match" />
        <ActivityIndicator color={colors.accent} style={styles.loading} />
      </View>
    );
  }
  if (match === null) {
    return (
      <View style={styles.fill}>
        <ScreenHeader title="Peek Match" />
        <EmptyState emoji="💨" title="This chat has ended" message="You or your match unmatched, blocked, or left Peek Match." />
      </View>
    );
  }

  const first = match.person.photos[0];
  const firstUri = first ? urls[first.path] : undefined;

  return (
    <View style={styles.fill}>
      <ScreenHeader
        titleContent={
          <Pressable style={styles.headerTitle} onPress={() => setProfileOpen(true)} accessibilityLabel={`See ${match.person.name}'s profile`}>
            <View style={styles.headerAvatar}>
              {firstUri ? (
                <Image source={{ uri: firstUri, cacheKey: first?.path }} style={StyleSheet.absoluteFill} contentFit="cover" blurRadius={revealed ? 0 : 20} />
              ) : null}
            </View>
            <Text style={styles.headerName} numberOfLines={1}>
              {match.person.name} 💘
            </Text>
          </Pressable>
        }
        right={<RoundIconButton icon="ellipsis-horizontal" label="Unmatch, report or block" onPress={openMenu} />}
      />

      {revealed ? null : (
        <View style={styles.blurBar}>
          <Text style={styles.blurText}>🙈 Photos unblur when you&apos;ve both sent {UNBLUR_AFTER} messages</Text>
          <View style={styles.progressRow}>
            <Progress label="You" count={match.my_count} />
            <Progress label={match.person.name} count={match.their_count} />
          </View>
        </View>
      )}

      <KeyboardAvoidingView style={styles.fill} behavior="padding" keyboardVerticalOffset={-insets.bottom}>
        {messages === null ? (
          <ActivityIndicator color={colors.accent} style={styles.loading} />
        ) : messages.length === 0 ? (
          <View style={styles.empty}>
            <EmptyState emoji="👋" title={`You matched with ${match.person.name}!`} message="Say hi – what made you like them?" />
          </View>
        ) : (
          <FlatList
            data={messages}
            inverted
            keyExtractor={(message) => message.id}
            contentContainerStyle={styles.list}
            keyboardDismissMode="interactive"
            renderItem={({ item }) => {
              const mine = item.sender === myDatingId;
              return (
                <View style={[styles.bubbleWrap, mine ? styles.right : styles.left]}>
                  <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
                    <Text style={[styles.bubbleText, mine && styles.bubbleTextMine]}>{item.body}</Text>
                  </View>
                  <Text style={styles.time}>{timeAgo(item.created_at)}</Text>
                </View>
              );
            }}
          />
        )}
        <View style={[styles.inputBar, { paddingBottom: insets.bottom + space.sm }]}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={`Message ${match.person.name}`}
            placeholderTextColor={colors.textFaint}
            keyboardAppearance="dark"
            selectionColor={colors.accent}
            multiline
            maxLength={1000}
            style={styles.input}
          />
          <IconButton icon="arrow-up" label="Send" background={text.trim() ? colors.pink : colors.card} onPress={send} />
        </View>
      </KeyboardAvoidingView>

      <Modal visible={profileOpen} animationType="slide" onRequestClose={() => setProfileOpen(false)}>
        <View style={styles.fill}>
          <ScreenHeader title={match.person.name} onBack={() => setProfileOpen(false)} />
          <ScrollView contentContainerStyle={styles.profile}>
            {revealed ? null : (
              <Text style={styles.blurText}>🙈 Photos unblur when you&apos;ve both sent {UNBLUR_AFTER} messages</Text>
            )}
            <DatingProfileView card={match.person} urls={urls} blurred={!revealed} />
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

function Progress({ label, count }: { label: string; count: number }) {
  const done = Math.min(count, UNBLUR_AFTER);
  return (
    <View style={styles.progress}>
      <Text style={styles.progressLabel} numberOfLines={1}>
        {label} {done}/{UNBLUR_AFTER}
      </Text>
      <View style={styles.dots}>
        {Array.from({ length: UNBLUR_AFTER }, (_, index) => (
          <Animated.View
            key={index}
            entering={index < done ? ZoomIn : undefined}
            style={[styles.dot, index < done && styles.dotOn]}
          />
        ))}
      </View>
    </View>
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
  headerTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    maxWidth: 240,
  },
  headerAvatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    overflow: 'hidden',
    backgroundColor: colors.card,
  },
  headerName: {
    ...font.body,
    fontWeight: '800',
  },
  blurBar: {
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    gap: space.sm,
  },
  blurText: {
    ...font.small,
    color: colors.purple,
    fontWeight: '800',
    textAlign: 'center',
  },
  progressRow: {
    flexDirection: 'row',
    gap: space.lg,
  },
  progress: {
    flex: 1,
    gap: 4,
  },
  progressLabel: {
    ...font.small,
    fontSize: 12,
  },
  dots: {
    flexDirection: 'row',
    gap: 4,
  },
  dot: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.border,
  },
  dotOn: {
    backgroundColor: colors.pink,
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
  },
  list: {
    padding: space.lg,
    gap: space.md,
    flexGrow: 1,
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
    backgroundColor: colors.pink,
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
  profile: {
    padding: space.lg,
    gap: space.md,
    paddingBottom: space.xxl * 2,
  },
});
