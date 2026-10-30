import { LinearGradient } from 'expo-linear-gradient';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { PostGrid } from '@/components/PostGrid';
import { ScreenHeader } from '@/components/ScreenHeader';
import { Avatar } from '@/components/Avatar';
import { useMe } from '@/lib/auth';
import { fetchDareChain, MAX_DARES_PER_DAY, nominationState, timeLeft, type DareChain, type Nomination } from '@/lib/dareChain';
import { DARE_RULES, dareFor, fetchDarePosts, formatCountdown, nextDareAt, todayDareDay } from '@/lib/dares';
import type { PostWithAuthor } from '@/lib/types';
import { colors, font, gradients, radius, space } from '@/theme';

// Today's dare, a countdown to the next one, and everyone's photos for it.
export default function DareScreen() {
  const { userId } = useMe();
  const [day, setDay] = useState(todayDareDay);
  const [posts, setPosts] = useState<{ day: string; list: PostWithAuthor[] } | null>(null);
  // Dares you were given and dares you gave today.
  const [chain, setChain] = useState<DareChain>({ received: [], sent: [] });
  const [refreshing, setRefreshing] = useState(false);
  const dare = dareFor(day);

  const load = useCallback(async () => {
    try {
      const [list, loadedChain] = await Promise.all([fetchDarePosts(day), fetchDareChain(userId, day).catch(() => null)]);
      setPosts({ day, list });
      if (loadedChain) setChain(loadedChain);
    } catch (error) {
      console.warn('Could not load dare posts', error);
      setPosts((current) => current ?? { day, list: [] });
    }
  }, [day, userId]);

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
  const openForMe = chain.received.filter((n) => nominationState(n) === 'open');
  const canDareMore = iDidIt && chain.sent.length < MAX_DARES_PER_DAY;

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
        <Text style={styles.rules}>{DARE_RULES}</Text>
      </LinearGradient>
      {iDidIt ? <Text style={styles.done}>✅ You did today&apos;s dare. Legend.</Text> : null}

      {/* Dares you were given: who dared you and how long you've got */}
      {chain.received.length > 0 ? (
        <View style={styles.chainBox}>
          <Text style={styles.chainTitle}>😈 Dared you today</Text>
          {chain.received.map((n) => (
            <ChainRow key={n.id} person={n.from} nomination={n} mine={false} />
          ))}
          {openForMe.length > 0 && !iDidIt ? (
            <Text style={styles.chainHint}>Do the dare before the clock runs out – or it&apos;s a forfeit 💀</Text>
          ) : null}
        </View>
      ) : null}

      {/* Dares you gave, and the button to give more */}
      {chain.sent.length > 0 || canDareMore ? (
        <View style={styles.chainBox}>
          <Text style={styles.chainTitle}>🔗 Your dare chain</Text>
          {chain.sent.map((n) => (
            <ChainRow key={n.id} person={n.to} nomination={n} mine />
          ))}
          {canDareMore ? (
            <Button
              title={chain.sent.length > 0 ? `Dare more friends (${MAX_DARES_PER_DAY - chain.sent.length} left)` : 'Dare your friends 😈'}
              icon="flame"
              small
              onPress={() => router.push('/dare-chain')}
            />
          ) : null}
        </View>
      ) : null}
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

// One person in your dare chain: who, and where their dare stands (ticking clock, done, or ran out).
function ChainRow({ person, nomination, mine }: { person: Nomination['from']; nomination: Nomination; mine: boolean }) {
  const state = nominationState(nomination);
  const name = person.display_name || person.username;
  const status =
    state === 'done' ? '✅ Did it' : state === 'open' ? `⏳ ${timeLeft(nomination)}` : mine ? '💀 Ran out of time' : '💀 You ran out of time';
  return (
    <Pressable style={styles.chainRow} onPress={() => router.push(`/profile/${person.id}`)} accessibilityLabel={`${name}: ${status}`}>
      <Avatar path={person.avatar_path} name={name} size={36} />
      <Text style={styles.chainName} numberOfLines={1}>
        {mine ? `You dared ${name}` : `${name} dared you`}
      </Text>
      <Text style={[styles.chainStatus, state === 'done' && styles.chainDone, state === 'expired' && styles.chainExpired]}>{status}</Text>
    </Pressable>
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
  rules: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
    marginTop: space.xs,
  },
  chainBox: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: space.md,
    gap: space.sm,
  },
  chainTitle: {
    ...font.label,
    textTransform: 'uppercase',
  },
  chainHint: {
    ...font.small,
    fontSize: 12,
  },
  chainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  chainName: {
    ...font.body,
    flex: 1,
    fontWeight: '700',
  },
  chainStatus: {
    ...font.small,
    fontWeight: '800',
    color: colors.orange,
  },
  chainDone: {
    color: colors.green,
  },
  chainExpired: {
    color: colors.red,
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
