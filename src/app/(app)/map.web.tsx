import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { IconButton } from '@/components/IconButton';
import { SafeEdge } from '@/components/SafeEdge';
import { useMe } from '@/lib/auth';
import { fetchMapLocations, type FriendLocation } from '@/lib/location';
import { timeAgo } from '@/lib/time';
import { colors, font, radius, space } from '@/theme';

// The friend map, for the web version of the app.
// The real map (map.tsx) uses the phone's own map, which a web browser doesn't have – loading it in a
// browser crashes the app. Here we show the same friends as a simple list instead.
// Turning your own sharing on or off is done in the phone app.
export default function FriendMapWeb() {
  const { userId } = useMe();
  const [spots, setSpots] = useState<FriendLocation[] | null>(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      fetchMapLocations()
        .then((found) => !cancelled && setSpots(found))
        .catch(() => !cancelled && setSpots((current) => current ?? []));
      return () => {
        cancelled = true;
      };
    }, []),
  );

  const friends = (spots ?? []).filter((spot) => spot.user_id !== userId);

  return (
    <View style={styles.fill}>
      <SafeEdge edge="top" style={styles.top}>
        <IconButton icon="close" label="Close map" background={colors.overlayStrong} onPress={() => router.back()} />
        <View style={styles.titlePill}>
          <Text style={styles.title}>Friend Map</Text>
          <Text style={styles.subtitle}>
            {spots === null ? 'Loading…' : friends.length === 1 ? '1 friend sharing' : `${friends.length} friends sharing`}
          </Text>
        </View>
        <View style={styles.topSpacer} />
      </SafeEdge>

      <ScrollView contentContainerStyle={styles.list}>
        <Text style={styles.note}>
          🗺️ The map itself works in the Peekaboo phone app. That&apos;s also where you choose to show or hide your spot.
        </Text>
        {friends.map((spot) => {
          const name = spot.profile?.display_name || spot.profile?.username || 'Friend';
          return (
            <Pressable
              key={spot.user_id}
              style={styles.row}
              accessibilityRole="button"
              accessibilityLabel={`${name}, seen ${timeAgo(spot.updated_at)}`}
              onPress={() => router.push(`/profile/${spot.user_id}`)}>
              <Avatar path={spot.profile?.avatar_path} name={name} size={44} />
              <View style={styles.rowText}>
                <Text style={styles.rowName} numberOfLines={1}>
                  {name}
                </Text>
                <Text style={styles.rowTime}>{timeAgo(spot.updated_at)}</Text>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
  },
  titlePill: {
    alignItems: 'center',
    backgroundColor: colors.overlayStrong,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
  },
  title: {
    ...font.body,
    fontWeight: '900',
  },
  subtitle: {
    ...font.small,
    fontSize: 12,
  },
  topSpacer: {
    width: 44,
  },
  list: {
    padding: space.lg,
    gap: space.md,
  },
  note: {
    ...font.small,
    textAlign: 'center',
    marginBottom: space.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: space.md,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowName: {
    ...font.body,
    fontWeight: '800',
  },
  rowTime: {
    ...font.small,
    fontSize: 12,
  },
});
