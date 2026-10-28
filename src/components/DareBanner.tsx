import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { Bouncy } from '@/components/Bouncy';
import { dareFor, todayDareDay } from '@/lib/dares';
import { colors, gradients, radius, space } from '@/theme';

// The little pink banner on the camera with today's dare. Tap it to open the Dare screen.
export function DareBanner({ onPress, done = false }: { onPress?: () => void; done?: boolean }) {
  const dare = dareFor(todayDareDay());

  const content = (
    <LinearGradient colors={gradients.brand} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.banner}>
      <Text style={styles.emoji}>{done ? '✅' : '🎯'}</Text>
      <View style={styles.text}>
        <Text style={styles.label}>{done ? 'DAILY DARE · DONE!' : 'DAILY DARE'}</Text>
        <Text style={styles.dare} numberOfLines={2}>
          {dare.text}
        </Text>
      </View>
      {onPress ? <Ionicons name="chevron-forward" size={18} color={colors.white} /> : null}
    </LinearGradient>
  );

  if (!onPress) return content;
  return (
    <Bouncy onPress={onPress} accessibilityRole="button" accessibilityLabel={`Daily dare: ${dare.text}`}>
      {content}
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
