import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View, type ListViewToken } from 'react-native';
import Animated, {
  Easing,
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
  ZoomIn,
} from 'react-native-reanimated';

import { Avatar } from '@/components/Avatar';
import { Bouncy } from '@/components/Bouncy';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { useOverlays } from '@/components/Overlays';
import { RoundIconButton, ScreenHeader } from '@/components/ScreenHeader';
import { VideoClip } from '@/components/VideoClipSafe';
import { useMe } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import {
  blockMysteryPoster,
  deleteMystery,
  fetchMysteryFeed,
  guessMystery,
  reportMystery,
  type MysteryFeed,
  type MysteryPost,
} from '@/lib/guess';
import { useMediaUrls } from '@/lib/media';
import { REPORT_REASONS } from '@/lib/safety';
import { timeAgo } from '@/lib/time';
import type { Profile } from '@/lib/types';
import { colors, font, radius, space } from '@/theme';

const HOUR = 60 * 60 * 1000;
const nameOf = (person: Profile | undefined) => (person ? person.display_name || person.username : 'Someone');
const stillOf = (post: MysteryPost) => (post.media_type === 'video' ? post.poster_path : post.media_path);

// Guess Who: your friends' anonymous posts. Pick who you think posted each one (one try!), then see who it was.
export default function GuessWho() {
  const { userId } = useMe();
  const { showOptions, showToast } = useOverlays();
  const [feed, setFeed] = useState<(MysteryFeed & { loadedAt: number }) | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [guessing, setGuessing] = useState<string | null>(null);
  // Posts you just guessed, to play the reveal animation once.
  const [justRevealed, setJustRevealed] = useState<Set<string>>(new Set());
  const [inView, setInView] = useState<string | null>(null);

  const load = useCallback(
    () => fetchMysteryFeed().then((loaded) => setFeed({ ...loaded, loadedAt: Date.now() })),
    [],
  );

  useFocusEffect(
    useCallback(() => {
      load().catch(() => setFeed((current) => current ?? { posts: [], people: new Map(), loadedAt: 0 }));
    }, [load]),
  );

  async function refresh() {
    setRefreshing(true);
    await load().catch(() => {});
    setRefreshing(false);
  }

  const posts = feed?.posts ?? [];
  const urls = useMediaUrls(
    posts
      .flatMap((post) => [stillOf(post), post.media_type === 'video' ? post.media_path : null, post.overlay_path])
      .filter((path): path is string => !!path),
  );

  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ListViewToken[] }) => {
    const firstVideo = viewableItems.find((entry) => (entry.item as MysteryPost | undefined)?.media_type === 'video');
    setInView((firstVideo?.item as MysteryPost | undefined)?.id ?? null);
  }, []);

  const update = (id: string, change: Partial<MysteryPost>) =>
    setFeed((current) =>
      current ? { ...current, posts: current.posts.map((post) => (post.id === id ? { ...post, ...change } : post)) } : current,
    );
  const remove = (id: string) =>
    setFeed((current) => (current ? { ...current, posts: current.posts.filter((post) => post.id !== id) } : current));

  async function guess(post: MysteryPost, choice: string) {
    if (guessing) return;
    setGuessing(post.id);
    try {
      const poster = await guessMystery(post.id, choice);
      Haptics.notificationAsync(
        poster === choice ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning,
      );
      setJustRevealed((current) => new Set(current).add(post.id));
      update(post.id, { my_guess: choice, poster });
    } catch (error) {
      Alert.alert('Could not guess', friendlyError(error));
    } finally {
      setGuessing(null);
    }
  }

  function openMenu(post: MysteryPost) {
    if (post.mine) {
      showOptions({
        options: [
          {
            label: 'Delete',
            destructive: true,
            onPress: () =>
              Alert.alert('Delete this Guess Who?', 'It will be gone for everyone.', [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Delete',
                  style: 'destructive',
                  onPress: async () => {
                    try {
                      await deleteMystery(post);
                      remove(post.id);
                      showToast('Deleted 🗑️');
                    } catch (error) {
                      Alert.alert('Could not delete', friendlyError(error));
                    }
                  },
                },
              ]),
          },
        ],
      });
      return;
    }
    showOptions({
      options: [
        {
          label: 'Report',
          onPress: () =>
            // Wait for this menu to close before opening the next one.
            setTimeout(
              () =>
                showOptions({
                  title: 'Why are you reporting this?',
                  message: "Your report is private – whoever posted it won't know it was you. We review every report within 24 hours.",
                  options: REPORT_REASONS.map((reason) => ({
                    label: reason.label,
                    onPress: async () => {
                      try {
                        await reportMystery(post.id, reason.code);
                        Alert.alert('Thanks for telling us 💛', 'We will take a look.');
                      } catch (error) {
                        Alert.alert('Could not send report', friendlyError(error));
                      }
                    },
                  })),
                }),
              400,
            ),
        },
        {
          label: 'Block whoever posted this',
          destructive: true,
          onPress: () =>
            Alert.alert(
              'Block whoever posted this?',
              "They won't be able to see your stuff or message you, and you'll stop seeing theirs. We won't tell them. (They'll show up in your Blocked accounts list.)",
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Block',
                  style: 'destructive',
                  onPress: async () => {
                    try {
                      await blockMysteryPoster(post.id);
                      remove(post.id);
                      showToast('Blocked');
                    } catch (error) {
                      Alert.alert('Could not block', friendlyError(error));
                    }
                  },
                },
              ],
            ),
        },
      ],
    });
  }

  const newPost = () => router.push({ pathname: '/camera', params: { guess: '1' } });

  return (
    <View style={styles.fill}>
      <ScreenHeader title="Guess Who 🕵️" right={<RoundIconButton icon="add" label="Post a Guess Who" onPress={newPost} />} />
      {feed === null ? (
        <ActivityIndicator style={styles.loading} color={colors.accent} />
      ) : (
        <FlatList
          data={posts}
          keyExtractor={(post) => post.id}
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accent} />}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
          ListHeaderComponent={
            posts.length > 0 ? (
              <Text style={styles.explain}>Friends posted these without their names. Who was it? You get one try! 🤔</Text>
            ) : undefined
          }
          ListEmptyComponent={
            <EmptyState
              emoji="🕵️"
              title="No Guess Who posts right now"
              message="Post a photo without your name and see if your friends can guess it was you!">
              <Button title="Post a Guess Who" icon="camera" onPress={newPost} />
            </EmptyState>
          }
          renderItem={({ item }) => (
            <GuessCard
              post={item}
              people={feed.people}
              me={userId}
              now={feed.loadedAt}
              stillUrl={urls[stillOf(item) ?? '']}
              videoUrl={item.media_type === 'video' ? urls[item.media_path] : undefined}
              overlayUrl={item.overlay_path ? urls[item.overlay_path] : undefined}
              active={inView === item.id}
              busy={guessing === item.id}
              animate={justRevealed.has(item.id)}
              onGuess={(choice) => guess(item, choice)}
              onMenu={() => openMenu(item)}
            />
          )}
        />
      )}
    </View>
  );
}

