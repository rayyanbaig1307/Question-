import { useEffect } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

// An emoji that floats up the screen and fades away (story reactions, and hearts on a live 🔴).
// `index` spreads several of them out sideways and makes each one a little slower than the last.
export function FloatingEmoji({ emoji, index, rise: height = 320, size = 44, onDone }: {
  emoji: string;
  index: number;
  // How far up it floats.
  rise?: number;
  size?: number;
  // Called once it has faded away (so a list of them can drop it).
  onDone?: () => void;
}) {
  const rise = useSharedValue(0);
  const duration = 1100 + index * 120;
  useEffect(() => {
    rise.set(withTiming(1, { duration, easing: Easing.out(Easing.quad) }));
    if (!onDone) return;
    const timer = setTimeout(onDone, duration + 50);
    return () => clearTimeout(timer);
  }, [rise, duration, onDone]);
  const drift = (index - 2.5) * 28;
  const style = useAnimatedStyle(() => ({
    opacity: 1 - rise.get(),
    transform: [
      { translateX: drift * rise.get() },
      { translateY: -height * rise.get() - index * 12 },
      { scale: 0.8 + rise.get() * (index === 0 ? 1.4 : 0.6) },
    ],
  }));
  return <Animated.Text style={[styles.floating, { fontSize: size }, style]}>{emoji}</Animated.Text>;
}

// A handful of the emoji you tapped float up the screen and fade away.
export function ReactionBurst({ emoji, style }: { emoji: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={style} pointerEvents="none">
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <FloatingEmoji key={index} emoji={emoji} index={index} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  floating: {
    position: 'absolute',
  },
});
