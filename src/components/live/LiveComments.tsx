import { useState, type ReactNode } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { IconButton } from '@/components/IconButton';
import { LIVE_COMMENT_MAX, type LiveComment } from '@/lib/lives';
import { colors, keyboardAppearance, radius, space } from '@/theme';

// The newest comments of a live, newest at the bottom, fading out towards the top (about 6 show; the screen
// keeps the last 50). Press and hold one for Report, Delete, Block (and, for the host, Remove).
export function LiveCommentList({ comments, onLongPress, empty = 'No comments yet – say hi 👋' }: {
  // Newest first.
  comments: LiveComment[];
  onLongPress?: (comment: LiveComment) => void;
  empty?: string | null;
}) {
  if (comments.length === 0) {
    return empty ? <Text style={styles.empty}>{empty}</Text> : null;
  }
  return (
    <FlatList
      data={comments}
      inverted
      keyExtractor={(comment) => comment.id}
      style={styles.list}
      contentContainerStyle={styles.listContent}
      keyboardShouldPersistTaps="handled"
      renderItem={({ item, index }) => (
        <Pressable
          style={[styles.comment, { opacity: index < 4 ? 1 : Math.max(0.25, 1 - (index - 3) * 0.2) }]}
          onLongPress={onLongPress ? () => onLongPress(item) : undefined}
          delayLongPress={300}
          accessibilityLabel={`${item.name}: ${item.body}`}
          accessibilityHint={onLongPress ? 'Press and hold for Report, Delete or Block' : undefined}>
          <Avatar path={item.avatar_path} name={item.name} size={26} />
          <Text style={styles.commentText}>
            <Text style={styles.commentName}>{item.name} </Text>
            {item.body}
          </Text>
        </Pressable>
      )}
    />
  );
}

// The comment box at the bottom of a live. `onSend` checks and sends; it returns true when the comment went
// (the box is then emptied). Comments switched off: just a short note instead.
export function LiveComposer({ commentsOn, onSend, extra, note = true }: {
  commentsOn: boolean;
  onSend: (text: string) => Promise<boolean>;
  // Something next to the box (the ❤️ button).
  extra?: ReactNode;
  // Show "Everyone watching sees your comment and name" under the box.
  note?: boolean;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  async function send() {
    if (sending || !text.trim()) return;
    setSending(true);
    try {
      if (await onSend(text)) setText('');
    } finally {
      setSending(false);
    }
  }

  if (!commentsOn) {
    return (
      <View style={styles.bar}>
        <Text style={styles.off}>Comments are off</Text>
        {extra}
      </View>
    );
  }
  return (
    <View style={styles.composer}>
      <View style={styles.bar}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Add a comment…"
          placeholderTextColor="rgba(255,255,255,0.7)"
          keyboardAppearance={keyboardAppearance}
          selectionColor={colors.live}
          maxLength={LIVE_COMMENT_MAX}
          returnKeyType="send"
          onSubmitEditing={send}
          style={styles.input}
          accessibilityLabel="Add a comment"
        />
        <IconButton
          icon="arrow-up"
          label="Send comment"
          size={40}
          background={text.trim() ? colors.live : 'rgba(0,0,0,0.45)'}
          disabled={sending}
          onPress={send}
        />
        {extra}
      </View>
      {note ? <Text style={styles.note}>Everyone watching sees your comment and name</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    maxHeight: 230,
    flexGrow: 0,
  },
  listContent: {
    gap: space.sm,
    paddingVertical: space.xs,
  },
  empty: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 14,
    fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 4,
  },
  comment: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    maxWidth: '88%',
  },
  commentText: {
    flexShrink: 1,
    color: colors.white,
    fontSize: 14,
    fontWeight: '500',
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowRadius: 4,
  },
  commentName: {
    fontWeight: '800',
  },
  composer: {
    gap: 4,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 90,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.5)',
    backgroundColor: 'rgba(0,0,0,0.35)',
    color: colors.white,
    fontSize: 15,
  },
  off: {
    flex: 1,
    color: 'rgba(255,255,255,0.85)',
    fontSize: 14,
    fontWeight: '700',
  },
  note: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 11,
    fontWeight: '600',
    paddingLeft: space.md,
  },
});
