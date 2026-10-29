import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import {
  FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';

import { Bouncy } from '@/components/Bouncy';
import { dareFor, todayDareDay } from '@/lib/dares';
import { formatClock, lateLabel, type DropStatus } from '@/lib/drop';
import { colors, gradients, radius, space } from '@/theme';

// What the camera is for right now. Swipe the dial (or tap a mode) to change it, like camera modes in other apps.
export type CameraMode = 'photo' | 'dare' | 'drop' | 'guess';

export const CAMERA_MODES: { key: CameraMode; emoji: string; label: string }[] = [
  { key: 'photo', emoji: '📷', label: 'Photo' },
  { key: 'dare', emoji: '🎯', label: 'Dare' },
  { key: 'drop', emoji: '👀', label: 'Drop' },
  { key: 'guess', emoji: '🕵️', label: 'Guess Who' },
];

// Each mode chip is this wide, so the dial can snap one chip at a time and keep the chosen one in the middle.
const CHIP_WIDTH = 104;

// The row of modes above the shutter. Swipe it left or right; the one in the middle is what you'll post.
// A pink dot on a mode means there's something waiting for you there (today's dare not done, a drop to post).
export function ModeDial({ mode, onChange, dots }: {
  mode: CameraMode;
  onChange: (mode: CameraMode) => void;
  dots?: Partial<Record<CameraMode, boolean>>;
}) {
  const { width } = useWindowDimensions();
  const list = useRef<FlatList<(typeof CAMERA_MODES)[number]>>(null);
  const index = CAMERA_MODES.findIndex((item) => item.key === mode);
  // So the first and last chips can still sit in the middle of the screen.
  const sidePadding = (width - CHIP_WIDTH) / 2;

  // Picked from somewhere else (e.g. a tap on a chip): glide the dial to it.
  useEffect(() => {
    list.current?.scrollToOffset({ offset: index * CHIP_WIDTH, animated: true });
  }, [index]);

  function pick(next: CameraMode) {
    if (next === mode) return;
    Haptics.selectionAsync();
    onChange(next);
  }

  // When the dial stops moving, whichever chip is closest to the middle wins.
  function settled(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const at = Math.round(event.nativeEvent.contentOffset.x / CHIP_WIDTH);
    const next = CAMERA_MODES[Math.max(0, Math.min(CAMERA_MODES.length - 1, at))];
    pick(next.key);
  }

  return (
    <FlatList
      ref={list}
      horizontal
      data={CAMERA_MODES}
      keyExtractor={(item) => item.key}
      showsHorizontalScrollIndicator={false}
      // Swiping sideways here moves the dial, not the Chat / Camera / Home pages underneath.
      nestedScrollEnabled
      snapToInterval={CHIP_WIDTH}
      decelerationRate="fast"
      initialScrollIndex={index}
      getItemLayout={(_, i) => ({ length: CHIP_WIDTH, offset: CHIP_WIDTH * i, index: i })}
      contentContainerStyle={{ paddingHorizontal: sidePadding }}
      onMomentumScrollEnd={settled}
      style={styles.dial}
      renderItem={({ item }) => {
        const active = item.key === mode;
        return (
          <View style={styles.slot}>
            <Bouncy
              style={[styles.chip, active && styles.chipActive]}
              pressScale={0.92}
              onPress={() => pick(item.key)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`${item.label} mode`}>
              <Text style={styles.chipEmoji}>{item.emoji}</Text>
              <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>
                {item.label}
              </Text>
              {dots?.[item.key] ? <View style={styles.dot} /> : null}
            </Bouncy>
          </View>
        );
      }}
    />
  );
}

// One line above the dial that says what the chosen mode will do: today's dare, the drop countdown, and so on.
// Nothing is shown in plain Photo mode, so the camera stays clean.
export function ModeCaption({ mode, drop }: { mode: CameraMode; drop: DropStatus }) {
  const pulse = usePulse(mode === 'drop' && drop.kind === 'live');
  if (mode === 'photo') return null;

  if (mode === 'dare') {
    const dare = dareFor(todayDareDay());
    return (
      <Bouncy
        style={styles.caption}
        pressScale={0.96}
        onPress={() => router.push('/dare')}
        accessibilityRole="button"
        accessibilityLabel={`Today's dare: ${dare.text}. Opens the Dare screen`}>
        <LinearGradient colors={gradients.brand} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
        <Text style={styles.captionText} numberOfLines={2}>
          🎯 {dare.text}
        </Text>
        <Text style={styles.captionHint}>Tap for the rules · snap it to do the dare</Text>
      </Bouncy>
    );
  }

  if (mode === 'guess') {
    return (
      <Bouncy
        style={[styles.caption, styles.captionQuiet]}
        pressScale={0.96}
        onPress={() => router.push('/guess')}
        accessibilityRole="button"
        accessibilityLabel="Guess Who: posted without your name. Opens Guess Who">
        <Text style={styles.captionText} numberOfLines={2}>
          🕵️ Posted without your name · friends guess who it was
        </Text>
      </Bouncy>
    );
  }

  // Drop: waiting for today's drop, live (countdown), or late.
  if (drop.kind === 'waiting') {
    return (
      <View style={[styles.caption, styles.captionQuiet]}>
        <Text style={styles.captionText} numberOfLines={2}>
          👀 Today&apos;s drop hasn&apos;t happened yet · wait for the notification
        </Text>
      </View>
    );
  }
  if (drop.kind === 'live') {
    return (
      <Animated.View style={[styles.caption, pulse]}>
        <LinearGradient colors={[colors.red, colors.accent]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
        <Text style={styles.captionText}>👀 Peekaboo! {formatClock(drop.endsAt.getTime() - drop.now)} left</Text>
        <Text style={styles.captionHint}>Show what you&apos;re doing right now</Text>
      </Animated.View>
    );
  }
  const late = lateLabel(Math.floor((drop.now - drop.at.getTime()) / 1000));
  return (
    <View style={[styles.caption, styles.captionQuiet]}>
      <Text style={styles.captionText}>⏰ {late.text} · post anyway, it still counts</Text>
    </View>
  );
}

// A gentle heartbeat while the drop is live.
function usePulse(on: boolean) {
  const scale = useSharedValue(1);
  useEffect(() => {
    scale.set(on ? withRepeat(withSequence(withTiming(1.03, { duration: 500 }), withTiming(1, { duration: 500 })), -1) : 1);
  }, [on, scale]);
  return useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));
}

const styles = StyleSheet.create({
  dial: {
    flexGrow: 0,
  },
  slot: {
    width: CHIP_WIDTH,
    alignItems: 'center',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: space.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  chipActive: {
    backgroundColor: colors.white,
  },
  chipEmoji: {
    fontSize: 16,
  },
  chipText: {
    color: colors.white,
    fontSize: 13,
    fontWeight: '800',
  },
  chipTextActive: {
    color: colors.black,
  },
  dot: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.pink,
    borderWidth: 2,
    borderColor: colors.white,
  },
  caption: {
    alignSelf: 'center',
    maxWidth: '88%',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  captionQuiet: {
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  captionText: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '800',
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  captionHint: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
  },
});
