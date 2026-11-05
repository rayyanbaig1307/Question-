import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useDropStatus } from '@/lib/drop';
import { usePlus } from '@/lib/plus';
import { shortDate, type PlusAllowances } from '@/lib/plusExtras';
import { colors, font, radius, space } from '@/theme';

// ⏰ Drop rewind (Peekaboo+): once a week, post a late drop without the "late" label.
// Only shows once today's drop is late. The server checks Plus and the weekly allowance again when the drop
// is posted – if it says no, the drop is simply posted late.
export function DropRewindOption({ allowances, selected, onChange }: {
  allowances: PlusAllowances;
  selected: boolean;
  onChange: (on: boolean) => void;
}) {
  const status = useDropStatus();
  const appPlus = usePlus();
  if (status.kind !== 'late') return null;
  const plus = appPlus || allowances.plus;
  const left = Math.max(0, allowances.rewindsLeft);
  const usable = plus && left > 0;

  const title = plus ? `⏰ Post without 'late' (${left} left this week)` : "⏰ Post without 'late'";
  const subtitle = !plus
    ? 'Once a week with Peekaboo+ ⭐'
    : left > 0
      ? 'Your friends won\'t see the "late" label on this one'
      : `You've used this week's. Next one on ${shortDate(allowances.rewindResetsAt)}`;

  return (
    <Pressable
      onPress={() => (usable ? onChange(!selected) : !plus ? router.push('/plus') : undefined)}
      disabled={plus && !usable}
      accessibilityRole={usable ? 'checkbox' : 'button'}
      accessibilityState={usable ? { checked: selected } : { disabled: plus && !usable }}
      style={({ pressed }) => [styles.option, selected && usable && styles.selected, pressed && styles.pressed]}>
      <View style={styles.text}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle} numberOfLines={2}>
          {subtitle}
        </Text>
      </View>
      {usable ? (
        <Ionicons name={selected ? 'checkmark-circle' : 'ellipse-outline'} size={28} color={selected ? colors.accent : colors.textFaint} />
      ) : !plus ? (
        <Text style={styles.star}>⭐</Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  selected: {
    borderColor: colors.accent,
  },
  pressed: {
    backgroundColor: colors.cardPressed,
  },
  text: {
    flex: 1,
    gap: 2,
  },
  title: {
    ...font.body,
    fontWeight: '800',
  },
  subtitle: {
    ...font.small,
  },
  star: {
    fontSize: 22,
  },
});
