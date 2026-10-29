import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Bouncy } from '@/components/Bouncy';
import { DatingProfileView } from '@/components/DatingProfileView';
import { EmptyState } from '@/components/EmptyState';
import { RoundIconButton, ScreenHeader } from '@/components/ScreenHeader';
import { SafeEdge } from '@/components/SafeEdge';
import { fetchLikesForMe, fetchMatches, likeDatingProfile, skipDatingProfile, type LikeForMe } from '@/lib/dating';
import { friendlyError } from '@/lib/errors';
import { useMediaUrls } from '@/lib/media';
import { useDatingSafety } from '@/lib/useDatingSafety';
import { colors, font, radius, space } from '@/theme';

// Someone who liked you: see their profile and what they said, then match 💘 or skip ✕.
export default function LikedYou() {
  const { datingId } = useLocalSearchParams<{ datingId: string }>();
  const insets = useSafeAreaInsets();
  const safety = useDatingSafety();
  const [like, setLike] = useState<LikeForMe | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchLikesForMe()
      .then((likes) => setLike(likes.find((entry) => entry.person.dating_id === datingId) ?? null))
      .catch(() => setLike(null));
  }, [datingId]);

  const urls = useMediaUrls(like ? like.person.photos.map((photo) => photo.path) : []);

  async function matchBack() {
    if (!like || busy) return;
    const firstPhoto = like.person.photos[0];
    if (!firstPhoto) return;
    setBusy(true);
    try {
      const result = await likeDatingProfile(like.person.dating_id, { photoId: firstPhoto.id }, '');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const match = result === 'match' ? (await fetchMatches()).find((m) => m.person.dating_id === like.person.dating_id) : undefined;
      if (match) router.replace(`/peek-match/chat/${match.match_id}`);
      else router.back();
    } catch (error) {
      Alert.alert('Could not match', friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  async function skip() {
    if (!like) return;
    Haptics.selectionAsync();
    await skipDatingProfile(like.person.dating_id).catch(() => {});
    router.back();
  }

  if (like === undefined) {
    return (
      <View style={styles.fill}>
        <ScreenHeader title="Likes you" />
        <ActivityIndicator color={colors.accent} style={styles.loading} />
      </View>
    );
  }
  if (like === null) {
    return (
      <View style={styles.fill}>
        <ScreenHeader title="Likes you" />
        <EmptyState emoji="💨" title="They're gone" message="This person isn't in Peek Match any more, or you've already answered." />
      </View>
    );
  }

  const person = like.person;
  return (
    <View style={styles.fill}>
      <ScreenHeader
        title="Likes you"
        right={<RoundIconButton icon="ellipsis-horizontal" label="Report or block" onPress={() => safety.openMenu(person, 'profile', () => router.back())} />}
      />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 110 }]}>
        <View style={styles.liked}>
          <Text style={styles.likedTitle}>
            💘 {person.name} liked your {like.liked_photo ? 'photo' : 'answer'}
            {like.liked_prompt ? `: “${like.liked_prompt}”` : ''}
          </Text>
          {like.comment ? <Text style={styles.comment}>“{like.comment}”</Text> : null}
        </View>
        <DatingProfileView card={person} urls={urls} />
      </ScrollView>
      <SafeEdge edge="bottom" style={styles.buttons} pointerEvents="box-none">
        <Bouncy style={styles.skip} pressScale={0.85} onPress={skip} accessibilityLabel={`Skip ${person.name}`}>
          <Ionicons name="close" size={34} color={colors.text} />
        </Bouncy>
        <Bouncy style={styles.match} pressScale={0.9} onPress={matchBack} disabled={busy} accessibilityLabel={`Match with ${person.name}`}>
          {busy ? <ActivityIndicator color={colors.white} /> : <Text style={styles.matchText}>💘 Match</Text>}
        </Bouncy>
      </SafeEdge>
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
    gap: space.lg,
  },
  liked: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.sm,
    borderWidth: 2,
    borderColor: colors.pink,
  },
  likedTitle: {
    ...font.body,
    fontWeight: '800',
  },
  comment: {
    ...font.heading,
    color: colors.pink,
  },
  buttons: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    bottom: space.lg,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
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
  match: {
    height: 64,
    paddingHorizontal: space.xl,
    borderRadius: 32,
    backgroundColor: colors.pink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  matchText: {
    color: colors.white,
    fontWeight: '900',
    fontSize: 18,
  },
});
