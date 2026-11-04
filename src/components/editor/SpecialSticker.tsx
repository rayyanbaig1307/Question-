import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withSpring, withTiming } from 'react-native-reanimated';

import { colors } from '@/theme';

// Peekaboo's own stickers, drawn by the app (no pictures needed).
export const SPECIAL_STICKERS = ['googly-eyes', 'googly-eye', 'peekaboo', 'peek-bubble', 'i-see-you', 'caught'] as const;
export type SpecialStickerId = (typeof SPECIAL_STICKERS)[number];

export function SpecialSticker({ id, small = false }: { id: string; small?: boolean }) {
  // The picker shows them at half size.
  const size = small ? 0.5 : 1;
  switch (id) {
    case 'googly-eyes':
      return (
        <View style={[styles.eyes, { gap: 6 * size }]}>
          <GooglyEye size={70 * size} look={small ? { x: 0.35, y: 0.4 } : undefined} />
          <GooglyEye size={70 * size} look={small ? { x: -0.2, y: 0.45 } : undefined} />
        </View>
      );
    case 'googly-eye':
      return <GooglyEye size={110 * size} look={small ? { x: 0.3, y: -0.35 } : undefined} />;
    case 'peekaboo':
      return (
        <LinearGradient
          colors={[colors.pink, colors.purple]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[styles.logo, { paddingHorizontal: 18 * size, paddingVertical: 8 * size, borderRadius: 22 * size }]}>
          <Text style={[styles.logoText, { fontSize: 34 * size }]}>PEEKABOO 👀</Text>
        </LinearGradient>
      );
    case 'peek-bubble':
      return (
        <View style={styles.bubbleWrap}>
          <View style={[styles.bubble, { paddingHorizontal: 20 * size, paddingVertical: 10 * size, borderRadius: 28 * size }]}>
            <Text style={[styles.bubbleText, { fontSize: 36 * size }]}>PEEK!</Text>
          </View>
          <View style={[styles.tail, { width: 22 * size, height: 22 * size, marginTop: -13 * size, marginLeft: 26 * size }]} />
        </View>
      );
    case 'i-see-you':
      return (
        <View style={[styles.note, { padding: 12 * size, borderRadius: 6 * size }]}>
          <Text style={[styles.noteText, { fontSize: 26 * size }]}>I SEE{'\n'}YOU 👁️</Text>
        </View>
      );
    case 'caught':
      return (
        <View style={[styles.stamp, { paddingHorizontal: 16 * size, paddingVertical: 6 * size, borderWidth: 4 * size, borderRadius: 12 * size }]}>
          <Text style={[styles.stampText, { fontSize: 30 * size }]}>CAUGHT 📸</Text>
        </View>
      );
    default:
      return null;
  }
}

// A cartoon googly eye: a white ball with a black pupil looking somewhere (x/y from -1 to 1).
// On a photo each eye looks a random way, and the pupil jiggles into place when it appears – like the real thing.
function GooglyEye({ size, look }: { size: number; look?: { x: number; y: number } }) {
  const pupil = size * 0.46;
  const room = (size - pupil) / 2 - size * 0.06;
  const [target] = useState(() => look ?? randomLook());
  const x = useSharedValue(look ? target.x : 0);
  const y = useSharedValue(look ? target.y : -0.9);

  useEffect(() => {
    if (look) return;
    const wobbly = { damping: 4, stiffness: 140, mass: 0.6 };
    x.set(withSequence(withTiming(-target.x * 0.6, { duration: 90 }), withSpring(target.x, wobbly)));
    y.set(withSpring(target.y, wobbly));
  }, [look, target, x, y]);

  const pupilStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() * room }, { translateY: y.get() * room }],
  }));

  return (
    <View style={[styles.eye, { width: size, height: size, borderRadius: size / 2, borderWidth: Math.max(2, size * 0.05) }]}>
      <Animated.View
        style={[{ width: pupil, height: pupil, borderRadius: pupil / 2, backgroundColor: colors.black }, pupilStyle]}>
        <View style={[styles.shine, { width: pupil * 0.28, height: pupil * 0.28, borderRadius: pupil * 0.14 }]} />
      </Animated.View>
    </View>
  );
}

// Somewhere along the bottom half of the eye, like a pupil that's fallen down (always inside the eye).
function randomLook() {
  const angle = Math.PI * (0.15 + Math.random() * 0.7);
  const reach = 0.55 + Math.random() * 0.4;
  return { x: Math.cos(angle) * reach, y: Math.sin(angle) * reach };
}

const styles = StyleSheet.create({
  eyes: {
    flexDirection: 'row',
  },
  eye: {
    backgroundColor: colors.white,
    borderColor: colors.black,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shine: {
    position: 'absolute',
    top: '18%',
    left: '22%',
    backgroundColor: colors.white,
  },
  logo: {
    transform: [{ rotate: '-6deg' }],
  },
  logoText: {
    color: colors.white,
    fontWeight: '900',
    letterSpacing: 1,
    textShadowColor: 'rgba(0,0,0,0.25)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 4,
  },
  bubbleWrap: {
    alignItems: 'flex-start',
  },
  bubble: {
    backgroundColor: colors.white,
    borderWidth: 3,
    borderColor: colors.black,
  },
  bubbleText: {
    color: colors.pink,
    fontWeight: '900',
  },
  tail: {
    backgroundColor: colors.white,
    borderRightWidth: 3,
    borderBottomWidth: 3,
    borderColor: colors.black,
    transform: [{ rotate: '45deg' }],
  },
  note: {
    backgroundColor: colors.yellow,
    transform: [{ rotate: '4deg' }],
    shadowColor: colors.black,
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  noteText: {
    color: colors.black,
    fontWeight: '900',
    textAlign: 'center',
  },
  stamp: {
    borderColor: colors.purple,
    backgroundColor: 'rgba(255,255,255,0.85)',
    transform: [{ rotate: '-10deg' }],
  },
  stampText: {
    color: colors.purple,
    fontWeight: '900',
    letterSpacing: 2,
  },
});
