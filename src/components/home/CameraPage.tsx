import { CameraView, useCameraPermissions, useMicrophonePermissions, type CameraType } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { Avatar } from '@/components/Avatar';
import { Bouncy } from '@/components/Bouncy';
import { Button } from '@/components/Button';
import { DareBanner, DarePill } from '@/components/DareBanner';
import { DropPill, DropTimer } from '@/components/DropPill';
import { IconButton } from '@/components/IconButton';
import { SafeEdge } from '@/components/SafeEdge';
import { useMe } from '@/lib/auth';
import { todayDareDay, useDareDone } from '@/lib/dares';
import { useDropDone } from '@/lib/drop';
import { useIncomingRequestCount } from '@/lib/friends';
import { friendlyError } from '@/lib/errors';
import { colors, font, space } from '@/theme';
import { TAB_BAR_HEIGHT } from './HomeTabBar';

// Videos can be up to this long.
const MAX_VIDEO_SECONDS = 10;

// The home screen: a full-screen camera.
// Also used on its own (with `sendTo`) when you tap the camera inside a chat.
export function CameraPage({ active, warm = false, sendTo, dare = false, drop = false }: {
  // The camera only runs while you're looking at it (saves battery).
  active: boolean;
  // You're swiping towards the camera: start it early so it's ready when you get there.
  warm?: boolean;
  // A friend's id: the photo goes straight to them as a peek.
  sendTo?: string;
  // Taking a photo for the Daily Dare.
  dare?: boolean;
  // Taking your Peekaboo drop photo (2-minute countdown at the top).
  drop?: boolean;
}) {
  const { userId, profile } = useMe();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [facing, setFacing] = useState<CameraType>('back');
  const lastTap = useRef(0);
  const [flash, setFlash] = useState<'off' | 'on'>('off');
  const [busy, setBusy] = useState(false);
  const isHome = !sendTo && !dare && !drop;
  const requestCount = useIncomingRequestCount(userId, active && isHome);
  const dareDone = useDareDone(userId, active && isHome);
  const dropDone = useDropDone(userId, active && isHome);
  // When you're taking the dare photo, a reminder of the dare pops up and then goes away.
  const [bannerGoneDay, setBannerGoneDay] = useState<string | null>(null);
  const hideBanner = () => setBannerGoneDay(todayDareDay());
  const bannerGone = bannerGoneDay === todayDareDay();
  // A quick white flash on screen when a photo is taken.
  const flashOverlay = useSharedValue(0);
  const flashStyle = useAnimatedStyle(() => ({ opacity: flashOverlay.get() }));

  // Videos: hold the shutter to record (up to 10 seconds). The camera switches to video while you hold.
  const [mic, requestMic] = useMicrophonePermissions();
  const [mode, setMode] = useState<'picture' | 'video'>('picture');
  const [recording, setRecording] = useState(false);
  const stopAsked = useRef(false);
  const cameraReady = useRef<(() => void)[]>([]);
  const recordProgress = useSharedValue(0);
  const ringStyle = useAnimatedStyle(() => ({ width: `${recordProgress.get() * 100}%` }));

  const openEditor = (uri: string, fit: 'cover' | 'contain', video = false) =>
    router.push({
      pathname: '/editor',
      params: {
        uri,
        fit,
        ...(video ? { video: '1' } : {}),
        ...(sendTo ? { to: sendTo } : {}),
        ...(dare ? { dare: '1' } : {}),
        ...(drop ? { drop: '1' } : {}),
      },
    });

  async function takePhoto() {
    if (!cameraRef.current || busy) return;
    setBusy(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    flashOverlay.set(withSequence(withTiming(0.85, { duration: 60 }), withTiming(0, { duration: 300 })));
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.85 });
      openEditor(photo.uri, 'cover');
    } catch (error) {
      Alert.alert('Could not take photo', friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  // Wait until the camera has switched to video (or give up waiting after a moment).
  const waitForCamera = () =>
    new Promise<void>((resolve) => {
      cameraReady.current.push(resolve);
      setTimeout(resolve, 700);
    });

  async function startRecording() {
    if (!cameraRef.current || busy || recording) return;
    // First time: ask for the microphone (so videos have sound), then you hold again.
    if (!mic?.granted && mic?.canAskAgain !== false) {
      await requestMic();
      return;
    }
    const withSound = mic?.granted ?? false;
    stopAsked.current = false;
    setBusy(true);
    setRecording(true);
    setMode('video');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await waitForCamera();
    try {
      recordProgress.set(0);
      recordProgress.set(withTiming(1, { duration: MAX_VIDEO_SECONDS * 1000, easing: Easing.linear }));
      // You let go before it even started: still keep a short clip.
      if (stopAsked.current) setTimeout(() => cameraRef.current?.stopRecording(), 300);
      const video = await cameraRef.current?.recordAsync({
        maxDuration: MAX_VIDEO_SECONDS,
        ...(Platform.OS === 'ios' ? { codec: 'avc1' as const } : {}),
      });
      if (video?.uri) openEditor(video.uri, 'cover', true);
      else if (!withSound) Alert.alert('No video', 'Something went wrong while recording. Try again!');
    } catch (error) {
      Alert.alert('Could not record', friendlyError(error));
    } finally {
      cancelAnimation(recordProgress);
      recordProgress.set(0);
      setRecording(false);
      setMode('picture');
      setBusy(false);
    }
  }

  function stopRecording() {
    stopAsked.current = true;
    if (recording) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      cameraRef.current?.stopRecording();
    }
  }

  function flipCamera() {
    setFacing((current) => (current === 'back' ? 'front' : 'back'));
  }

  // Double-tap anywhere on the camera to flip between the front and back camera.
  function tapCamera() {
    const now = Date.now();
    if (now - lastTap.current < 300) {
      lastTap.current = 0;
      Haptics.selectionAsync();
      flipCamera();
    } else {
      lastTap.current = now;
    }
  }

  async function pickFromGallery() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      quality: 0.9,
      videoMaxDuration: MAX_VIDEO_SECONDS,
      allowsEditing: false,
    });
    const asset = result.canceled ? null : result.assets[0];
    if (!asset) return;
    if (asset.type === 'video') {
      // Peekaboo videos are short and small, so uploads stay quick.
      if ((asset.duration ?? 0) > (MAX_VIDEO_SECONDS + 0.5) * 1000) {
        Alert.alert('Too long', `Pick a video of ${MAX_VIDEO_SECONDS} seconds or less.`);
        return;
      }
      if ((asset.fileSize ?? 0) > 30 * 1024 * 1024) {
        Alert.alert('Too big', 'That video is too big. Try a shorter one, or record one in Peekaboo.');
        return;
      }
      openEditor(asset.uri, 'cover', true);
      return;
    }
    openEditor(asset.uri, 'contain');
  }

  return (
    <View style={styles.fill}>
      {!permission ? null : permission.granted ? (
        active || warm ? (
          <CameraView
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            facing={facing}
            flash={flash}
            mirror={facing === 'front'}
            mode={mode}
            mute={!(mic?.granted ?? false)}
            // Small, quick-to-upload videos: 720p at a modest quality (about 3–4 MB for 10 seconds).
            videoQuality="720p"
            videoBitrate={2_500_000}
            onCameraReady={() => cameraReady.current.splice(0).forEach((resolve) => resolve())}
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

      {permission?.granted ? <Pressable style={StyleSheet.absoluteFill} onPress={tapCamera} accessible={false} /> : null}
      <Animated.View style={[styles.flash, flashStyle]} pointerEvents="none" />

      {/* Top: your picture on the left, camera controls on the right */}
      <SafeEdge edge="top" style={styles.top} pointerEvents="box-none">
        <View style={styles.topLeftColumn} pointerEvents="box-none">
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
          {/* Today's dare, always one tap away (pink dot = not done yet) */}
          {isHome ? <DarePill done={dareDone} /> : null}
          {/* Once today's Peekaboo drop has happened, until you've posted yours */}
          {isHome && dropDone === false ? <DropPill /> : null}
          {/* Taking your drop photo: the countdown, and today's dare in case you'd rather do that */}
          {drop ? <DropTimer /> : null}
          {drop ? <DarePill done={null} /> : null}
          {/* Taking the dare photo: a quick reminder of what the dare is */}
          {dare && !bannerGone ? <DareBanner onDismiss={hideBanner} /> : null}
        </View>
        <View style={styles.tools}>
          {isHome ? <IconButton icon="map" label="Friend map" onPress={() => router.push('/map')} /> : null}
          <IconButton
            icon="camera-reverse"
            label="Flip camera"
            onPress={flipCamera}
          />
          <IconButton
            icon={flash === 'on' ? 'flash' : 'flash-off'}
            label="Flash"
            color={flash === 'on' ? colors.yellow : colors.white}
            onPress={() => setFlash(flash === 'on' ? 'off' : 'on')}
          />
        </View>
      </SafeEdge>

      {/* Bottom: gallery and the big shutter button (on the home screen, just above the tab bar) */}
      <SafeEdge edge="bottom" style={[styles.bottom, isHome && styles.bottomAboveTabs]} pointerEvents="box-none">
        {recording ? (
          <View style={styles.recordTrack} pointerEvents="none">
            <Animated.View style={[styles.recordBar, ringStyle]} />
          </View>
        ) : null}
        <View style={styles.shutterRow}>
          <IconButton icon="images" label="Pick from gallery" onPress={pickFromGallery} />
          {/* The big shutter button: tap for a photo, hold for a video. It squishes when you press it. */}
          <Bouncy
            onPress={takePhoto}
            onLongPress={startRecording}
            delayLongPress={250}
            onPressOut={stopRecording}
            disabled={!permission?.granted || (busy && !recording)}
            accessibilityRole="button"
            accessibilityLabel="Take photo, or hold to record a video"
            pressScale={0.82}
            style={[styles.shutter, recording && styles.shutterRecording]}>
            <View style={[styles.shutterInner, recording && styles.shutterInnerRecording]} />
          </Bouncy>
          <View style={styles.shutterSpacer} />
        </View>
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
  topLeftColumn: {
    flex: 1,
    alignItems: 'flex-start',
    gap: space.md,
    marginRight: space.lg,
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
  bottomAboveTabs: {
    paddingBottom: TAB_BAR_HEIGHT + space.md,
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
  flash: {
    ...StyleSheet.absoluteFill,
    backgroundColor: colors.white,
  },
  shutterInner: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: 'rgba(255,255,255,0.25)',
  },
  shutterRecording: {
    borderColor: colors.red,
  },
  shutterInnerRecording: {
    backgroundColor: colors.red,
    width: 40,
    height: 40,
    borderRadius: 10,
  },
  recordTrack: {
    height: 6,
    marginHorizontal: space.xl,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.3)',
    overflow: 'hidden',
  },
  recordBar: {
    height: 6,
    backgroundColor: colors.red,
  },
  shutterSpacer: {
    width: 44,
  },
});
