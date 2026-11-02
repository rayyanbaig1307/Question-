import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';

import { Bouncy } from '@/components/Bouncy';
import { useMe } from '@/lib/auth';
import { rateDare, HYPE_RATINGS, type DareHype, type HypeRatingKey } from '@/lib/dareChain';
import { friendlyError } from '@/lib/errors';
import { colors, radius, space } from '@/theme';

// It gets a verdict ("💀 Unhinged") once this many friends have rated it.
const VERDICT_AFTER = 3;

// Under a dare (or forfeit) post: friends rate how bold it was – 🔥 Iconic · 😬 Mid · 💀 Unhinged.
// Ratings are anonymous – everyone sees the totals, nobody sees who picked what.
// `canVote` is false on your own posts and on strangers' posts (then it just shows the totals).
export function HypeRating({ postId, authorId, hype, canVote, onDark = false }: {
  postId: string;
  // Who posted the dare (on your own post it says your friends are rating you).
  authorId: string;
  hype: DareHype;
  canVote: boolean;
  // Drawn over a photo (white text) instead of on the page background.
  onDark?: boolean;
}) {
  const { userId } = useMe();
  const [current, setCurrent] = useState(hype);
  const total = HYPE_RATINGS.reduce((sum, item) => sum + current[item.key], 0);
  // The most-picked rating wins (ties go to the bolder one).
  const top = [...HYPE_RATINGS].reverse().reduce((best, item) => (current[item.key] > current[best.key] ? item : best));
  const label =
    total >= VERDICT_AFTER
      ? `${top.emoji} ${top.word}`
      : authorId === userId
        ? 'Your friends rate your dare'
        : canVote
          ? 'How bold was it?'
          : 'Friends rate this dare';

  async function rate(key: HypeRatingKey) {
    if (!canVote) return;
    // Tap your own rating again to take it back.
    const next = current.mine === key ? null : key;
    const before = current;
    const counts = { iconic: current.iconic, mid: current.mid, unhinged: current.unhinged };
    if (current.mine) counts[current.mine] -= 1;
    if (next) counts[next] += 1;
    Haptics.selectionAsync();
    setCurrent({ ...counts, mine: next });
    try {
      await rateDare(postId, next);
    } catch (error) {
      setCurrent(before);
      Alert.alert('Could not rate', friendlyError(error));
    }
  }

  return (
    <View style={styles.row}>
      <Text style={[styles.label, onDark && styles.labelDark]} numberOfLines={1}>
        {label}
      </Text>
      {HYPE_RATINGS.map((item) => (
        <Pill
          key={item.key}
          emoji={item.emoji}
          word={item.word}
          count={current[item.key]}
          on={current.mine === item.key}
          color={item.color}
          disabled={!canVote}
          onDark={onDark}
          onPress={() => rate(item.key)}
        />
      ))}
    </View>
  );
}

function Pill({ emoji, word, count, on, color, disabled, onDark, onPress }: {
  emoji: string;
  word: string;
  count: number;
  on: boolean;
  color: string;
  disabled: boolean;
  onDark: boolean;
  onPress: () => void;
}) {
  return (
    <Bouncy
      style={[styles.pill, onDark && styles.pillDark, on && { backgroundColor: color, borderColor: color }]}
      pressScale={0.88}
      disabled={disabled}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on, disabled }}
      accessibilityLabel={`${word}: ${count} rating${count === 1 ? '' : 's'}${on ? ', your rating' : ''}`}>
      <Text style={[styles.pillText, (on || onDark) && styles.pillTextOn]}>
        {emoji} {count}
      </Text>
    </Bouncy>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  label: {
    flex: 1,
    color: colors.text,
    fontSize: 14,
    fontWeight: '800',
  },
  labelDark: {
    color: colors.white,
  },
  pill: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  pillDark: {
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderColor: 'rgba(255,255,255,0.35)',
  },
  pillText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '800',
  },
  pillTextOn: {
    color: colors.white,
  },
});
