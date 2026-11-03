import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, View } from 'react-native';

import { Button } from '@/components/Button';
import { IconButton } from '@/components/IconButton';
import { useOverlays } from '@/components/Overlays';
import { SafeEdge } from '@/components/SafeEdge';
import { VideoClip } from '@/components/VideoClipSafe';
import { useMe } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { CAN_SAVE_TO_PHOTOS, deleteKeep, downloadKeepFile, fetchKeeps, saveToPhotos, type Keep } from '@/lib/keeps';
import { useMediaUrls } from '@/lib/media';
import { colors, space } from '@/theme';

// One keep, full screen: save it to Photos, post it again, or delete it.
export default function KeepViewer() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId } = useMe();
  const { showToast } = useOverlays();
  const [keep, setKeep] = useState<Keep | null | undefined>(undefined);
  const [busy, setBusy] = useState<'photos' | 'post' | null>(null);
  const urls = useMediaUrls(keep ? [keep.media_path, keep.poster_path, keep.overlay_path].filter((p): p is string => !!p) : []);

  useEffect(() => {
    fetchKeeps(userId)
      .then((all) => setKeep(all.find((k) => k.id === id) ?? null))
      .catch(() => setKeep(null));
  }, [id, userId]);

  const mediaUrl = keep ? urls[keep.media_path] : undefined;

  async function toPhotos() {
    if (!keep || !mediaUrl) return;
    setBusy('photos');
    try {
      const local = await downloadKeepFile(mediaUrl, `keep-${keep.id}.${keep.media_type === 'video' ? 'mp4' : 'jpg'}`);
      const ok = await saveToPhotos(local);
      showToast(ok ? 'Saved to Photos ✅' : 'Peekaboo needs permission to save to Photos');
    } catch (error) {
      Alert.alert('Could not save', friendlyError(error));
    } finally {
      setBusy(null);
    }
  }

  // Posting again: the file comes back to the phone and goes through the usual "Send to…" screen.
  async function postAgain() {
    if (!keep || !mediaUrl) return;
    setBusy('post');
    try {
      const local = await downloadKeepFile(mediaUrl, `keep-${keep.id}.${keep.media_type === 'video' ? 'mp4' : 'jpg'}`);
      const overlay = keep.overlay_path && urls[keep.overlay_path] ? await downloadKeepFile(urls[keep.overlay_path], `keep-${keep.id}-overlay.png`) : null;
      router.push({ pathname: '/share', params: { uri: local, ...(keep.media_type === 'video' ? { video: '1' } : {}), ...(overlay ? { overlay } : {}) } });
    } catch (error) {
      Alert.alert('Could not open it', friendlyError(error));
    } finally {
      setBusy(null);
    }
  }

  function confirmDelete() {
    if (!keep) return;
    Alert.alert('Delete this keep?', 'It stays in your phone\'s Photos if you saved it there.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteKeep(keep);
            showToast('Deleted from Keeps');
            router.back();
          } catch (error) {
            Alert.alert('Could not delete', friendlyError(error));
          }
        },
      },
    ]);
  }

  return (
    <View style={styles.fill}>
      {keep === undefined || (keep && !mediaUrl) ? (
        <ActivityIndicator color={colors.accent} size="large" style={styles.fill} />
      ) : keep === null ? null : keep.media_type === 'video' ? (
        <VideoClip uri={mediaUrl!} posterUri={keep.poster_path ? urls[keep.poster_path] : undefined} overlayUri={keep.overlay_path ? urls[keep.overlay_path] : undefined} playing style={styles.fill} />
      ) : (
        <Image source={{ uri: mediaUrl }} style={styles.fill} contentFit="contain" />
      )}
      <SafeEdge edge="top" style={styles.top}>
        <IconButton icon="close" label="Close" onPress={() => router.back()} />
        <IconButton icon="trash" label="Delete" onPress={confirmDelete} />
      </SafeEdge>
      {keep ? (
        <SafeEdge edge="bottom" style={styles.bottom}>
          {CAN_SAVE_TO_PHOTOS ? (
            <Button title="Save to Photos" icon="download" variant="secondary" small loading={busy === 'photos'} onPress={toPhotos} />
          ) : null}
          <Button title="Post it" icon="send" small loading={busy === 'post'} onPress={postAgain} />
        </SafeEdge>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.black,
  },
  top: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
  },
  bottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: space.sm,
    padding: space.lg,
  },
});
