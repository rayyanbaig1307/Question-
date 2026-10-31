import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type TextInputInstance,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import { Bouncy } from '@/components/Bouncy';
import { EmptyState } from '@/components/EmptyState';
import { IconButton } from '@/components/IconButton';
import { useOverlays } from '@/components/Overlays';
import { useMe } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { addComment, deleteComment, fetchComments, setCommentLiked, type Comment } from '@/lib/feed';
import { fetchPost } from '@/lib/posts';
import { timeAgo } from '@/lib/time';
import { useSafetyActions } from '@/lib/useSafetyActions';
import { colors, font, keyboardAppearance, space } from '@/theme';

// Comments on a post, in a sheet that slides up over the post (like Instagram): read them, add yours, reply to
// one, like them, delete or report. Drag the top of the sheet down, or tap above it, to close.
export default function Comments() {
  const { postId } = useLocalSearchParams<{ postId: string }>();
  const { userId } = useMe();
  const { showOptions, showToast } = useOverlays();
  const { report } = useSafetyActions();
  const insets = useSafeAreaInsets();
  const input = useRef<TextInputInstance>(null);
  const { height } = useWindowDimensions();
  const sheetHeight = Math.round(height * 0.75);

  // The sheet slides up when it opens and back down when it closes (0 = fully open).
  const [slide] = useState(() => new Animated.Value(height));
  useEffect(() => {
    Animated.spring(slide, { toValue: 0, useNativeDriver: true, bounciness: 0, speed: 16 }).start();
  }, [slide]);
  const closing = useRef(false);
  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    Keyboard.dismiss();
    Animated.timing(slide, { toValue: height, duration: 220, useNativeDriver: true }).start(() => router.back());
  }, [slide, height]);
  // Dragging the top of the sheet down: far enough (or fast enough) closes it, otherwise it springs back.
  const [draggedAway, setDraggedAway] = useState(false);
  const [drag] = useState(() =>
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, move) => move.dy > 4 && Math.abs(move.dy) > Math.abs(move.dx),
      onPanResponderMove: (_, move) => slide.setValue(Math.max(0, move.dy)),
      onPanResponderRelease: (_, move) => {
        if (move.dy > 120 || move.vy > 1.2) setDraggedAway(true);
        else Animated.spring(slide, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
      },
    }),
  );
  useEffect(() => {
    if (draggedAway) close();
  }, [draggedAway, close]);
  const backdrop = slide.interpolate({ inputRange: [0, height], outputRange: [1, 0], extrapolate: 'clamp' });

  const [comments, setComments] = useState<Comment[] | null>(null);
  const [postOwner, setPostOwner] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  // The comment you're replying to (null = a new comment on the post).
  const [replyTo, setReplyTo] = useState<Comment | null>(null);

  useEffect(() => {
    fetchComments(userId, postId)
      .then(setComments)
      .catch(() => setComments([]));
    fetchPost(postId)
      .then((post) => setPostOwner(post?.user_id ?? null))
      .catch(() => {});
  }, [postId, userId]);

  // Top comments in order, each followed by its replies.
  const rows = useMemo(() => {
    const all = comments ?? [];
    return all
      .filter((comment) => !comment.parent_id)
      .flatMap((top) => [top, ...all.filter((comment) => comment.parent_id === top.id)]);
  }, [comments]);

  const nameOf = (comment: Comment) => (comment.author ? comment.author.display_name || comment.author.username : 'Someone');

  // Opening someone's profile closes the sheet first.
  function openProfile(id: string) {
    router.back();
    router.push(`/profile/${id}`);
  }

  function startReply(comment: Comment) {
    setReplyTo(comment);
    if (comment.author && !text.startsWith(`@${comment.author.username}`)) setText(`@${comment.author.username} `);
    input.current?.focus();
  }

  async function send() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      // Replies always hang off the top comment (one level deep).
      const added = await addComment(userId, postId, body, replyTo ? (replyTo.parent_id ?? replyTo.id) : null);
      setComments((current) => [...(current ?? []), added]);
      setText('');
      setReplyTo(null);
    } catch (error) {
      Alert.alert('Comment not posted', friendlyError(error));
    } finally {
      setSending(false);
    }
  }

  async function like(comment: Comment) {
    const liked = !comment.likedByMe;
    const flip = (on: boolean) =>
      setComments(
        (current) =>
          current?.map((c) =>
            c.id === comment.id ? { ...c, likedByMe: on, likeCount: Math.max(0, c.likeCount + (on ? 1 : -1)) } : c,
          ) ?? null,
      );
    if (liked) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    flip(liked); // show it straight away
    try {
      await setCommentLiked(userId, comment.id, liked);
    } catch {
      flip(!liked); // undo if it didn't work
    }
  }

  function openMenu(comment: Comment) {
    // You can delete your own comments – and, on your own post, anyone's.
    const canDelete = comment.user_id === userId || postOwner === userId;
    const options = [];
    if (canDelete) {
      options.push({
        label: 'Delete comment',
        destructive: true,
        onPress: async () => {
          try {
            await deleteComment(comment.id);
            // Deleting a comment also deletes its replies.
            setComments((current) => current?.filter((c) => c.id !== comment.id && c.parent_id !== comment.id) ?? null);
            showToast('Comment deleted');
          } catch (error) {
            Alert.alert('Could not delete', friendlyError(error));
          }
        },
      });
    }
    if (comment.user_id !== userId && comment.author) {
      const author = comment.author;
      options.push({
        label: 'Report comment',
        onPress: () => report({ user: author, contentType: 'comment', contentId: comment.id }),
      });
    }
    if (options.length > 0) showOptions({ options });
  }

  return (
    <View style={styles.screen}>
      <Animated.View style={[styles.backdrop, { opacity: backdrop }]}>
        <Pressable style={styles.screen} onPress={close} accessibilityLabel="Close comments" />
      </Animated.View>
      {/* The negative offset stops a gap appearing between the comment box and the keyboard. */}
      <KeyboardAvoidingView
        style={[styles.sheetArea, { paddingTop: insets.top + space.lg }]}
        behavior="padding"
        keyboardVerticalOffset={-insets.bottom}
        pointerEvents="box-none">
        <Animated.View style={[styles.sheet, { height: sheetHeight, transform: [{ translateY: slide }] }]}>
          <View style={styles.sheetTop} {...drag.panHandlers}>
            <View style={styles.grabber} />
            <Text style={styles.title}>Comments</Text>
          </View>
          {comments === null ? (
            <ActivityIndicator color={colors.accent} style={styles.loading} />
          ) : (
            <FlatList
              data={rows}
              keyExtractor={(comment) => comment.id}
              contentContainerStyle={styles.list}
              keyboardDismissMode="interactive"
              ListEmptyComponent={<EmptyState emoji="💬" title="No comments yet" message="Be the first to say something nice!" />}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => {
                const isReply = !!item.parent_id;
                const name = nameOf(item);
                return (
                  <Pressable
                    style={[styles.comment, isReply && styles.reply]}
                    onLongPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                      openMenu(item);
                    }}>
                    <Pressable onPress={() => item.author && openProfile(item.author.id)}>
                      <Avatar path={item.author?.avatar_path} name={name} size={isReply ? 28 : 36} />
                    </Pressable>
                    <View style={styles.commentText}>
                      <Text style={styles.body}>
                        <Text style={styles.name}>{name} </Text>
                        {item.body}
                      </Text>
                      <View style={styles.meta}>
                        <Text style={styles.time}>{timeAgo(item.created_at)}</Text>
                        {item.likeCount > 0 ? (
                          <Text style={styles.time}>{item.likeCount === 1 ? '1 like' : `${item.likeCount} likes`}</Text>
                        ) : null}
                        <Pressable onPress={() => startReply(item)} hitSlop={8} accessibilityRole="button">
                          <Text style={styles.replyButton}>Reply</Text>
                        </Pressable>
                      </View>
                    </View>
                    <Bouncy
                      style={styles.heart}
                      pressScale={0.8}
                      onPress={() => like(item)}
                      accessibilityLabel={item.likedByMe ? 'Unlike comment' : 'Like comment'}>
                      <Ionicons
                        name={item.likedByMe ? 'heart' : 'heart-outline'}
                        size={18}
                        color={item.likedByMe ? colors.pink : colors.textFaint}
                      />
                    </Bouncy>
                  </Pressable>
                );
              }}
            />
          )}

          {replyTo ? (
            <View style={styles.replyingBar}>
              <Text style={styles.replyingText} numberOfLines={1}>
                Replying to <Text style={styles.name}>{nameOf(replyTo)}</Text>
              </Text>
              <Pressable
                onPress={() => {
                  setReplyTo(null);
                  setText('');
                }}
                hitSlop={10}
                accessibilityLabel="Cancel reply">
                <Ionicons name="close" size={18} color={colors.textMuted} />
              </Pressable>
            </View>
          ) : null}
          <View style={[styles.inputBar, { paddingBottom: insets.bottom + space.sm }]}>
            <TextInput
              ref={input}
              value={text}
              onChangeText={setText}
              placeholder={replyTo ? 'Write a reply…' : 'Add a comment…'}
              placeholderTextColor={colors.textFaint}
              keyboardAppearance={keyboardAppearance}
              selectionColor={colors.accent}
              multiline
              maxLength={500}
              style={styles.input}
            />
            <IconButton
              icon="arrow-up"
              label={replyTo ? 'Post reply' : 'Post comment'}
              background={text.trim() ? colors.pink : colors.card}
              onPress={send}
            />
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheetArea: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    flexShrink: 1,
    overflow: 'hidden',
    backgroundColor: colors.bg,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
  },
  sheetTop: {
    alignItems: 'center',
    gap: space.sm,
    paddingTop: space.sm,
    paddingBottom: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  grabber: {
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.textFaint,
  },
  title: {
    ...font.body,
    fontWeight: '900',
  },
  loading: {
    flex: 1,
  },
  list: {
    padding: space.lg,
    gap: space.lg,
  },
  comment: {
    flexDirection: 'row',
    gap: space.md,
  },
  reply: {
    marginLeft: 48,
  },
  commentText: {
    flex: 1,
    gap: 2,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  replyButton: {
    ...font.small,
    fontSize: 12,
    fontWeight: '800',
    color: colors.textMuted,
  },
  heart: {
    paddingTop: 4,
    paddingLeft: space.sm,
  },
  replyingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    backgroundColor: colors.card,
  },
  replyingText: {
    ...font.small,
    flex: 1,
  },
  body: {
    ...font.body,
    lineHeight: 22,
  },
  name: {
    fontWeight: '800',
  },
  time: {
    ...font.small,
    fontSize: 12,
    color: colors.textFaint,
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    backgroundColor: colors.card,
    borderRadius: 22,
    paddingHorizontal: space.lg,
    paddingTop: 12,
    paddingBottom: 12,
    color: colors.text,
    fontSize: 16,
  },
});
