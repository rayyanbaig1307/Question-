import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { Avatar } from '@/components/Avatar';
import { useMe } from '@/lib/auth';
import { useStoryBadge, type StoryBadge } from '@/lib/storyRings';
import { colors, gradients } from '@/theme';

type Person = { id: string; avatar_path?: string | null; display_name?: string | null; username?: string | null };

type Props = {
  person: Person | null | undefined;
  size?: number;
  // What tapping the picture does when there's no story to watch (e.g. open their profile). Without it, the
  // picture then does nothing itself and a tap goes to whatever it sits in (a chat row, a profile link…).
  onPress?: () => void;
  onLongPress?: () => void;
  label?: string;
  // The screen already knows about their story (the profile page loads it itself).
  badge?: StoryBadge | null;
};

// A profile picture that shows when someone has a story you can watch, like Instagram:
// a glowing pink-purple ring = a new story (green = a close-friends story), a grey ring = you've watched it.
// Tapping the picture then opens their story.
export function StoryAvatar({ person, size = 40, onPress, onLongPress, label, badge: given }: Props) {
  const { userId } = useMe();
  const fromStore = useStoryBadge(userId, given === undefined ? person?.id : null);
  const badge = given === undefined ? fromStore : given;
  const name = person?.display_name || person?.username;

  if (!person || !badge) {
    const plain = <Avatar path={person?.avatar_path} name={name} size={size} />;
    return onPress || onLongPress ? (
      <Pressable onPress={onPress} onLongPress={onLongPress} accessibilityLabel={label} hitSlop={4}>
        {plain}
      </Pressable>
    ) : (
      plain
    );
  }

  // The ring and the gap inside it fit in the same space as the plain picture, so nothing around it moves.
  const ring = size >= 60 ? 3 : 2;
  const gap = size >= 60 ? 3 : 2;
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/stories/[user]', params: { user: person.id } })}
      onLongPress={onLongPress}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={person.id === userId ? 'Watch my story' : `Watch ${name ?? 'their'}'s story`}>
      <View style={{ width: size, height: size }}>
        {badge.allSeen ? null : <Glow size={size} close={badge.closeFriends} />}
        <LinearGradient
          colors={badge.allSeen ? [colors.border, colors.border] : badge.closeFriends ? [colors.green, colors.green] : gradients.brand}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[styles.center, { width: size, height: size, borderRadius: size / 2, padding: ring }]}>
          <View style={[styles.center, styles.gap, { borderRadius: size / 2, padding: gap }]}>
            <Avatar path={person.avatar_path} name={name} size={size - 2 * (ring + gap)} />
          </View>
        </LinearGradient>
      </View>
    </Pressable>
  );
}

// A soft halo behind the ring that slowly breathes (it stays still when the phone asks for less motion).
function Glow({ size, close }: { size: number; close: boolean }) {
  const still = useReducedMotion();
  const pulse = useSharedValue(0);

  useEffect(() => {
    if (still) return;
    pulse.set(withRepeat(withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.ease) }), -1, true));
    return () => cancelAnimation(pulse);
  }, [pulse, still]);

  const breathe = useAnimatedStyle(() => ({
    opacity: still ? 0.45 : 0.25 + 0.45 * pulse.get(),
    transform: [{ scale: still ? 1 : 0.94 + 0.1 * pulse.get() }],
  }));

  const spread = Math.max(4, Math.round(size * 0.12));
  const halo = size + spread * 2;
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.glow, { width: halo, height: halo, borderRadius: halo / 2, left: -spread, top: -spread }, breathe]}>
      <LinearGradient
        colors={close ? [colors.green, colors.green] : gradients.brand}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[StyleSheet.absoluteFill, { borderRadius: halo / 2 }]}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  gap: {
    backgroundColor: colors.bg,
  },
  glow: {
    position: 'absolute',
  },
});
