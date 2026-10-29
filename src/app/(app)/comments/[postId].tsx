import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputInstance,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import { Bouncy } from '@/components/Bouncy';
import { EmptyState } from '@/components/EmptyState';
import { IconButton } from '@/components/IconButton';
import { useOverlays } from '@/components/Overlays';
import { ScreenHeader } from '@/components/ScreenHeader';
import { useMe } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { addComment, deleteComment, fetchComments, setCommentLiked, type Comment } from '@/lib/feed';
import { fetchPost } from '@/lib/posts';
import { timeAgo } from '@/lib/time';
import { useSafetyActions } from '@/lib/useSafetyActions';
import { colors, font, keyboardAppearance, space } from '@/theme';

// Comments on a post: read them, add yours, reply to one, like them, delete or report.
export default function Comments() {
  const { postId } = useLocalSearchParams<{ postId: string }>();
  const { userId } = useMe();
  const { showOptions, showToast } = useOverlays();
  const { report } = useSafetyActions();
  const insets = useSafeAreaInsets();
  const input = useRef<TextInputInstance>(null);

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
    <View style={styles.fill}>
      <ScreenHeader title="Comments" />
      {/* The negative offset stops a gap appearing between the comment box and the keyboard. */}
      <KeyboardAvoidingView style={styles.fill} behavior="padding" keyboardVerticalOffset={-insets.bottom}>
        {comments === null ? (
          <ActivityIndicator color={colors.accent} style={styles.loading} />
        ) : (
          <FlatList
            data={rows}
            keyExtractor={(comment) => comment.id}
            contentContainerStyle={styles.list}
            keyboardDismissMode="interactive"
            ListEmptyComponent={<EmptyState emoji="💬" title="No comments yet" message="Be the first to say something nice!" />}
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
                  <Pressable onPress={() => item.author && router.push(`/profile/${item.author.id}`)}>
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
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.bg,
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
