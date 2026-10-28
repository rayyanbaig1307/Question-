import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { EmptyState } from '@/components/EmptyState';
import { IconButton } from '@/components/IconButton';
import { useMe } from '@/lib/auth';
import { useMediaUrl } from '@/lib/media';
import { fetchStoryRings, type StoryRing } from '@/lib/stories';
import { timeAgo, timeLeft } from '@/lib/time';
import { colors, font, gradients, radius, space } from '@/theme';
import { PageHeader } from './PageHeader';

// Right page: stories and (soon) the feed of friends' posts.
export function StoriesPage({ visible, onCamera }: { visible: boolean; onCamera: () => void }) {
  const { userId } = useMe();
  const [rings, setRings] = useState<{ mine: StoryRing | null; friends: StoryRing[] } | null>(null);

  // Refresh whenever you swipe to this page (or come back from watching stories).
  useEffect(() => {
    if (!visible) return;
    fetchStoryRings(userId)
      .then(setRings)
      .catch((error) => console.warn('Could not load stories', error));
  }, [visible, userId]);

  const mine = rings?.mine ?? null;
  const latest = mine?.stories[mine.stories.length - 1];
  const thumbnail = useMediaUrl(latest?.media_path);
  const friends = rings?.friends ?? [];

  // Watch one friend's stories, then carry on with the next friends who have new ones.
  function openFriend(index: number) {
    const next = friends
      .slice(index + 1)
      .filter((ring) => !ring.allSeen)
      .map((ring) => ring.author.id);
    router.push({
      pathname: '/stories/[user]',
      params: next.length ? { user: friends[index].author.id, queue: next.join(',') } : { user: friends[index].author.id },
    });
  }

  return (
    <View style={styles.fill}>
      <PageHeader title="Stories" cameraSide="left" onCamera={onCamera} />
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable
          style={styles.myStory}
          onPress={() => (mine ? router.push({ pathname: '/stories/[user]', params: { user: userId } }) : onCamera())}>
          <LinearGradient colors={latest ? gradients.brand : [colors.border, colors.border]} style={styles.ring}>
            <View style={styles.ringGap}>
              {thumbnail && latest ? (
                <Image source={{ uri: thumbnail, cacheKey: latest.media_path }} style={styles.thumb} contentFit="cover" />
              ) : (
                <View style={[styles.thumb, styles.addThumb]}>
                  <Text style={styles.plus}>＋</Text>
                </View>
              )}
            </View>
          </LinearGradient>
          <View style={styles.myStoryText}>
            <Text style={styles.myStoryTitle}>My Story</Text>
            <Text style={styles.myStorySubtitle}>
              {mine
                ? `${mine.stories.length} ${mine.stories.length === 1 ? 'snap' : 'snaps'} · ${timeLeft(mine.stories[0].expires_at)}`
                : 'Tap to add a snap to your story'}
            </Text>
          </View>
          {mine ? <IconButton icon="add" label="Add to story" background={colors.surface} onPress={onCamera} /> : null}
        </Pressable>

        <Text style={styles.sectionTitle}>Friends</Text>
        {rings === null ? null : friends.length === 0 ? (
          <Text style={styles.noStories}>No new stories from friends right now. 🌙</Text>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rings}>
            {friends.map((ring, index) => (
              <Pressable key={ring.author.id} style={styles.friend} onPress={() => openFriend(index)}>
                <LinearGradient
                  colors={ring.allSeen ? [colors.border, colors.border] : gradients.brand}
                  style={styles.ring}>
                  <View style={styles.ringGap}>
                    <Avatar path={ring.author.avatar_path} name={ring.author.display_name || ring.author.username} size={60} />
                  </View>
                </LinearGradient>
                <Text style={[styles.friendName, ring.allSeen && styles.seen]} numberOfLines={1}>
                  {ring.author.display_name || ring.author.username}
                </Text>
                <Text style={styles.friendTime}>{timeAgo(ring.latestAt)}</Text>
              </Pressable>
            ))}
          </ScrollView>
        )}

        <EmptyState
          emoji="📰"
          title="Your friends' posts will show up here"
          message="Scrolling friends' posts with likes and comments arrives in the next step."
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: space.lg,
    gap: space.lg,
  },
  myStory: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    backgroundColor: colors.card,
    padding: space.lg,
    borderRadius: radius.lg,
  },
  ring: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringGap: {
    padding: 3,
    borderRadius: 36,
    backgroundColor: colors.bg,
  },
  thumb: {
    width: 60,
    height: 60,
    borderRadius: 30,
  },
  addThumb: {
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  plus: {
    color: colors.yellow,
    fontSize: 28,
    fontWeight: '900',
  },
  myStoryText: {
    flex: 1,
    gap: 2,
  },
  myStoryTitle: {
    ...font.heading,
  },
  myStorySubtitle: {
    ...font.small,
  },
  sectionTitle: {
    ...font.label,
    textTransform: 'uppercase',
    marginLeft: space.xs,
    marginBottom: -space.sm,
  },
  noStories: {
    ...font.small,
    marginLeft: space.xs,
  },
  rings: {
    gap: space.lg,
    paddingVertical: space.xs,
  },
  friend: {
    width: 76,
    alignItems: 'center',
    gap: 4,
  },
  friendName: {
    ...font.small,
    color: colors.text,
    fontWeight: '700',
  },
  seen: {
    color: colors.textMuted,
  },
  friendTime: {
    ...font.small,
    fontSize: 11,
    color: colors.textFaint,
  },
});
