import Ionicons from '@expo/vector-icons/Ionicons';
import { CameraView, useCameraPermissions, type CameraType } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { IconButton } from '@/components/IconButton';
import { SafeEdge } from '@/components/SafeEdge';
import { useMe } from '@/lib/auth';
import { useUnreadCount } from '@/lib/chat';
import { useIncomingRequestCount } from '@/lib/friends';
import { friendlyError } from '@/lib/errors';
import { colors, font, radius, space } from '@/theme';

// The home screen: a full-screen camera.
// Also used on its own (with `sendTo`) when you tap the camera inside a chat.
export function CameraPage({ active, sendTo, onOpenChat, onOpenStories }: {
  // The camera only runs while you're looking at it (saves battery).
  active: boolean;
  // A friend's id: the photo goes straight to them as a peek.
  sendTo?: string;
  onOpenChat?: () => void;
  onOpenStories?: () => void;
}) {
  const { userId, profile } = useMe();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [facing, setFacing] = useState<CameraType>('back');
  const [flash, setFlash] = useState<'off' | 'on'>('off');
  const [busy, setBusy] = useState(false);
  const isHome = !sendTo;
  const requestCount = useIncomingRequestCount(userId, active && isHome);
  const unreadCount = useUnreadCount(userId, active && isHome);

  const openEditor = (uri: string, fit: 'cover' | 'contain') =>
    router.push({ pathname: '/editor', params: sendTo ? { uri, fit, to: sendTo } : { uri, fit } });

  async function takePhoto() {
    if (!cameraRef.current || busy) return;
    setBusy(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.85 });
      openEditor(photo.uri, 'cover');
    } catch (error) {
      Alert.alert('Could not take photo', friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  async function pickFromGallery() {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.9 });
    if (!result.canceled && result.assets[0]) {
      openEditor(result.assets[0].uri, 'contain');
    }
  }

  return (
    <View style={styles.fill}>
      {!permission ? null : permission.granted ? (
        active ? (
          <CameraView
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            facing={facing}
            flash={flash}
            mirror={facing === 'front'}
          />
        ) : null
      ) : (
        <View style={styles.permission}>
          <Text style={styles.permissionEmoji}>📸</Text>
          <Text style={styles.permissionTitle}>Let&apos;s take some photos!</Text>
          <Text style={styles.permissionText}>Peekaboo needs your camera to take photos.</Text>
          {!permission.canAskAgain ? (
            <Button title="Open Settings" icon="settings-outline" onPress={() => Linking.openSettings()} />
          ) : (
            <Button title="Allow camera" icon="camera" onPress={requestPermission} />
          )}
        </View>
      )}

      {/* Top: your picture on the left, camera controls on the right */}
      <SafeEdge edge="top" style={styles.top} pointerEvents="box-none">
        {isHome ? (
          <View style={styles.topLeft}>
            <Pressable onPress={() => router.push(`/profile/${userId}`)} accessibilityLabel="My profile">
              <Avatar path={profile?.avatar_path} name={profile?.display_name || profile?.username} size={44} ring />
            </Pressable>
            <View>
              <IconButton icon="person-add" label="Add friends" onPress={() => router.push('/friends')} />
              <CountBadge count={requestCount} />
            </View>
          </View>
        ) : (
          <IconButton icon="close" label="Close camera" onPress={() => router.back()} />
        )}
        <View style={styles.tools}>
          {isHome ? <IconButton icon="map" label="Friend map" onPress={() => router.push('/map')} /> : null}
          <IconButton
            icon="camera-reverse"
            label="Flip camera"
            onPress={() => setFacing(facing === 'back' ? 'front' : 'back')}
          />
          <IconButton
            icon={flash === 'on' ? 'flash' : 'flash-off'}
            label="Flash"
            color={flash === 'on' ? colors.yellow : colors.white}
            onPress={() => setFlash(flash === 'on' ? 'off' : 'on')}
          />
        </View>
      </SafeEdge>

      {/* Bottom: gallery, the big shutter button, and shortcuts to the other pages */}
      <SafeEdge edge="bottom" style={styles.bottom} pointerEvents="box-none">
        <View style={styles.shutterRow}>
          <IconButton icon="images" label="Pick from gallery" onPress={pickFromGallery} />
          <Pressable
            onPress={takePhoto}
            disabled={!permission?.granted || busy}
            accessibilityRole="button"
            accessibilityLabel="Take photo"
            style={({ pressed }) => [styles.shutter, pressed && styles.shutterPressed]}>
            <View style={styles.shutterInner} />
          </Pressable>
          <View style={styles.shutterSpacer} />
        </View>
        {isHome ? (
          <View style={styles.nav}>
            <Pressable style={styles.navButton} onPress={onOpenChat} accessibilityRole="button">
              <Ionicons name="chatbubble" size={20} color={colors.blue} />
              <Text style={styles.navText}>Chat</Text>
              <CountBadge count={unreadCount} />
            </Pressable>
            <Pressable style={styles.navButton} onPress={onOpenStories} accessibilityRole="button">
              <Text style={styles.navText}>Stories</Text>
              <Ionicons name="sparkles" size={20} color={colors.pink} />
            </Pressable>
          </View>
        ) : null}
      </SafeEdge>
    </View>
  );
}

// Little red bubble with a number, e.g. new friend requests or unread chats.
function CountBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <View style={styles.badge} pointerEvents="none">
      <Text style={styles.badgeText}>{count > 9 ? '9+' : count}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.black,
  },
  permission: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    padding: space.xxl,
    backgroundColor: colors.surface,
  },
  permissionEmoji: {
    fontSize: 64,
  },
  permissionTitle: {
    ...font.title,
    textAlign: 'center',
  },
  permissionText: {
    ...font.body,
    color: colors.textMuted,
    textAlign: 'center',
    marginBottom: space.md,
  },
  top: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
  },
  topLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 5,
    backgroundColor: colors.red,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: colors.white,
    fontSize: 12,
    fontWeight: '900',
  },
  tools: {
    gap: space.md,
  },
  bottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
    gap: space.lg,
  },
  shutterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.xl,
  },
  shutter: {
    width: 84,
    height: 84,
    borderRadius: 42,
    borderWidth: 6,
    borderColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterPressed: {
    transform: [{ scale: 0.92 }],
  },
  shutterInner: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: 'rgba(255,255,255,0.25)',
  },
  shutterSpacer: {
    width: 44,
  },
  nav: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  navButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: colors.overlay,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
  },
  navText: {
    color: colors.white,
    fontWeight: '800',
    fontSize: 15,
  },
});
