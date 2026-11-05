import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';

import { VideoClip } from '@/components/VideoClipSafe';
import { Avatar } from '@/components/Avatar';
import { Bouncy } from '@/components/Bouncy';
import { IconButton } from '@/components/IconButton';
import { useOverlays } from '@/components/Overlays';
import { PersonRow } from '@/components/PersonRow';
import { SafeEdge } from '@/components/SafeEdge';
import { useMe } from '@/lib/auth';
import { sendReaction, STORY_REACTIONS } from '@/lib/chat';
import { friendlyError } from '@/lib/errors';
import { fetchStoryInsights, recordStoryView, useContentScreenshots, type StoryInsights } from '@/lib/insights';
import { mediaFiles, useMediaUrls } from '@/lib/media';
import { deleteStory, fetchStoryRing, fetchStoryViewers, type StoryRing } from '@/lib/stories';
import { refreshStoryBadges } from '@/lib/storyRings';
import { timeAgo } from '@/lib/time';
import type { Profile } from '@/lib/types';
import { useSafetyActions } from '@/lib/useSafetyActions';
import { colors, font, radius, space } from '@/theme';

const SECONDS_PER_PHOTO = 5;

// Watch someone's story: tap right = next, tap left = back, hold = pause.
// `queue` lists the friends to watch next, so it flows from one friend to the next.
export default function StoryViewer() {
  const { user, queue } = useLocalSearchParams<{ user: string; queue?: string }>();
  const { userId } = useMe();
  const { showOptions, showToast } = useOverlays();
  const { report } = useSafetyActions();
  const isMine = user === userId;

  const [ring, setRing] = useState<StoryRing | null | undefined>(undefined);
  const [index, setIndex] = useState(0);
  const [round, setRound] = useState(0); // bumps to replay the current photo
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [viewers, setViewers] = useState<{ storyId: string; people: Profile[] } | null>(null);
  const [viewersOpen, setViewersOpen] = useState(false);
  // Peekaboo+ insights for your own story: who rewatched it 🔁 and who screenshotted it 📸.
  const [insights, setInsights] = useState<{ storyId: string; data: StoryInsights } | null>(null);
  // Swipe up on your own story: the list of everyone who viewed it.
  const openViewers = () => setViewersOpen(true);
  const swipeUp = usePanGesture({
    enabled: isMine,
    activeOffsetY: -25,
    failOffsetX: [-30, 30],
    onDeactivate: (event) => {
      'worklet';
      if (event.translationY < -60) scheduleOnRN(openViewers);
    },
  });
  // The last reaction you sent (its counter restarts the flying-emoji animation).
  const [burst, setBurst] = useState<{ count: number; emoji: string } | null>(null);
  const progress = useSharedValue(0);

  // Closing the viewer: the rings on profile pictures catch up (a watched story turns grey, a deleted one goes).
  useEffect(() => () => void refreshStoryBadges(userId, true), [userId]);

  useEffect(() => {
    fetchStoryRing(userId, user)
      .then((loaded) => {
        setRing(loaded);
        // Start at the first photo you haven't seen yet.
        if (loaded && !isMine) {
          const firstNew = loaded.stories.findIndex((story) => !loaded.seenIds.has(story.id));
          setIndex(firstNew >= 0 ? firstNew : 0);
        }
      })
      .catch(() => setRing(null));
  }, [user, userId, isMine]);

  const urls = useMediaUrls(ring?.stories.flatMap((story) => mediaFiles(story)) ?? []);
  const story = ring?.stories[index];
  const url = story ? urls[story.media_path] : undefined;
  // A video story lasts as long as the video (up to 30 seconds, or 60 with Peekaboo+); a photo story 5 seconds.
  const [videoLength, setVideoLength] = useState<{ id: string; seconds: number } | null>(null);
  const isVideo = story?.media_type === 'video';
  const seconds =
    isVideo && videoLength?.id === story?.id ? Math.min(60, Math.max(1, videoLength.seconds)) : SECONDS_PER_PHOTO;

  // Finished this person's stories (or they have none) → next friend in line, or close.
  const finished = ring === null || (ring !== undefined && index >= ring.stories.length);
  useEffect(() => {
    if (!finished) return;
    const rest = queue ? queue.split(',').filter(Boolean) : [];
    if (rest.length > 0) {
      router.replace({
        pathname: '/stories/[user]',
        params: rest.length > 1 ? { user: rest[0], queue: rest.slice(1).join(',') } : { user: rest[0] },
      });
    } else if (router.canGoBack()) {
      router.back();
    }
  }, [finished, queue]);

  const next = useCallback(() => setIndex((current) => current + 1), []);
  const previous = () => (index > 0 ? setIndex(index - 1) : setRound(round + 1));

  // The timer bar: restart for each new photo, run while the photo is on screen and not paused.
  const storyId = story?.id;
  useEffect(() => {
    progress.set(0);
  }, [storyId, round, progress]);

  const running = storyId !== undefined && loadedId === storyId && !paused && !viewersOpen;
  useEffect(() => {
    if (!running) return;
    const remaining = (1 - progress.get()) * seconds * 1000;
    progress.set(
      withTiming(1, { duration: remaining, easing: Easing.linear }, (done) => {
        'worklet';
        if (done) scheduleOnRN(next);
      }),
    );
    return () => cancelAnimation(progress);
  }, [running, storyId, round, progress, next, seconds]);

  // Tell your friend you saw it. Each time you open their story counts once per photo (pausing doesn't
  // count again), so they can see with Peekaboo+ who rewatched it.
  const counted = useRef(new Set<string>());
  useEffect(() => {
    if (!running || !storyId || isMine || counted.current.has(storyId)) return;
    counted.current.add(storyId);
    recordStoryView(userId, storyId);
  }, [running, storyId, isMine, userId]);

  // 📸 A screenshot of a friend's story is recorded (they get a push; Peekaboo+ shows them who).
  useContentScreenshots('story', storyId, !isMine && !!storyId);

  // On your own story: who has seen this photo (and, opening the list again, the latest).
  useEffect(() => {
    if (!isMine || !storyId) return;
    let current = true;
    fetchStoryViewers(storyId)
      .then((people) => current && setViewers({ storyId, people }))
      .catch(() => {});
    fetchStoryInsights(storyId).then((data) => {
      if (current && data) setInsights({ storyId, data });
    });
    return () => {
      current = false;
    };
  }, [isMine, storyId, viewersOpen]);

  // Download the next photo in advance so it appears instantly.
  const nextUrl = ring ? urls[ring.stories[index + 1]?.media_path ?? ''] : undefined;
  useEffect(() => {
    if (nextUrl) Image.prefetch(nextUrl);
  }, [nextUrl]);

  // React to a friend's story: the emoji flies up, and it lands in your chat with them.
  async function react(emoji: string) {
    if (!ring || !story) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setBurst((current) => ({ count: (current?.count ?? 0) + 1, emoji }));
    try {
      await sendReaction(userId, ring.author.id, emoji, story.id);
      showToast(`Sent ${emoji} to ${ring.author.display_name || ring.author.username}`);
    } catch (error) {
      Alert.alert('Could not send your reaction', friendlyError(error));
    }
  }

  // Delete the one you're looking at from your story (asks first).
  function confirmDelete(onCancel?: () => void) {
    if (!ring || !story) return;
    setPaused(true);
    Alert.alert('Delete this from your story?', "It's gone for everyone right away.", [
      {
        text: 'Cancel',
        style: 'cancel',
        onPress: () => {
          setPaused(false);
          onCancel?.();
        },
      },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteStory(story);
            showToast('Deleted from your story 🗑️');
            const remaining = ring.stories.filter((s) => s.id !== story.id);
            setRing({ ...ring, stories: remaining });
            // (If that was the last one, the viewer closes by itself.)
            setIndex(Math.min(index, Math.max(0, remaining.length - 1)));
          } catch (error) {
            Alert.alert('Could not delete', friendlyError(error));
          } finally {
            setPaused(false);
          }
        },
      },
    ]);
  }

  function openMenu() {
    if (!ring || !story) return;
    setPaused(true);
    const resume = () => setPaused(false);
    if (isMine) {
      showOptions({
        onClose: resume,
        options: [
          {
            // Keep it on your profile grid after the story disappears (write a caption first).
            label: 'Add to my profile',
            onPress: () => router.push({ pathname: '/post-compose', params: { story: story.id } }),
          },
          { label: 'Delete from my story', destructive: true, onPress: () => confirmDelete() },
        ],
      });
    } else {
      showOptions({
        onClose: resume,
        options: [
          {
            label: 'Report story',
            onPress: () => report({ user: ring.author, contentType: 'story', contentId: story.id }),
          },
        ],
      });
    }
  }

  if (ring === undefined) {
    return (
      <View style={[styles.fill, styles.center]}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }
  // Nothing left to show: we're about to move on to the next friend (or close).
  if (!story) return <View style={styles.fill} />;

  const name = ring.author.display_name || ring.author.username;
  const seenBy = viewers?.storyId === story.id ? viewers.people : null;
  const storyInsights = insights?.storyId === story.id ? insights.data : null;
  const openPlus = () => {
    setViewersOpen(false);
    router.push('/plus');
  };

  return (
    <View style={styles.fill}>
      <StatusBar style="light" />
      {url && isVideo ? (
        <VideoClip
          key={story.id}
          uri={url}
          posterUri={story.poster_path ? urls[story.poster_path] : undefined}
          overlayUri={story.overlay_path ? urls[story.overlay_path] : undefined}
          playing={running}
          loop={false}
          onDuration={(length) => {
            setVideoLength({ id: story.id, seconds: length });
            setLoadedId(story.id);
          }}
          style={StyleSheet.absoluteFill}
        />
      ) : url ? (
        <Image
          key={story.id}
          source={{ uri: url, cacheKey: story.media_path }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          onLoad={() => setLoadedId(story.id)}
        />
      ) : null}
      {loadedId !== story.id ? <ActivityIndicator style={styles.spinner} color={colors.white} size="large" /> : null}

      {/* Tap zones: left third goes back, the rest goes forward. Hold anywhere to pause.
          On your own story, swipe up to see who viewed it. */}
      <GestureDetector gesture={swipeUp}>
      <View style={styles.tapZones}>
        <Pressable
          style={styles.backZone}
          onPress={previous}
          onLongPress={() => setPaused(true)}
          onPressOut={() => paused && setPaused(false)}
          delayLongPress={200}
          accessibilityLabel="Previous photo"
        />
        <Pressable
          style={styles.nextZone}
          onPress={next}
          onLongPress={() => setPaused(true)}
          onPressOut={() => paused && setPaused(false)}
          delayLongPress={200}
          accessibilityLabel="Next photo"
        />
      </View>
      </GestureDetector>

      <SafeEdge edge="top" style={styles.top} pointerEvents="box-none">
        <LinearGradient colors={['rgba(0,0,0,0.55)', 'transparent']} style={StyleSheet.absoluteFill} pointerEvents="none" />
        <View style={styles.bars} pointerEvents="none">
          {ring.stories.map((s, i) => (
            <ProgressBar key={s.id} state={i < index ? 'full' : i === index ? 'current' : 'empty'} progress={progress} />
          ))}
        </View>
        <View style={styles.header}>
          <Pressable style={styles.author} onPress={() => router.push(`/profile/${ring.author.id}`)}>
            <Avatar path={ring.author.avatar_path} name={name} size={36} />
            <Text style={styles.authorName} numberOfLines={1}>
              {isMine ? 'My Story' : name}
            </Text>
            <Text style={styles.time}>{timeAgo(story.created_at)}</Text>
            {story.audience === 'close_friends' ? <Text style={styles.closeTag}>⭐ Close friends</Text> : null}
          </Pressable>
          <IconButton icon="ellipsis-horizontal" label="More" size={38} onPress={openMenu} />
          <IconButton icon="close" label="Close" size={38} onPress={() => router.back()} />
        </View>
      </SafeEdge>

      {isMine ? (
        <SafeEdge edge="bottom" style={styles.bottom} pointerEvents="box-none">
          <View style={styles.myButtons}>
            <Pressable style={styles.viewersButton} onPress={() => setViewersOpen(true)}>
              <Ionicons name="eye" size={18} color={colors.white} />
              <Text style={styles.viewersText}>{seenBy === null ? '…' : `${seenBy.length} seen · swipe up`}</Text>
            </Pressable>
            <Pressable style={styles.viewersButton} onPress={() => confirmDelete()} accessibilityLabel="Delete from my story">
              <Ionicons name="trash" size={18} color={colors.white} />
              <Text style={styles.viewersText}>Delete</Text>
            </Pressable>
          </View>
        </SafeEdge>
      ) : (
        <SafeEdge edge="bottom" style={styles.bottom} pointerEvents="box-none">
          <View style={styles.reactions}>
            {STORY_REACTIONS.map((emoji) => (
              <Bouncy
                key={emoji}
                style={styles.reactionButton}
                pressScale={0.75}
                onPress={() => react(emoji)}
                accessibilityLabel={`React ${emoji}`}>
                <Text style={styles.reactionEmoji}>{emoji}</Text>
              </Bouncy>
            ))}
          </View>
        </SafeEdge>
      )}
      {burst ? <ReactionBurst key={burst.count} emoji={burst.emoji} /> : null}

      <Modal visible={viewersOpen} transparent animationType="slide" onRequestClose={() => setViewersOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setViewersOpen(false)}>
          <SafeEdge edge="bottom" style={styles.sheet}>
            <Pressable>
              <Text style={styles.sheetTitle}>👁 Seen by {seenBy?.length ?? 0}</Text>
              <FlatList
                data={seenBy ?? []}
                keyExtractor={(person) => person.id}
                contentContainerStyle={styles.sheetList}
                style={styles.sheetScroll}
                ListEmptyComponent={<Text style={styles.sheetEmpty}>Nobody yet – check back soon!</Text>}
                ListHeaderComponent={
                  storyInsights && !storyInsights.plus ? (
                    <Pressable style={styles.teaser} onPress={openPlus} accessibilityRole="button">
                      <Text style={styles.teaserTitle}>🔁 Who rewatched? ⭐</Text>
                      {storyInsights.rewatchers + storyInsights.screenshotters > 0 ? (
                        <Text style={styles.teaserText}>
                          {[
                            storyInsights.rewatchers > 0 ? `${storyInsights.rewatchers} rewatched` : null,
                            storyInsights.screenshotters > 0 ? `${storyInsights.screenshotters} screenshotted` : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}{' '}
                          – see who with Peekaboo+
                        </Text>
                      ) : (
                        <Text style={styles.teaserText}>See who watched again with Peekaboo+</Text>
                      )}
                    </Pressable>
                  ) : undefined
                }
                renderItem={({ item }) => {
                  const extra = storyInsights?.plus ? storyInsights.people.get(item.id) : undefined;
                  return (
                    <PersonRow
                      person={item}
                      plain
                      right={
                        extra && (extra.views > 1 || extra.screenshots > 0) ? (
                          <Text style={styles.insightTag}>
                            {[extra.views > 1 ? `🔁 ×${extra.views}` : null, extra.screenshots > 0 ? '📸' : null]
                              .filter(Boolean)
                              .join('  ')}
                          </Text>
                        ) : undefined
                      }
                    />
                  );
                }}
              />
            </Pressable>
          </SafeEdge>
        </Pressable>
      </Modal>
    </View>
  );
}

// A handful of the emoji you tapped float up the screen and fade away.
function ReactionBurst({ emoji }: { emoji: string }) {
  return (
    <View style={styles.burst} pointerEvents="none">
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <FloatingEmoji key={index} emoji={emoji} index={index} />
      ))}
    </View>
  );
}

