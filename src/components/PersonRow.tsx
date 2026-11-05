import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { PlusBadge } from '@/components/PlusBadge';
import type { Profile } from '@/lib/types';
import { colors, font, radius, space } from '@/theme';

// One person in a list: picture, name, @username (tap → their profile), and a button on the right.
export function PersonRow({ person, right }: { person: Profile; right?: ReactNode }) {
  return (
    <View style={styles.row}>
      <Pressable
        style={styles.person}
        onPress={() => router.push(`/profile/${person.id}`)}
        accessibilityLabel={`Open @${person.username}`}>
        <Avatar path={person.avatar_path} name={person.display_name || person.username} size={48} />
        <View style={styles.names}>
          <View style={styles.nameLine}>
            <Text style={styles.name} numberOfLines={1}>
              {person.display_name || person.username}
            </Text>
            <PlusBadge userId={person.id} small />
          </View>
          <Text style={styles.username} numberOfLines={1}>
            @{person.username}
          </Text>
        </View>
      </Pressable>
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.card,
    padding: space.md,
    borderRadius: radius.md,
  },
  person: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  names: {
    flex: 1,
  },
  nameLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  name: {
    ...font.body,
    fontWeight: '800',
    flexShrink: 1,
  },
  username: {
    ...font.small,
  },
});