function GuessCard({ post, people, me, now, stillUrl, videoUrl, overlayUrl, active, busy, animate, onGuess, onMenu }: {
  post: MysteryPost;
  people: Map<string, Profile>;
  me: string;
  now: number;
  stillUrl: string | undefined;
  videoUrl: string | undefined;
  overlayUrl: string | undefined;
  active: boolean;
  busy: boolean;
  animate: boolean;
  onGuess: (choice: string) => void;
  onMenu: () => void;
}) {
  const poster = post.poster ? people.get(post.poster) : undefined;
  const hoursLeft = Math.max(1, Math.round((Date.parse(post.expires_at) - now) / HOUR));
  const revealed = !post.mine && post.poster !== null;
  const correct = revealed && post.my_guess === post.poster;

  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{revealed ? '🔓' : '🕵️'}</Text>
        </View>
        <View style={styles.cardTitles}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {post.mine ? 'Your Guess Who 🤫' : revealed ? `${nameOf(poster)}'s Guess Who` : 'Who posted this?'}
          </Text>
          <Text style={styles.cardTime}>
            {timeAgo(post.created_at)} · {hoursLeft}h left
          </Text>
        </View>
        <Pressable onPress={onMenu} hitSlop={10} accessibilityLabel="More options">
          <Ionicons name="ellipsis-horizontal" size={22} color={colors.textMuted} />
        </Pressable>
      </View>

      <View style={styles.media}>
        {post.media_type === 'video' && videoUrl ? (
          <VideoClip
            uri={videoUrl}
            posterUri={stillUrl}
            overlayUri={overlayUrl}
            playing={active}
            muted
            loop
            style={StyleSheet.absoluteFill}
          />
        ) : stillUrl ? (
          <Image source={{ uri: stillUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />
        ) : null}
      </View>
      {post.caption ? <Text style={styles.caption}>{post.caption}</Text> : null}

      {post.mine ? (
        <View style={styles.results}>
          <Text style={styles.resultsText}>
            {!post.guess_count
              ? "🤫 Nobody's guessed yet"
              : `👀 ${post.guess_count} guessed · ${post.right_count ?? 0} got it · ${
                  post.guess_count - (post.right_count ?? 0)
                } fooled 😈`}
          </Text>
        </View>
      ) : revealed ? (
        <Reveal
          person={poster}
          correct={correct}
          guessed={post.my_guess && post.my_guess !== post.poster ? nameOf(people.get(post.my_guess)) : null}
          animate={animate}
        />
      ) : (
        <View style={styles.choices}>
          {(post.options ?? []).map((option) => {
            const person = people.get(option);
            return (
              <Bouncy
                key={option}
                style={styles.choice}
                pressScale={0.92}
                disabled={busy}
                onPress={() => onGuess(option)}
                accessibilityLabel={`Guess ${nameOf(person)}`}>
                <Avatar path={person?.avatar_path} name={nameOf(person)} size={32} />
                <Text style={styles.choiceName} numberOfLines={1}>
                  {option === me ? 'Me' : nameOf(person)}
                </Text>
              </Bouncy>
            );
          })}
          {busy ? <ActivityIndicator color={colors.accent} style={styles.choiceSpinner} /> : null}
        </View>
      )}
    </View>
  );
}

// Who it really was: their picture pops in, with a burst of emojis.
function Reveal({ person, correct, guessed, animate }: {
  person: Profile | undefined;
  correct: boolean;
  guessed: string | null;
  animate: boolean;
}) {
  const emojis = correct ? ['🎉', '✨', '🥳', '🎊', '✨', '🎉'] : ['😜', '🙈', '👀', '😂', '🙈', '😜'];
  return (
    <View style={styles.reveal}>
      {animate ? (
        <View style={styles.burst} pointerEvents="none">
          {emojis.map((emoji, index) => (
            <FlyingEmoji key={index} emoji={emoji} index={index} />
          ))}
        </View>
      ) : null}
      <Animated.View
        entering={animate ? ZoomIn.springify().damping(7).stiffness(160) : undefined}
        style={[styles.revealRing, { borderColor: correct ? colors.green : colors.pink }]}>
        <Avatar path={person?.avatar_path} name={nameOf(person)} size={72} />
      </Animated.View>
      <Animated.Text entering={animate ? FadeInDown.delay(250) : undefined} style={styles.revealTitle}>
        {correct ? `You got it! It was ${nameOf(person)} 🎉` : `Nope! It was ${nameOf(person)} 😜`}
      </Animated.Text>
      {guessed ? <Text style={styles.revealText}>You guessed {guessed}</Text> : null}
      {person ? (
        <Pressable onPress={() => router.push(`/profile/${person.id}`)} hitSlop={8}>
          <Text style={styles.revealLink}>See @{person.username}&apos;s profile</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function FlyingEmoji({ emoji, index }: { emoji: string; index: number }) {
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.set(withDelay(index * 60, withTiming(1, { duration: 1300, easing: Easing.out(Easing.quad) })));
  }, [index, progress]);
  const spread = (index - 2.5) * 36;
  const style = useAnimatedStyle(() => ({
    opacity: 1 - progress.get(),
    transform: [
      { translateX: spread * progress.get() },
      { translateY: -120 * progress.get() },
      { scale: 0.6 + progress.get() * 0.9 },
    ],
  }));
  return <Animated.Text style={[styles.flying, style]}>{emoji}</Animated.Text>;
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
    gap: space.xl,
    flexGrow: 1,
  },
  explain: {
    ...font.small,
    textAlign: 'center',
    marginBottom: -space.sm,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
  },
  badge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.purple,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    fontSize: 20,
  },
  cardTitles: {
    flex: 1,
  },
  cardTitle: {
    ...font.body,
    fontWeight: '800',
  },
  cardTime: {
    ...font.small,
  },
  media: {
    width: '100%',
    aspectRatio: 3 / 4,
    backgroundColor: colors.surface,
  },
  caption: {
    ...font.body,
    paddingHorizontal: space.md,
    paddingTop: space.md,
  },
  choices: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    padding: space.md,
  },
  choice: {
    flexBasis: '48%',
    flexGrow: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.purple,
  },
  choiceName: {
    ...font.small,
    color: colors.text,
    fontWeight: '800',
    flexShrink: 1,
  },
  choiceSpinner: {
    position: 'absolute',
    alignSelf: 'center',
    left: 0,
    right: 0,
  },
  results: {
    padding: space.md,
  },
  resultsText: {
    ...font.body,
    fontWeight: '700',
    textAlign: 'center',
  },
  reveal: {
    alignItems: 'center',
    gap: space.sm,
    padding: space.lg,
  },
  burst: {
    position: 'absolute',
    top: space.xl + 20,
    alignSelf: 'center',
    width: 1,
    height: 1,
    alignItems: 'center',
  },
  flying: {
    position: 'absolute',
    fontSize: 28,
  },
  revealRing: {
    borderWidth: 4,
    borderRadius: 44,
    padding: 3,
  },
  revealTitle: {
    ...font.heading,
    textAlign: 'center',
  },
  revealText: {
    ...font.small,
  },
  revealLink: {
    ...font.small,
    color: colors.pink,
    fontWeight: '800',
  },
});
