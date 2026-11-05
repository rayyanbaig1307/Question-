import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, Text } from 'react-native';

import { usePersonPlus } from '@/lib/plus';
import { radius, space } from '@/theme';

// The little "⭐ Plus" badge next to the name of someone who has Peekaboo+. Shows nothing for everyone else.
export function PlusBadge({ userId, small = false }: { userId: string | null | undefined; small?: boolean }) {
  const plus = usePersonPlus(userId);
  if (!plus) return null;
  return (
    <LinearGradient
      colors={GOLD}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.badge, small && styles.small]}
      accessible
      accessibilityLabel="Has Peekaboo+">
      <Text style={[styles.text, small && styles.smallText]}>⭐ Plus</Text>
    </LinearGradient>
  );
}

// Gold, the same in every theme, so the badge always looks special.
const GOLD = ['#FFD84D', '#FF9F1C'] as const;

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  small: {
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  text: {
    color: '#3A2300',
    fontSize: 12,
    fontWeight: '900',
  },
  smallText: {
    fontSize: 10,
  },
});
