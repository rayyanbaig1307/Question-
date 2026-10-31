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
import {
  fetchDareChain,
  fetchDareStreaks,
  fetchForfeits,
  MAX_DARES_PER_DAY,
  nominationState,
  streakAtRisk,
  timeLeft,
  type DareChain,
  type Forfeit,
  type Nomination,
  type Streak,
} from '@/lib/dareChain';
import { syncCommunityDares } from '@/lib/communityDares';
import { DARE_RULES, fetchDarePosts, formatCountdown, nextDareAt, todayDareDay, useDare } from '@/lib/dares';
import type { PostWithAuthor } from '@/lib/types';
import { colors, font, gradients, radius, space } from '@/theme';

// Today's dare, a countdown to the next one, and everyone's photos for it.
export default function DareScreen() {
  const { userId } = useMe();
  const [day, setDay] = useState(todayDareDay);
  const [posts, setPosts] = useState<{ day: string; list: PostWithAuthor[] } | null>(null);
  // Dares you were given and dares you gave today.
  const [chain, setChain] = useState<DareChain>({ received: [], sent: [] });
  // Forfeits you owe and forfeits you handed out.
  const [forfeits, setForfeits] = useState<Forfeit[]>([]);
  // Streaks with friends: days in a row you both did the dare.
  const [streaks, setStreaks] = useState<Streak[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const dare = useDare(day);

  const load = useCallback(async () => {
    try {
      const [list, loadedChain, loadedForfeits, loadedStreaks] = await Promise.all([
        fetchDarePosts(day),
        // (also asks for today's community dare, in case one just got picked)
        syncCommunityDares().catch(() => null).then(() => null),
      ]).then(([list]) => Promise.all([
        Promise.resolve(list),
        fetchDareChain(userId, day).catch(() => null),
        fetchForfeits().catch(() => null),
        fetchDareStreaks(userId).catch(() => null),
      ]));
      setPosts({ day, list });
      if (loadedChain) setChain(loadedChain);
      if (loadedForfeits) setForfeits(loadedForfeits);
      if (loadedStreaks) setStreaks(loadedStreaks);
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
  const forfeitFor = (n: Nomination) => forfeits.find((f) => f.nomination_id === n.id) ?? null;
  const iOwe = forfeits.filter((f) => f.to_user === userId && !f.done_at);
  const iGave = forfeits.filter((f) => f.from_user === userId);
  const payForfeit = (f: Forfeit) => router.push({ pathname: '/camera', params: { forfeit: f.id, ftext: f.forfeit_text } });

  const header = (
    <View style={styles.header}>
      <LinearGradient colors={gradients.brand} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.card}>
        <Text style={styles.label}>{dare.author ? `💡 COMMUNITY DARE · by ${dare.author}` : `🎯 DARE #${dare.number} · TODAY`}</Text>
        <Text style={styles.dare}>{dare.text}</Text>
        <Countdown day={day} onNewDare={() => setDay(todayDareDay())} />
        <Button
          title={iDidIt ? 'Do it again 📸' : 'Do the dare 📸'}
          variant="secondary"
          onPress={doTheDare}
          style={styles.cardButton}
        />
        <Text
          style={styles.rules}
          onPress={() => router.push({ pathname: '/legal/[doc]', params: { doc: 'dare-rules' } })}
          accessibilityRole="link">
          {DARE_RULES} · <Text style={styles.rulesLink}>Full rules</Text>
        </Text>
      </LinearGradient>
      {iDidIt ? <Text style={styles.done}>✅ You did today&apos;s dare. Legend.</Text> : null}

      {/* Community dares: suggest one, vote, and the top one becomes everyone's dare with your name on it */}
      <Button title="💡 Suggest a dare · vote on ideas" variant="secondary" onPress={() => router.push('/dare-ideas')} />

      {/* Streaks: you and a friend both doing the dare, day after day */}
      {streaks.length > 0 ? (
        <View style={styles.chainBox}>
          <Text style={styles.chainTitle}>🔥 Dare streaks</Text>
          {streaks.map((s) => {
            const name = s.friend.display_name || s.friend.username;
            const status =
              s.me_today && s.them_today
                ? '✅ Both done today'
                : s.me_today
                  ? `⏳ ${name} still has to`
                  : s.them_today
                    ? streakAtRisk(s) ? '⚠️ Your turn – or it ends' : `⏳ Your turn`
                    : streakAtRisk(s) ? '⚠️ Both of you, today' : '⏳ Both still to do';
            return (
              <Pressable key={s.friend.id} style={styles.chainRow} onPress={() => router.push(`/profile/${s.friend.id}`)}>
                <Avatar path={s.friend.avatar_path} name={name} size={36} />
                <Text style={styles.chainName} numberOfLines={1}>
                  {s.streak > 0 ? `🔥 ${s.streak} with ${name}` : `${name} did today's – match it to start a streak`}
                </Text>
                <Text style={[styles.chainStatus, s.me_today && s.them_today && styles.chainDone]}>{status}</Text>
              </Pressable>
            );
          })}
          <Text style={styles.chainHint}>A streak counts every day you BOTH do the dare. Miss a day and it&apos;s back to zero.</Text>
        </View>
      ) : null}

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

      {/* Forfeits: what you owe (pay it with a photo) and what friends owe you */}
      {iOwe.length > 0 || iGave.length > 0 ? (
        <View style={styles.chainBox}>
          <Text style={styles.chainTitle}>💀 Forfeits</Text>
          {iOwe.map((f) => (
            <View key={f.id} style={styles.forfeitRow}>
              <Text style={styles.forfeitText}>
                You owe {f.from.display_name || f.from.username}: {f.forfeit_text}
              </Text>
              <Button title="Pay it 📸" small onPress={() => payForfeit(f)} />
            </View>
          ))}
          {iGave.map((f) => (
            <Pressable
              key={f.id}
              style={styles.chainRow}
              disabled={!f.done_post_id}
              onPress={() => router.push(`/post/${f.done_post_id}`)}
              accessibilityLabel={`${f.to.display_name || f.to.username} owes you: ${f.forfeit_text}`}>
              <Avatar path={f.to.avatar_path} name={f.to.display_name || f.to.username} size={36} />
              <Text style={styles.chainName} numberOfLines={2}>
                {f.to.display_name || f.to.username} owes you: {f.forfeit_text}
              </Text>
              <Text style={[styles.chainStatus, f.done_at && styles.chainDone]}>{f.done_at ? '✅ Paid' : '⏳ Owes'}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {/* Dares you gave, and the button to give more */}
      {chain.sent.length > 0 || canDareMore ? (
        <View style={styles.chainBox}>
          <Text style={styles.chainTitle}>🔗 Your dare chain</Text>
          {chain.sent.map((n) => (
            <ChainRow
              key={n.id}
              person={n.to}
              nomination={n}
              mine
              forfeit={forfeitFor(n)}
              onPickForfeit={() =>
                router.push({ pathname: '/forfeit/[nomination]', params: { nomination: n.id, name: n.to.display_name || n.to.username } })
              }
            />
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
function ChainRow({ person, nomination, mine, forfeit = null, onPickForfeit }: {
  person: Nomination['from'];
  nomination: Nomination;
  mine: boolean;
  // The forfeit already picked for this dare, if any.
  forfeit?: Forfeit | null;
  onPickForfeit?: () => void;
}) {
  const state = nominationState(nomination);
  const name = person.display_name || person.username;
  const status =
    state === 'done'
      ? '✅ Did it'
      : state === 'open'
        ? `⏳ ${timeLeft(nomination)}`
        : forfeit
          ? '💀 Forfeit'
          : mine
            ? '💀 Ran out of time'
            : '💀 You ran out of time';
  return (
    <View style={styles.chainRow}>
      <Pressable style={styles.chainPerson} onPress={() => router.push(`/profile/${person.id}`)} accessibilityLabel={`${name}: ${status}`}>
        <Avatar path={person.avatar_path} name={name} size={36} />
        <Text style={styles.chainName} numberOfLines={1}>
          {mine ? `You dared ${name}` : `${name} dared you`}
        </Text>
      </Pressable>
      {mine && state === 'expired' && !forfeit && onPickForfeit ? (
        <Button title="Pick a forfeit 💀" small variant="secondary" onPress={onPickForfeit} />
      ) : (
        <Text style={[styles.chainStatus, state === 'done' && styles.chainDone, state === 'expired' && styles.chainExpired]}>{status}</Text>
      )}
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
  rulesLink: {
    textDecorationLine: 'underline',
    fontWeight: '900',
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
  chainPerson: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  chainName: {
    ...font.body,
    flex: 1,
    fontWeight: '700',
  },
  forfeitRow: {
    gap: space.sm,
    paddingVertical: space.xs,
  },
  forfeitText: {
    ...font.body,
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
