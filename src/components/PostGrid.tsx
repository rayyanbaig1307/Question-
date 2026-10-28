import { Image } from 'expo-image';
import { router } from 'expo-router';
import type { ReactElement } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { useMediaUrls } from '@/lib/media';
import type { Post } from '@/lib/types';
import { colors } from '@/theme';

const GAP = 2;

// Instagram-style grid of photos: 3 per row, each cropped to a perfect square. Tap one to see it full screen.
export function PostGrid({ posts, header, empty, refreshing, onRefresh, hideDareBadge = false }: {
  posts: Post[];
  header: ReactElement;
  empty?: ReactElement;
  // Daily Dare photos get a little 🎯 in the corner (not needed on the Dare screen itself).
  hideDareBadge?: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { width } = useWindowDimensions();
  const size = (width - GAP * 2) / 3;
  const urls = useMediaUrls(posts.map((post) => post.media_path));

  return (
    <FlatList
      data={posts}
      keyExtractor={(post) => post.id}
      numColumns={3}
      columnWrapperStyle={styles.row}
      ListHeaderComponent={header}
      ListEmptyComponent={empty}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
      contentContainerStyle={styles.content}
      renderItem={({ item }) => {
        const uri = urls[item.media_path];
        return (
          <Pressable
            accessibilityLabel="Open photo"
            onPress={() => router.push(`/post/${item.id}`)}
            style={({ pressed }) => [{ width: size, height: size }, pressed && styles.pressed]}>
            {uri ? (
              <Image
                source={{ uri, cacheKey: item.media_path }}
                style={styles.image}
                contentFit="cover"
                transition={200}
                recyclingKey={item.id}
              />
            ) : (
              <View style={[styles.image, styles.loading]} />
            )}
            {item.drop_day ? (
              <View style={styles.dropBadge}>
                <Text style={styles.dareBadgeText}>👀</Text>
              </View>
            ) : null}
            {item.dare_day && !hideDareBadge ? (
              <View style={styles.dareBadge}>
                <Text style={styles.dareBadgeText}>🎯</Text>
              </View>
            ) : null}
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  content: {
    paddingBottom: 48,
  },
  row: {
    gap: GAP,
    marginBottom: GAP,
  },
  image: {
    flex: 1,
  },
  loading: {
    backgroundColor: colors.card,
  },
  pressed: {
    opacity: 0.8,
  },
  dareBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dropBadge: {
    position: 'absolute',
    top: 6,
    left: 6,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dareBadgeText: {
    fontSize: 14,
  },
});
