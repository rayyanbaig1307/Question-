import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useEffect, useEffectEvent } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, {
  FadeInUp,
  FadeOutUp,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { Bouncy } from '@/components/Bouncy';
import { dareFor, todayDareDay } from '@/lib/dares';
import { colors, gradients, radius, space } from '@/theme';

// How long the banner stays before sliding away by itself.
const AUTO_HIDE_MS = 6000;

// Today's dare, popping down at the top of the camera like a notification.
// It slides away by itself after a few seconds, or when you swipe it up or tap it.
export function DareBanner({ onPress, onDismiss }: {
  // Tapping opens the Dare screen (leave out to just show the dare as a reminder).
  onPress?: () => void;
  onDismiss: () => void;
}) {
  const dare = dareFor(todayDareDay());
  const lift = useSharedValue(0);
  const speed = useSharedValue(0);

  const dismiss = useEffectEvent(onDismiss);
  useEffect(() => {
    const timer = setTimeout(() => dismiss(), AUTO_HIDE_MS);
    return () => clearTimeout(timer);
  }, []);

  // Swipe up to get rid of it (sideways swipes still move between Chat, Camera and Stories).
  const swipe = usePanGesture({
    activeOffsetY: [-8, 1000],
    failOffsetX: [-20, 20],
    onUpdate: (event) => {
      'worklet';
      lift.set(Math.min(0, event.translationY));
      speed.set(event.velocityY);
    },
    onDeactivate: () => {
      'worklet';
      if (lift.get() < -30 || speed.get() < -500) {
        lift.set(withTiming(-160, { duration: 180 }, () => scheduleOnRN(onDismiss)));
      } else {
        lift.set(withSpring(0));
      }
    },
  });

  const liftStyle = useAnimatedStyle(() => ({
    opacity: 1 + lift.get() / 160,
    transform: [{ translateY: lift.get() }],
  }));

  const content = (
    <LinearGradient colors={gradients.brand} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.banner}>
      <Text style={styles.emoji}>🎯</Text>
      <View style={styles.text}>
        <Text style={styles.label}>DAILY DARE</Text>
        <Text style={styles.dare} numberOfLines={2}>
          {dare.text}
        </Text>
      </View>
      {onPress ? <Ionicons name="chevron-forward" size={18} color={colors.white} /> : null}
    </LinearGradient>
  );

  return (
    <Animated.View entering={FadeInUp.springify().damping(14)} exiting={FadeOutUp.duration(250)}>
      <GestureDetector gesture={swipe}>
        <Animated.View style={liftStyle}>
          {onPress ? (
            <Bouncy onPress={onPress} accessibilityRole="button" accessibilityLabel={`Daily dare: ${dare.text}`}>
              {content}
            </Bouncy>
          ) : (
            content
          )}
        </Animated.View>
      </GestureDetector>
    </Animated.View>
  );
}

// The pill at the top of the camera: "🎯 Today's dare" and the dare itself. Tap it to open the Dare screen.
// A pink dot means you haven't done today's dare yet; a ✅ means you have.
// `compact` is the small "🎯 Dare" chip for the home camera, so the screen stays clean.
export function DarePill({ done, compact = false }: { done: boolean | null; compact?: boolean }) {
  const dare = dareFor(todayDareDay());
  return (
    <Bouncy
      style={[styles.pill, compact && styles.pillCompact]}
      pressScale={0.95}
      onPress={() => {
        Haptics.selectionAsync();
        router.push('/dare');
      }}
      accessibilityRole="button"
      accessibilityLabel={`Today's dare: ${dare.text}${done ? ' – done' : ''}`}>
      <LinearGradient colors={gradients.brand} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      <Text style={styles.pillLabel}>{compact ? '🎯 Dare' : "🎯 Today's dare"}</Text>
      {compact ? null : (
        <Text style={styles.pillText} numberOfLines={1}>
          {dare.text}
        </Text>
      )}
      {done ? <Text style={styles.pillCheck}>✅</Text> : null}
      {done === false ? <View style={styles.pillDot} /> : null}
    </Bouncy>
  );
}

// The "🎯 Dare" tag on a photo that was someone's answer to a Daily Dare.
// Tapping it on today's dare opens the Dare screen.
export function DareTag({ day }: { day: string }) {
  const isToday = day === todayDareDay();
  return (
    <Bouncy
      style={styles.tag}
      disabled={!isToday}
      onPress={() => router.push('/dare')}
      accessibilityRole={isToday ? 'button' : 'text'}>
      <Text style={styles.tagText} numberOfLines={2}>
        <Text style={styles.tagLabel}>🎯 Dare </Text>
        {dareFor(day).text}
      </Text>
    </Bouncy>
  );
}

const styles = StyleSheet.create({
  tag: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,79,154,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(255,79,154,0.5)',
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: 6,
  },
  tagText: {
    color: colors.white,
    fontSize: 13,
    fontWeight: '600',
  },
  tagLabel: {
    color: colors.accent,
    fontWeight: '900',
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    alignSelf: 'stretch',
    paddingLeft: space.md,
    paddingRight: space.lg,
    paddingVertical: 10,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  pillCompact: {
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingRight: space.lg + 4,
  },
  pillLabel: {
    color: colors.white,
    fontSize: 13,
    fontWeight: '900',
  },
  pillText: {
    flexShrink: 1,
    color: 'rgba(255,255,255,0.9)',
    fontSize: 13,
    fontWeight: '600',
  },
  pillCheck: {
    fontSize: 13,
  },
  pillDot: {
    position: 'absolute',
    top: 6,
    right: 8,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.white,
    borderWidth: 2,
    borderColor: colors.accent,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  emoji: {
    fontSize: 22,
  },
  text: {
    flexShrink: 1,
    gap: 1,
  },
  label: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1,
  },
  dare: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '800',
  },
});
