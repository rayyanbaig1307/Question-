import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Modal, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { IconButton } from '@/components/IconButton';
import { useOverlays } from '@/components/Overlays';
import { ScreenHeader } from '@/components/ScreenHeader';
import { StoryAvatar } from '@/components/StoryAvatar';
import { ZoomableImage } from '@/components/ZoomableImage';
import { useMe } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { useMediaUrls } from '@/lib/media';
import {
  deletePublicPhoto,
  fetchPublicPhotos,
  PUBLIC_CHAT,
  subscribeToPublicChat,
  usePublicChatStatus,
  type PublicPhoto,
} from '@/lib/publicChat';
import { timeAgo } from '@/lib/time';
import { useSafetyActions } from '@/lib/useSafetyActions';
import { colors, font, radius, space } from '@/theme';

// The public chat 📸: one room for everyone on Peekaboo who is 18 or over. Photos only.
// Rules (checked by the server): 18+, one photo every 30 seconds, report → 3 reports hide a photo, blocks.
export default function PublicChatScreen() {
  const { userId } = useMe();
  const insets = useSafeAreaInsets();
  const { showToast, showOptions } = useOverlays();
  const { report } = useSafetyActions();
  const status = usePublicChatStatus();
  const [photos, setPhotos] = useState<PublicPhoto[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [viewing, setViewing] = useState<PublicPhoto | null>(null);
  const urls = useMediaUrls((photos ?? []).map((photo) => photo.media_path));

  const load = useCallback(async () => {
    try {
      setPhotos(await fetchPublicPhotos());
    } catch {
      setPhotos((current) => current ?? []);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (status !== 'ok') return;
      load();
      return subscribeToPublicChat(load);
    }, [status, load]),
  );

  const openCamera = () => router.push({ pathname: '/camera', params: { group: PUBLIC_CHAT } });

  function openMenu(photo: PublicPhoto) {
    const author = photo.author;
    if (photo.sender_id === userId) {
      showOptions({
        title: 'Your photo',
        options: [
          {
            label: 'Delete',
            destructive: true,
            onPress: async () => {
              try {
                await deletePublicPhoto(photo);
                setPhotos((current) => current?.filter((p) => p.id !== photo.id) ?? null);
                showToast('Deleted');
              } catch (error) {
                Alert.alert('Could not delete', friendlyError(error));
              }
            },
          },
        ],
      });
      return;
    }
    if (!author) return;
    showOptions({
      title: `@${author.username}`,
      options: [
        {
          label: 'Report photo',
          onPress: () =>
            report({
              user: { id: author.id, username: author.username },
              contentType: 'public_photo',
              contentId: photo.id,
              // Blocked: their photos leave your room straight away.
              onBlocked: () => setPhotos((current) => current?.filter((p) => p.sender_id !== author.id) ?? null),
            }),
        },
        { label: 'See profile', onPress: () => router.push(`/profile/${author.id}`) },
      ],
    });
  }

  const header = <ScreenHeader title="Public chat 📸" />;

  if (status === null) {
    return (
      <View style={styles.fill}>
        {header}
        <ActivityIndicator color={colors.accent} style={styles.loading} />
      </View>
    );
  }
  if (status === 'no_birthday') {
    return (
      <View style={styles.fill}>
        {header}
        <EmptyState emoji="🎂" title="Add your birthday to join" message="The public chat is only for people 18 and over. Your birthday stays private.">
          <Button title="Add my birthday" onPress={() => router.push('/birthday')} />
        </EmptyState>
      </View>
    );
  }
  if (status !== 'ok') {
    return (
      <View style={styles.fill}>
        {header}
        <EmptyState emoji="🔒" title="Not available" message="The public chat is only for people 18 and over." />
      </View>
    );
  }

  return (
    <View style={styles.fill}>
      {header}
      <FlatList
        data={photos ?? []}
        keyExtractor={(photo) => photo.id}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 96 }]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={colors.accent}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
        ListHeaderComponent={
          <Text style={styles.rules}>
            Everyone here is 18 or over. Photos only · one every 30 seconds · be kind. Hold a photo to report it.
          </Text>
        }
        ListEmptyComponent={
          photos === null ? (
            <ActivityIndicator color={colors.accent} style={styles.loading} />
          ) : (
            <EmptyState emoji="📸" title="Nobody has posted yet" message="Be the first – take a photo for everyone on Peekaboo." />
          )
        }
        renderItem={({ item }) => {
          const name = item.author?.display_name || item.author?.username || 'Someone';
          const url = urls[item.media_path];
          return (
            <View style={styles.card}>
              <View style={styles.cardTop}>
                <Pressable
                  style={styles.author}
                  onPress={() => item.author && router.push(`/profile/${item.author.id}`)}
                  accessibilityLabel={`Open ${name}'s profile`}>
                  <StoryAvatar person={item.author} size={34} />
                  <View>
                    <Text style={styles.name} numberOfLines={1}>
                      {item.sender_id === userId ? 'You' : name}
                    </Text>
                    <Text style={styles.time}>{timeAgo(item.created_at)}</Text>
                  </View>
                </Pressable>
                <Pressable onPress={() => openMenu(item)} hitSlop={10} accessibilityLabel="More">
                  <Ionicons name="ellipsis-horizontal" size={22} color={colors.textMuted} />
                </Pressable>
              </View>
              <Pressable
                onPress={url ? () => setViewing(item) : undefined}
                onLongPress={() => openMenu(item)}
                accessibilityRole="button"
                accessibilityLabel={`Open ${name}'s photo`}>
                {url ? (
                  <Image source={{ uri: url, cacheKey: item.media_path }} style={styles.photo} contentFit="cover" transition={150} />
                ) : (
                  <View style={[styles.photo, styles.photoLoading]} />
                )}
              </Pressable>
              {item.hidden ? <Text style={styles.hidden}>🙈 Hidden: several people reported this photo. Only you can see it.</Text> : null}
            </View>
          );
        }}
      />
      <View style={[styles.cameraButton, { bottom: insets.bottom + space.lg }]}>
        <IconButton icon="camera" label="Post a photo" size={64} background={colors.accent} color={colors.onAccent} onPress={openCamera} />
      </View>

      <Modal visible={viewing !== null} animationType="fade" onRequestClose={() => setViewing(null)} statusBarTranslucent>
        <View style={styles.viewer}>
          {viewing && urls[viewing.media_path] ? (
            <ZoomableImage uri={urls[viewing.media_path]} cacheKey={viewing.media_path} style={StyleSheet.absoluteFill} />
          ) : null}
          <View style={[styles.viewerClose, { top: insets.top + space.sm }]}>
            <IconButton icon="close" label="Close" onPress={() => setViewing(null)} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  loading: {
    marginTop: space.xl,
  },
  content: {
    paddingHorizontal: space.lg,
    gap: space.lg,
    flexGrow: 1,
  },
  rules: {
    ...font.small,
    textAlign: 'center',
    paddingVertical: space.sm,
  },
  card: {
    gap: space.sm,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  author: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    flexShrink: 1,
  },
  name: {
    ...font.label,
  },
  time: {
    ...font.small,
    fontSize: 12,
  },
  photo: {
    width: '100%',
    aspectRatio: 3 / 4,
    borderRadius: radius.lg,
  },
  photoLoading: {
    backgroundColor: colors.card,
  },
  hidden: {
    ...font.small,
    color: colors.orange,
  },
  cameraButton: {
    position: 'absolute',
    alignSelf: 'center',
  },
  viewer: {
    flex: 1,
    backgroundColor: colors.black,
  },
  viewerClose: {
    position: 'absolute',
    right: space.lg,
  },
});
