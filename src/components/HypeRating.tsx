import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';

import { Bouncy } from '@/components/Bouncy';
import { rateDare, HYPE_RATINGS, type DareHype, type HypeRatingKey } from '@/lib/dareChain';
import { friendlyError } from '@/lib/errors';
import { colors, radius, space } from '@/theme';

// Under a dare (or forfeit) post: one rounded bar split in three – 🔥 Iconic | 😬 Mid | 💀 Unhinged.
// Friends tap one to rate how bold the dare was; the one you picked fills with its colour.
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
    <View style={[styles.bar, onDark && styles.barDark]}>
      {HYPE_RATINGS.map((item) => (
        <Segment
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

function Segment({ emoji, word, count, on, color, disabled, onDark, onPress }: {
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
      style={[styles.segment, on && { backgroundColor: color }]}
      pressScale={0.94}
      disabled={disabled}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on, disabled }}
      accessibilityLabel={`${word}: ${count} rating${count === 1 ? '' : 's'}${on ? ', your rating' : ''}`}>
      <Text style={[styles.word, (on || onDark) && styles.wordOn]} numberOfLines={1}>
        {emoji} {word}
        {/* The number only shows once someone has picked it */}
        {count > 0 ? <Text style={[styles.count, (on || onDark) && styles.countOn]}>{`  ${count}`}</Text> : null}
      </Text>
    </Bouncy>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    padding: 3,
    gap: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.card,
  },
  barDark: {
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 7,
    paddingHorizontal: space.xs,
    borderRadius: radius.pill,
  },
  word: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
  },
  wordOn: {
    color: colors.white,
  },
  count: {
    color: colors.textMuted,
    fontWeight: '800',
  },
  countOn: {
    color: 'rgba(255,255,255,0.8)',
  },
});
