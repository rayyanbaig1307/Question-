import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { useOverlays } from '@/components/Overlays';
import { ScreenHeader } from '@/components/ScreenHeader';
import { useMe } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { fetchBlockedUsers, unblockUser, type BlockedUser } from '@/lib/safety';
import { colors, font, radius, space } from '@/theme';

export default function Blocked() {
  const { userId } = useMe();
  const { showToast } = useOverlays();
  const [blocked, setBlocked] = useState<BlockedUser[] | null>(null);

  useFocusEffect(
    useCallback(() => {
      fetchBlockedUsers(userId)
        .then(setBlocked)
        .catch(() => setBlocked([]));
    }, [userId]),
  );

  async function unblock(item: BlockedUser) {
    try {
      await unblockUser(userId, item.blocked_id);
      setBlocked((list) => list?.filter((entry) => entry.blocked_id !== item.blocked_id) ?? null);
      showToast(`Unblocked @${item.profile?.username ?? 'user'}`);
    } catch (error) {
      Alert.alert('Could not unblock', friendlyError(error));
    }
  }

  return (
    <View style={styles.fill}>
      <ScreenHeader title="Blocked accounts" />
      {blocked === null ? (
        <ActivityIndicator style={styles.loading} color={colors.accent} />
      ) : (
        <FlatList
          data={blocked}
          keyExtractor={(item) => item.blocked_id}
          contentContainerStyle={styles.content}
          ListEmptyComponent={
            <EmptyState emoji="🕊️" title="Nobody blocked" message="People you block will show up here." />
          }
          renderItem={({ item }) => (
            <View style={styles.row}>
              <Avatar path={item.profile?.avatar_path} name={item.profile?.display_name || item.profile?.username} size={48} />
              <View style={styles.names}>
                <Text style={styles.name}>{item.profile?.display_name || item.profile?.username}</Text>
                <Text style={styles.username}>@{item.profile?.username}</Text>
              </View>
              <Button title="Unblock" variant="secondary" small onPress={() => unblock(item)} />
            </View>
          )}
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
  username: {
    ...font.small,
  },
});
