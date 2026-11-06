import { LinearGradient } from 'expo-linear-gradient';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { PeekASaveCard } from '@/components/PeekASaveCard';
import { PostGrid } from '@/components/PostGrid';
import { ScreenHeader } from '@/components/ScreenHeader';
import { Avatar } from '@/components/Avatar';
import { useMe } from '@/lib/auth';
import { fetchDaresForMe, type DareForMe } from '@/lib/chat';
import { fetchFriends } from '@/lib/friends';
import { timeAgo } from '@/lib/time';
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
import { fetchPeekASaves, type BrokenStreak, type PlusAllowances } from '@/lib/plusExtras';
import { DARE_RULES, fetchDarePosts, formatCountdown, nextDareAt, todayDareDay, useDare } from '@/lib/dares';
import type { PostWithAuthor, Profile } from '@/lib/types';
import { colors, font, gradients, radius, space } from '@/theme';

// The Dare screen, top to bottom:
// 1. Today's dare (everyone gets the same one) – do it, or do it again.
// 2. Dare your friends – write your own dare and send it to anyone, any time.
// 3. Dares for you – what friends dared you (do it → the proof goes back to them).
// 4. Streaks, forfeits and your dare chain, then everyone's photos for today's dare.
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
  // 🙈 Streaks that broke in the last 24 hours (Peek-a-Save). null = not available (yet) on the server.
  const [saves, setSaves] = useState<{ streaks: BrokenStreak[]; allowances: PlusAllowances } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Dares friends wrote for you, and your friends (for the quick "dare them" faces).
  const [daresForMe, setDaresForMe] = useState<DareForMe[]>([]);
  const [friends, setFriends] = useState<Profile[]>([]);
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
      fetchPeekASaves().then(setSaves);
      fetchDaresForMe(userId)
        .then(setDaresForMe)
        .catch(() => {});
      fetchFriends(userId)
        .then(setFriends)
        .catch(() => {});
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

      {/* Dare your friends: your own dare, to anyone, any time */}
      <View style={styles.dareFriends}>
        <Text style={styles.dareFriendsTitle}>😈 Dare your friends</Text>
        <Text style={styles.dareFriendsText}>Write your own dare and send it to anyone – as many as you like.</Text>
        {friends.length > 0 ? (
          <View style={styles.faces}>
            {friends.slice(0, 6).map((friend) => (
              <Pressable
                key={friend.id}
                onPress={() => router.push({ pathname: '/dare-friend', params: { to: friend.id } })}
                accessibilityLabel={`Dare ${friend.display_name || friend.username}`}
                style={styles.face}>
                <Avatar path={friend.avatar_path} name={friend.display_name || friend.username} size={46} />
                <Text style={styles.faceName} numberOfLines={1}>
                  {friend.display_name || friend.username}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <Button title="✍️ Write a dare" onPress={() => router.push('/dare-friend')} />
      </View>

      {/* Dares friends wrote for you: do it, and the proof goes straight back to them */}
      {daresForMe.length > 0 ? (
        <View style={styles.chainBox}>
          <Text style={styles.chainTitle}>📬 Dares for you</Text>
          {daresForMe.slice(0, 5).map((d) => (
            <View key={d.id} style={styles.forMe}>
              <Avatar path={d.from.avatar_path} name={d.from.display_name || d.from.username} size={36} />
              <View style={styles.forMeText}>
                <Text style={styles.forMeFrom}>
                  {d.from.display_name || d.from.username} · {timeAgo(d.created_at)}
                </Text>
                <Text style={styles.forMeDare}>{d.body}</Text>
              </View>
              <Button title="Do it 📸" small onPress={() => router.push({ pathname: '/camera', params: { to: d.from.id } })} />
            </View>
          ))}
        </View>
      ) : null}

      {/* 🙈 Peek-a-Save: streaks that just broke, which can still be brought back */}
      {saves?.streaks.map((broken) => (
        <PeekASaveCard
          key={`${broken.kind}:${broken.friend_id}`}
          streak={broken}
          friend={friends.find((f) => f.id === broken.friend_id)}
          allowances={saves.allowances}
          onSaved={() => load()}
        />
      ))}

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
          <Text style={styles.chainTitle}>⏳ Dared you to do today&apos;s dare</Text>
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
          <Text style={styles.chainTitle}>🔗 Who you dared to do today&apos;s dare</Text>
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
              title={chain.sent.length > 0 ? `Pass today's dare on (${MAX_DARES_PER_DAY - chain.sent.length} left)` : "Pass today's dare on 🔗"}
              icon="flame"
              small
              onPress={() => router.push('/dare-chain')}
            />
          ) : null}
        </View>
      ) : null}
      {/* Community dares: suggest one and vote. The top one becomes everyone's dare only after we approve it. */}
      <Pressable onPress={() => router.push('/dare-ideas')} style={styles.ideasLink} accessibilityRole="link">
        <Text style={styles.ideasLinkText}>💡 Suggest a dare for everyone · we approve ideas before they run ›</Text>
      </Pressable>
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
    padding: space.lg,
    gap: space.sm,
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
    fontSize: 22,
    fontWeight: '900',
    lineHeight: 28,
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
  dareFriends: {
    borderRadius: radius.lg,
    borderWidth: 2,
    borderColor: colors.pink,
    backgroundColor: colors.card,
    padding: space.lg,
    gap: space.md,
  },
  dareFriendsTitle: {
    ...font.heading,
  },
  dareFriendsText: {
    ...font.small,
    marginTop: -space.sm,
  },
  faces: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.md,
  },
  face: {
    width: 52,
    alignItems: 'center',
    gap: 4,
  },
  faceName: {
    ...font.small,
    fontSize: 11,
    color: colors.text,
  },
  forMe: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.xs,
  },
  forMeText: {
    flex: 1,
    gap: 2,
  },
  forMeFrom: {
    ...font.small,
    fontSize: 12,
  },
  forMeDare: {
    ...font.body,
    fontWeight: '700',
  },
  ideasLink: {
    paddingVertical: space.sm,
  },
  ideasLinkText: {
    ...font.small,
    color: colors.accent,
    fontWeight: '800',
    textAlign: 'center',
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
