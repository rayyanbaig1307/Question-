import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, font, gradients, space } from '@/theme';

// The bar at the top of a screen: a round back button, a title, and an optional button on the right.
// It is drawn by the app itself (not the phone), so it always matches the app's colors.
export function ScreenHeader({ title, titleContent, right, onBack, showBack = true }: {
  title?: string;
  // Something richer than plain text in the middle (e.g. a picture + name).
  titleContent?: ReactNode;
  right?: ReactNode;
  onBack?: () => void;
  showBack?: boolean;
}) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.bar, { paddingTop: insets.top + space.sm }]}>
      <View style={styles.side}>
        {showBack ? <BackButton onPress={onBack ?? (() => router.back())} /> : null}
      </View>
      <View style={styles.middle}>
        {titleContent ?? (
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
        )}
      </View>
      <View style={[styles.side, styles.right]}>{right}</View>
    </View>
  );
}

export function BackButton({ onPress }: { onPress: () => void }) {
  return <RoundIconButton icon="chevron-back" label="Go back" onPress={onPress} />;
}

// A small dark round button with an icon (back, •••, …).
export function RoundIconButton({ icon, label, onPress }: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={10}
      onPress={() => {
        Haptics.selectionAsync();
        onPress();
      }}
      style={({ pressed }) => [styles.round, styles.back, pressed && styles.pressed]}>
      <Ionicons name={icon} size={icon === 'chevron-back' ? 24 : 20} color={colors.text} />
    </Pressable>
  );
}

// A small round button filled with the pink → purple brand colors.
export function BrandIconButton({ icon, label, onPress }: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={10}
      onPress={() => {
        Haptics.selectionAsync();
        onPress();
      }}
      style={({ pressed }) => [styles.round, pressed && styles.pressed]}>
      <LinearGradient colors={gradients.brand} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.gradient}>
        <Ionicons name={icon} size={20} color={colors.white} />
      </LinearGradient>
    </Pressable>
  );
}

const SIZE = 40;

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
    backgroundColor: colors.bg,
  },
  side: {
    width: 56,
  },
  right: {
    alignItems: 'flex-end',
  },
  middle: {
    flex: 1,
    alignItems: 'center',
  },
  title: {
    ...font.heading,
    fontSize: 18,
  },
  round: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    overflow: 'hidden',
  },
  back: {
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gradient: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    transform: [{ scale: 0.9 }],
    opacity: 0.85,
  },
});
