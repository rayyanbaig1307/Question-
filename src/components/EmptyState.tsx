import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, font, space } from '@/theme';

// A big emoji with a short message, for "nothing here yet" moments.
export function EmptyState({ emoji, title, message, children }: {
  emoji: string;
  title: string;
  message?: string;
  children?: ReactNode;
}) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.emoji}>{emoji}</Text>
      <Text style={styles.title}>{title}</Text>
      {message ? <Text style={styles.message}>{message}</Text> : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    paddingHorizontal: space.xxl,
    paddingVertical: space.xxl,
    gap: space.sm,
  },
  emoji: {
    fontSize: 56,
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
});
