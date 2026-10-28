import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { Avatar } from '@/components/Avatar';
import { Bouncy, usePop } from '@/components/Bouncy';
import { DareTag } from '@/components/DareBanner';
import { DropBadge } from '@/components/DropPill';
import { EmptyState } from '@/components/EmptyState';
import { IconButton } from '@/components/IconButton';
import { useOverlays } from '@/components/Overlays';
import { SafeEdge } from '@/components/SafeEdge';
import { useMe } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { fetchPostStats, setLiked, type PostStats } from '@/lib/feed';
import { useMediaUrl } from '@/lib/media';
import { deletePost, fetchPost } from '@/lib/posts';
import { timeAgo } from '@/lib/time';
import type { PostWithAuthor } from '@/lib/types';
import { useSafetyActions } from '@/lib/useSafetyActions';
import { colors, font, space } from '@/theme';

// One photo, full screen.
export default function PostViewer() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId } = useMe();
  const { showOptions, showToast } = useOverlays();
  const { report } = useSafetyActions();
  const [post, setPost] = useState<PostWithAuthor | null | undefined>(undefined);
  const [stats, setStats] = useState<PostStats | null>(null);
  const uri = useMediaUrl(post?.media_path);
  const likeButton = usePop();

  useEffect(() => {
    fetchPost(id)
      .then(setPost)
      .catch(() => setPost(null));
  }, [id]);

  // Likes and comment count – refreshed when you come back from the comments.
  useFocusEffect(
    useCallback(() => {
      fetchPostStats(userId, id)
        .then(setStats)
        .catch(() => {});
    }, [id, userId]),
  );

  async function toggleLike() {
    if (!stats) return;
    const liked = !stats.likedByMe;
    const before = stats;
    if (liked) {
      // A little buzz and a heart pop when you like something.
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      likeButton.pop();
    } else {
      Haptics.selectionAsync();
    }
    setStats({ ...stats, likedByMe: liked, likeCount: Math.max(0, stats.likeCount + (liked ? 1 : -1)) });
    try {
      await setLiked(userId, id, liked);
    } catch {
      setStats(before);
    }
  }

  const isMine = post?.user_id === userId;
  const author = post?.author;

  function openMenu() {
    if (!post || !author) return;
    if (isMine) {
      showOptions({
        options: [
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
                      showToast('Post deleted 🗑️');
                      router.back();
                    } catch (error) {
                      Alert.alert('Could not delete', friendlyError(error));
                    }
                  },
                },
              ]),
          },
        ],
      });
    } else {
      showOptions({
        options: [
          {
            label: 'Report post',
            onPress: () => report({ user: author, contentType: 'post', contentId: post.id }),
          },
        ],
      });
    }
  }

  return (
    <View style={styles.fill}>
      {post === undefined ? (
        <ActivityIndicator style={styles.fill} color={colors.accent} size="large" />
      ) : post === null ? (
        <View style={[styles.fill, styles.center]}>
          <EmptyState emoji="💨" title="This post is gone" message="It was deleted, or you can't see it anymore." />
        </View>
      ) : uri ? (
        <Image source={{ uri, cacheKey: post.media_path }} style={styles.fill} contentFit="contain" transition={200} />
      ) : (
        <ActivityIndicator style={styles.fill} color={colors.accent} size="large" />
      )}

      <SafeEdge edge="top" style={styles.top}>
        <LinearGradient colors={['rgba(0,0,0,0.6)', 'transparent']} style={StyleSheet.absoluteFill} />
        <IconButton icon="close" label="Close" onPress={() => router.back()} />
        {author ? (
          <Pressable style={styles.author} onPress={() => router.push(`/profile/${author.id}`)}>
            <Avatar path={author.avatar_path} name={author.display_name || author.username} size={36} />
            <View>
              <Text style={styles.authorName}>{author.display_name || author.username}</Text>
              <Text style={styles.authorMeta}>
                @{author.username} · {post ? timeAgo(post.created_at) : ''}
              </Text>
              {post?.drop_day && post.drop_late_seconds !== null ? (
                <DropBadge lateSeconds={post.drop_late_seconds} />
              ) : null}
            </View>
          </Pressable>
        ) : (
          <View style={styles.author} />
        )}
        {post ? <IconButton icon="ellipsis-horizontal" label="More" onPress={openMenu} /> : null}
      </SafeEdge>

      {post ? (
        <SafeEdge edge="bottom" style={styles.bottom}>
          <LinearGradient colors={['transparent', 'rgba(0,0,0,0.75)']} style={StyleSheet.absoluteFill} />
          {post.dare_day ? (
            <View style={styles.dareTag}>
              <DareTag day={post.dare_day} />
            </View>
          ) : null}
          {post.caption ? <Text style={styles.caption}>{post.caption}</Text> : null}
          {stats ? (
            <View style={styles.actions}>
              <Bouncy
                style={styles.action}
                pressScale={0.85}
                onPress={toggleLike}
                accessibilityLabel={stats.likedByMe ? 'Unlike' : 'Like'}>
                <Animated.View style={likeButton.style}>
                  <Ionicons
                    name={stats.likedByMe ? 'heart' : 'heart-outline'}
                    size={28}
                    color={stats.likedByMe ? colors.pink : colors.white}
                  />
                </Animated.View>
                <Text style={styles.count}>{stats.likeCount}</Text>
              </Bouncy>
              <Pressable style={styles.action} onPress={() => router.push(`/comments/${post.id}`)} accessibilityLabel="Comments">
                <Ionicons name="chatbubble-outline" size={26} color={colors.white} />
                <Text style={styles.count}>{stats.commentCount}</Text>
              </Pressable>
            </View>
          ) : null}
        </SafeEdge>
      ) : null}
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
  top: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingBottom: space.xl,
  },
  author: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  authorName: {
    ...font.body,
    fontWeight: '800',
  },
  authorMeta: {
    ...font.small,
    color: 'rgba(255,255,255,0.8)',
  },
  bottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: space.xl,
    paddingTop: space.xxl,
    paddingBottom: space.lg,
  },
  actions: {
    flexDirection: 'row',
    gap: space.xl,
    marginBottom: space.md,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  count: {
    ...font.body,
    fontWeight: '800',
  },
  dareTag: {
    marginBottom: space.md,
  },
  caption: {
    ...font.body,
    fontSize: 17,
    lineHeight: 24,
    marginBottom: space.md,
  },
});
