import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { Bouncy } from '@/components/Bouncy';
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
  color,
  background = colors.overlay,
  label,
  style,
}: Props) {
  // On a plain card-colored button the icon uses the text color (so it shows in light mode too);
  // on dark see-through or colored buttons it's white.
  const iconColor = color ?? (background === colors.card || background === colors.surface ? colors.text : colors.white);
  return (
    <Bouncy
      accessibilityRole="button"
      pressScale={0.85}
      accessibilityLabel={label}
      hitSlop={8}
      onPress={() => {
        Haptics.selectionAsync();
        onPress();
      }}
      style={[styles.base, { width: size, height: size, borderRadius: size / 2, backgroundColor: background }, style]}>
      <Ionicons name={icon} size={size * 0.5} color={iconColor} />
    </Bouncy>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
