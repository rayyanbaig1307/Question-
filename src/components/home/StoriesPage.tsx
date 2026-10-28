import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { EmptyState } from '@/components/EmptyState';
import { useMe } from '@/lib/auth';
import { useMediaUrl } from '@/lib/media';
import { fetchMyActiveStories } from '@/lib/posts';
import { timeLeft } from '@/lib/time';
import type { Story } from '@/lib/types';
import { colors, font, gradients, radius, space } from '@/theme';
import { PageHeader } from './PageHeader';

// Right page: stories and (soon) the feed of friends' posts.
export function StoriesPage({ visible, onCamera }: { visible: boolean; onCamera: () => void }) {
  const { userId } = useMe();
  const [myStories, setMyStories] = useState<Story[]>([]);

  // Refresh whenever you swipe to this page.
  useEffect(() => {
    if (!visible) return;
    fetchMyActiveStories(userId)
      .then(setMyStories)
      .catch((error) => console.warn('Could not load stories', error));
  }, [visible, userId]);

  const latest = myStories[myStories.length - 1];
  const thumbnail = useMediaUrl(latest?.media_path);

  return (
    <View style={styles.fill}>
      <PageHeader title="Stories" cameraSide="left" onCamera={onCamera} />
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable style={styles.myStory} onPress={onCamera}>
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
              {latest
                ? `${myStories.length} ${myStories.length === 1 ? 'snap' : 'snaps'} · ${timeLeft(myStories[0].expires_at)}`
                : 'Tap to add a snap to your story'}
            </Text>
          </View>
        </Pressable>

        <EmptyState
          emoji="✨"
          title="Your friends' stories and posts will show up here"
          message="Tapping through friends' stories and scrolling their posts arrive in a later step."
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
    backgroundColor: colors.card,
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
});
