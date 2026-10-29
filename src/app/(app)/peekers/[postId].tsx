import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, SectionList, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { EmptyState } from '@/components/EmptyState';
import { ScreenHeader } from '@/components/ScreenHeader';
import { fetchPeekers, type Peeker } from '@/lib/peeks';
import { timeAgo } from '@/lib/time';
import { colors, font, radius, space } from '@/theme';

// Who Peeked (only you see this, for your own drops): who held to reveal it, and who scrolled past.
export default function Peekers() {
  const { postId } = useLocalSearchParams<{ postId: string }>();
  const [peekers, setPeekers] = useState<Peeker[] | null>(null);

  useFocusEffect(
    useCallback(() => {
      fetchPeekers(postId)
        .then(setPeekers)
        .catch(() => setPeekers([]));
    }, [postId]),
  );

  const revealed = (peekers ?? []).filter((peeker) => peeker.revealed);
  const passed = (peekers ?? []).filter((peeker) => !peeker.revealed);
  const sections = [
    { key: 'revealed', title: `👀 Peeked (${revealed.length})`, hint: 'Held to reveal your drop', data: revealed },
    { key: 'passed', title: `💨 Scrolled past (${passed.length})`, hint: 'Saw it covered and kept going', data: passed },
  ].filter((section) => section.data.length > 0);

  return (
    <View style={styles.fill}>
      <ScreenHeader title="Who peeked" />
      {peekers === null ? (
        <ActivityIndicator style={styles.loading} color={colors.accent} />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(peeker) => peeker.viewer_id}
          contentContainerStyle={styles.content}
          stickySectionHeadersEnabled={false}
          ListHeaderComponent={<Text style={styles.private}>🔒 Only you can see this</Text>}
          ListEmptyComponent={
            <EmptyState emoji="🫣" title="Nobody's peeked yet" message="When friends see your drop, they'll show up here." />
          }
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>{section.title}</Text>
              <Text style={styles.sectionHint}>{section.hint}</Text>
            </View>
          )}
          renderItem={({ item }) => {
            const name = item.viewer ? item.viewer.display_name || item.viewer.username : 'Someone';
            return (
              <Pressable style={styles.row} onPress={() => router.push(`/profile/${item.viewer_id}`)}>
                <Avatar path={item.viewer?.avatar_path} name={name} size={44} />
                <View style={styles.names}>
                  <Text style={styles.name} numberOfLines={1}>
                    {name}
                  </Text>
                  <Text style={styles.when}>{timeAgo(item.revealed_at ?? item.seen_at)}</Text>
                </View>
                <Text style={styles.emoji}>{item.revealed ? '👀' : '💨'}</Text>
              </Pressable>
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
  private: {
    ...font.small,
    textAlign: 'center',
  },
  sectionHeader: {
    marginTop: space.lg,
    marginBottom: space.xs,
  },
  sectionTitle: {
    ...font.heading,
  },
  sectionHint: {
    ...font.small,
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
  },
  name: {
    ...font.body,
    fontWeight: '800',
  },
  when: {
    ...font.small,
  },
  emoji: {
    fontSize: 24,
  },
});
