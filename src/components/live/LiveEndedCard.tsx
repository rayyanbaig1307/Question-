import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { SafeEdge } from '@/components/SafeEdge';
import type { LiveEndedReason } from '@/lib/lives';
import { colors, font, radius, space } from '@/theme';

// What the host is told when the live ended without them tapping End (only the host is ever told why).
export function hostEndLine(reason: LiveEndedReason | string | null | undefined, maxMinutes = 60): string | null {
  switch (reason) {
    case 'time':
      return `That's ${maxMinutes} minutes!`;
    case 'empty':
      return 'Nobody joined, so we ended your live.';
    case 'reports':
      return 'Your live was ended for a safety check.';
    case 'host_gone':
      return 'Your connection dropped.';
    case 'owner':
    case 'safety':
      return 'Your live was ended.';
    default:
      return null;
  }
}

export type LiveNumbers = { minutes: number; viewers: number; hearts: number; comments: number | null };

// "23 min · 12 friends watched · ❤️ 248 · 💬 40"
export function summaryLine({ minutes, viewers, hearts, comments }: LiveNumbers): string {
  const parts = [
    `${Math.max(0, Math.round(minutes))} min`,
    `${viewers} ${viewers === 1 ? 'friend' : 'friends'} watched`,
    `❤️ ${hearts}`,
  ];
  if (comments !== null) parts.push(`💬 ${comments}`);
  return parts.join(' · ');
}

// A full-screen card on a live (ended, removed, waiting, can't watch…) with its buttons underneath.
export function LiveCard({ emoji, title, message, children }: {
  emoji: string;
  title: string;
  message?: string | null;
  children?: ReactNode;
}) {
  return (
    <View style={styles.cover}>
      <SafeEdge edge="bottom" style={styles.center}>
        <View style={styles.card} accessibilityRole="summary">
          <Text style={styles.emoji}>{emoji}</Text>
          <Text style={styles.title}>{title}</Text>
          {message ? <Text style={styles.message}>{message}</Text> : null}
          {children ? <View style={styles.buttons}>{children}</View> : null}
        </View>
      </SafeEdge>
    </View>
  );
}

// The host's "That's a wrap 🎬" card. The numbers come from the phone at once, then from the server once it
// answers.
export function HostSummaryCard({ numbers, reason, maxMinutes, onDone }: {
  numbers: LiveNumbers;
  reason: LiveEndedReason | string | null;
  maxMinutes?: number;
  onDone: () => void;
}) {
  return (
    <LiveCard emoji="🙌" title="That's a wrap 🎬" message={hostEndLine(reason, maxMinutes)}>
      <Text style={styles.numbers}>{summaryLine(numbers)}</Text>
      <Button title="Done" onPress={onDone} />
    </LiveCard>
  );
}

const styles = StyleSheet.create({
  cover: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.82)',
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    padding: space.xl,
  },
  card: {
    alignItems: 'stretch',
    gap: space.md,
    padding: space.xl,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  emoji: {
    fontSize: 48,
    textAlign: 'center',
  },
  title: {
    ...font.heading,
    textAlign: 'center',
  },
  message: {
    ...font.body,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 22,
  },
  numbers: {
    ...font.body,
    fontWeight: '800',
    textAlign: 'center',
  },
  buttons: {
    gap: space.sm,
  },
});
