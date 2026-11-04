import { useEffect, useRef } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { SafeEdge } from '@/components/SafeEdge';
import { REACTIONS } from '@/lib/reactions';
import { colors, font, radius, space } from '@/theme';

export type MessageAction = { label: string; destructive?: boolean; onPress: () => void };

// What you get when you hold a chat message: a row of reactions ❤️ 😂 🔥 😮 😢 👍 on top (yours is circled),
// then actions like Reply, Pin, Delete or Report.
export function MessageActions({ visible, myReaction, onReact, actions, onClose }: {
  visible: boolean;
  myReaction: string | null;
  onReact: (emoji: string) => void;
  actions: MessageAction[];
  onClose: () => void;
}) {
  const pending = useRef<(() => void) | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function runPending() {
    const action = pending.current;
    pending.current = null;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    action?.();
  }
  function choose(action: () => void) {
    if (pending.current) return;
    pending.current = action;
    onClose();
    // iOS needs the old native menu gone before a report sheet or warning can open.
    timer.current = setTimeout(runPending, Platform.OS === 'ios' ? 700 : 250);
  }
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    pending.current = null;
  }, []);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} onDismiss={runPending}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close">
        <SafeEdge edge="bottom" style={styles.sheet}>
          <Pressable style={styles.inner}>
            <View style={styles.reactions}>
              {REACTIONS.map((emoji) => (
                <Pressable
                  key={emoji}
                  onPress={() => {
                    choose(() => onReact(emoji));
                  }}
                  style={({ pressed }) => [styles.emojiButton, myReaction === emoji && styles.emojiMine, pressed && styles.pressed]}
                  accessibilityRole="button"
                  accessibilityLabel={myReaction === emoji ? `Take back ${emoji}` : `React ${emoji}`}>
                  <Text style={styles.emoji}>{emoji}</Text>
                </Pressable>
              ))}
            </View>
            {actions.map((action) => (
              <Pressable
                key={action.label}
                onPress={() => {
                  choose(action.onPress);
                }}
                style={({ pressed }) => [styles.action, pressed && styles.pressed]}
                accessibilityRole="button">
                <Text style={[styles.actionText, action.destructive && styles.destructive]}>{action.label}</Text>
              </Pressable>
            ))}
          </Pressable>
        </SafeEdge>
      </Pressable>
    </Modal>
  );
}

// The reactions under a message: each emoji with how many people picked it. Yours is highlighted;
// tap it to take it back.
export function ReactionChips({ reactions, me, onToggle }: {
  reactions: { user_id: string; emoji: string }[] | undefined;
  me: string;
  onToggle: (emoji: string) => void;
}) {
  if (!reactions || reactions.length === 0) return null;
  const counts = new Map<string, { count: number; mine: boolean }>();
  for (const r of reactions) {
    const now = counts.get(r.emoji) ?? { count: 0, mine: false };
    counts.set(r.emoji, { count: now.count + 1, mine: now.mine || r.user_id === me });
  }
  return (
    <View style={styles.chips}>
      {[...counts.entries()].map(([emoji, { count, mine }]) => (
        <Pressable
          key={emoji}
          onPress={() => onToggle(emoji)}
          style={[styles.chip, mine && styles.chipMine]}
          accessibilityRole="button"
          accessibilityLabel={`${emoji} ${count}`}>
          <Text style={styles.chipText}>
            {emoji}
            {count > 1 ? ` ${count}` : ''}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

// The little quote above a reply: who said it and the start of what they said.
export function ReplyQuote({ name, text, mine }: { name: string; text: string; mine: boolean }) {
  return (
    <View style={[styles.quote, mine ? styles.quoteMine : styles.quoteTheirs]}>
      <Text style={styles.quoteName} numberOfLines={1}>
        ↩ {name}
      </Text>
      <Text style={styles.quoteText} numberOfLines={2}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  inner: {
    padding: space.lg,
    gap: space.xs,
  },
  reactions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: space.sm,
  },
  emojiButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
  },
  emojiMine: {
    borderWidth: 2,
    borderColor: colors.accent,
  },
  emoji: {
    fontSize: 26,
  },
  action: {
    paddingVertical: space.md,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
  },
  actionText: {
    ...font.body,
    fontWeight: '700',
  },
  destructive: {
    color: colors.red,
  },
  pressed: {
    opacity: 0.6,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: -2,
  },
  chip: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipMine: {
    borderColor: colors.accent,
  },
  chipText: {
    fontSize: 13,
    color: colors.text,
  },
  quote: {
    borderLeftWidth: 3,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    marginBottom: 2,
    maxWidth: 260,
  },
  quoteMine: {
    borderLeftColor: colors.purple,
    backgroundColor: colors.card,
  },
  quoteTheirs: {
    borderLeftColor: colors.pink,
    backgroundColor: colors.card,
  },
  quoteName: {
    ...font.small,
    fontWeight: '800',
  },
  quoteText: {
    ...font.small,
  },
});
