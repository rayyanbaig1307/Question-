import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { HiddenPersonRow } from '@/components/HiddenPersonRow';
import { PersonRow } from '@/components/PersonRow';
import { ScreenHeader } from '@/components/ScreenHeader';
import { fetchPostScreenshots, type PostScreenshots } from '@/lib/insights';
import { refreshServerPlus, useServerPlus, useStorePlus } from '@/lib/plus';
import { timeAgo } from '@/lib/time';
import { colors, font, space } from '@/theme';

// 📸 Who took a screenshot of one of your posts. Everyone sees how many; Peekaboo+ shows who.
// The server decides who sees the names. Right after buying, the App Store knows a few seconds before the
// server does: then this screen says "Unlocking your Peekaboo+…" instead of asking you to buy it again.
export default function PostScreenshotsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  // undefined = loading, null = couldn't load.
  const [shots, setShots] = useState<PostScreenshots | null | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const storePlus = useStorePlus();
  const serverPlus = useServerPlus();

  // Loads the screenshots when the screen opens, and again when your Plus changes (so the names show up as soon
  // as the server knows). While Plus is still unlocking, it also asks the server again.
  useFocusEffect(
    useCallback(() => {
      let current = true;
      if (storePlus && !serverPlus) refreshServerPlus();
      fetchPostScreenshots(id).then((loaded) => {
        if (current) setShots(loaded);
      });
      return () => {
        current = false;
      };
    }, [id, storePlus, serverPlus]),
  );

  // Pull down to refresh.
  async function refresh() {
    setRefreshing(true);
    const [loaded] = await Promise.all([fetchPostScreenshots(id), refreshServerPlus()]);
    setShots(loaded);
    setRefreshing(false);
  }

  let body;
  if (shots === undefined) {
    body = <ActivityIndicator style={styles.loading} color={colors.accent} />;
  } else if (shots === null) {
    body = <EmptyState emoji="🤔" title="Couldn't load the screenshots" message="Please try again in a little while." />;
  } else if (shots.people === 0) {
    body = <EmptyState emoji="📸" title="No screenshots yet" message="When someone screenshots this post, it shows up here." />;
  } else {
    const header = (
      <View style={styles.summary}>
        <Text style={styles.summaryText}>
          📸 {shots.screenshots} {shots.screenshots === 1 ? 'screenshot' : 'screenshots'} by {shots.people}{' '}
          {shots.people === 1 ? 'person' : 'people'}
        </Text>
        <Text style={styles.private}>🔒 Only you can see this</Text>
      </View>
    );
    body = shots.plus ? (
      <FlatList
        data={shots.takers}
        keyExtractor={(taker) => taker.profile.id}
        contentContainerStyle={styles.list}
        refreshing={refreshing}
        onRefresh={refresh}
        ListHeaderComponent={header}
        renderItem={({ item }) => (
          <PersonRow
            person={item.profile}
            right={
              <View style={styles.meta}>
                <Text style={styles.when}>{timeAgo(item.lastAt)}</Text>
                {item.times > 1 ? <Text style={styles.repeat}>📸 ×{item.times}</Text> : null}
              </View>
            }
          />
        )}
      />
    ) : (
      // Free: the faces stay hidden. (The server doesn't send names without Peekaboo+.)
      // Just bought it: they stay hidden until the server knows, with "Unlocking…" instead of the buy button.
      <FlatList
        data={Array.from({ length: Math.min(shots.people, 8) }, (_, index) => index)}
        keyExtractor={(index) => String(index)}
        contentContainerStyle={styles.list}
        refreshing={refreshing}
        onRefresh={refresh}
        ListHeaderComponent={header}
        renderItem={() => <HiddenPersonRow />}
        ListFooterComponent={
          storePlus ? (
            <View style={styles.upsell}>
              <Text style={styles.unlockingTitle}>⏳ Unlocking your Peekaboo+…</Text>
              <Text style={styles.private}>This takes a few seconds. Pull down to refresh.</Text>
            </View>
          ) : (
            <View style={styles.upsell}>
              <Button title="See who with Peekaboo+ ⭐" onPress={() => router.push('/plus')} />
            </View>
          )
        }
      />
    );
  }

  return (
    <View style={styles.fill}>
      <ScreenHeader title="📸 Screenshots" />
      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  loading: {
    marginTop: space.xxl,
  },
  list: {
    padding: space.lg,
    gap: space.sm,
    flexGrow: 1,
  },
  summary: {
    alignItems: 'center',
    gap: space.xs,
    marginBottom: space.md,
  },
  summaryText: {
    ...font.body,
    fontWeight: '800',
    textAlign: 'center',
  },
  private: {
    ...font.small,
    textAlign: 'center',
  },
  meta: {
    alignItems: 'flex-end',
    gap: 2,
  },
  when: {
    ...font.small,
  },
  repeat: {
    ...font.small,
    color: colors.text,
    fontWeight: '800',
  },
  upsell: {
    marginTop: space.lg,
    gap: space.xs,
  },
  unlockingTitle: {
    ...font.body,
    fontWeight: '800',
    textAlign: 'center',
  },
});
