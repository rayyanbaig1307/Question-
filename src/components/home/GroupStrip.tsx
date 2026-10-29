import { router } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Bouncy } from '@/components/Bouncy';
import { GroupFaces } from '@/components/GroupFaces';
import { counting, stillToPost, type PeekGroup } from '@/lib/groups';
import { colors, font, radius, space } from '@/theme';

// A row of your Group Peek groups at the top of Discover: how many have posted today, tap to open.
export function GroupStrip({ groups }: { groups: PeekGroup[] | null }) {
  if (!groups) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.strip}
      contentContainerStyle={styles.row}>
      {groups.map((group) => {
        const total = counting(group).length;
        const left = stillToPost(group).length;
        return (
          <Bouncy
            key={group.id}
            style={[styles.chip, left === 0 && styles.chipDone]}
            pressScale={0.94}
            onPress={() => router.push(`/groups/${group.id}`)}
            accessibilityLabel={`Open ${group.name}`}>
            <GroupFaces members={group.members} size={24} />
            <View>
              <Text style={styles.name} numberOfLines={1}>
                {group.name}
              </Text>
              <Text style={styles.count}>{left === 0 ? 'Everyone posted 🎉' : `${total - left}/${total} posted 👀`}</Text>
            </View>
          </Bouncy>
        );
      })}
      <Bouncy
        style={[styles.chip, styles.newChip]}
        pressScale={0.94}
        onPress={() => router.push(groups.length > 0 ? '/groups' : '/groups/new')}
        accessibilityLabel={groups.length > 0 ? 'See all groups' : 'Make a Group Peek'}>
        <Text style={styles.newText}>{groups.length > 0 ? '👯 All groups' : '👯 Make a Group Peek'}</Text>
      </Bouncy>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  strip: {
    marginHorizontal: -space.lg,
    marginBottom: space.lg,
  },
  row: {
    gap: space.sm,
    paddingHorizontal: space.lg,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: colors.card,
    borderWidth: 1.5,
    borderColor: colors.purple,
    maxWidth: 220,
  },
  chipDone: {
    borderColor: colors.green,
  },
  name: {
    ...font.small,
    color: colors.text,
    fontWeight: '800',
  },
  count: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
  },
  newChip: {
    borderStyle: 'dashed',
    borderColor: colors.pink,
  },
  newText: {
    ...font.small,
    color: colors.pink,
    fontWeight: '800',
  },
});
