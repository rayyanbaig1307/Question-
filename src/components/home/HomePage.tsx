import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, RefreshControl, StyleSheet, Text, View, type ListViewToken } from 'react-native';

import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { FeedCard } from '@/components/FeedCard';
import { useOverlays } from '@/components/Overlays';
import { useMe } from '@/lib/auth';
import { fetchMyDrops, NO_DROPS, postMedia, useDropKeyOpen, useMyDropPosts, useWithMyNewDrop, type MyDrops } from '@/lib/drop';
import { friendlyError } from '@/lib/errors';
import { fetchDiscover, setLiked, type DiscoverCursor, type DiscoverPost } from '@/lib/feed';
import { countUnguessed } from '@/lib/guess';
import { inviteFriends } from '@/lib/invite';
import { liveMaybeAvailable } from '@/lib/liveAccess';
import { fetchFriendsLiveNow, type FriendLive } from '@/lib/lives';
import { onNotificationArrived } from '@/lib/notifications';
import { useDropSending } from '@/lib/outbox';
import { noteDropSeen } from '@/lib/peeks';
import { useMediaUrls } from '@/lib/media';
import { deletePost } from '@/lib/posts';
import { useScratchToReveal } from '@/lib/preferences';
import { fetchStoryRings } from '@/lib/stories';
import { setStoryRings, storyRingsTicket } from '@/lib/storyRings';
import { useSafetyActions } from '@/lib/useSafetyActions';
import { colors, font, space, pageBackground } from '@/theme';
import { useTabBarSpace } from './HomeTabBar';
import { PageHeader } from './PageHeader';
import { StoryRow, type Rings } from './StoryRow';

// How long Home waits for a drop you just sent before loading again anyway.
const DROP_WAIT_MS = 3000;

