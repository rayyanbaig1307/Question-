import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';

import { Bouncy } from '@/components/Bouncy';
import { voteDare, type DareVerdict } from '@/lib/dareChain';
import { friendlyError } from '@/lib/errors';
import { colors, radius, space } from '@/theme';

// It's a verdict once this many friends have voted.
const VERDICT_AFTER = 3;

// "Legit or cap?" under a dare (or forfeit) post: friends vote 🔥 legit (they really did it) or 🧢 cap.
// Votes are anonymous – everyone sees the totals, nobody sees who voted what.
// `canVote` is false on your own posts and on strangers' posts (then it just shows the totals).
export function LegitOrCap({ postId, verdict, canVote, onDark = false }: {
  postId: string;
  verdict: DareVerdict;
  canVote: boolean;
  // Drawn over a photo (white text) instead of on the page background.
  onDark?: boolean;
}) {
  const [current, setCurrent] = useState(verdict);
  const total = current.legit + current.cap;
  const label =
    total >= VERDICT_AFTER
      ? current.cap > current.legit
        ? '🧢 Friends say cap'
        : '🔥 Certified legit'
      : canVote
        ? 'Legit or cap?'
        : total === 0
          ? 'No votes yet'
          : 'Legit or cap?';

  async function vote(legit: boolean) {
    if (!canVote) return;
    // Tap your own vote again to take it back.
    const next = current.mine === legit ? null : legit;
    const before = current;
    const counts = { legit: current.legit, cap: current.cap };
    if (current.mine === true) counts.legit -= 1;
    if (current.mine === false) counts.cap -= 1;
    if (next === true) counts.legit += 1;
    if (next === false) counts.cap += 1;
    Haptics.selectionAsync();
    setCurrent({ ...counts, mine: next });
    try {
      await voteDare(postId, next);
    } catch (error) {
      setCurrent(before);
      Alert.alert('Could not vote', friendlyError(error));
    }
  }

  return (
    <View style={styles.row}>
      <Text style={[styles.label, onDark && styles.labelDark]} numberOfLines={1}>
        {label}
      </Text>
      <Pill
        emoji="🔥"
        word="Legit"
        count={current.legit}
        on={current.mine === true}
        color={colors.pink}
        disabled={!canVote}
        onDark={onDark}
        onPress={() => vote(true)}
      />
      <Pill
        emoji="🧢"
        word="Cap"
        count={current.cap}
        on={current.mine === false}
        color={colors.purple}
        disabled={!canVote}
        onDark={onDark}
        onPress={() => vote(false)}
      />
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
      accessibilityLabel={`${word}: ${count} vote${count === 1 ? '' : 's'}${on ? ', your vote' : ''}`}>
      <Text style={[styles.pillText, (on || onDark) && styles.pillTextOn]}>
        {emoji} {disabled ? '' : `${word} `}
        {count}
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
