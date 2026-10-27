import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import { EmptyState } from '@/components/EmptyState';
import { IconButton } from '@/components/IconButton';
import { useOverlays } from '@/components/Overlays';
import { useMe } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
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
  const uri = useMediaUrl(post?.media_path);

  useEffect(() => {
    fetchPost(id)
      .then(setPost)
      .catch(() => setPost(null));
  }, [id]);

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
        <ActivityIndicator style={styles.fill} color={colors.yellow} size="large" />
      ) : post === null ? (
        <View style={[styles.fill, styles.center]}>
          <EmptyState emoji="👻" title="This post is gone" message="It was deleted, or you can't see it anymore." />
        </View>
      ) : uri ? (
        <Image source={{ uri, cacheKey: post.media_path }} style={styles.fill} contentFit="contain" transition={200} />
      ) : (
        <ActivityIndicator style={styles.fill} color={colors.yellow} size="large" />
      )}

      <SafeAreaView edges={['top']} style={styles.top}>
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
            </View>
          </Pressable>
        ) : (
          <View style={styles.author} />
        )}
        {post ? <IconButton icon="ellipsis-horizontal" label="More" onPress={openMenu} /> : null}
      </SafeAreaView>

      {post?.caption ? (
        <SafeAreaView edges={['bottom']} style={styles.bottom}>
          <LinearGradient colors={['transparent', 'rgba(0,0,0,0.75)']} style={StyleSheet.absoluteFill} />
          <Text style={styles.caption}>{post.caption}</Text>
        </SafeAreaView>
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
  caption: {
    ...font.body,
    fontSize: 17,
    lineHeight: 24,
    marginBottom: space.md,
  },
});
