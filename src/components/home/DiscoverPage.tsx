import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { FeedCard } from '@/components/FeedCard';
import { useOverlays } from '@/components/Overlays';
import { useMe } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { fetchDiscover, setLiked, type DiscoverCursor, type DiscoverPost } from '@/lib/feed';
import { inviteFriends } from '@/lib/invite';
import { useMediaUrls } from '@/lib/media';
import { deletePost } from '@/lib/posts';
import { useSafetyActions } from '@/lib/useSafetyActions';
import { colors, font, space } from '@/theme';
import { useTabBarSpace } from './HomeTabBar';
import { PageHeader } from './PageHeader';

// Discover: the photo feed. Your friends' posts (and yours) first, then everyone else's public posts.
export function DiscoverPage({ visible, onCamera }: { visible: boolean; onCamera: () => void }) {
  const { userId, profile } = useMe();
  const { showOptions, showToast } = useOverlays();
  const { report, confirmBlock } = useSafetyActions();
  const tabSpace = useTabBarSpace();
  const [posts, setPosts] = useState<DiscoverPost[] | null>(null);
  const [next, setNext] = useState<DiscoverCursor | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const show = useCallback((page: { posts: DiscoverPost[]; next: DiscoverCursor | null }) => {
    setPosts(page.posts);
    setNext(page.next);
  }, []);

  // Fresh posts every time you come to this page.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    fetchDiscover(userId)
      .then((page) => !cancelled && show(page))
      .catch((error) => {
        console.warn('Could not load Discover', error);
        if (!cancelled) setPosts((current) => current ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, userId, show]);

  async function refresh() {
    setRefreshing(true);
    try {
      show(await fetchDiscover(userId));
    } catch (error) {
      console.warn('Could not refresh Discover', error);
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

  const urls = useMediaUrls((posts ?? []).map((post) => post.media_path));

  return (
    <View style={styles.fill}>
      <PageHeader title="Discover" cameraSide="left" onCamera={onCamera} />
      <FlatList
        data={posts ?? []}
        keyExtractor={(post) => post.id}
        contentContainerStyle={[styles.content, { paddingBottom: tabSpace + space.lg }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accent} />}
        onEndReached={loadMore}
        onEndReachedThreshold={0.6}
        ListEmptyComponent={
          posts === null ? (
            <ActivityIndicator color={colors.accent} style={styles.loading} />
          ) : (
            <EmptyState
              emoji="🔭"
              title="Nothing to scroll… yet"
              message="Posts from your friends and everyone on Peekaboo land here. Post something or invite friends!">
              <Button title="Take a photo" icon="camera" onPress={onCamera} />
              <Button
                title="Invite friends"
                icon="paper-plane"
                variant="secondary"
                onPress={() => inviteFriends(profile?.username)}
              />
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
              url={urls[item.media_path]}
              onLike={(liked) => like(item, liked)}
              onMenu={() => openMenu(item)}
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
