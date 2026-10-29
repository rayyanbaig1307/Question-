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

import { Bouncy } from '@/components/Bouncy';
import { Button } from '@/components/Button';
import { DatingProfileView, type LikeTarget } from '@/components/DatingProfileView';
import { EmptyState } from '@/components/EmptyState';
import { useOverlays } from '@/components/Overlays';
import { RoundIconButton } from '@/components/ScreenHeader';
import { SafeEdge } from '@/components/SafeEdge';
import { fetchDatingFeed, fetchMatches, likeDatingProfile, skipDatingProfile, type DatingCard } from '@/lib/dating';
import { friendlyError } from '@/lib/errors';
import { useMediaUrls } from '@/lib/media';
import { useDatingSafety } from '@/lib/useDatingSafety';
import { colors, font, keyboardAppearance, radius, space } from '@/theme';

// One profile at a time. ♥ a photo or prompt (with a comment if you like), or ✕ to skip.
// `bottomSpace` keeps the ✕ button above the tab bar.
export function MatchFeed({ visible, bottomSpace }: { visible: boolean; bottomSpace: number }) {
  const { showToast } = useOverlays();
  const safety = useDatingSafety();
  const [cards, setCards] = useState<DatingCard[] | null>(null);
  const [liking, setLiking] = useState<LikeTarget | null>(null);
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);

  // Fetch people; keeps the ones you're already looking at if there are any.
  const load = useCallback(
    (replace: boolean) =>
      fetchDatingFeed()
        .then((fresh) => setCards((current) => (!replace && current && current.length > 0 ? current : fresh)))
        .catch((error) => {
          setCards((current) => current ?? []);
          console.warn('Could not load Peek Match', error);
        }),
    [],
  );

  // Each time you come to the Match tab (so new people show up if you'd run out).
  useEffect(() => {
    if (visible) load(false);
  }, [visible, load]);

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
    load(true);
  }

  function skip() {
    if (!card) return;
    Haptics.selectionAsync();
    next();
    skipDatingProfile(card.dating_id).catch(() => {});
  }

  async function sendLike() {
    if (!card || !liking) return;
    setSending(true);
    try {
      const result = await likeDatingProfile(
        card.dating_id,
        'photoId' in liking ? { photoId: liking.photoId } : { prompt: liking.prompt },
        comment,
      );
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setLiking(null);
      setComment('');
      const person = card;
      next();
      if (result === 'match') {
        // They'd already liked you: it's a match!
        Alert.alert(`It's a match! 💘`, `You and ${person.name} liked each other.`, [
          { text: 'Keep looking', style: 'cancel' },
          {
            text: 'Say hi 👋',
            onPress: async () => {
              const match = (await fetchMatches().catch(() => [])).find((m) => m.person.dating_id === person.dating_id);
              if (match) router.push(`/peek-match/chat/${match.match_id}`);
            },
          },
        ]);
      } else {
        showToast(`Like sent to ${person.name} 💘`);
      }
    } catch (error) {
      Alert.alert('Could not send your like', friendlyError(error));
    } finally {
      setSending(false);
    }
  }

  if (cards === null) return <ActivityIndicator color={colors.accent} style={styles.loading} />;

  if (!card) {
    return (
      <ScrollView contentContainerStyle={[styles.emptyWrap, { paddingBottom: bottomSpace }]}>
        <EmptyState
          emoji="👀"
          title="No one new right now"
          message="Check back later – or widen who you'd like to see (ages, distance) in your dating profile.">
          <Button
            title="Look again"
            icon="refresh"
            variant="secondary"
            onPress={() => {
              setCards(null);
              load(true);
            }}
          />
          <Button title="Edit my dating profile" icon="create" variant="secondary" onPress={() => router.push('/peek-match/profile')} />
        </EmptyState>
      </ScrollView>
    );
  }

  return (
    <View style={styles.fill}>
      <Animated.View key={card.dating_id} entering={FadeIn.duration(250)} exiting={FadeOut.duration(150)} style={styles.fill}>
        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomSpace + 100 }]}>
          <DatingProfileView
            card={card}
            urls={urls}
            onLike={setLiking}
            headerRight={
              <RoundIconButton icon="ellipsis-horizontal" label="Report or block" onPress={() => safety.openMenu(card, 'profile', next)} />
            }
          />
        </ScrollView>
      </Animated.View>
      <Bouncy style={[styles.skip, { bottom: bottomSpace + space.md }]} pressScale={0.85} onPress={skip} accessibilityLabel={`Skip ${card.name}`}>
        <Ionicons name="close" size={34} color={colors.text} />
      </Bouncy>

      <Modal visible={!!liking} transparent animationType="slide" onRequestClose={() => setLiking(null)}>
        <KeyboardAvoidingView style={styles.fill} behavior="padding">
          <Pressable style={styles.backdrop} onPress={() => setLiking(null)}>
            <SafeEdge edge="bottom" style={styles.sheet}>
              <Pressable style={styles.sheetInner}>
                <Text style={styles.sheetTitle}>Like {card.name}&apos;s {liking && 'photoId' in liking ? 'photo' : 'answer'} 💘</Text>
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
                  keyboardAppearance={keyboardAppearance}
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
  },
  loading: {
    marginTop: space.xxl,
  },
  emptyWrap: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: space.lg,
  },
  content: {
    padding: space.lg,
    paddingTop: space.sm,
  },
  skip: {
    position: 'absolute',
    left: space.lg,
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
