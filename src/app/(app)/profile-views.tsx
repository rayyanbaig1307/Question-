import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { HiddenPersonRow } from '@/components/HiddenPersonRow';
import { PersonRow } from '@/components/PersonRow';
import { ScreenHeader } from '@/components/ScreenHeader';
import { fetchMyProfileViews, type ProfileViews } from '@/lib/insights';
import { timeAgo } from '@/lib/time';
import { colors, font, space } from '@/theme';

// 👀 Who viewed your profile in the last 30 days. Everyone sees how many; Peekaboo+ shows who.
export default function ProfileViewsScreen() {
  // undefined = loading, null = couldn't load.
  const [views, setViews] = useState<ProfileViews | null | undefined>(undefined);

  useFocusEffect(
    useCallback(() => {
      let current = true;
      fetchMyProfileViews().then((loaded) => {
        if (current) setViews(loaded);
      });
      return () => {
        current = false;
      };
    }, []),
  );

  let body;
  if (views === undefined) {
    body = <ActivityIndicator style={styles.loading} color={colors.accent} />;
  } else if (views === null) {
    body = <EmptyState emoji="🤔" title="Couldn't load your profile views" message="Please try again in a little while." />;
  } else if (!views.sharing) {
    body = (
      <EmptyState
        emoji="🙈"
        title="Profile views are off"
        message={'You turned off "Show me in Profile views", so your visits aren\'t shown to others – and you can\'t see who viewed you either. Turn it back on in Settings → Privacy.'}>
        <Button title="Open Settings" icon="settings-sharp" variant="secondary" onPress={() => router.push('/settings')} />
      </EmptyState>
    );
  } else if (views.people === 0) {
    body = <EmptyState emoji="👀" title="No profile views yet" message="When someone opens your profile, it shows up here." />;
  } else if (views.plus) {
    body = (
      <FlatList
        data={views.viewers}
        keyExtractor={(viewer) => viewer.profile.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={<Summary views={views} />}
        renderItem={({ item }) => (
          <PersonRow
            person={item.profile}
            right={
              <View style={styles.meta}>
                <Text style={styles.when}>{timeAgo(item.lastViewedAt)}</Text>
                {item.visits > 1 ? <Text style={styles.repeat}>👀 ×{item.visits}</Text> : null}
              </View>
            }
          />
        )}
      />
    );
  } else {
    // Free: the count, with the faces hidden. (The server doesn't send names without Peekaboo+.)
    const hidden = Array.from({ length: Math.min(views.people, 8) }, (_, index) => index);
    body = (
      <FlatList
        data={hidden}
        keyExtractor={(index) => String(index)}
        contentContainerStyle={styles.list}
        ListHeaderComponent={<Summary views={views} />}
        renderItem={() => <HiddenPersonRow />}
        ListFooterComponent={
          <View style={styles.upsell}>
            <Text style={styles.upsellText}>{"Find out who's been checking you out 👀"}</Text>
            <Button title="See who with Peekaboo+ ⭐" onPress={() => router.push('/plus')} />
          </View>
        }
      />
    );
  }

  return (
    <View style={styles.fill}>
      <ScreenHeader title="👀 Profile views" />
      {body}
    </View>
  );
}

function Summary({ views }: { views: ProfileViews }) {
  return (
    <View style={styles.summary}>
      <Text style={styles.summaryNumber}>{views.people}</Text>
      <Text style={styles.summaryText}>
        {views.people === 1 ? 'person' : 'people'} viewed your profile in the last 30 days
        {views.visits > views.people ? ` (${views.visits} visits)` : ''}
      </Text>
      <Text style={styles.private}>🔒 Only you can see this</Text>
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
  summaryNumber: {
    ...font.heading,
    fontSize: 40,
  },
  summaryText: {
    ...font.body,
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
    gap: space.md,
    marginTop: space.lg,
    alignItems: 'stretch',
  },
  upsellText: {
    ...font.body,
    fontWeight: '800',
    textAlign: 'center',
  },
});
