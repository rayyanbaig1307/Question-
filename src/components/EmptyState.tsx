import { useEffect, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { colors, font, space } from '@/theme';

// A big floating emoji, a short funny line and (optionally) big buttons, for "nothing here yet" moments.
export function EmptyState({ emoji, title, message, children }: {
  emoji: string;
  title: string;
  message?: string;
  children?: ReactNode;
}) {
  // The emoji gently bobs up and down so the screen doesn't feel dead.
  const bob = useSharedValue(0);
  useEffect(() => {
    bob.set(withRepeat(withSequence(
      withTiming(-10, { duration: 900, easing: Easing.inOut(Easing.quad) }),
      withTiming(0, { duration: 900, easing: Easing.inOut(Easing.quad) }),
    ), -1));
  }, [bob]);
  const emojiStyle = useAnimatedStyle(() => ({ transform: [{ translateY: bob.get() }] }));

  return (
    <View style={styles.wrap}>
      <Animated.Text style={[styles.emoji, emojiStyle]}>{emoji}</Animated.Text>
      <Text style={styles.title}>{title}</Text>
      {message ? <Text style={styles.message}>{message}</Text> : null}
      {children ? <View style={styles.buttons}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    paddingHorizontal: space.xl,
    paddingVertical: space.xxl,
    gap: space.sm,
  },
  emoji: {
    fontSize: 64,
    marginBottom: space.sm,
  },
  title: {
    ...font.heading,
    fontSize: 22,
    textAlign: 'center',
  },
  message: {
    ...font.body,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 22,
  },
  buttons: {
    alignSelf: 'stretch',
    gap: space.md,
    marginTop: space.lg,
  },
});
