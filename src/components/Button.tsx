import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { ActivityIndicator, Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radius, space } from '@/theme';

type Variant = 'primary' | 'secondary' | 'pink' | 'danger' | 'ghost';

type Props = {
  title: string;
  onPress: () => void;
  variant?: Variant;
  icon?: keyof typeof Ionicons.glyphMap;
  loading?: boolean;
  disabled?: boolean;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
};

const backgrounds: Record<Variant, string> = {
  primary: colors.yellow,
  secondary: colors.card,
  pink: colors.pink,
  danger: colors.red,
  ghost: 'transparent',
};

const textColors: Record<Variant, string> = {
  primary: colors.black,
  secondary: colors.text,
  pink: colors.white,
  danger: colors.white,
  ghost: colors.textMuted,
};

// A big, friendly, rounded button.
export function Button({ title, onPress, variant = 'primary', icon, loading, disabled, small, style }: Props) {
  const inactive = disabled || loading;
  const textColor = textColors[variant];

  return (
    <Pressable
      accessibilityRole="button"
      disabled={inactive}
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      style={({ pressed }) => [
        styles.base,
        small && styles.small,
        { backgroundColor: backgrounds[variant] },
        pressed && styles.pressed,
        inactive && styles.inactive,
        style,
      ]}>
      {loading ? (
        <ActivityIndicator color={textColor} />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={small ? 16 : 20} color={textColor} /> : null}
          <Text style={[styles.text, small && styles.smallText, { color: textColor }]}>{title}</Text>
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 54,
    borderRadius: radius.pill,
    paddingHorizontal: space.xl,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
  },
  small: {
    minHeight: 38,
    paddingHorizontal: space.lg,
  },
  pressed: {
    transform: [{ scale: 0.97 }],
    opacity: 0.9,
  },
  inactive: {
    opacity: 0.5,
  },
  text: {
    fontSize: 17,
    fontWeight: '800',
  },
  smallText: {
    fontSize: 14,
  },
});
