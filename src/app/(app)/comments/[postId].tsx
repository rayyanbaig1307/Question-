import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
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
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import { EmptyState } from '@/components/EmptyState';
import { IconButton } from '@/components/IconButton';
import { useOverlays } from '@/components/Overlays';
import { ScreenHeader } from '@/components/ScreenHeader';
import { useMe } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { addComment, deleteComment, fetchComments, type Comment } from '@/lib/feed';
import { fetchPost } from '@/lib/posts';
import { timeAgo } from '@/lib/time';
import { useSafetyActions } from '@/lib/useSafetyActions';
import { colors, font, space } from '@/theme';

// Comments on a post: read them, add yours, delete or report.
export default function Comments() {
  const { postId } = useLocalSearchParams<{ postId: string }>();
  const { userId } = useMe();
  const { showOptions, showToast } = useOverlays();
  const { report } = useSafetyActions();
  const insets = useSafeAreaInsets();

  const [comments, setComments] = useState<Comment[] | null>(null);
  const [postOwner, setPostOwner] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    fetchComments(postId)
      .then(setComments)
      .catch(() => setComments([]));
    fetchPost(postId)
      .then((post) => setPostOwner(post?.user_id ?? null))
      .catch(() => {});
  }, [postId]);

  async function send() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const added = await addComment(userId, postId, body);
      setComments((current) => [...(current ?? []), added]);
      setText('');
    } catch (error) {
      Alert.alert('Comment not posted', friendlyError(error));
    } finally {
      setSending(false);
    }
  }

  function openMenu(comment: Comment) {
    const canDelete = comment.user_id === userId || postOwner === userId;
    const options = [];
    if (canDelete) {
      options.push({
        label: 'Delete comment',
        destructive: true,
        onPress: async () => {
          try {
            await deleteComment(comment.id);
            setComments((current) => current?.filter((c) => c.id !== comment.id) ?? null);
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
            data={comments}
            keyExtractor={(comment) => comment.id}
            contentContainerStyle={styles.list}
            keyboardDismissMode="interactive"
            ListEmptyComponent={<EmptyState emoji="💬" title="No comments yet" message="Be the first to say something nice!" />}
            renderItem={({ item }) => {
              const name = item.author ? item.author.display_name || item.author.username : 'Someone';
              return (
                <Pressable style={styles.comment} onLongPress={() => openMenu(item)}>
                  <Pressable onPress={() => item.author && router.push(`/profile/${item.author.id}`)}>
                    <Avatar path={item.author?.avatar_path} name={name} size={36} />
                  </Pressable>
                  <View style={styles.commentText}>
                    <Text style={styles.body}>
                      <Text style={styles.name}>{name} </Text>
                      {item.body}
                    </Text>
                    <Text style={styles.time}>{timeAgo(item.created_at)}</Text>
                  </View>
                </Pressable>
              );
            }}
          />
        )}

        <View style={[styles.inputBar, { paddingBottom: insets.bottom + space.sm }]}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Add a comment…"
            placeholderTextColor={colors.textFaint}
            keyboardAppearance="dark"
            selectionColor={colors.accent}
            multiline
            maxLength={500}
            style={styles.input}
          />
          <IconButton
            icon="arrow-up"
            label="Post comment"
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
  commentText: {
    flex: 1,
    gap: 2,
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
