import { Image } from 'expo-image';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { StatusBar } from 'expo-status-bar';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { VideoClip } from '@/components/VideoClipSafe';
import { Bouncy, usePop } from '@/components/Bouncy';
import { DareTag, ForfeitTag } from '@/components/DareBanner';
import { LegitOrCap } from '@/components/LegitOrCap';
import { DropBadge } from '@/components/DropPill';
import { EmptyState } from '@/components/EmptyState';
import { IconButton } from '@/components/IconButton';
import { useOverlays } from '@/components/Overlays';
import { SafeEdge } from '@/components/SafeEdge';
import { useMe } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { fetchPostStats, setLiked, type PostStats } from '@/lib/feed';
import { fetchRelation } from '@/lib/friends';
import { postMedia, useMyDropDays } from '@/lib/drop';
import { useMediaUrls } from '@/lib/media';
import { noteDropSeen } from '@/lib/peeks';
import { deletePost, fetchPost } from '@/lib/posts';
import { timeAgo } from '@/lib/time';
import type { PostWithAuthor } from '@/lib/types';
import { useSafetyActions } from '@/lib/useSafetyActions';
import { colors, font, space } from '@/theme';

// One post: the photo or video, with the likes, comments and caption in a panel underneath.
export default function PostViewer() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId } = useMe();
  const { showOptions, showToast } = useOverlays();
  const { report } = useSafetyActions();
  const [post, setPost] = useState<PostWithAuthor | null | undefined>(undefined);
  const [stats, setStats] = useState<PostStats | null>(null);
  // A friend's drop stays blurry until you've posted your own drop that day ("peek to see").
  const myDropDays = useMyDropDays(userId, post);
  const files = post ? postMedia(post, userId, myDropDays) : null;
  const locked = files?.locked ?? false;
  const urls = useMediaUrls([files?.still, files?.video, files?.overlay].filter((path): path is string => !!path));
  const uri = files?.still ? urls[files.still] : undefined;
  const videoUri = files?.video ? urls[files.video] : undefined;
  const likeButton = usePop();
  // Long captions show 3 lines; tap to see it all.
  const [captionOpen, setCaptionOpen] = useState(false);

  // Who Peeked: opening a friend's drop full screen counts as seeing it (if it's unlocked for you).
  const friendsDrop = !!post && post.drop_day !== null && post.user_id !== userId;
  useEffect(() => {
    if (friendsDrop && myDropDays !== null) noteDropSeen(id, !locked);
  }, [friendsDrop, myDropDays, locked, id]);

  // Loaded again when you come back to it (e.g. after editing the caption).
  useFocusEffect(
    useCallback(() => {
      fetchPost(id)
        .then(setPost)
        .catch(() => setPost(null));
    }, [id]),
  );

  // "Legit or cap?": only the poster's friends can vote on a dare.
  const [isFriend, setIsFriend] = useState(false);
  const posterId = post?.user_id ?? null;
  const hasVerdict = !!post?.dare_verdict;
  useEffect(() => {
    if (!posterId || posterId === userId || !hasVerdict) return;
    fetchRelation(userId, posterId)
      .then((relation) => setIsFriend(relation.kind === 'friends'))
      .catch(() => {});
  }, [posterId, userId, hasVerdict]);

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
            label: 'Edit caption',
            onPress: () => router.push({ pathname: '/post-compose', params: { post: post.id } }),
          },
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

  const authorName = author ? author.display_name || author.username : '';

  return (
    <View style={styles.fill}>
      <StatusBar style="light" />

      {/* Top bar: close, who posted it, and ••• */}
      <SafeEdge edge="top" style={styles.top}>
        <IconButton icon="close" label="Close" onPress={() => router.back()} />
        {author ? (
          <Pressable style={styles.author} onPress={() => router.push(`/profile/${author.id}`)}>
            <Avatar path={author.avatar_path} name={authorName} size={36} />
            <View style={styles.authorText}>
              <Text style={styles.authorName} numberOfLines={1}>
                {authorName}
              </Text>
              <Text style={styles.authorMeta} numberOfLines={1}>
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

      {/* The photo or video, fitted in the space between the top bar and the panel. */}
      <View style={styles.media}>
        {post === undefined ? (
          <ActivityIndicator style={styles.fill} color={colors.accent} size="large" />
        ) : post === null ? (
          <View style={[styles.fill, styles.center]}>
            <EmptyState emoji="💨" title="This post is gone" message="It was deleted, or you can't see it anymore." />
          </View>
        ) : locked ? (
          <View style={[styles.fill, styles.center]}>
            {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" blurRadius={30} /> : null}
            <View style={styles.lockedShade} />
            {files?.lock === 'group' ? (
              <>
                <Text style={styles.lockedEmoji}>👯</Text>
                <Text style={styles.lockedTitle}>Waiting on your group 👀</Text>
                <Text style={styles.lockedText}>This drop shows once everyone in your group has posted.</Text>
                <Button title="See my groups" icon="people" onPress={() => router.push('/groups')} />
              </>
            ) : (
              <>
                <Text style={styles.lockedEmoji}>🙈</Text>
                <Text style={styles.lockedTitle}>Give a peek to get a peek 👀</Text>
                <Text style={styles.lockedText}>Post your Peekaboo drop to see this one.</Text>
                <Button
                  title="Open camera"
                  icon="camera"
                  onPress={() => router.push({ pathname: '/camera', params: { drop: '1' } })}
                />
              </>
            )}
          </View>
        ) : videoUri ? (
          <VideoClip
            uri={videoUri}
            posterUri={uri}
            overlayUri={files?.overlay ? urls[files.overlay] : undefined}
            contentFit={post.overlay_path ? 'cover' : 'contain'}
            playing
            style={StyleSheet.absoluteFill}
          />
        ) : uri ? (
          <Image source={{ uri, cacheKey: post.media_path }} style={StyleSheet.absoluteFill} contentFit="contain" transition={200} />
        ) : (
          <ActivityIndicator style={styles.fill} color={colors.accent} size="large" />
        )}
      </View>

      {/* Under the photo, in its own panel: ❤️ and 💬, dare tags, then the caption (like Instagram). */}
      {post ? (
        <SafeEdge edge="bottom" style={styles.panel}>
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
          {post.dare_day ? <DareTag day={post.dare_day} /> : null}
          {post.forfeit_text ? <ForfeitTag text={post.forfeit_text} /> : null}
          {post.dare_verdict ? (
            <LegitOrCap
              key={`${isFriend}`}
              postId={post.id}
              verdict={post.dare_verdict}
              canVote={isFriend && post.user_id !== userId}
              onDark
            />
          ) : null}
          {post.caption ? (
            <Text
              style={styles.caption}
              numberOfLines={captionOpen ? undefined : 3}
              onPress={() => setCaptionOpen((open) => !open)}>
              <Text style={styles.captionName}>{authorName} </Text>
              {post.caption}
            </Text>
          ) : null}
          {post.peek_stats ? (
            <Pressable
              style={styles.peeked}
              onPress={() => router.push(`/peekers/${post.id}`)}
              accessibilityLabel="See who peeked">
              <Text style={styles.peekedText}>
                👀 {post.peek_stats.revealed} peeked · {post.peek_stats.passed} scrolled past ›
              </Text>
            </Pressable>
          ) : null}
        </SafeEdge>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  peeked: {
    alignSelf: 'flex-start',
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderWidth: 1,
    borderColor: colors.purple,
  },
  peekedText: {
    color: colors.white,
    fontWeight: '800',
    fontSize: 13,
  },
  lockedShade: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(11,11,16,0.4)',
  },
  lockedEmoji: {
    fontSize: 56,
  },
  lockedTitle: {
    color: colors.white,
    fontSize: 22,
    fontWeight: '900',
    textAlign: 'center',
    marginTop: space.sm,
  },
  lockedText: {
    color: colors.white,
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: space.lg,
  },
  fill: {
    flex: 1,
    backgroundColor: colors.black,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  authorText: {
    flex: 1,
  },
  media: {
    flex: 1,
    overflow: 'hidden',
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
  },
  authorMeta: {
    ...font.small,
    color: 'rgba(255,255,255,0.8)',
  },
  panel: {
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.md,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    backgroundColor: '#17171f',
  },
  actions: {
    flexDirection: 'row',
    gap: space.xl,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  count: {
    ...font.body,
    color: colors.white,
    fontWeight: '800',
  },
  caption: {
    ...font.body,
    color: colors.white,
    fontSize: 16,
    lineHeight: 22,
  },
  captionName: {
    fontWeight: '900',
  },
});
