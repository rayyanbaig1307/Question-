import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { colors } from '@/theme';

type Props = {
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  size?: number;
  color?: string;
  background?: string;
  label: string;
  style?: StyleProp<ViewStyle>;
};

// A round button with just an icon (used over the camera and photos).
export function IconButton({
  icon,
  onPress,
  size = 44,
  color = colors.white,
  background = colors.overlay,
  label,
  style,
}: Props) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={() => {
        Haptics.selectionAsync();
        onPress();
      }}
      style={({ pressed }) => [
        styles.base,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: background },
        pressed && styles.pressed,
        style,
      ]}>
      <Ionicons name={icon} size={size * 0.5} color={color} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    transform: [{ scale: 0.9 }],
  },
});
