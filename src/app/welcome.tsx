import { Image } from 'expo-image';
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

import logoEyes from '../../assets/images/logo-eyes.png';
import { Button } from '@/components/Button';
import { SafeScreen } from '@/components/SafeEdge';
import { font, space } from '@/theme';

// The same pink → purple as the app icon.
const BRAND = ['#FE59A5', '#E469C7', '#8650DB'] as const;

export default function Welcome() {
  const bob = useSharedValue(0);

  useEffect(() => {
    bob.set(withRepeat(withSequence(withTiming(-14, { duration: 900 }), withTiming(0, { duration: 900 })), -1));
  }, [bob]);

  const mascotStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: bob.get() }, { rotate: `${bob.get() / 2}deg` }],
  }));

  return (
    <LinearGradient colors={BRAND} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.fill}>
      <SafeScreen style={styles.fill}>
        <View style={styles.hero}>
          <Animated.View style={mascotStyle}>
            <Image source={logoEyes} style={styles.mascot} contentFit="contain" accessibilityLabel="Peekaboo eyes" />
          </Animated.View>
          {/* Plain letters here – the big eyes above are the logo, no need for them twice. */}
          <Text style={styles.title}>peekaboo</Text>
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
      </SafeScreen>
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
    width: 190,
    height: 152,
    marginBottom: space.sm,
  },
  title: {
    ...font.hero,
    color: '#FFFFFF',
    fontSize: 52,
    letterSpacing: -2,
    textShadowColor: 'rgba(0,0,0,0.2)',
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
