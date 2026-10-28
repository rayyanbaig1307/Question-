import { LinearGradient } from 'expo-linear-gradient';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { PostGrid } from '@/components/PostGrid';
import { ScreenHeader } from '@/components/ScreenHeader';
import { useMe } from '@/lib/auth';
import { dareFor, fetchDarePosts, formatCountdown, nextDareAt, todayDareDay } from '@/lib/dares';
import type { PostWithAuthor } from '@/lib/types';
import { colors, font, gradients, radius, space } from '@/theme';

// Today's dare, a countdown to the next one, and everyone's photos for it.
export default function DareScreen() {
  const { userId } = useMe();
  const [day, setDay] = useState(todayDareDay);
  const [posts, setPosts] = useState<{ day: string; list: PostWithAuthor[] } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const dare = dareFor(day);

  const load = useCallback(async () => {
    try {
      setPosts({ day, list: await fetchDarePosts(day) });
    } catch (error) {
      console.warn('Could not load dare posts', error);
      setPosts((current) => current ?? { day, list: [] });
    }
  }, [day]);

  // Load when the screen opens, and again when you come back after posting.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  const list = posts?.day === day ? posts.list : null;
  const iDidIt = list?.some((post) => post.user_id === userId) ?? false;
  const doTheDare = () => router.push({ pathname: '/camera', params: { dare: '1' } });

  const header = (
    <View style={styles.header}>
      <LinearGradient colors={gradients.brand} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.card}>
        <Text style={styles.label}>🎯 DARE #{dare.number} · TODAY</Text>
        <Text style={styles.dare}>{dare.text}</Text>
        <Countdown day={day} onNewDare={() => setDay(todayDareDay())} />
        <Button
          title={iDidIt ? 'Do it again 📸' : 'Do the dare 📸'}
          variant="secondary"
          onPress={doTheDare}
          style={styles.cardButton}
        />
      </LinearGradient>
      {iDidIt ? <Text style={styles.done}>✅ You did today&apos;s dare. Legend.</Text> : null}
      <Text style={styles.sectionTitle}>
        Everyone&apos;s dares today{list && list.length > 0 ? ` (${list.length})` : ''}
      </Text>
    </View>
  );

  return (
    <View style={styles.fill}>
      <ScreenHeader title="Daily Dare" />
      <PostGrid
        posts={list ?? []}
        header={header}
        hideDareBadge
        refreshing={refreshing}
        onRefresh={refresh}
        empty={
          list === null ? (
            <ActivityIndicator color={colors.accent} style={styles.loading} />
          ) : (
            <EmptyState emoji="🦗" title="Nobody has done it yet…" message="Be the first! Everyone else will see yours here.">
              <Button title="Do the dare 📸" onPress={doTheDare} />
            </EmptyState>
          )
        }
      />
    </View>
  );
}

// "New dare in 5h 03m 12s" – ticks every second. Lives in its own little piece so only it redraws.
function Countdown({ day, onNewDare }: { day: string; onNewDare: () => void }) {
  const [now, setNow] = useState(Date.now);
  const left = nextDareAt(day) - now;

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (left <= 0) onNewDare();
  }, [left, onNewDare]);

  return <Text style={styles.countdown}>⏰ New dare in {formatCountdown(left)}</Text>;
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    padding: space.lg,
    gap: space.md,
  },
  card: {
    borderRadius: radius.lg,
    padding: space.xl,
    gap: space.md,
    overflow: 'hidden',
  },
  label: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 1,
  },
  dare: {
    color: colors.white,
    fontSize: 28,
    fontWeight: '900',
    lineHeight: 34,
  },
  countdown: {
    color: colors.white,
    fontSize: 15,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  cardButton: {
    marginTop: space.sm,
  },
  done: {
    ...font.body,
    fontWeight: '800',
    textAlign: 'center',
  },
  sectionTitle: {
    ...font.label,
    textTransform: 'uppercase',
    marginTop: space.sm,
    marginLeft: space.xs,
  },
  loading: {
    marginTop: space.xl,
  },
});
