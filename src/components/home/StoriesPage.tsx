import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { FeedCard } from '@/components/FeedCard';
import { IconButton } from '@/components/IconButton';
import { useOverlays } from '@/components/Overlays';
import { useMe } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { FEED_PAGE_SIZE, fetchFeed, setLiked, type FeedPost } from '@/lib/feed';
import { useMediaUrl, useMediaUrls } from '@/lib/media';
import { deletePost } from '@/lib/posts';
import { inviteFriends } from '@/lib/invite';
import { fetchStoryRings, type StoryRing } from '@/lib/stories';
import { timeAgo, timeLeft } from '@/lib/time';
import { useSafetyActions } from '@/lib/useSafetyActions';
import { colors, font, gradients, radius, space } from '@/theme';
import { PageHeader } from './PageHeader';

type Rings = { mine: StoryRing | null; friends: StoryRing[] };

// Right page: stories at the top, then the feed of your friends' posts.
export function StoriesPage({ visible, onCamera }: { visible: boolean; onCamera: () => void }) {
  const { userId, profile } = useMe();
  const { showOptions, showToast } = useOverlays();
  const { report } = useSafetyActions();
  const [rings, setRings] = useState<Rings | null>(null);
  const [posts, setPosts] = useState<FeedPost[] | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const show = useCallback((loaded: Rings & { feed: FeedPost[] }) => {
    setRings({ mine: loaded.mine, friends: loaded.friends });
    setPosts(loaded.feed);
    setHasMore(loaded.feed.length === FEED_PAGE_SIZE);
  }, []);

  const showError = useCallback((error: unknown) => {
    console.warn('Could not load stories and feed', error);
    setRings((current) => current ?? { mine: null, friends: [] });
    setPosts((current) => current ?? []);
  }, []);

  // Refresh whenever you swipe to this page (or come back from watching stories).
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    loadStoriesAndFeed(userId)
      .then((loaded) => !cancelled && show(loaded))
      .catch((error) => !cancelled && showError(error));
    return () => {
      cancelled = true;
    };
  }, [visible, userId, show, showError]);

  async function refresh() {
    setRefreshing(true);
    try {
      show(await loadStoriesAndFeed(userId));
    } catch (error) {
      showError(error);
    }
    setRefreshing(false);
  }

  async function loadMore() {
    if (!posts || !hasMore || loadingMore || posts.length === 0) return;
    setLoadingMore(true);
    try {
      const older = await fetchFeed(userId, posts[posts.length - 1].created_at);
      setPosts([...posts, ...older.filter((post) => !posts.some((p) => p.id === post.id))]);
      setHasMore(older.length === FEED_PAGE_SIZE);
    } catch (error) {
      console.warn('Could not load more posts', error);
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

  function openMenu(post: FeedPost) {
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
    } else if (post.author) {
      const author = post.author;
      showOptions({
        options: [
          { label: 'Open full screen', onPress: () => router.push(`/post/${post.id}`) },
          { label: 'Report post', onPress: () => report({ user: author, contentType: 'post', contentId: post.id }) },
        ],
      });
    }
  }

  const urls = useMediaUrls((posts ?? []).map((post) => post.media_path));

  return (
    <View style={styles.fill}>
      <PageHeader title="Stories" cameraSide="left" onCamera={onCamera} />
      <FlatList
        data={posts ?? []}
        keyExtractor={(post) => post.id}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accent} />}
        onEndReached={loadMore}
        onEndReachedThreshold={0.6}
        ListHeaderComponent={<StoriesHeader rings={rings} userId={userId} onCamera={onCamera} />}
        ListEmptyComponent={
          posts === null ? (
            <ActivityIndicator color={colors.accent} style={styles.loading} />
          ) : (
            <EmptyState
              emoji="🦗"
              title="Crickets…"
              message="Nobody has posted yet. Be the legend who goes first, or invite friends to liven things up!">
              <Button title="Take a photo" icon="camera" onPress={onCamera} />
              <Button title="Invite friends" icon="paper-plane" variant="secondary" onPress={() => inviteFriends(profile?.username)} />
            </EmptyState>
          )
        }
        ListFooterComponent={loadingMore ? <ActivityIndicator color={colors.accent} /> : undefined}
        renderItem={({ item }) => (
          <FeedCard
            post={item}
            url={urls[item.media_path]}
            onLike={(liked) => like(item, liked)}
            onMenu={() => openMenu(item)}
          />
        )}
      />
    </View>
  );
}

async function loadStoriesAndFeed(userId: string): Promise<Rings & { feed: FeedPost[] }> {
  const [rings, feed] = await Promise.all([fetchStoryRings(userId), fetchFeed(userId)]);
  return { ...rings, feed };
}

// My Story + friends' story circles, shown above the feed.
function StoriesHeader({ rings, userId, onCamera }: { rings: Rings | null; userId: string; onCamera: () => void }) {
  const mine = rings?.mine ?? null;
  const latest = mine?.stories[mine.stories.length - 1];
  const thumbnail = useMediaUrl(latest?.media_path);
  const friends = rings?.friends ?? [];
  const { profile } = useMe();

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
    <View style={styles.header}>
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
              ? `${mine.stories.length} ${mine.stories.length === 1 ? 'photo' : 'photos'} · ${timeLeft(mine.stories[0].expires_at)}`
              : 'Tap to add a photo to your story'}
          </Text>
        </View>
        {mine ? <IconButton icon="add" label="Add to story" background={colors.surface} onPress={onCamera} /> : null}
      </Pressable>

      <Text style={styles.sectionTitle}>Friends&apos; stories</Text>
      {rings === null ? null : friends.length === 0 ? (
        <View style={styles.noStoriesRow}>
          <InviteBubble onPress={() => inviteFriends(profile?.username)} />
          <Text style={styles.noStories}>No new stories right now. 🌙{'\n'}Invite friends so there&apos;s more to watch!</Text>
        </View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rings}>
          {friends.map((ring, index) => (
            <Pressable key={ring.author.id} style={styles.friend} onPress={() => openFriend(index)}>
              <LinearGradient colors={ring.allSeen ? [colors.border, colors.border] : gradients.brand} style={styles.ring}>
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
          <InviteBubble onPress={() => inviteFriends(profile?.username)} />
        </ScrollView>
      )}

      <Text style={styles.sectionTitle}>Feed</Text>
    </View>
  );
}

// A dashed circle with a "+" that opens the share sheet to invite friends.
function InviteBubble({ onPress }: { onPress: () => void }) {
  return (
    <Pressable style={styles.friend} onPress={onPress} accessibilityRole="button" accessibilityLabel="Invite friends">
      <View style={[styles.ring, styles.inviteRing]}>
        <Text style={styles.plus}>＋</Text>
      </View>
      <Text style={styles.friendName}>Invite</Text>
      <Text style={styles.friendTime}>friends</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    paddingHorizontal: space.lg,
    paddingBottom: space.xxl,
  },
  loading: {
    marginTop: space.xl,
  },
  header: {
    gap: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.lg,
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
    color: colors.accent,
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
  noStoriesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  noStories: {
    ...font.small,
    flex: 1,
    lineHeight: 19,
  },
  inviteRing: {
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.accent,
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
