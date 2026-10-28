import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { IconButton } from '@/components/IconButton';
import { useOverlays } from '@/components/Overlays';
import { useMe } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { fetchMapLocations, setLocationSharing, type FriendLocation } from '@/lib/location';
import { supabase } from '@/lib/supabase';
import { timeAgo } from '@/lib/time';
import { colors, font, radius, space } from '@/theme';

const WHOLE_WORLD = { latitude: 25, longitude: 0, latitudeDelta: 120, longitudeDelta: 120 };

// The friend map: see friends who share their location. You're hidden (ghost mode) unless you turn sharing on.
export default function FriendMap() {
  const { userId, profile, setProfile } = useMe();
  const { showToast } = useOverlays();
  const mapRef = useRef<MapView>(null);
  const zoomedIn = useRef(false);
  const [spots, setSpots] = useState<FriendLocation[] | null>(null);
  const [busy, setBusy] = useState(false);
  const sharing = profile?.location_sharing ?? false;

  const load = useCallback(() => {
    fetchMapLocations()
      .then((found) => {
        setSpots(found);
        // The first time, zoom so everyone fits on screen.
        if (!zoomedIn.current && found.length > 0) {
          zoomedIn.current = true;
          mapRef.current?.fitToCoordinates(
            found.map((spot) => ({ latitude: spot.latitude, longitude: spot.longitude })),
            { edgePadding: { top: 160, right: 80, bottom: 260, left: 80 }, animated: true },
          );
        }
      })
      .catch(() => setSpots((current) => current ?? []));
  }, []);

  // Load now, and move friends around live when they update their spot.
  useFocusEffect(
    useCallback(() => {
      load();
      const channel = supabase
        .channel(`map-${userId}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'locations' }, load)
        .subscribe();
      return () => {
        supabase.removeChannel(channel);
      };
    }, [load, userId]),
  );

  async function toggleSharing() {
    setBusy(true);
    try {
      const updated = await setLocationSharing(userId, !sharing);
      if (!updated) {
        Alert.alert(
          'Location is turned off for Expo Go',
          'To share your spot with friends, allow location in your phone settings.',
          [
            { text: 'Not now', style: 'cancel' },
            { text: 'Open Settings', onPress: () => Linking.openSettings() },
          ],
        );
        return;
      }
      setProfile(updated);
      zoomedIn.current = false;
      load();
      showToast(updated.location_sharing ? '📍 Your friends can see you now' : "👻 Ghost mode on – you're hidden");
    } catch (error) {
      Alert.alert('Could not change it', friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  const friendsOnMap = (spots ?? []).filter((spot) => spot.user_id !== userId).length;

  return (
    <View style={styles.fill}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        initialRegion={WHOLE_WORLD}
        userInterfaceStyle="dark"
        toolbarEnabled={false}
        showsMyLocationButton={false}>
        {(spots ?? []).map((spot) => {
          const isMe = spot.user_id === userId;
          const name = isMe ? 'You' : spot.profile?.display_name || spot.profile?.username || 'Friend';
          return (
            <Marker
              key={spot.user_id}
              coordinate={{ latitude: spot.latitude, longitude: spot.longitude }}
              anchor={{ x: 0.5, y: 0.5 }}
              onPress={() => !isMe && router.push(`/profile/${spot.user_id}`)}>
              <View style={styles.marker}>
                <View style={[styles.markerRing, isMe && styles.markerRingMe]}>
                  <Avatar path={spot.profile?.avatar_path} name={name} size={44} />
                </View>
                <View style={styles.label}>
                  <Text style={styles.labelName} numberOfLines={1}>
                    {name}
                  </Text>
                  <Text style={styles.labelTime}>{timeAgo(spot.updated_at)}</Text>
                </View>
              </View>
            </Marker>
          );
        })}
      </MapView>

      <SafeAreaView edges={['top']} style={styles.top} pointerEvents="box-none">
        <IconButton icon="close" label="Close map" background={colors.overlayStrong} onPress={() => router.back()} />
        <View style={styles.titlePill}>
          <Text style={styles.title}>Friend Map</Text>
          <Text style={styles.subtitle}>
            {spots === null ? 'Loading…' : friendsOnMap === 1 ? '1 friend sharing' : `${friendsOnMap} friends sharing`}
          </Text>
        </View>
        <View style={styles.topSpacer} />
      </SafeAreaView>

      <SafeAreaView edges={['bottom']} style={styles.bottom} pointerEvents="box-none">
        <View style={styles.card}>
          <Pressable style={styles.cardRow} onPress={toggleSharing} disabled={busy}>
            <Text style={styles.cardEmoji}>{sharing ? '📍' : '👻'}</Text>
            <View style={styles.cardText}>
              <Text style={styles.cardTitle}>{sharing ? 'Sharing with friends' : 'Ghost mode is on'}</Text>
              <Text style={styles.cardSubtitle}>
                {sharing
                  ? 'Only your friends can see your spot. It updates when you open the app.'
                  : 'Nobody can see where you are.'}
              </Text>
            </View>
          </Pressable>
          <Button
            title={sharing ? 'Turn on ghost mode' : 'Share my location with friends'}
            icon={sharing ? 'eye-off' : 'location'}
            variant={sharing ? 'secondary' : 'primary'}
            loading={busy}
            onPress={toggleSharing}
          />
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  marker: {
    alignItems: 'center',
  },
  markerRing: {
    padding: 3,
    borderRadius: 30,
    backgroundColor: colors.yellow,
  },
  markerRingMe: {
    backgroundColor: colors.pink,
  },
  label: {
    marginTop: 4,
    backgroundColor: colors.overlayStrong,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    alignItems: 'center',
    maxWidth: 120,
  },
  labelName: {
    color: colors.white,
    fontWeight: '800',
    fontSize: 12,
  },
  labelTime: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '600',
  },
  top: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
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
  bottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: space.lg,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.md,
    boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  cardEmoji: {
    fontSize: 32,
  },
  cardText: {
    flex: 1,
    gap: 2,
  },
  cardTitle: {
    ...font.heading,
    fontSize: 18,
  },
  cardSubtitle: {
    ...font.small,
  },
});
