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

// What the camera is for right now. 'photo' is the plain camera: nothing selected, nothing on screen.
export type CameraMode = 'photo' | 'dare' | 'drop' | 'guess';

// The round mode bubbles, in the order they sit on the row. The plain camera is the empty spot before them.
export const CAMERA_MODES: { key: Exclude<CameraMode, 'photo'>; emoji: string; label: string }[] = [
  { key: 'dare', emoji: '🎯', label: 'Dare' },
  { key: 'drop', emoji: '👀', label: 'Drop' },
  { key: 'guess', emoji: '🕵️', label: 'Guess Who' },
];

// Everything on the row, including the empty spot for the plain camera at the start.
const SLOTS: CameraMode[] = ['photo', ...CAMERA_MODES.map((item) => item.key)];

// Every spot on the row is this wide, so the row snaps one spot at a time and the chosen one lands dead centre.
const SLOT_WIDTH = 76;
const BUBBLE = 46;
const BUBBLE_ACTIVE = 54;

// The row of round mode bubbles right above the shutter, like lenses on other camera apps.
// Swipe it sideways (or tap a bubble) to bring a mode over the shutter. Swipe back and the camera is plain again.
// A pink dot on a bubble means there's something waiting for you there (today's dare not done, a drop to post).
export function ModeDial({ mode, onChange, dots }: {
  mode: CameraMode;
  onChange: (mode: CameraMode) => void;
  dots?: Partial<Record<CameraMode, boolean>>;
}) {
  // The row stretches across the whole screen, so "the middle" is the middle of the screen – right over the shutter.
  const { width } = useWindowDimensions();
  const scroll = useRef<ScrollViewInstance>(null);
  const index = SLOTS.indexOf(mode);
  const sidePadding = (width - SLOT_WIDTH) / 2;

  // Picked from somewhere else (e.g. a tap on a bubble): glide the row so it's in the middle.
  useEffect(() => {
    scroll.current?.scrollTo({ x: index * SLOT_WIDTH, animated: true });
  }, [index]);

  function pick(next: CameraMode) {
    if (next === mode) return;
    Haptics.selectionAsync();
    onChange(next);
  }

  // When the row stops moving, whichever spot is closest to the middle wins.
  function settled(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const at = Math.round(event.nativeEvent.contentOffset.x / SLOT_WIDTH);
    pick(SLOTS[Math.max(0, Math.min(SLOTS.length - 1, at))]);
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
      style={[styles.dial, { width }]}>
      {/* The empty spot: plain camera, nothing to see */}
      <Pressable style={styles.slot} onPress={() => pick('photo')} accessibilityRole="tab" accessibilityLabel="Plain camera" />
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
            <View style={[styles.bubble, active && styles.bubbleActive]}>
              <Text style={[styles.bubbleEmoji, active && styles.bubbleEmojiActive]}>{item.emoji}</Text>
              {dots?.[item.key] ? <View style={styles.dot} /> : null}
            </View>
            <Text style={[styles.label, active && styles.labelActive]} numberOfLines={1}>
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

// One line above the row that says what the chosen mode will do: today's dare, the drop countdown, and so on.
// Nothing is shown on the plain camera, so it stays clean.
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
    // The camera's bottom area has side padding; pull the row back out so it's as wide as the screen.
    marginHorizontal: -space.lg,
  },
  slot: {
    width: SLOT_WIDTH,
    height: BUBBLE_ACTIVE + 20,
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 4,
  },
  bubble: {
    width: BUBBLE,
    height: BUBBLE,
    borderRadius: BUBBLE / 2,
    // The small bubbles sit a little lower, so all the bubbles share the same middle line.
    marginTop: (BUBBLE_ACTIVE - BUBBLE) / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.55)',
  },
  bubbleActive: {
    width: BUBBLE_ACTIVE,
    height: BUBBLE_ACTIVE,
    borderRadius: BUBBLE_ACTIVE / 2,
    marginTop: 0,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderWidth: 3,
    borderColor: colors.white,
  },
  bubbleEmoji: {
    fontSize: 21,
  },
  bubbleEmojiActive: {
    fontSize: 25,
  },
  label: {
    color: 'transparent',
    fontSize: 12,
    fontWeight: '900',
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowRadius: 4,
  },
  labelActive: {
    color: colors.white,
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
