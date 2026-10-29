import { Image } from 'expo-image';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Bouncy } from '@/components/Bouncy';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { ScreenHeader } from '@/components/ScreenHeader';
import {
  fetchLikesForMe,
  fetchMatches,
  photosRevealed,
  UNBLUR_AFTER,
  type DatingMatch,
  type LikeForMe,
} from '@/lib/dating';
import { useMediaUrls } from '@/lib/media';
import { timeAgo } from '@/lib/time';
import { colors, font, radius, space } from '@/theme';

// Peek Match: people who liked you (like them back to match) and your match chats.
export default function DatingMatches() {
  const [likes, setLikes] = useState<LikeForMe[] | null>(null);
  const [matches, setMatches] = useState<DatingMatch[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    () =>
      Promise.all([fetchLikesForMe(), fetchMatches()])
        .then(([loadedLikes, loadedMatches]) => {
          setLikes(loadedLikes);
          setMatches(loadedMatches);
        })
        .catch(() => {
          setLikes((current) => current ?? []);
          setMatches((current) => current ?? []);
        }),
    [],
  );

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  const urls = useMediaUrls(
    [...(likes ?? []).map((like) => like.person.photos[0]?.path), ...(matches ?? []).map((m) => m.person.photos[0]?.path)].filter(
      (path): path is string => !!path,
    ),
  );

  if (likes === null || matches === null) {
    return (
      <View style={styles.fill}>
        <ScreenHeader title="Matches 💘" />
        <ActivityIndicator color={colors.accent} style={styles.loading} />
      </View>
    );
  }

  return (
    <View style={styles.fill}>
      <ScreenHeader title="Matches 💘" />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accent} />}>
        {likes.length > 0 ? (
          <>
            <Text style={styles.sectionTitle}>Likes you ({likes.length})</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.likes}>
              {likes.map((like) => {
                const photo = like.person.photos[0];
                const uri = photo ? urls[photo.path] : undefined;
                return (
                  <Bouncy
                    key={like.person.dating_id}
                    style={styles.likeCard}
                    pressScale={0.95}
                    onPress={() => router.push(`/peek-match/person/${like.person.dating_id}`)}
                    accessibilityLabel={`See ${like.person.name}, who liked you`}>
                    {uri ? <Image source={{ uri, cacheKey: photo?.path }} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
                    <View style={styles.likeShade} />
                    <View style={styles.likeInfo}>
                      <Text style={styles.likeName} numberOfLines={1}>
                        {like.person.name}, {like.person.age}
                      </Text>
                      {like.comment ? (
                        <Text style={styles.likeComment} numberOfLines={2}>
                          💬 {like.comment}
                        </Text>
                      ) : null}
                    </View>
                  </Bouncy>
                );
              })}
            </ScrollView>
          </>
        ) : null}

        <Text style={styles.sectionTitle}>Matches</Text>
        {matches.length === 0 ? (
          <EmptyState
            emoji="💘"
            title="No matches yet"
            message="When you and someone both like each other, you'll match and can chat here.">
            <Button title="Start peeking" icon="heart" onPress={() => router.push('/peek-match/discover')} />
          </EmptyState>
        ) : (
          matches.map((match) => {
            const photo = match.person.photos[0];
            const uri = photo ? urls[photo.path] : undefined;
            const revealed = photosRevealed(match);
            return (
              <Pressable
                key={match.match_id}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                onPress={() => router.push(`/peek-match/chat/${match.match_id}`)}>
                <View style={styles.avatar}>
                  {uri ? (
                    <Image source={{ uri, cacheKey: photo?.path }} style={StyleSheet.absoluteFill} contentFit="cover" blurRadius={revealed ? 0 : 25} />
                  ) : null}
                </View>
                <View style={styles.rowText}>
                  <Text style={styles.rowName} numberOfLines={1}>
                    {match.person.name}
                  </Text>
                  <Text style={[styles.rowLast, match.unread > 0 && styles.rowUnread]} numberOfLines={1}>
                    {match.last ? `${match.last.mine ? 'You: ' : ''}${match.last.body}` : 'New match! Say hi 👋'}
                  </Text>
                  {!revealed ? (
                    <Text style={styles.rowBlur}>
                      🙈 Photos unblur at {UNBLUR_AFTER} messages each · you {Math.min(match.my_count, UNBLUR_AFTER)}/{UNBLUR_AFTER}
                    </Text>
                  ) : null}
                </View>
                <View style={styles.rowSide}>
                  <Text style={styles.time}>{timeAgo(match.last?.created_at ?? match.created_at)}</Text>
                  {match.unread > 0 ? <View style={styles.dot} /> : null}
                </View>
              </Pressable>
            );
          })
        )}
      </ScrollView>
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
    gap: space.md,
    paddingBottom: space.xxl * 2,
  },
  sectionTitle: {
    ...font.label,
    textTransform: 'uppercase',
    marginTop: space.sm,
  },
  likes: {
    gap: space.md,
  },
  likeCard: {
    width: 150,
    height: 200,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: colors.card,
    justifyContent: 'flex-end',
    borderWidth: 2,
    borderColor: colors.pink,
  },
  likeShade: {
    ...StyleSheet.absoluteFill,
    top: '45%',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  likeInfo: {
    padding: space.sm,
    gap: 2,
  },
  likeName: {
    color: colors.white,
    fontWeight: '900',
    fontSize: 15,
  },
  likeComment: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 12,
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.card,
  },
  rowPressed: {
    backgroundColor: colors.cardPressed,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowName: {
    ...font.body,
    fontWeight: '800',
  },
  rowLast: {
    ...font.small,
  },
  rowUnread: {
    color: colors.text,
    fontWeight: '800',
  },
  rowBlur: {
    ...font.small,
    fontSize: 11,
    color: colors.purple,
    fontWeight: '700',
  },
  rowSide: {
    alignItems: 'flex-end',
    gap: space.xs,
  },
  time: {
    ...font.small,
    fontSize: 11,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.pink,
  },
});
