import { Image } from 'expo-image';
import type { ImageStyle, StyleProp } from 'react-native';

import wordmarkNavy from '../../assets/images/wordmark-navy.png';
import wordmarkWhite from '../../assets/images/wordmark-white.png';
import { isDark } from '@/theme';

// The "peekaboo" name as a logo (the "oo" are the googly eyes). White letters for dark backgrounds,
// navy letters for light ones – the eyes look the same on both. Made by scripts/make-brand-assets.py.
const ASPECT = 1171 / 240;

export function Wordmark({ height = 30, onDark = isDark, style }: {
  height?: number;
  // True when it sits on a dark or colourful background (the welcome screen), whatever the theme.
  onDark?: boolean;
  style?: StyleProp<ImageStyle>;
}) {
  return (
    <Image
      source={onDark ? wordmarkWhite : wordmarkNavy}
      style={[{ height, width: Math.round(height * ASPECT) }, style]}
      contentFit="contain"
      accessibilityLabel="Peekaboo"
    />
  );
}