function FloatingEmoji({ emoji, index }: { emoji: string; index: number }) {
  const rise = useSharedValue(0);
  useEffect(() => {
    rise.set(withTiming(1, { duration: 1100 + index * 120, easing: Easing.out(Easing.quad) }));
  }, [rise, index]);
  const drift = (index - 2.5) * 28;
  const style = useAnimatedStyle(() => ({
    opacity: 1 - rise.get(),
    transform: [
      { translateX: drift * rise.get() },
      { translateY: -320 * rise.get() - index * 12 },
      { scale: 0.8 + rise.get() * (index === 0 ? 1.4 : 0.6) },
    ],
  }));
  return <Animated.Text style={[styles.floating, style]}>{emoji}</Animated.Text>;
}

function ProgressBar({ state, progress }: { state: 'full' | 'current' | 'empty'; progress: SharedValue<number> }) {
  const fill = useAnimatedStyle(() => ({
    width: `${(state === 'full' ? 1 : state === 'current' ? progress.get() : 0) * 100}%`,
  }));
  return (
    <View style={styles.track}>
      <Animated.View style={[styles.fillBar, fill]} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.black,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  spinner: {
    ...StyleSheet.absoluteFill,
  },
  tapZones: {
    ...StyleSheet.absoluteFill,
    flexDirection: 'row',
  },
  backZone: {
    flex: 1,
  },
  nextZone: {
    flex: 2,
  },
  top: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: space.md,
    paddingBottom: space.xl,
    gap: space.md,
  },
  bars: {
    flexDirection: 'row',
    gap: 4,
    marginTop: space.sm,
  },
  track: {
    flex: 1,
    height: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.35)',
    overflow: 'hidden',
  },
  fillBar: {
    height: 3,
    backgroundColor: colors.white,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  author: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  authorName: {
    ...font.body,
    color: colors.white,
    fontWeight: '800',
    flexShrink: 1,
  },
  time: {
    ...font.small,
    color: 'rgba(255,255,255,0.8)',
  },
  bottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingBottom: space.lg,
  },
  reactions: {
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.overlayStrong,
  },
  reactionButton: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reactionEmoji: {
    fontSize: 32,
  },
  burst: {
    position: 'absolute',
    bottom: 120,
    alignSelf: 'center',
    width: 1,
    height: 1,
    alignItems: 'center',
  },
  floating: {
    position: 'absolute',
    fontSize: 44,
  },
  closeTag: {
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.green,
    color: colors.black,
    fontSize: 11,
    fontWeight: '900',
    overflow: 'hidden',
  },
  myButtons: {
    flexDirection: 'row',
    gap: space.sm,
  },
  viewersButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: colors.overlayStrong,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
  },
  viewersText: {
    color: colors.white,
    fontWeight: '800',
  },
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingTop: space.lg,
  },
  sheetTitle: {
    ...font.heading,
    textAlign: 'center',
    marginBottom: space.md,
  },
  sheetScroll: {
    maxHeight: 420,
  },
  sheetList: {
    paddingHorizontal: space.lg,
    paddingBottom: space.lg,
    gap: space.sm,
  },
  teaser: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.yellow,
    padding: space.md,
    gap: 2,
  },
  teaserTitle: {
    ...font.body,
    fontWeight: '800',
  },
  teaserText: {
    ...font.small,
  },
  insightTag: {
    ...font.body,
    fontWeight: '800',
  },
  sheetEmpty: {
    ...font.small,
    textAlign: 'center',
    paddingVertical: space.lg,
  },
});
