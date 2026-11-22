import { Image, StyleSheet, View } from 'react-native';

import { WATERMARK, watermarkRect } from '@/lib/watermark';

import wordmarkWhite from '../../../assets/images/wordmark-white.png';

// ---------------------------------------------------------------------------
// Main Character Mode 🌆: the small white Peekaboo logo on the live poster and on the finished poster
// (docs/MAIN_CHARACTER.md). Only on screen, so screenshots and screen recordings carry it too. The saved and shared
// files get their own copy when they leave the app (lib/watermark.ts puts it on); the copies that stay inside
// Peekaboo (story, friends) never have one.
//
// It sits at the same spot as on the saved file (top left, lib/watermark.ts watermarkRect), measured on the part of
// the poster you can see. It can't be tapped and VoiceOver skips it.
// ---------------------------------------------------------------------------

// The part of the screen that shows the poster (screen points).
export type ShownArea = { x: number; y: number; width: number; height: number };

export function ScreenWordmark({ area }: { area: ShownArea }) {
  // Nothing to place it on yet (the size isn't known), or a size that makes no sense.
  if (!(area.width > 0) || !(area.height > 0) || !Number.isFinite(area.x) || !Number.isFinite(area.y)) return null;
  const spot = watermarkRect(area.width, area.height);
  if (![spot.x, spot.y, spot.width, spot.height].every(Number.isFinite)) return null;
  return (
    <View
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.spot, { left: area.x + spot.x, top: area.y + spot.y, width: spot.width, height: spot.height, opacity: WATERMARK.opacity }]}>
      <Image source={wordmarkWhite} style={styles.logo} resizeMode="contain" accessible={false} />
    </View>
  );
}

const styles = StyleSheet.create({
  spot: {
    position: 'absolute',
  },
  logo: {
    width: '100%',
    height: '100%',
  },
});
