import { Image } from 'expo-image';
import { router } from 'expo-router';
import type { ReactElement } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View, useWindowDimensions } from 'react-native';

import { useMediaUrls } from '@/lib/media';
import type { Post } from '@/lib/types';
import { colors } from '@/theme';

const GAP = 2;

// Instagram-style grid of photos, 3 per row. Tap one to see it full screen.
export function PostGrid({ posts, header, empty, refreshing, onRefresh }: {
  posts: Post[];
  header: ReactElement;
  empty?: ReactElement;
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
            style={({ pressed }) => [{ width: size, height: size * 1.33 }, pressed && styles.pressed]}>
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
});
