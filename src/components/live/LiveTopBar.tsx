import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';

import { Avatar } from '@/components/Avatar';
import { IconButton } from '@/components/IconButton';
import { SafeEdge } from '@/components/SafeEdge';
import type { LivePerson } from '@/lib/lives';
import { colors, radius, space } from '@/theme';

// "4:05" or "1:02:09" – how long the live has been on.
export function liveClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
}

export function personName(person: LivePerson | null | undefined): string {
  return person?.display_name || person?.username || 'Your friend';
}

// The bar at the top of a live: who's on (one or two pictures and names), the pulsing LIVE pill with the
// time, 👀 how many are watching (the host can tap it to see who), ⋯ and ✕.
export function LiveTopBar({ host, cohost, onAirAt, onAir, viewers, onViewers, onMenu, onClose, closeLabel = 'Leave the live' }: {
  host: LivePerson | null;
  cohost?: LivePerson | null;
  // When the live went on air (the clock counts from here).
  onAirAt?: string | null;
  // Show the LIVE pill (on air right now).
  onAir: boolean;
  // How many friends are watching (null = don't show).
  viewers?: number | null;
  // The host: tap 👀 to see who's watching.
  onViewers?: () => void;
  onMenu?: () => void;
  onClose: () => void;
  closeLabel?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!onAir || !onAirAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [onAir, onAirAt]);
  const started = onAirAt ? Date.parse(onAirAt) : NaN;
  const seconds = Number.isFinite(started) ? (now - started) / 1000 : 0;

  const pulse = useSharedValue(1);
  useEffect(() => {
    pulse.set(onAir ? withRepeat(withSequence(withTiming(0.55, { duration: 700 }), withTiming(1, { duration: 700 })), -1) : 1);
  }, [onAir, pulse]);
  const dotStyle = useAnimatedStyle(() => ({ opacity: pulse.get() }));

  const names = cohost ? `${personName(host)} + ${personName(cohost)}` : personName(host);

  return (
    <SafeEdge edge="top" style={styles.bar} pointerEvents="box-none">
      <View style={styles.who}>
        <View style={styles.faces}>
          <Avatar path={host?.avatar_path} name={personName(host)} size={36} />
          {cohost ? (
            <View style={styles.second}>
              <Avatar path={cohost.avatar_path} name={personName(cohost)} size={28} />
            </View>
          ) : null}
        </View>
        <View style={styles.texts}>
          <Text style={styles.name} numberOfLines={1}>
            {names}
          </Text>
          {onAir ? (
            <View style={styles.pillRow}>
              <View style={styles.pill} accessibilityLabel={`Live, ${liveClock(seconds)}`}>
                <Animated.View style={[styles.dot, dotStyle]} />
                <Text style={styles.pillText}>LIVE</Text>
              </View>
              <Text style={styles.clock}>{liveClock(seconds)}</Text>
            </View>
          ) : null}
        </View>
      </View>
      <View style={styles.tools}>
        {viewers !== null && viewers !== undefined ? (
          onViewers ? (
            <Pressable style={styles.count} onPress={onViewers} accessibilityRole="button" accessibilityLabel={`${viewers} watching. See who`}>
              <Text style={styles.countText}>👀 {viewers}</Text>
            </Pressable>
          ) : (
            <View style={styles.count} accessibilityLabel={`${viewers} watching`}>
              <Text style={styles.countText}>👀 {viewers}</Text>
            </View>
          )
        ) : null}
        {onMenu ? <IconButton icon="ellipsis-horizontal" label="More" size={38} onPress={onMenu} /> : null}
        <IconButton icon="close" label={closeLabel} size={38} onPress={onClose} />
      </View>
    </SafeEdge>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    gap: space.sm,
  },
  who: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  faces: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  second: {
    marginLeft: -10,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: colors.black,
  },
  texts: {
    flexShrink: 1,
    gap: 2,
  },
  name: {
    color: colors.white,
    fontSize: 15,
    fontWeight: '800',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 4,
  },
  pillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.live,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.white,
  },
  pillText: {
    color: colors.white,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  clock: {
    color: colors.white,
    fontSize: 12,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  tools: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  count: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  countText: {
    color: colors.white,
    fontSize: 13,
    fontWeight: '800',
  },
});