// Home, like Instagram: story circles along the top, then the feed – your friends' posts (and yours) first,
// then everyone else's public posts.
export function HomePage({ visible, onCamera }: { visible: boolean; onCamera: () => void }) {
  const { userId, profile } = useMe();
  const { showOptions, showToast } = useOverlays();
  const { report, confirmBlock } = useSafetyActions();
  const [scratchToReveal] = useScratchToReveal();
  const tabSpace = useTabBarSpace();
  const [rings, setRings] = useState<Rings | null>(null);
  const [posts, setPosts] = useState<DiscoverPost[] | null>(null);
  const [next, setNext] = useState<DiscoverCursor | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Your own drops: posting one opens every drop until the next day's drop goes off ("give a peek to get a peek").
  // The drop you just posted counts the moment it's saved, before Home has loaded your drops again.
  const [loadedDrops, setMyDrops] = useState<MyDrops | null>(null);
  const myDrops = useWithMyNewDrop(userId, loadedDrops);
  // Is your latest drop still the current one? (Redraws Home whenever drops lock again.)
  const dropKey = useDropKeyOpen(myDrops);
  // How many Guess Who posts you can still guess (a number on the Guess Who circle).
  const [toGuess, setToGuess] = useState(0);
  // Friends who are live right now 🔴 (only on downloads that can open a live).
  const [lives, setLives] = useState<FriendLive[]>([]);

  // Loads everything on Home. Each part shows the moment it arrives: the posts never wait for the stories, your
  // drops, the Guess Who number or the lives (before, the slowest of them held up all the others). `current()` says
  // whether this load still counts (Home may have been left meanwhile). Resolves once every part is done.
  const loadAll = useCallback(
    (current: () => boolean) => {
      const ticket = storyRingsTicket();
      const stories = fetchStoryRings(userId)
        .then((loaded) => {
          // The same list gives the rings on profile pictures everywhere else.
          setStoryRings(userId, loaded, ticket);
          return loaded;
        })
        .catch((error) => {
          console.warn('Could not load stories', error);
          return { mine: null, friends: [] } as Rings;
        })
        .then((loaded) => {
          if (current()) setRings(loaded);
        });
      const feed = fetchDiscover(userId)
        .then((page) => {
          if (!current()) return;
          setPosts(page.posts);
          setNext(page.next);
        })
        .catch((error) => {
          console.warn('Could not load Home', error);
          if (current()) setPosts((shown) => shown ?? []);
        });
      const drops = fetchMyDrops(userId)
        .catch(() => NO_DROPS)
        .then((loaded) => {
          if (current()) setMyDrops(loaded);
        });
      const guess = countUnguessed()
        .catch(() => 0)
        .then((count) => {
          if (current()) setToGuess(count);
        });
      const live = liveMaybeAvailable()
        ? fetchFriendsLiveNow()
            .catch(() => [] as FriendLive[])
            .then((loaded) => {
              if (current()) setLives(loaded);
            })
        : Promise.resolve();
      return Promise.all([stories, feed, drops, guess, live]).then(() => {});
    },
    [userId],
  );

  // Friends who are live: checked again every 30 seconds while Home is on screen, and when a "… is live"
  // notification comes in.
  const refreshLives = useCallback(() => {
    if (!liveMaybeAvailable()) return;
    fetchFriendsLiveNow()
      .then(setLives)
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!visible || !liveMaybeAvailable()) return;
    const timer = setInterval(refreshLives, 30_000);
    const stop = onNotificationArrived('live', refreshLives);
    return () => {
      clearInterval(timer);
      stop();
    };
  }, [visible, refreshLives]);

  // Your drop is still on its way (you just sent it from "Send to…"): Home waits for it before loading again – at
  // most 3 seconds – so its loading (posts, stories, pictures) doesn't slow your drop down on a weak signal. The
  // server stamps On time / Late when your drop is saved, so every second counts.
  const dropSending = useDropSending(userId);
  const [waitedFor, setWaitedFor] = useState<string | null>(null);
  useEffect(() => {
    if (!dropSending) return;
    const timer = setTimeout(() => setWaitedFor(dropSending), DROP_WAIT_MS);
    return () => clearTimeout(timer);
  }, [dropSending]);
  const waitingForDrop = !!dropSending && waitedFor !== dropSending;

  // Fresh stories and posts every time you come to this page – and again when your drop has just been saved (so
  // your own drop shows in the feed; your friends' drops already unlocked the moment it was saved).
  const dropPosts = useMyDropPosts();
  useEffect(() => {
    if (!visible || waitingForDrop) return;
    let cancelled = false;
    void loadAll(() => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [visible, waitingForDrop, loadAll, dropPosts]);

  // You just posted your drop: celebrate – every drop is unlocking (friends' and everyone's, old ones too).
  const hadKey = useRef<boolean | null>(null);
  useEffect(() => {
    if (!myDrops) return;
    if (hadKey.current === false && dropKey) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showToast('🔓 All drops unlocked!');
    }
    hadKey.current = dropKey;
  }, [myDrops, dropKey, showToast]);

  async function refresh() {
    setRefreshing(true);
    await loadAll(() => true);
    setRefreshing(false);
  }

  async function loadMore() {
    if (!posts || !next || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchDiscover(userId, next);
      setPosts([...posts, ...page.posts.filter((post) => !posts.some((p) => p.id === post.id))]);
      setNext(page.next);
    } catch (error) {
      console.warn('Could not load more posts', error);
    } finally {
      setLoadingMore(false);
    }
  }

  const updatePost = (id: string, change: (post: DiscoverPost) => DiscoverPost) =>
    setPosts((current) => current?.map((post) => (post.id === id ? change(post) : post)) ?? null);

  async function like(post: DiscoverPost, liked: boolean) {
    const flip = (p: DiscoverPost, on: boolean): DiscoverPost => ({
      ...p,
      likedByMe: on,
      likeCount: Math.max(0, p.likeCount + (on ? 1 : -1)),
    });
    updatePost(post.id, (p) => flip(p, liked)); // show it straight away
    try {
      await setLiked(userId, post.id, liked);
    } catch {
      updatePost(post.id, (p) => flip(p, !liked)); // undo if it didn't work
    }
  }

  function openMenu(post: DiscoverPost) {
    const author = post.author;
    if (post.user_id === userId) {
      showOptions({
        options: [
          { label: 'Open full screen', onPress: () => router.push(`/post/${post.id}`) },
          {
            label: 'Delete post',
            destructive: true,
            onPress: () =>
              Alert.alert('Delete this post?', 'It will be gone from your profile for good.', [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Delete',
                  style: 'destructive',
                  onPress: async () => {
                    try {
                      await deletePost(post);
                      setPosts((current) => current?.filter((p) => p.id !== post.id) ?? null);
                      showToast('Post deleted 🗑️');
                    } catch (error) {
                      Alert.alert('Could not delete', friendlyError(error));
                    }
                  },
                },
              ]),
          },
        ],
      });
    } else if (author) {
      showOptions({
        options: [
          { label: 'Open full screen', onPress: () => router.push(`/post/${post.id}`) },
          { label: 'Report post', onPress: () => report({ user: author, contentType: 'post', contentId: post.id }) },
          {
            label: `Block @${author.username}`,
            destructive: true,
            // Their posts disappear from your feed straight away.
            onPress: () =>
              confirmBlock(author, () => setPosts((current) => current?.filter((p) => p.user_id !== author.id) ?? null)),
          },
        ],
      });
    }
  }

  // Locked drops only get their tiny blurry preview; videos also need the video and its text/sticker layer.
  const media = (post: DiscoverPost) => postMedia(post, userId, myDrops);
  const urls = useMediaUrls(
    (posts ?? [])
      .flatMap((post) => {
        const files = media(post);
        return [files.still, files.video, files.overlay];
      })
      .filter((path): path is string => !!path),
  );

  // The video most in view plays; the others wait.
  const [inView, setInView] = useState<string | null>(null);
  // Every post that's on screen right now (for Who Peeked).
  const [onScreen, setOnScreen] = useState<string[]>([]);
  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ListViewToken[] }) => {
    const firstVideo = viewableItems.find((entry) => (entry.item as DiscoverPost | undefined)?.media_type === 'video');
    setInView((firstVideo?.item as DiscoverPost | undefined)?.id ?? null);
    setOnScreen(viewableItems.map((entry) => (entry.item as DiscoverPost).id));
  }, []);

  // Who Peeked: tell the database when a friend's drop is on your screen – and whether you can actually see
  // it (unlocked and not waiting to be scratched; scratching it clear is reported by the card itself).
  useEffect(() => {
    for (const post of posts ?? []) {
      if (!visible || post.drop_day === null || post.user_id === userId || !onScreen.includes(post.id)) continue;
      const { locked } = postMedia(post, userId, myDrops);
      noteDropSeen(post.id, !locked && (!scratchToReveal || post.media_type === 'video'));
    }
  }, [visible, onScreen, posts, myDrops, dropKey, scratchToReveal, userId]);

  const loading = posts === null || rings === null;
  // Nothing at all yet (no friends' stories, no posts): one friendly message instead of two empty sections.
  const nothingYet = !loading && rings.friends.length === 0 && posts.length === 0 && lives.length === 0;
  const invite = () => inviteFriends(profile?.username);

  return (
    <View style={styles.fill}>
      <PageHeader logo />
      <FlatList
        data={posts ?? []}
        keyExtractor={(post) => post.id}
        contentContainerStyle={[styles.content, { paddingBottom: tabSpace + space.lg }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accent} />}
        onEndReached={loadMore}
        onEndReachedThreshold={0.6}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
        ListHeaderComponent={
          loading || nothingYet ? undefined : (
            <View style={styles.top}>
              <StoryRow rings={rings} toGuess={toGuess} lives={lives} onCamera={onCamera} />
            </View>
          )
        }
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator color={colors.accent} style={styles.loading} />
          ) : nothingYet ? (
            <EmptyState
              emoji="👋"
              title="Welcome to Peekaboo!"
              message="Your friends' stories and posts will show up here. Take a photo to start, or invite some friends!">
              <Button title="Take a photo" icon="camera" onPress={onCamera} />
              <Button title="Invite friends" icon="paper-plane" variant="secondary" onPress={invite} />
            </EmptyState>
          ) : (
            <EmptyState emoji="🔭" title="No posts yet" message="Posts from your friends and everyone on Peekaboo land here.">
              <Button title="Take a photo" icon="camera" onPress={onCamera} />
            </EmptyState>
          )
        }
        ListFooterComponent={
          loadingMore ? (
            <ActivityIndicator color={colors.accent} />
          ) : posts && posts.length > 0 && !next ? (
            <Text style={styles.end}>You&apos;re all caught up 🌱</Text>
          ) : undefined
        }
        renderItem={({ item, index }) => (
          <>
            {/* A little divider where your friends' posts end and everyone else's begin. */}
            {item.fromEveryone && (index === 0 || !posts?.[index - 1]?.fromEveryone) ? (
              <Text style={styles.divider}>✨ More from everyone on Peekaboo</Text>
            ) : null}
            <FeedCard
              post={item}
              url={urls[media(item).still ?? '']}
              videoUrl={urls[media(item).video ?? '']}
              overlayUrl={urls[media(item).overlay ?? '']}
              active={visible && inView === item.id}
              lock={media(item).lock}
              // Other people's drops start blurred – hold and scratch to reveal (unless turned off in Settings).
              scratch={scratchToReveal && item.drop_day !== null && item.user_id !== userId}
              onLike={(liked) => like(item, liked)}
              onMenu={() => openMenu(item)}
              onRevealed={() => noteDropSeen(item.id, true)}
              // Only friends rate dares (🔥 😬 💀) – not your own.
              canVote={item.user_id !== userId && !item.fromEveryone}
              canDareBack={item.user_id !== userId && !item.fromEveryone}
            />
          </>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // See-through on a Peekaboo+ theme with a moving picture behind (theme.ts pageBackground).
  fill: {
    flex: 1,
    backgroundColor: pageBackground,
  },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    flexGrow: 1,
  },
  top: {
    gap: space.lg,
    marginBottom: space.lg,
  },
  loading: {
    marginTop: space.xl,
  },
  divider: {
    ...font.label,
    textTransform: 'uppercase',
    textAlign: 'center',
    marginBottom: space.lg,
  },
  end: {
    ...font.small,
    textAlign: 'center',
    marginVertical: space.lg,
  },
});
