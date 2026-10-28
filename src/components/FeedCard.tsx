import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { Avatar } from '@/components/Avatar';
import { Bouncy, usePop } from '@/components/Bouncy';
import type { FeedPost } from '@/lib/feed';
import { timeAgo } from '@/lib/time';
import { colors, font, radius, space } from '@/theme';

// One post in the feed, Instagram-style. Double-tap the photo to like it.
export function FeedCard({ post, url, onLike, onMenu }: {
  post: FeedPost;
  url: string | undefined;
  onLike: (like: boolean) => void;
  onMenu: () => void;
}) {
  const lastTap = useRef(0);
  const heart = useSharedValue(0);
  const likeButton = usePop();
  const author = post.author;
  const name = author ? author.display_name || author.username : 'Someone';

  function tapPhoto() {
    const now = Date.now();
    if (now - lastTap.current < 300) {
      // Double tap → like + a big heart pops up.
      lastTap.current = 0;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      heart.set(withSequence(withSpring(1, { damping: 8 }), withDelay(500, withTiming(0, { duration: 200 }))));
      if (!post.likedByMe) {
        likeButton.pop();
        onLike(true);
      }
    } else {
      lastTap.current = now;
    }
  }

  const heartStyle = useAnimatedStyle(() => ({
    opacity: heart.get() > 0.05 ? 1 : 0,
    transform: [{ scale: heart.get() }],
  }));

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Pressable
          style={styles.author}
          onPress={() => author && router.push(`/profile/${author.id}`)}
          accessibilityLabel={`Open ${name}'s profile`}>
          <Avatar path={author?.avatar_path} name={name} size={36} />
          <View style={styles.authorText}>
            <Text style={styles.name} numberOfLines={1}>
              {name}
            </Text>
            <Text style={styles.time}>{timeAgo(post.created_at)}</Text>
          </View>
        </Pressable>
        <Pressable onPress={onMenu} hitSlop={10} accessibilityLabel="More">
          <Ionicons name="ellipsis-horizontal" size={22} color={colors.textMuted} />
        </Pressable>
      </View>

      <Pressable onPress={tapPhoto} onLongPress={() => router.push(`/post/${post.id}`)} style={styles.photoWrap}>
        {url ? (
          <Image
            source={{ uri: url, cacheKey: post.media_path }}
            style={styles.photo}
            contentFit="cover"
            transition={200}
            recyclingKey={post.id}
          />
        ) : (
          <View style={[styles.photo, styles.loading]} />
        )}
        <Animated.View style={[styles.bigHeart, heartStyle]} pointerEvents="none">
          <Ionicons name="heart" size={110} color={colors.pink} />
        </Animated.View>
      </Pressable>

      <View style={styles.actions}>
        <Bouncy
          style={styles.action}
          pressScale={0.85}
          onPress={() => {
            if (post.likedByMe) {
              Haptics.selectionAsync();
            } else {
              // A little buzz and a heart pop when you like something.
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              likeButton.pop();
            }
            onLike(!post.likedByMe);
          }}
          accessibilityLabel={post.likedByMe ? 'Unlike' : 'Like'}>
          <Animated.View style={likeButton.style}>
            <Ionicons
              name={post.likedByMe ? 'heart' : 'heart-outline'}
              size={28}
              color={post.likedByMe ? colors.pink : colors.text}
            />
          </Animated.View>
          <Text style={styles.count}>{post.likeCount}</Text>
        </Bouncy>
        <Pressable style={styles.action} onPress={() => router.push(`/comments/${post.id}`)} accessibilityLabel="Comments">
          <Ionicons name="chatbubble-outline" size={26} color={colors.text} />
          <Text style={styles.count}>{post.commentCount}</Text>
        </Pressable>
      </View>

      {post.caption ? (
        <Text style={styles.caption}>
          <Text style={styles.captionName}>{name} </Text>
          {post.caption}
        </Text>
      ) : null}
      {post.commentCount > 0 ? (
        <Pressable onPress={() => router.push(`/comments/${post.id}`)}>
          <Text style={styles.viewComments}>
            {post.commentCount === 1 ? 'View 1 comment' : `View all ${post.commentCount} comments`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: space.sm,
    paddingBottom: space.xl,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  author: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  authorText: {
    flex: 1,
  },
  name: {
    ...font.body,
    fontWeight: '800',
  },
  time: {
    ...font.small,
    fontSize: 12,
  },
  photoWrap: {
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  photo: {
    width: '100%',
    aspectRatio: 9 / 16,
  },
  loading: {
    backgroundColor: colors.card,
  },
  bigHeart: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actions: {
    flexDirection: 'row',
    gap: space.xl,
    paddingTop: space.xs,
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
  caption: {
    ...font.body,
    lineHeight: 22,
  },
  captionName: {
    fontWeight: '800',
  },
  viewComments: {
    ...font.small,
  },
});
