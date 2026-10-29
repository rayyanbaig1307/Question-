import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { ScreenHeader } from '@/components/ScreenHeader';
import { useMe } from '@/lib/auth';
import { fetchCloseFriendIds, setCloseFriend } from '@/lib/closeFriends';
import { friendlyError } from '@/lib/errors';
import { fetchFriends } from '@/lib/friends';
import { inviteFriends } from '@/lib/invite';
import type { Profile } from '@/lib/types';
import { colors, font, radius, space } from '@/theme';

// Pick your close friends: tap the star next to a friend. Only you see this list.
export default function CloseFriends() {
  const { userId, profile } = useMe();
  const [friends, setFriends] = useState<Profile[] | null>(null);
  const [close, setClose] = useState<Set<string>>(new Set());

  useEffect(() => {
    Promise.all([fetchFriends(userId), fetchCloseFriendIds(userId)])
      .then(([loaded, ids]) => {
        setClose(ids);
        // Close friends first, then everyone else.
        setFriends([...loaded].sort((a, b) => Number(ids.has(b.id)) - Number(ids.has(a.id))));
      })
      .catch(() => setFriends([]));
  }, [userId]);

  async function toggle(friend: Profile) {
    const on = !close.has(friend.id);
    Haptics.selectionAsync();
    setClose((current) => {
      const next = new Set(current);
      if (on) next.add(friend.id);
      else next.delete(friend.id);
      return next;
    });
    try {
      await setCloseFriend(userId, friend.id, on);
    } catch (error) {
      // Put it back the way it was.
      setClose((current) => {
        const next = new Set(current);
        if (on) next.delete(friend.id);
        else next.add(friend.id);
        return next;
      });
      Alert.alert('Could not update', friendlyError(error));
    }
  }

  return (
    <View style={styles.fill}>
      <ScreenHeader title="Close friends ⭐" />
      {friends === null ? (
        <ActivityIndicator style={styles.loading} color={colors.accent} />
      ) : (
        <FlatList
          data={friends}
          keyExtractor={(friend) => friend.id}
          contentContainerStyle={styles.content}
          ListHeaderComponent={
            friends.length > 0 ? (
              <Text style={styles.explain}>
                {close.size === 0 ? 'Nobody yet' : `${close.size} close friend${close.size === 1 ? '' : 's'}`} · When you post,
                pick &quot;Close friends ⭐&quot; to share only with them. Only you see this list.
              </Text>
            ) : undefined
          }
          ListEmptyComponent={
            <EmptyState emoji="⭐" title="No friends yet" message="Add some friends first, then pick your close friends here.">
              <Button title="Invite friends" icon="paper-plane" onPress={() => inviteFriends(profile?.username)} />
            </EmptyState>
          }
          renderItem={({ item }) => {
            const on = close.has(item.id);
            return (
              <Pressable
                style={[styles.row, on && styles.rowOn]}
                onPress={() => toggle(item)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={`${item.display_name || item.username} close friend`}>
                <Avatar path={item.avatar_path} name={item.display_name || item.username} size={44} />
                <View style={styles.names}>
                  <Text style={styles.name} numberOfLines={1}>
                    {item.display_name || item.username}
                  </Text>
                  <Text style={styles.username} numberOfLines={1}>
                    @{item.username}
                  </Text>
                </View>
                <Ionicons name={on ? 'star' : 'star-outline'} size={26} color={on ? colors.green : colors.textFaint} />
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
  explain: {
    ...font.small,
    marginBottom: space.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.card,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  rowOn: {
    borderColor: colors.green,
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
