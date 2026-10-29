import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Bouncy } from '@/components/Bouncy';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { useMe } from '@/lib/auth';
import { inviteFriends } from '@/lib/invite';
import { useMediaUrls } from '@/lib/media';
import { fetchStoryRings, type StoryRing } from '@/lib/stories';
import { timeAgo } from '@/lib/time';
import { colors, font, gradients, radius, space } from '@/theme';
import { useTabBarSpace } from './HomeTabBar';
import { PageHeader } from './PageHeader';

type Rings = { mine: StoryRing | null; friends: StoryRing[] };

// Stories only: a row of circles at the top (My Story first), then bigger cards for friends' stories.
export function StoriesPage({ visible, onCamera }: { visible: boolean; onCamera: () => void }) {
  const { userId, profile } = useMe();
  const tabSpace = useTabBarSpace();
  const { width } = useWindowDimensions();
  const [rings, setRings] = useState<Rings | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const showError = useCallback((error: unknown) => {
    console.warn('Could not load stories', error);
    setRings((current) => current ?? { mine: null, friends: [] });
  }, []);

  // Refresh whenever you swipe to this page (or come back from watching stories).
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    fetchStoryRings(userId)
      .then((loaded) => !cancelled && setRings(loaded))
      .catch((error) => !cancelled && showError(error));
    return () => {
      cancelled = true;
    };
  }, [visible, userId, showError]);

  async function refresh() {
    setRefreshing(true);
    try {
      setRings(await fetchStoryRings(userId));
    } catch (error) {
      showError(error);
    }
    setRefreshing(false);
  }

  const mine = rings?.mine ?? null;
  const friends = rings?.friends ?? [];
  const latestOf = (ring: StoryRing) => ring.stories[ring.stories.length - 1];
  // The picture on each story card: the photo, or a video's still picture.
  const thumbPath = (ring: StoryRing) => {
    const latest = latestOf(ring);
    return latest.media_type === 'video' ? latest.poster_path : latest.media_path;
  };
  const thumbs = useMediaUrls(friends.map(thumbPath).filter((path): path is string => !!path));

  // Watch one friend's stories, then carry on with the next friends who have new ones.
  function openFriend(index: number) {
    const queue = friends
      .slice(index + 1)
      .filter((ring) => !ring.allSeen)
      .map((ring) => ring.author.id);
    router.push({
      pathname: '/stories/[user]',
      params: queue.length ? { user: friends[index].author.id, queue: queue.join(',') } : { user: friends[index].author.id },
    });
  }

  const openMine = () => (mine ? router.push({ pathname: '/stories/[user]', params: { user: userId } }) : onCamera());
  const cardWidth = (width - space.lg * 2 - space.md) / 2;
  const myName = profile?.display_name || profile?.username;

  return (
    <View style={styles.fill}>
      <PageHeader title="Stories" cameraSide="left" onCamera={onCamera} />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: tabSpace + space.lg }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accent} />}>
        {/* The row of circles, like Instagram */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rings}>
          <Pressable style={styles.circle} onPress={openMine} accessibilityLabel={mine ? 'Watch my story' : 'Add to my story'}>
            <Ring active={!!mine}>
              <Avatar path={profile?.avatar_path} name={myName} size={64} />
            </Ring>
            <Bouncy style={styles.plus} pressScale={0.8} onPress={onCamera} accessibilityLabel="Add to my story">
              <Text style={styles.plusText}>＋</Text>
            </Bouncy>
            <Text style={styles.circleName} numberOfLines={1}>
              My Story
            </Text>
          </Pressable>

          {friends.map((ring, index) => (
            <Pressable key={ring.author.id} style={styles.circle} onPress={() => openFriend(index)}>
              <Ring active={!ring.allSeen}>
                <Avatar path={ring.author.avatar_path} name={ring.author.display_name || ring.author.username} size={64} />
              </Ring>
              <Text style={[styles.circleName, ring.allSeen && styles.seen]} numberOfLines={1}>
                {ring.author.display_name || ring.author.username}
              </Text>
            </Pressable>
          ))}

          <Pressable
            style={styles.circle}
            onPress={() => inviteFriends(profile?.username)}
            accessibilityRole="button"
            accessibilityLabel="Invite friends">
            <View style={[styles.ring, styles.inviteRing]}>
              <Text style={styles.inviteText}>＋</Text>
            </View>
            <Text style={styles.circleName}>Invite</Text>
          </Pressable>
        </ScrollView>

        {rings === null ? (
          <ActivityIndicator color={colors.accent} style={styles.loading} />
        ) : friends.length === 0 ? (
          <EmptyState
            emoji="🌙"
            title="No stories right now"
            message="When your friends share a story, it shows up here for 24 hours.">
            <Button title="Add to my story" icon="camera" onPress={onCamera} />
            <Button title="Invite friends" icon="paper-plane" variant="secondary" onPress={() => inviteFriends(profile?.username)} />
          </EmptyState>
        ) : (
          <>
            <Text style={styles.sectionTitle}>Friends&apos; stories</Text>
            <View style={styles.grid}>
              {friends.map((ring, index) => {
                const thumb = thumbs[thumbPath(ring) ?? ''];
                const name = ring.author.display_name || ring.author.username;
                return (
                  <Bouncy
                    key={ring.author.id}
                    style={[styles.card, { width: cardWidth, height: cardWidth * 1.6 }, ring.allSeen && styles.cardSeen]}
                    pressScale={0.96}
                    onPress={() => openFriend(index)}
                    accessibilityLabel={`Watch ${name}'s story`}>
                    {thumb ? (
                      <Image source={{ uri: thumb, cacheKey: thumbPath(ring) ?? undefined }} style={StyleSheet.absoluteFill} contentFit="cover" />
                    ) : null}
                    <LinearGradient colors={['transparent', 'rgba(0,0,0,0.75)']} style={styles.cardShade} />
                    <View style={styles.cardInfo}>
                      <Avatar path={ring.author.avatar_path} name={name} size={28} />
                      <View style={styles.cardText}>
                        <Text style={styles.cardName} numberOfLines={1}>
                          {name}
                        </Text>
                        <Text style={styles.cardTime}>{ring.allSeen ? 'Seen' : timeAgo(ring.latestAt)}</Text>
                      </View>
                    </View>
                    {!ring.allSeen ? <View style={styles.newDot} /> : null}
                  </Bouncy>
                );
              })}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

// The colorful ring around a story circle (grey once you've seen everything).
function Ring({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <LinearGradient colors={active ? gradients.brand : [colors.border, colors.border]} style={styles.ring}>
      <View style={styles.ringGap}>{children}</View>
    </LinearGradient>
  );
}

const RING = 76;

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    paddingTop: space.sm,
    gap: space.lg,
  },
  loading: {
    marginTop: space.xl,
  },
  rings: {
    gap: space.lg,
    paddingHorizontal: space.lg,
    paddingVertical: space.xs,
  },
  circle: {
    width: RING,
    alignItems: 'center',
    gap: 6,
  },
  ring: {
    width: RING,
    height: RING,
    borderRadius: RING / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringGap: {
    padding: 3,
    borderRadius: RING / 2,
    backgroundColor: colors.bg,
  },
  plus: {
    position: 'absolute',
    top: RING - 26,
    right: 0,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.accent,
    borderWidth: 3,
    borderColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  plusText: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '900',
  },
  circleName: {
    ...font.small,
    color: colors.text,
    fontWeight: '700',
  },
  seen: {
    color: colors.textMuted,
  },
  inviteRing: {
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.accent,
  },
  inviteText: {
    color: colors.accent,
    fontSize: 28,
    fontWeight: '900',
  },
  sectionTitle: {
    ...font.label,
    textTransform: 'uppercase',
    marginHorizontal: space.lg,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.md,
    paddingHorizontal: space.lg,
  },
  card: {
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: colors.card,
    justifyContent: 'flex-end',
  },
  cardSeen: {
    opacity: 0.6,
  },
  cardShade: {
    ...StyleSheet.absoluteFill,
    top: '50%',
  },
  cardInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.md,
  },
  cardText: {
    flexShrink: 1,
  },
  cardName: {
    color: colors.white,
    fontWeight: '800',
    fontSize: 14,
  },
  cardTime: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 12,
  },
  newDot: {
    position: 'absolute',
    top: space.md,
    right: space.md,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.accent,
    borderWidth: 2,
    borderColor: colors.white,
  },
});
