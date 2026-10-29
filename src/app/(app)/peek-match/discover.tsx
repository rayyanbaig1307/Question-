import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Bouncy } from '@/components/Bouncy';
import { Button } from '@/components/Button';
import { DatingProfileView, type LikeTarget } from '@/components/DatingProfileView';
import { EmptyState } from '@/components/EmptyState';
import { useOverlays } from '@/components/Overlays';
import { RoundIconButton, ScreenHeader } from '@/components/ScreenHeader';
import { SafeEdge } from '@/components/SafeEdge';
import {
  blockDatingProfile,
  fetchDatingFeed,
  likeDatingProfile,
  reportDatingProfile,
  skipDatingProfile,
  type DatingCard,
} from '@/lib/dating';
import { friendlyError } from '@/lib/errors';
import { useMediaUrls } from '@/lib/media';
import { REPORT_REASONS } from '@/lib/safety';
import { colors, font, radius, space } from '@/theme';

// Peek Match: one profile at a time. ♥ a photo or prompt (with a comment if you like), or ✕ to skip.
export default function DatingDiscover() {
  const { showOptions, showToast } = useOverlays();
  const insets = useSafeAreaInsets();
  const [cards, setCards] = useState<DatingCard[] | null>(null);
  const [liking, setLiking] = useState<LikeTarget | null>(null);
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);

  const load = useCallback(
    () =>
      fetchDatingFeed()
        .then(setCards)
        .catch((error) => {
          setCards((current) => current ?? []);
          Alert.alert('Could not load Peek Match', friendlyError(error));
        }),
    [],
  );

  useEffect(() => {
    load();
  }, [load]);

  const card = cards?.[0] ?? null;
  const urls = useMediaUrls(card ? card.photos.map((photo) => photo.path) : []);

  // Move on to the next person (and fetch more when we run out).
  function next() {
    const rest = (cards ?? []).slice(1);
    if (rest.length > 0) {
      setCards(rest);
      return;
    }
    setCards(null);
    load();
  }

  async function skip() {
    if (!card) return;
    Haptics.selectionAsync();
    next();
    skipDatingProfile(card.dating_id).catch(() => {});
  }

  async function sendLike() {
    if (!card || !liking) return;
    setSending(true);
    try {
      await likeDatingProfile(card.dating_id, 'photoId' in liking ? { photoId: liking.photoId } : { prompt: liking.prompt }, comment);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showToast(`Like sent to ${card.name} 💘`);
      setLiking(null);
      setComment('');
      next();
    } catch (error) {
      Alert.alert('Could not send your like', friendlyError(error));
    } finally {
      setSending(false);
    }
  }

  function openMenu() {
    if (!card) return;
    const person = card;
    const block = () =>
      Alert.alert(`Block ${person.name}?`, "You won't see each other in Peek Match again. We won't tell them.", [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block',
          style: 'destructive',
          onPress: async () => {
            try {
              await blockDatingProfile(person.dating_id);
              showToast(`Blocked ${person.name}`);
              next();
            } catch (error) {
              Alert.alert('Could not block', friendlyError(error));
            }
          },
        },
      ]);
    showOptions({
      options: [
        {
          label: `Report ${person.name}`,
          onPress: () =>
            setTimeout(
              () =>
                showOptions({
                  title: 'Why are you reporting this profile?',
                  message: "Your report is private. They won't know it was you.",
                  options: REPORT_REASONS.map((reason) => ({
                    label: reason.label,
                    onPress: async () => {
                      try {
                        await reportDatingProfile(person.dating_id, reason.code);
                        Alert.alert('Thanks for telling us 💛', 'We will take a look. Do you also want to block them?', [
                          { text: 'Not now', style: 'cancel' },
                          { text: 'Block', style: 'destructive', onPress: () => setTimeout(block, 400) },
                        ]);
                      } catch (error) {
                        Alert.alert('Could not send report', friendlyError(error));
                      }
                    },
                  })),
                }),
              400,
            ),
        },
        { label: `Block ${person.name}`, destructive: true, onPress: block },
      ],
    });
  }

  return (
    <View style={styles.fill}>
      <ScreenHeader
        title="Peek Match 💘"
        right={card ? <RoundIconButton icon="ellipsis-horizontal" label="Report or block" onPress={openMenu} /> : undefined}
      />
      {cards === null ? (
        <ActivityIndicator color={colors.accent} style={styles.loading} />
      ) : !card ? (
        <EmptyState
          emoji="👀"
          title="No one new right now"
          message="Check back later – or widen who you'd like to see (ages, distance). Your profile needs to be finished and showing, too.">
          <Button title="Edit my dating profile" icon="create" onPress={() => router.push('/peek-match/profile')} />
        </EmptyState>
      ) : (
        <>
          <Animated.View key={card.dating_id} entering={FadeIn.duration(250)} exiting={FadeOut.duration(150)} style={styles.fill}>
            <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 110 }]}>
              <DatingProfileView card={card} urls={urls} onLike={setLiking} />
            </ScrollView>
          </Animated.View>
          <SafeEdge edge="bottom" style={styles.skipWrap} pointerEvents="box-none">
            <Bouncy style={styles.skip} pressScale={0.85} onPress={skip} accessibilityLabel={`Skip ${card.name}`}>
              <Ionicons name="close" size={34} color={colors.text} />
            </Bouncy>
          </SafeEdge>
        </>
      )}

      <Modal visible={!!liking} transparent animationType="slide" onRequestClose={() => setLiking(null)}>
        <KeyboardAvoidingView style={styles.fill} behavior="padding">
          <Pressable style={styles.backdrop} onPress={() => setLiking(null)}>
            <SafeEdge edge="bottom" style={styles.sheet}>
              <Pressable style={styles.sheetInner}>
                <Text style={styles.sheetTitle}>Like {card?.name}&apos;s {liking && 'photoId' in liking ? 'photo' : 'answer'} 💘</Text>
                {liking && 'photoId' in liking ? (
                  urls[liking.path] ? (
                    <Image source={{ uri: urls[liking.path] }} style={styles.likedPhoto} contentFit="cover" />
                  ) : null
                ) : liking ? (
                  <View style={styles.likedPrompt}>
                    <Text style={styles.likedQuestion}>{liking.text}</Text>
                    <Text style={styles.likedAnswer}>{liking.answer}</Text>
                  </View>
                ) : null}
                <TextInput
                  value={comment}
                  onChangeText={setComment}
                  placeholder="Add a comment (optional)"
                  placeholderTextColor={colors.textFaint}
                  keyboardAppearance="dark"
                  selectionColor={colors.accent}
                  maxLength={200}
                  multiline
                  style={styles.comment}
                />
                <Button title={comment.trim() ? 'Send like + comment' : 'Send like'} icon="heart" loading={sending} onPress={sendLike} />
              </Pressable>
            </SafeEdge>
          </Pressable>
        </KeyboardAvoidingView>
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
    marginTop: space.xxl,
  },
  content: {
    padding: space.lg,
  },
  skipWrap: {
    position: 'absolute',
    left: space.lg,
    bottom: space.lg,
  },
  skip: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.card,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  sheetInner: {
    padding: space.lg,
    gap: space.md,
  },
  sheetTitle: {
    ...font.heading,
    textAlign: 'center',
  },
  likedPhoto: {
    alignSelf: 'center',
    width: 160,
    height: 200,
    borderRadius: radius.md,
  },
  likedPrompt: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: space.lg,
    gap: space.sm,
  },
  likedQuestion: {
    ...font.label,
    color: colors.pink,
  },
  likedAnswer: {
    ...font.body,
    fontWeight: '800',
  },
  comment: {
    ...font.body,
    minHeight: 60,
    maxHeight: 120,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: space.md,
    color: colors.text,
  },
});
