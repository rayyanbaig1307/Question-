import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { HiddenPersonRow } from '@/components/HiddenPersonRow';
import { PersonRow } from '@/components/PersonRow';
import { ScreenHeader } from '@/components/ScreenHeader';
import { fetchPostScreenshots, type PostScreenshots } from '@/lib/insights';
import { timeAgo } from '@/lib/time';
import { colors, font, space } from '@/theme';

// 📸 Who took a screenshot of one of your posts. Everyone sees how many; Peekaboo+ shows who.
export default function PostScreenshotsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  // undefined = loading, null = couldn't load.
  const [shots, setShots] = useState<PostScreenshots | null | undefined>(undefined);

  useFocusEffect(
    useCallback(() => {
      let current = true;
      fetchPostScreenshots(id).then((loaded) => {
        if (current) setShots(loaded);
      });
      return () => {
        current = false;
      };
    }, [id]),
  );

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
      <FlatList
        data={Array.from({ length: Math.min(shots.people, 8) }, (_, index) => index)}
        keyExtractor={(index) => String(index)}
        contentContainerStyle={styles.list}
        ListHeaderComponent={header}
        renderItem={() => <HiddenPersonRow />}
        ListFooterComponent={
          <View style={styles.upsell}>
            <Button title="See who with Peekaboo+ ⭐" onPress={() => router.push('/plus')} />
          </View>
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
  },
});
