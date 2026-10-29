import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { Bouncy } from '@/components/Bouncy';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { GroupFaces } from '@/components/GroupFaces';
import { RoundIconButton, ScreenHeader } from '@/components/ScreenHeader';
import { useMe } from '@/lib/auth';
import { counting, fetchGroups, stillToPost, waitingText, type PeekGroup } from '@/lib/groups';
import { colors, font, radius, space } from '@/theme';

// Group Peek: all your groups, with how many have posted today's drop.
export default function Groups() {
  const { userId } = useMe();
  const [groups, setGroups] = useState<PeekGroup[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      fetchGroups()
        .then((loaded) => !cancelled && setGroups(loaded))
        .catch(() => !cancelled && setGroups((current) => current ?? []));
      return () => {
        cancelled = true;
      };
    }, []),
  );

  async function refresh() {
    setRefreshing(true);
    try {
      setGroups(await fetchGroups());
    } catch {
      // keep what we have
    }
    setRefreshing(false);
  }

  return (
    <View style={styles.fill}>
      <ScreenHeader
        title="Group Peek"
        right={<RoundIconButton icon="add" label="New group" onPress={() => router.push('/groups/new')} />}
      />
      {groups === null ? (
        <ActivityIndicator style={styles.loading} color={colors.accent} />
      ) : (
        <FlatList
          data={groups}
          keyExtractor={(group) => group.id}
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accent} />}
          ListHeaderComponent={
            groups.length > 0 ? (
              <Text style={styles.explain}>
                Everyone&apos;s Peekaboo drop stays hidden until the whole group has posted. 👀
              </Text>
            ) : undefined
          }
          ListEmptyComponent={
            <EmptyState
              emoji="👯"
              title="No groups yet"
              message="Make a group with your friends. Everyone's Peekaboo drop stays hidden until the whole group has posted!">
              <Button title="Make a group" icon="people" onPress={() => router.push('/groups/new')} />
            </EmptyState>
          }
          renderItem={({ item }) => {
            const total = counting(item).length;
            const posted = total - stillToPost(item).length;
            const done = posted === total;
            return (
              <Bouncy
                style={styles.row}
                pressScale={0.97}
                onPress={() => router.push(`/groups/${item.id}`)}
                accessibilityLabel={`Open ${item.name}`}>
                <GroupFaces members={item.members} size={40} />
                <View style={styles.names}>
                  <Text style={styles.name} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={[styles.status, done && styles.statusDone]} numberOfLines={1}>
                    {waitingText(item, userId)}
                  </Text>
                </View>
                <View style={[styles.count, done && styles.countDone]}>
                  <Text style={styles.countText}>
                    {posted}/{total}
                  </Text>
                </View>
              </Bouncy>
            );
          }}
        />
      )}
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
  content: {
    padding: space.lg,
    gap: space.sm,
    flexGrow: 1,
  },
  explain: {
    ...font.small,
    textAlign: 'center',
    marginBottom: space.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.card,
    padding: space.md,
    borderRadius: radius.md,
  },
  names: {
    flex: 1,
    gap: 2,
  },
  name: {
    ...font.body,
    fontWeight: '800',
  },
  status: {
    ...font.small,
  },
  statusDone: {
    color: colors.green,
    fontWeight: '700',
  },
  count: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.purple,
  },
  countDone: {
    backgroundColor: colors.green,
  },
  countText: {
    color: colors.white,
    fontWeight: '900',
    fontSize: 13,
  },
});
