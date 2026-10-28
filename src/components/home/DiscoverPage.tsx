import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Share, StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import { Bouncy, usePop } from '@/components/Bouncy';
import { Button } from '@/components/Button';
import { DareTag } from '@/components/DareBanner';
import { EmptyState } from '@/components/EmptyState';
import { useOverlays } from '@/components/Overlays';
import { useMe } from '@/lib/auth';
import { DISCOVER_PAGE_SIZE, fetchDiscover, setLiked, type FeedPost } from '@/lib/feed';
import { inviteFriends, withAppLink } from '@/lib/invite';
import { useMediaUrls } from '@/lib/media';
import { timeAgo } from '@/lib/time';
import { useSafetyActions } from '@/lib/useSafetyActions';
import { colors, font, space } from '@/theme';
import { useTabBarSpace } from './HomeTabBar';

// Discover: one photo per screen from everyone on Peekaboo. Swipe up for the next one… forever.
export function DiscoverPage({ visible, onCamera }: { visible: boolean; onCamera: () => void }) {
  const { userId, profile } = useMe();
  const { showOptions } = useOverlays();
  const { report, confirmBlock } = useSafetyActions();
  const insets = useSafeAreaInsets();
  const tabSpace = useTabBarSpace();
  const [posts, setPosts] = useState<FeedPost[] | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Every photo fills the whole page, so we need to know how tall the page is.
  const [height, setHeight] = useState(0);
  const [index, setIndex] = useState(0);
  const list = useRef<FlatList<FeedPost>>(null);

  const show = useCallback((loaded: FeedPost[]) => {
    setPosts(loaded);
    setHasMore(loaded.length === DISCOVER_PAGE_SIZE);
    setIndex(0);
  }, []);

  // Load the first time you swipe here.
  const firstLoad = visible && posts === null;
  useEffect(() => {
    if (!firstLoad) return;
    fetchDiscover(userId)
      .then(show)
      .catch((error) => {
        console.warn('Could not load Discover', error);
        setPosts([]);
      });
  }, [firstLoad, userId, show]);

  async function refresh() {
    setRefreshing(true);
    try {
      show(await fetchDiscover(userId));
      list.current?.scrollToOffset({ offset: 0, animated: false });
    } catch (error) {
      console.warn('Could not refresh Discover', error);
    }
    setRefreshing(false);
  }

  async function loadMore() {
    if (!posts || !hasMore || loadingMore || posts.length === 0) return;
    setLoadingMore(true);
    try {
      const older = await fetchDiscover(userId, posts[posts.length - 1].created_at);
      setPosts([...posts, ...older.filter((post) => !posts.some((p) => p.id === post.id))]);
      setHasMore(older.length === DISCOVER_PAGE_SIZE);
    } catch (error) {
      console.warn('Could not load more Discover posts', error);
    } finally {
      setLoadingMore(false);
    }
  }

  const updatePost = (id: string, change: (post: FeedPost) => FeedPost) =>
    setPosts((current) => current?.map((post) => (post.id === id ? change(post) : post)) ?? null);

  async function like(post: FeedPost, liked: boolean) {
    const flip = (p: FeedPost, on: boolean): FeedPost => ({
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

  function share(post: FeedPost) {
    const who = post.author ? `@${post.author.username}` : 'this';
    Share.share({ message: withAppLink(`Look what ${who} posted on Peekaboo 👀`) }).catch(() => {});
  }

  function openMenu(post: FeedPost) {
    const author = post.author;
    if (!author) return;
    showOptions({
      options: [
        { label: `View @${author.username}'s profile`, onPress: () => router.push(`/profile/${author.id}`) },
        { label: 'Report post', onPress: () => report({ user: author, contentType: 'post', contentId: post.id }) },
        {
          label: `Block @${author.username}`,
          destructive: true,
          // Their posts disappear from your Discover straight away.
          onPress: () =>
            confirmBlock(author, () =>
              setPosts((current) => current?.filter((p) => p.user_id !== author.id) ?? null),
            ),
        },
      ],
    });
  }

  const urls = useMediaUrls((posts ?? []).map((post) => post.media_path));

  // Quietly download the next two photos so they're ready before you swipe.
  useEffect(() => {
    const next = (posts ?? [])
      .slice(index + 1, index + 3)
      .map((post) => urls[post.media_path])
      .filter((url): url is string => !!url);
    if (next.length > 0) Image.prefetch(next).catch(() => {});
  }, [index, posts, urls]);

  return (
    <View style={styles.fill} onLayout={(event) => setHeight(event.nativeEvent.layout.height)}>
      {posts === null || height === 0 ? (
        <ActivityIndicator color={colors.accent} style={styles.loading} />
      ) : posts.length === 0 ? (
        <View style={[styles.fill, styles.center, { paddingBottom: tabSpace }]}>
          <EmptyState
            emoji="🔭"
            title="Nothing to scroll… yet"
            message="Posts from everyone on Peekaboo land here. Post something or invite friends to get it going!">
            <Button title="Take a photo" icon="camera" onPress={onCamera} />
            <Button title="Invite friends" icon="paper-plane" variant="secondary" onPress={() => inviteFriends(profile?.username)} />
          </EmptyState>
        </View>
      ) : (
        <FlatList
          ref={list}
          data={posts}
          keyExtractor={(post) => post.id}
          pagingEnabled
          showsVerticalScrollIndicator={false}
          decelerationRate="fast"
          getItemLayout={(_, i) => ({ length: height, offset: height * i, index: i })}
          initialNumToRender={2}
          maxToRenderPerBatch={3}
          windowSize={5}
          onMomentumScrollEnd={(event) => setIndex(Math.round(event.nativeEvent.contentOffset.y / height))}
          onEndReached={loadMore}
          onEndReachedThreshold={2}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.white} />}
          ListFooterComponent={
            hasMore ? undefined : (
              <View style={[styles.end, { height, paddingBottom: tabSpace }]}>
                <EmptyState
                  emoji="🌱"
                  title="You've seen it all!"
                  message="Go touch some grass… or take a pic of it and post it here.">
                  <Button title="Take a photo" icon="camera" onPress={onCamera} />
                </EmptyState>
              </View>
            )
          }
          renderItem={({ item }) => (
            <DiscoverCard
              post={item}
              url={urls[item.media_path]}
              height={height}
              bottomSpace={tabSpace}
              onLike={(liked) => like(item, liked)}
              onShare={() => share(item)}
              onMenu={() => openMenu(item)}
            />
          )}
        />
      )}

      {/* Title in the top corner */}
      <LinearGradient
        colors={['rgba(0,0,0,0.55)', 'transparent']}
        style={[styles.top, { paddingTop: insets.top + space.sm }]}
        pointerEvents="none">
        <Text style={styles.title}>Discover 🔥</Text>
        {loadingMore ? <ActivityIndicator color={colors.white} size="small" /> : null}
      </LinearGradient>
    </View>
  );
}

// One full-screen photo with the person, caption and buttons on top. Double-tap to like.
function DiscoverCard({ post, url, height, bottomSpace, onLike, onShare, onMenu }: {
  post: FeedPost;
  url: string | undefined;
  height: number;
  bottomSpace: number;
  onLike: (like: boolean) => void;
  onShare: () => void;
  onMenu: () => void;
}) {
  const lastTap = useRef(0);
  const heart = useSharedValue(0);
  const likeButton = usePop();
  const author = post.author;
  const name = author ? author.display_name || author.username : 'Someone';

  function likeIt() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    likeButton.pop();
    onLike(true);
  }

  function tapPhoto() {
    const now = Date.now();
    if (now - lastTap.current < 300) {
      // Double tap → a big heart pops up and the post is liked.
      lastTap.current = 0;
      heart.set(withSequence(withSpring(1, { damping: 8 }), withDelay(500, withTiming(0, { duration: 200 }))));
      if (post.likedByMe) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      else likeIt();
    } else {
      lastTap.current = now;
    }
  }

  const heartStyle = useAnimatedStyle(() => ({
    opacity: heart.get() > 0.05 ? 1 : 0,
    transform: [{ scale: heart.get() }],
  }));

  return (
    <Pressable onPress={tapPhoto} style={[styles.card, { height }]}>
      {url ? (
        <Image
          source={{ uri: url, cacheKey: post.media_path }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={150}
          recyclingKey={post.id}
        />
      ) : (
        <ActivityIndicator color={colors.white} style={StyleSheet.absoluteFill} />
      )}

      <LinearGradient colors={['transparent', 'rgba(0,0,0,0.8)']} style={styles.shade} pointerEvents="none" />

      <Animated.View style={[styles.bigHeart, heartStyle]} pointerEvents="none">
        <Ionicons name="heart" size={120} color={colors.pink} />
      </Animated.View>

      {/* Bottom left: who posted it, the dare (if any) and the caption */}
      <View style={[styles.info, { bottom: bottomSpace + space.md }]}>
        <Pressable
          style={styles.author}
          onPress={() => author && router.push(`/profile/${author.id}`)}
          accessibilityLabel={`Open ${name}'s profile`}>
          <Avatar path={author?.avatar_path} name={name} size={40} ring />
          <View style={styles.authorText}>
            <Text style={styles.name} numberOfLines={1}>
              {name}
            </Text>
            <Text style={styles.meta} numberOfLines={1}>
              @{author?.username ?? 'someone'} · {timeAgo(post.created_at)}
            </Text>
          </View>
        </Pressable>
        {post.dare_day ? <DareTag day={post.dare_day} /> : null}
        {post.caption ? (
          <Text style={styles.caption} numberOfLines={3}>
            {post.caption}
          </Text>
        ) : null}
      </View>

      {/* Right side: like, comments, share, more */}
      <View style={[styles.actions, { bottom: bottomSpace + space.md }]}>
        <Bouncy
          style={styles.action}
          pressScale={0.8}
          onPress={() => {
            if (post.likedByMe) {
              Haptics.selectionAsync();
              onLike(false);
            } else {
              likeIt();
            }
          }}
          accessibilityLabel={post.likedByMe ? 'Unlike' : 'Like'}>
          <Animated.View style={likeButton.style}>
            <Ionicons
              name={post.likedByMe ? 'heart' : 'heart-outline'}
              size={34}
              color={post.likedByMe ? colors.pink : colors.white}
            />
          </Animated.View>
          <Text style={styles.count}>{post.likeCount}</Text>
        </Bouncy>
        <Bouncy
          style={styles.action}
          pressScale={0.8}
          onPress={() => router.push(`/comments/${post.id}`)}
          accessibilityLabel="Comments">
          <Ionicons name="chatbubble-ellipses" size={32} color={colors.white} />
          <Text style={styles.count}>{post.commentCount}</Text>
        </Bouncy>
        <Bouncy style={styles.action} pressScale={0.8} onPress={onShare} accessibilityLabel="Share">
          <Ionicons name="paper-plane" size={30} color={colors.white} />
          <Text style={styles.count}>Share</Text>
        </Bouncy>
        <Bouncy style={styles.action} pressScale={0.8} onPress={onMenu} accessibilityLabel="More">
          <Ionicons name="ellipsis-horizontal" size={28} color={colors.white} />
        </Bouncy>
      </View>
    </Pressable>
  );
}

const shadow = {
  textShadowColor: 'rgba(0,0,0,0.6)',
  textShadowRadius: 6,
} as const;

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.black,
  },
  center: {
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
  loading: {
    flex: 1,
  },
  top: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingBottom: space.xl,
  },
  title: {
    ...font.heading,
    fontSize: 22,
    color: colors.white,
    ...shadow,
  },
  card: {
    backgroundColor: colors.black,
    overflow: 'hidden',
  },
  shade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '45%',
  },
  bigHeart: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  info: {
    position: 'absolute',
    left: space.lg,
    right: 88,
    gap: space.sm,
  },
  author: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  authorText: {
    flexShrink: 1,
  },
  name: {
    color: colors.white,
    fontSize: 16,
    fontWeight: '900',
    ...shadow,
  },
  meta: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 13,
    fontWeight: '600',
    ...shadow,
  },
  caption: {
    color: colors.white,
    fontSize: 15,
    lineHeight: 21,
    ...shadow,
  },
  actions: {
    position: 'absolute',
    right: space.md,
    alignItems: 'center',
    gap: space.lg,
  },
  action: {
    alignItems: 'center',
    gap: 2,
    minWidth: 56,
  },
  count: {
    color: colors.white,
    fontSize: 13,
    fontWeight: '800',
    ...shadow,
  },
  end: {
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
});
