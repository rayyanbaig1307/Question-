import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, RefreshControl, StyleSheet, Text, View, type ListViewToken } from 'react-native';

import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { FeedCard } from '@/components/FeedCard';
import { useOverlays } from '@/components/Overlays';
import { useMe } from '@/lib/auth';
import { fetchMyDropDays, localDay, postMedia } from '@/lib/drop';
import { friendlyError } from '@/lib/errors';
import { fetchDiscover, setLiked, type DiscoverCursor, type DiscoverPost } from '@/lib/feed';
import { fetchGroups, type PeekGroup } from '@/lib/groups';
import { countUnguessed } from '@/lib/guess';
import { inviteFriends } from '@/lib/invite';
import { noteDropSeen } from '@/lib/peeks';
import { useMediaUrls } from '@/lib/media';
import { deletePost } from '@/lib/posts';
import { useScratchToReveal } from '@/lib/preferences';
import { fetchStoryRings } from '@/lib/stories';
import { useSafetyActions } from '@/lib/useSafetyActions';
import { colors, font, space } from '@/theme';
import { HomeStrip } from './HomeStrip';
import { useTabBarSpace } from './HomeTabBar';
import { PageHeader } from './PageHeader';
import { StoryRow, type Rings } from './StoryRow';

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
  // The days you've posted a drop for – friends' drops from those days are unlocked ("peek to see").
  const [myDropDays, setMyDropDays] = useState<Set<string> | null>(null);
  // Your Group Peek groups and how many Guess Who posts you can still guess, shown as a row under the stories.
  const [groups, setGroups] = useState<PeekGroup[] | null>(null);
  const [toGuess, setToGuess] = useState<number | null>(null);

  const show = useCallback(
    (loaded: {
      rings: Rings;
      page: { posts: DiscoverPost[]; next: DiscoverCursor | null };
      days: Set<string>;
      groups: PeekGroup[] | null;
      toGuess: number | null;
    }) => {
      setRings(loaded.rings);
      setPosts(loaded.page.posts);
      setNext(loaded.page.next);
      setMyDropDays(loaded.days);
      setGroups(loaded.groups);
      setToGuess(loaded.toGuess);
    },
    [],
  );

  const loadAll = useCallback(async () => {
    const [rings, page, days, groups, toGuess] = await Promise.all([
      fetchStoryRings(userId).catch((error) => {
        console.warn('Could not load stories', error);
        return { mine: null, friends: [] } as Rings;
      }),
      fetchDiscover(userId),
      fetchMyDropDays(userId).catch(() => new Set<string>()),
      fetchGroups().catch(() => null),
      countUnguessed().catch(() => null),
    ]);
    return { rings, page, days, groups, toGuess };
  }, [userId]);

  // Fresh stories and posts every time you come to this page.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    loadAll()
      .then((loaded) => !cancelled && show(loaded))
      .catch((error) => {
        console.warn('Could not load Home', error);
        if (!cancelled) {
          setPosts((current) => current ?? []);
          setRings((current) => current ?? { mine: null, friends: [] });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [visible, loadAll, show]);

  // You just posted today's drop: celebrate – your friends' drops are unlocking.
  const hadToday = useRef<boolean | null>(null);
  useEffect(() => {
    if (!myDropDays) return;
    const hasToday = myDropDays.has(localDay());
    if (hadToday.current === false && hasToday) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showToast("🔓 Today's drops unlocked!");
    }
    hadToday.current = hasToday;
  }, [myDropDays, showToast]);

  async function refresh() {
    setRefreshing(true);
    try {
      show(await loadAll());
    } catch (error) {
      console.warn('Could not refresh Home', error);
    }
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
  const media = (post: DiscoverPost) => postMedia(post, userId, myDropDays);
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
      const { locked } = postMedia(post, userId, myDropDays);
      noteDropSeen(post.id, !locked && (!scratchToReveal || post.media_type === 'video'));
    }
  }, [visible, onScreen, posts, myDropDays, scratchToReveal, userId]);

  const loading = posts === null || rings === null;
  // Nothing at all yet (no friends' stories, no posts): one friendly message instead of two empty sections.
  const nothingYet = !loading && rings.friends.length === 0 && posts.length === 0;
  const invite = () => inviteFriends(profile?.username);

  return (
    <View style={styles.fill}>
      <PageHeader title="Peekaboo" onCamera={onCamera} />
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
              <StoryRow rings={rings} onCamera={onCamera} />
              <HomeStrip groups={groups} toGuess={toGuess} />
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
            />
          </>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.bg,
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
