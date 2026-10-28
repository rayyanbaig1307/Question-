import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';

import { Bouncy } from '@/components/Bouncy';
import { DROP_WINDOW_MS, formatClock, lateLabel, useDropStatus } from '@/lib/drop';
import { colors, radius, space } from '@/theme';

// A gentle heartbeat, so the drop pill catches your eye.
function usePulse() {
  const scale = useSharedValue(1);
  useEffect(() => {
    scale.set(withRepeat(withSequence(withTiming(1.04, { duration: 500 }), withTiming(1, { duration: 500 })), -1));
  }, [scale]);
  return useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));
}

// On the camera, once today's drop has happened and you haven't posted yours:
// "👀 Peekaboo! 1:42 left" (pulsing), or later "👀 Post today's drop – you're late". Tap it to open the drop camera.
export function DropPill() {
  const status = useDropStatus();
  const pulse = usePulse();
  if (status.kind === 'waiting') return null;
  const live = status.kind === 'live';

  return (
    <Animated.View style={[styles.stretch, live && pulse]}>
      <Bouncy
        style={styles.pill}
        pressScale={0.95}
        onPress={() => {
          Haptics.selectionAsync();
          router.push({ pathname: '/camera', params: { drop: '1' } });
        }}
        accessibilityRole="button"
        accessibilityLabel={live ? 'Peekaboo drop is live, post now' : "Post today's Peekaboo drop"}>
        <LinearGradient
          colors={live ? [colors.red, colors.accent] : [colors.card, colors.card]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <Text style={styles.pillText} numberOfLines={1}>
          {live ? `👀 Peekaboo! ${formatClock(status.endsAt.getTime() - status.now)} left · tap to post` : "👀 Post today's drop · you're late"}
        </Text>
      </Bouncy>
    </Animated.View>
  );
}

// At the top of the drop camera: the 2-minute countdown, or how late you are.
export function DropTimer() {
  const status = useDropStatus();
  const pulse = usePulse();

  if (status.kind === 'waiting') {
    return (
      <View style={[styles.timer, styles.timerQuiet]}>
        <Text style={styles.timerSmall}>Today&apos;s drop hasn&apos;t happened yet – wait for the 👀 notification!</Text>
      </View>
    );
  }
  if (status.kind === 'live') {
    const left = status.endsAt.getTime() - status.now;
    return (
      <Animated.View style={[styles.timer, pulse]}>
        <LinearGradient colors={[colors.red, colors.accent]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
        <Text style={styles.timerBig}>⏱ {formatClock(left)}</Text>
        <Text style={styles.timerSmall}>Peekaboo! Show what you&apos;re doing 👀</Text>
        <View style={styles.track}>
          <View style={[styles.bar, { width: `${(left / DROP_WINDOW_MS) * 100}%` }]} />
        </View>
      </Animated.View>
    );
  }
  const late = lateLabel(Math.floor((status.now - status.at.getTime()) / 1000));
  return (
    <View style={[styles.timer, styles.timerQuiet]}>
      <Text style={styles.timerBig}>⏰ {late.text}</Text>
      <Text style={styles.timerSmall}>Post anyway – it still counts!</Text>
    </View>
  );
}

// The little badge on a drop post: "👀 On time" or "⏰ Late by 3h".
export function DropBadge({ lateSeconds }: { lateSeconds: number }) {
  const late = lateLabel(lateSeconds);
  return (
    <View style={[styles.badge, late.onTime ? styles.badgeOnTime : styles.badgeLate]}>
      <Text style={[styles.badgeText, late.onTime && styles.badgeTextOnTime]}>
        {late.onTime ? '👀 On time' : `⏰ ${late.text}`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  stretch: {
    alignSelf: 'stretch',
  },
  pill: {
    alignSelf: 'stretch',
    paddingHorizontal: space.lg,
    paddingVertical: 10,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  pillText: {
    color: colors.white,
    fontSize: 13,
    fontWeight: '900',
  },
  timer: {
    alignSelf: 'stretch',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  timerQuiet: {
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  timerBig: {
    color: colors.white,
    fontSize: 26,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  timerSmall: {
    color: colors.white,
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
  },
  track: {
    alignSelf: 'stretch',
    height: 4,
    borderRadius: 2,
    marginTop: space.sm,
    backgroundColor: 'rgba(255,255,255,0.3)',
    overflow: 'hidden',
  },
  bar: {
    height: 4,
    backgroundColor: colors.white,
  },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  badgeOnTime: {
    backgroundColor: colors.green,
  },
  badgeLate: {
    backgroundColor: colors.card,
  },
  badgeText: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '900',
  },
  badgeTextOnTime: {
    color: colors.black,
  },
});
