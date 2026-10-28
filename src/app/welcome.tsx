import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { colors, font, space } from '@/theme';

export default function Welcome() {
  const bob = useSharedValue(0);

  useEffect(() => {
    bob.set(withRepeat(withSequence(withTiming(-14, { duration: 900 }), withTiming(0, { duration: 900 })), -1));
  }, [bob]);

  const mascotStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: bob.get() }, { rotate: `${bob.get() / 2}deg` }],
  }));

  return (
    <LinearGradient colors={[colors.purple, colors.pink, colors.orange]} style={styles.fill}>
      <SafeAreaView style={styles.fill}>
        <View style={styles.hero}>
          <Animated.Text style={[styles.mascot, mascotStyle]}>👀</Animated.Text>
          <Text style={styles.title}>Peekaboo</Text>
          <Text style={styles.tagline}>Peek it. Share it.{'\n'}Gone in 24h – or forever on your profile.</Text>
        </View>
        <View style={styles.buttons}>
          <Button title="Create account" onPress={() => router.push('/sign-up')} />
          <Button
            title="I already have an account"
            variant="secondary"
            style={styles.secondary}
            onPress={() => router.push('/sign-in')}
          />
        </View>
      </SafeAreaView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  hero: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    paddingHorizontal: space.xl,
  },
  mascot: {
    fontSize: 96,
  },
  title: {
    ...font.hero,
    fontSize: 52,
    textShadowColor: 'rgba(0,0,0,0.25)',
    textShadowOffset: { width: 0, height: 4 },
    textShadowRadius: 10,
  },
  tagline: {
    ...font.body,
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
    lineHeight: 26,
    color: 'rgba(255,255,255,0.9)',
  },
  buttons: {
    paddingHorizontal: space.xl,
    paddingBottom: space.lg,
    gap: space.md,
  },
  secondary: {
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
});
