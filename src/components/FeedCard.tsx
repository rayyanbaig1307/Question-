import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated, {
  FadeOut,
  useAnimatedStyle,
  ZoomIn,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { Bouncy, usePop } from '@/components/Bouncy';
import { DareTag } from '@/components/DareBanner';
import { DropBadge } from '@/components/DropPill';
import { ScratchReveal } from '@/components/ScratchRevealSafe';
import { VideoClip } from '@/components/VideoClipSafe';
import type { DropLock } from '@/lib/drop';
import type { FeedPost } from '@/lib/feed';
import { timeAgo } from '@/lib/time';
import { colors, font, radius, space } from '@/theme';

// Each photo's shape (width ÷ height), remembered so cards don't jump when you scroll back.
const shapes = new Map<string, number>();
// Drop photos you've already scratched clear (so they stay clear when you scroll back).
const scratched = new Set<string>();

// One post in the feed, Instagram-style: the whole photo (nothing cut off) with rounded corners,
// then like + comment buttons, the number of likes and the caption. Double-tap the photo to like it.
export function FeedCard({
  post,
  url,
  videoUrl,
  overlayUrl,
  active = false,
  lock = null,
  scratch = false,
  onLike,
  onMenu,
  onRevealed,
}: {
  post: FeedPost;
  // The photo's link (for a video: its still picture) – or, while `locked`, the link of its tiny blurry preview.
  url: string | undefined;
  // Videos: the video itself and its text/sticker layer.
  videoUrl?: string;
  overlayUrl?: string;
  // On screen right now (videos only play then).
  active?: boolean;
  // Peek to see: a friend's drop you can't see yet – until you've posted your own drop that day ('drop'),
  // or until everyone in a Group Peek you share has posted ('group').
  lock?: DropLock;
  // Hold to reveal: the photo starts blurred and you scratch it clear.
  scratch?: boolean;
  onLike: (like: boolean) => void;
  onMenu: () => void;
  // You scratched a drop clear (for Who Peeked).
  onRevealed?: () => void;
}) {
  const lastTap = useRef(0);
  const locked = lock !== null;
  const [shape, setShape] = useState(() => shapes.get(post.media_path) ?? 3 / 4);
  // Remember when this card goes from locked to unlocked, to play the reveal animation once.
  const [wasLocked, setWasLocked] = useState(locked);
  const [justUnlocked, setJustUnlocked] = useState(false);
  const [revealed, setRevealed] = useState(() => scratched.has(post.id));
  const isVideo = post.media_type === 'video';
  // Videos start without sound; tap the speaker to hear them.
  const [muted, setMuted] = useState(true);
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const scratchIt = scratch && !isVideo && !locked && !revealed && !!url && ScratchReveal !== null;
  // A video with text/stickers is shown in the full-screen shape it was decorated in, so they line up.
  const cardShape = isVideo && post.overlay_path ? screenWidth / screenHeight : shape;
  if (locked !== wasLocked) {
    setWasLocked(locked);
    if (wasLocked && !locked) setJustUnlocked(true);
  }
  useEffect(() => {
    if (justUnlocked) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [justUnlocked]);
  const heart = useSharedValue(0);
  const likeButton = usePop();
  const author = post.author;
  const name = author ? author.display_name || author.username : 'Someone';

  function tapPhoto() {
    if (locked || scratchIt) return;
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
            <View style={styles.meta}>
              <Text style={styles.time}>{timeAgo(post.created_at)}</Text>
              {post.drop_day && post.drop_late_seconds !== null ? <DropBadge lateSeconds={post.drop_late_seconds} /> : null}
            </View>
          </View>
        </Pressable>
        <Pressable onPress={onMenu} hitSlop={10} accessibilityLabel="More">
          <Ionicons name="ellipsis-horizontal" size={22} color={colors.textMuted} />
        </Pressable>
      </View>

      <Pressable
        onPress={tapPhoto}
        onLongPress={locked || scratchIt ? undefined : () => router.push(`/post/${post.id}`)}
        style={styles.photoWrap}>
        {scratchIt && ScratchReveal && url ? (
          <ScratchReveal
            uri={url}
            shape={shape}
            onRevealed={() => {
              scratched.add(post.id);
              setRevealed(true);
              onRevealed?.();
            }}
          />
        ) : locked ? (
          // Blurry preview + "give a peek to get a peek" until you've posted your own drop.
          <Animated.View exiting={FadeOut.duration(400)} style={[styles.photo, styles.locked, { aspectRatio: shape }]}>
            {url ? (
              <Image
                source={{ uri: url, cacheKey: post.blur_path ?? undefined }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                blurRadius={25}
                onLoad={({ source }) => {
                  // The tiny preview has the same shape as the real photo.
                  if (source.width > 0 && source.height > 0 && !shapes.has(post.media_path)) {
                    setShape(source.width / source.height);
                  }
                }}
              />
            ) : null}
            <View style={styles.lockedShade} />
            {lock === 'group' ? (
              <View style={styles.lockedContent}>
                <Text style={styles.lockedEmoji}>👯</Text>
                <Text style={styles.lockedTitle}>Waiting on your group 👀</Text>
                <Text style={styles.lockedText}>{name}&apos;s drop shows once everyone in your group has posted.</Text>
                <Button title="See my groups" icon="people" small onPress={() => router.push('/groups')} />
              </View>
            ) : (
              <View style={styles.lockedContent}>
                <Text style={styles.lockedEmoji}>🙈</Text>
                <Text style={styles.lockedTitle}>Give a peek to get a peek 👀</Text>
                <Text style={styles.lockedText}>Post your Peekaboo drop to see {name}&apos;s.</Text>
                <Button
                  title="Open camera"
                  icon="camera"
                  small
                  onPress={() => router.push({ pathname: '/camera', params: { drop: '1' } })}
                />
              </View>
            )}
          </Animated.View>
        ) : isVideo && videoUrl ? (
          <Animated.View entering={justUnlocked ? ZoomIn.springify().damping(12) : undefined}>
            <VideoClip
              uri={videoUrl}
              posterUri={url}
              overlayUri={overlayUrl}
              playing={active}
              muted={muted}
              style={[styles.photo, { aspectRatio: cardShape }]}
            />
            <Bouncy
              style={styles.sound}
              pressScale={0.85}
              onPress={() => setMuted(!muted)}
              accessibilityLabel={muted ? 'Turn sound on' : 'Turn sound off'}>
              <Ionicons name={muted ? 'volume-mute' : 'volume-high'} size={18} color={colors.white} />
            </Bouncy>
          </Animated.View>
        ) : url ? (
          <Animated.View entering={justUnlocked ? ZoomIn.springify().damping(12) : undefined}>
          <Image
            source={{ uri: url, cacheKey: post.media_path }}
            style={[styles.photo, { aspectRatio: shape }]}
            contentFit="cover"
            transition={200}
            recyclingKey={post.id}
            onLoad={({ source }) => {
              // Once we know the photo's real shape, make the card exactly that shape.
              if (source.width > 0 && source.height > 0) {
                const real = source.width / source.height;
                shapes.set(post.media_path, real);
                setShape(real);
              }
            }}
          />
          </Animated.View>
        ) : (
          <View style={[styles.photo, styles.loading, { aspectRatio: shape }]} />
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
        </Bouncy>
        <Bouncy
          style={styles.action}
          pressScale={0.85}
          onPress={() => router.push(`/comments/${post.id}`)}
          accessibilityLabel="Comments">
          <Ionicons name="chatbubble-outline" size={26} color={colors.text} />
        </Bouncy>
      </View>

      <Text style={styles.likes}>{post.likeCount === 1 ? '1 like' : `${post.likeCount} likes`}</Text>

      {post.peek_stats ? (
        // Your own drop: who peeked (only you see this).
        <Pressable
          style={styles.peeked}
          onPress={() => router.push(`/peekers/${post.id}`)}
          accessibilityLabel="See who peeked">
          <Text style={styles.peekedText}>
            👀 {post.peek_stats.revealed} peeked · {post.peek_stats.passed} scrolled past
          </Text>
          <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
        </Pressable>
      ) : null}
      {post.dare_day ? <DareTag day={post.dare_day} /> : null}
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
  peeked: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.purple,
  },
  peekedText: {
    ...font.small,
    color: colors.text,
    fontWeight: '800',
  },
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
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
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
  },
  loading: {
    backgroundColor: colors.card,
  },
  sound: {
    position: 'absolute',
    right: space.md,
    bottom: space.md,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  locked: {
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockedShade: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(11,11,16,0.35)',
  },
  lockedContent: {
    alignItems: 'center',
    gap: space.sm,
    padding: space.xl,
  },
  lockedEmoji: {
    fontSize: 44,
  },
  lockedTitle: {
    color: colors.white,
    fontSize: 20,
    fontWeight: '900',
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowRadius: 6,
  },
  lockedText: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: space.sm,
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowRadius: 6,
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
  likes: {
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
