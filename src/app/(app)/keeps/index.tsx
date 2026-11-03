import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { ScreenHeader } from '@/components/ScreenHeader';
import { useMe } from '@/lib/auth';
import { fetchKeeps, type Keep } from '@/lib/keeps';
import { useMediaUrls } from '@/lib/media';
import { colors, font, space } from '@/theme';

// Keeps 📦: everything you saved from the editor – only you can see it.
export default function Keeps() {
  const { userId } = useMe();
  const { width } = useWindowDimensions();
  const [keeps, setKeeps] = useState<Keep[] | null>(null);
  const urls = useMediaUrls((keeps ?? []).map((keep) => keep.poster_path ?? keep.media_path));

  useFocusEffect(
    useCallback(() => {
      fetchKeeps(userId)
        .then(setKeeps)
        .catch(() => setKeeps((current) => current ?? []));
    }, [userId]),
  );

  const size = (width - space.lg * 2 - 4) / 3;

  return (
    <View style={styles.fill}>
      <ScreenHeader title="Keeps 📦" />
      {keeps === null ? (
        <ActivityIndicator color={colors.accent} style={styles.loading} />
      ) : (
        <FlatList
          data={keeps}
          numColumns={3}
          keyExtractor={(keep) => keep.id}
          contentContainerStyle={styles.grid}
          columnWrapperStyle={styles.row}
          ListHeaderComponent={
            keeps.length > 0 ? <Text style={styles.hint}>Only you can see these. Tap one to save it to Photos or post it.</Text> : undefined
          }
          ListEmptyComponent={
            <EmptyState
              emoji="📦"
              title="Nothing kept yet"
              message="In the editor, tap the ⬇️ button to keep a photo or video with all its stickers and filters.">
              <Button title="Open camera" icon="camera" onPress={() => router.dismissTo({ pathname: '/', params: { page: 'camera' } })} />
            </EmptyState>
          }
          renderItem={({ item }) => (
            <Pressable onPress={() => router.push(`/keeps/${item.id}`)} accessibilityLabel="Open this keep">
              <Image source={{ uri: urls[item.poster_path ?? item.media_path] }} style={{ width: size, height: size * 1.4 }} contentFit="cover" />
              {item.media_type === 'video' ? <Ionicons name="videocam" size={16} color={colors.white} style={styles.videoMark} /> : null}
            </Pressable>
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
  grid: {
    paddingHorizontal: space.lg,
    paddingBottom: space.xxl,
    gap: 2,
  },
  row: {
    gap: 2,
  },
  hint: {
    ...font.small,
    paddingBottom: space.sm,
  },
  videoMark: {
    position: 'absolute',
    top: 6,
    right: 6,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 4,
  },
});
