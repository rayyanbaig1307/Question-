import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  type ScrollViewInstance,
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

// Every mode gets the same amount of room, so they sit evenly spaced with the chosen one in the middle.
const SLOT_WIDTH = 96;

// The row of modes above the shutter, like the mode row on other camera apps: plain words over the camera,
// the chosen one bright and in the middle. Swipe it left or right, or tap a mode.
// A pink dot on a mode means there's something waiting for you there (today's dare not done, a drop to post).
export function ModeDial({ mode, onChange, dots }: {
  mode: CameraMode;
  onChange: (mode: CameraMode) => void;
  dots?: Partial<Record<CameraMode, boolean>>;
}) {
  const { width } = useWindowDimensions();
  const scroll = useRef<ScrollViewInstance>(null);
  const index = CAMERA_MODES.findIndex((item) => item.key === mode);
  // Empty room on both sides, so the first and last modes can sit in the middle of the screen too.
  const sidePadding = (width - SLOT_WIDTH) / 2;

  // Picked from somewhere else (e.g. a tap on a mode): glide the row so it's in the middle.
  useEffect(() => {
    scroll.current?.scrollTo({ x: index * SLOT_WIDTH, animated: true });
  }, [index]);

  function pick(next: CameraMode) {
    if (next === mode) return;
    Haptics.selectionAsync();
    onChange(next);
  }

  // When the row stops moving, whichever mode is closest to the middle wins.
  function settled(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const at = Math.round(event.nativeEvent.contentOffset.x / SLOT_WIDTH);
    pick(CAMERA_MODES[Math.max(0, Math.min(CAMERA_MODES.length - 1, at))].key);
  }

  return (
    <ScrollView
      ref={scroll}
      horizontal
      showsHorizontalScrollIndicator={false}
      // Swiping sideways here moves the row, not the Chat / Camera / Home pages underneath.
      nestedScrollEnabled
      snapToInterval={SLOT_WIDTH}
      decelerationRate="fast"
      contentOffset={{ x: index * SLOT_WIDTH, y: 0 }}
      contentContainerStyle={{ paddingHorizontal: sidePadding }}
      onMomentumScrollEnd={settled}
      style={styles.dial}>
      {CAMERA_MODES.map((item) => {
        const active = item.key === mode;
        return (
          <Pressable
            key={item.key}
            style={styles.slot}
            onPress={() => pick(item.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`${item.label} mode`}>
            <View>
              <Text style={[styles.modeText, active && styles.modeTextActive]} numberOfLines={1}>
                {item.emoji} {item.label}
              </Text>
              {dots?.[item.key] ? <View style={styles.dot} /> : null}
            </View>
            <View style={[styles.marker, active && styles.markerActive]} />
          </Pressable>
        );
      })}
    </ScrollView>
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
    width: SLOT_WIDTH,
    alignItems: 'center',
    gap: 5,
    paddingVertical: space.xs,
  },
  modeText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
    fontWeight: '800',
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowRadius: 4,
  },
  modeTextActive: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '900',
  },
  marker: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: 'transparent',
  },
  markerActive: {
    backgroundColor: colors.white,
  },
  dot: {
    position: 'absolute',
    top: -3,
    right: -9,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.pink,
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
