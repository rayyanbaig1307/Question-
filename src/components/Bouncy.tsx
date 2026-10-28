import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  type WithSpringConfig,
} from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// Pressing squishes quickly; letting go springs back with a tiny wobble.
const PRESS: WithSpringConfig = { damping: 20, stiffness: 450 };
const RELEASE: WithSpringConfig = { damping: 8, stiffness: 320 };

// A button that squishes down a little when you press it and bounces back when you let go.
export function Bouncy({ pressScale = 0.94, style, onPressIn, onPressOut, ...rest }: Omit<PressableProps, 'style'> & {
  // How small it gets while pressed (1 = no squish).
  pressScale?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));

  return (
    <AnimatedPressable
      {...rest}
      onPressIn={(event) => {
        scale.set(withSpring(pressScale, PRESS));
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        scale.set(withSpring(1, RELEASE));
        onPressOut?.(event);
      }}
      style={[style, animatedStyle]}
    />
  );
}

// A quick "pop" (grow, then settle back), e.g. for the heart when you like something.
export function usePop() {
  const scale = useSharedValue(1);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));
  const pop = () => scale.set(withSequence(withSpring(1.35, PRESS), withSpring(1, RELEASE)));
  return { style, pop };
}
