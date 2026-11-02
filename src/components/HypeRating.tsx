import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';

import { Bouncy } from '@/components/Bouncy';
import { rateDare, HYPE_RATINGS, type DareHype, type HypeRatingKey } from '@/lib/dareChain';
import { friendlyError } from '@/lib/errors';
import { colors, radius, space } from '@/theme';

// Under a dare (or forfeit) post: three small buttons – 🔥 Iconic · 😬 Mid · 💀 Unhinged – no words on screen.
// Friends tap one to rate how bold the dare was; the most-picked one is highlighted.
// Ratings are anonymous – everyone sees the totals, nobody sees who picked what.
// `canVote` is false on your own posts and on strangers' posts (then it just shows the totals).
export function HypeRating({ postId, hype, canVote, onDark = false }: {
  postId: string;
  hype: DareHype;
  canVote: boolean;
  // Drawn over a photo instead of on the page background.
  onDark?: boolean;
}) {
  const [current, setCurrent] = useState(hype);
  // The most-picked rating (ties go to the bolder one), shown a little bigger.
  const top = [...HYPE_RATINGS].reverse().reduce((best, item) => (current[item.key] > current[best.key] ? item : best));
  const topKey = current[top.key] > 0 ? top.key : null;

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
      {HYPE_RATINGS.map((item) => (
        <Pill
          key={item.key}
          emoji={item.emoji}
          word={item.word}
          count={current[item.key]}
          on={current.mine === item.key}
          top={topKey === item.key}
          color={item.color}
          disabled={!canVote}
          onDark={onDark}
          onPress={() => rate(item.key)}
        />
      ))}
    </View>
  );
}

function Pill({ emoji, word, count, on, top, color, disabled, onDark, onPress }: {
  emoji: string;
  word: string;
  count: number;
  on: boolean;
  top: boolean;
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
      <Text style={[styles.emoji, top && styles.emojiTop]}>{emoji}</Text>
      {/* Just the emoji until someone picks it */}
      {count > 0 ? <Text style={[styles.count, (on || onDark) && styles.countOn]}>{count}</Text> : null}
    </Bouncy>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: 'transparent',
    backgroundColor: colors.card,
  },
  pillDark: {
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  emoji: {
    fontSize: 16,
  },
  emojiTop: {
    fontSize: 20,
  },
  count: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '800',
  },
  countOn: {
    color: colors.white,
  },
});
