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
import { GestureDetector, usePinchGesture, useSimultaneousGestures, useTapGesture } from 'react-native-gesture-handler';
import { scheduleOnRN } from 'react-native-worklets';

import { Avatar } from '@/components/Avatar';
import { Bouncy } from '@/components/Bouncy';
import { Button } from '@/components/Button';
import { DareBanner, DarePill } from '@/components/DareBanner';
import { DropPill, DropTimer } from '@/components/DropPill';
import { IconButton } from '@/components/IconButton';
import { SafeEdge } from '@/components/SafeEdge';
import { useMe } from '@/lib/auth';
import { todayDareDay, useDareDone } from '@/lib/dares';
import { useDropDone, useDropStatus } from '@/lib/drop';
import { FACE_LENS_AVAILABLE, type FaceLook, type LensItem } from '@/lib/faceLens';
import { useIncomingRequestCount } from '@/lib/friends';
import { friendlyError } from '@/lib/errors';
import { colors, font, radius, space } from '@/theme';
import { TAB_BAR_HEIGHT } from './HomeTabBar';
import type { FaceLensHandle } from './FaceLensCamera';
import type { SoftGlowHandle } from '@/components/lens/SoftGlowCamera';
import { FACE_MESH_AVAILABLE } from '@/lib/faceMesh';
import { usePlus } from '@/lib/plus';
import { ModeDial, type CameraMode } from './ModeDial';

// The live googly-eyes lens, only on phones that have face tracking (the app download, not Expo Go).
const FaceLens: typeof import('./FaceLensCamera').FaceLensCamera | null = FACE_LENS_AVAILABLE
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./FaceLensCamera').FaceLensCamera
  : null;

// The Soft Glow filter (MediaPipe face tracking), only on downloads that have it. Peekaboo+.
const SoftGlow: typeof import('@/components/lens/SoftGlowCamera').SoftGlowCamera | null = FACE_MESH_AVAILABLE
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('@/components/lens/SoftGlowCamera').SoftGlowCamera
  : null;

// Videos can be up to this long.
const MAX_VIDEO_SECONDS = 30;

// The shutter ring takes the colour of the mode you're in, so you always know what you're about to post.
const MODE_RING: Record<CameraMode, string> = {
  photo: colors.white,
  googly: colors.blue,
  glow: colors.yellow,
  dare: colors.pink,
  drop: colors.accent,
  guess: colors.yellow,
};

// The home screen: a full-screen camera.
// Also used on its own (with `sendTo`) when you tap the camera inside a chat.
export function CameraPage({ active, warm = false, sendTo, chatDare, sendToGroup, groupDare, dare = false, drop = false, guess = false, forfeit, forfeitText }: {
  // The camera only runs while you're looking at it (saves battery).
  active: boolean;
  // You're swiping towards the camera: start it early so it's ready when you get there.
  warm?: boolean;
  // A friend's id: the photo goes straight to them as a peek.
  sendTo?: string;
  // The friend's chat dare this peek is the proof for (see chat/[id].tsx).
  chatDare?: string;
  // Opened from a group chat: what you take goes to that group (or is your proof for `groupDare`).
  sendToGroup?: string;
  groupDare?: string;
  // Taking a photo for the Daily Dare.
  dare?: boolean;
  // Taking your Peekaboo drop photo (2-minute countdown at the top).
  drop?: boolean;
  // Taking a photo for Guess Who (posted anonymously).
  guess?: boolean;
  // Paying a forfeit: its id and words.
  forfeit?: string;
  forfeitText?: string;
}) {
  const { userId, profile } = useMe();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [facing, setFacing] = useState<CameraType>('back');
  // Pinch the camera to zoom in (0 = not zoomed, 1 = as far as it goes).
  const [camZoom, setCamZoom] = useState(0);
  const camZoomShared = useSharedValue(0);
  const zoomStart = useSharedValue(0);
  const [flash, setFlash] = useState<'off' | 'on'>('off');
  const [busy, setBusy] = useState(false);
  const isHome = !sendTo && !sendToGroup && !dare && !drop && !guess && !forfeit;
  // The googly lens works on the home camera and on the camera inside a chat.
  const lensesHere = isHome || ((!!sendTo || !!sendToGroup) && !dare && !drop && !guess && !forfeit);
  const requestCount = useIncomingRequestCount(userId, active && isHome);
  const dareDone = useDareDone(userId, active && isHome);
  const dropDone = useDropDone(userId, active && isHome);
  // On the home camera you pick what you're posting with the mode dial above the shutter.
  const [homeMode, setHomeMode] = useState<CameraMode>('photo');
  const dropStatus = useDropStatus();
  const dareOn = dare || (isHome && homeMode === 'dare');
  // While today's drop is live (2 minutes) and you haven't posted it, the normal camera IS the drop camera:
  // no bubble to pick, just snap. (The drop notification also opens the camera straight in drop mode.)
  const autoDrop = isHome && homeMode === 'photo' && dropStatus.kind === 'live' && dropDone === false;
  const dropOn = drop || autoDrop;
  // Missed it: a small "post today's drop · you're late" button on the camera until you do.
  const lateDrop = isHome && homeMode === 'photo' && dropStatus.kind === 'late' && dropDone === false;
  const guessOn = guess || (isHome && homeMode === 'guess');
  // When you're taking the dare photo, a reminder of the dare pops up and then goes away.
  const [bannerGoneDay, setBannerGoneDay] = useState<string | null>(null);
  const hideBanner = () => setBannerGoneDay(todayDareDay());
  const bannerGone = bannerGoneDay === todayDareDay();
  // A quick white flash on screen when a photo is taken.
  const flashOverlay = useSharedValue(0);
  const flashStyle = useAnimatedStyle(() => ({ opacity: flashOverlay.get() }));

  // Videos: hold the shutter to record (up to 30 seconds). The camera switches to video while you hold.
  const [mic, requestMic] = useMicrophonePermissions();
  const [mode, setMode] = useState<'picture' | 'video'>('picture');
  const [recording, setRecording] = useState(false);
  const stopAsked = useRef(false);
  const cameraReady = useRef<(() => void)[]>([]);
  const recordProgress = useSharedValue(0);
  const ringStyle = useAnimatedStyle(() => ({ width: `${recordProgress.get() * 100}%` }));

  // A face lens is on: the live camera with a drawing on every face (instead of the normal camera).
  const faceLook: FaceLook | null = lensesHere && homeMode === 'googly' ? 'googly' : null;
  const lensOn = faceLook !== null && FaceLens !== null;
  const lensRef = useRef<FaceLensHandle>(null);
  // Soft Glow (Peekaboo+): the face-tracking camera with the glow drawn on top.
  const plus = usePlus();
  const glowOn = lensesHere && homeMode === 'glow' && SoftGlow !== null;
  const glowRef = useRef<SoftGlowHandle>(null);
  // Recording a video with a lens on: the normal camera is shown while you hold the shutter.
  const [lensRecording, setLensRecording] = useState(false);
  const lensVideoItems = useRef<LensItem[]>([]);

  // Lenses are for faces – picking one turns to the selfie camera.
  function changeMode(next: CameraMode) {
    // Soft Glow is a Peekaboo+ filter: without Plus, show what Peekaboo+ is instead.
    if (next === 'glow' && !plus) {
      router.push('/plus');
      return;
    }
    setHomeMode(next);
    if ((next === 'googly' || next === 'glow') && facing === 'back') setFacing('front');
  }

  const openEditor = (uri: string, fit: 'cover' | 'contain', video = false, lens: LensItem[] = []) =>
    router.push({
      pathname: '/editor',
      params: {
        uri,
        fit,
        ...(video ? { video: '1' } : {}),
        // Face lens: where the drawings were, so they're on the photo as stickers you can still move.
        ...(lens.length > 0 ? { lens: JSON.stringify(lens) } : {}),
        ...(sendTo ? { to: sendTo } : {}),
        ...(sendTo && chatDare ? { chatDare } : {}),
        ...(sendToGroup ? { group: sendToGroup } : {}),
        ...(sendToGroup && groupDare ? { groupDare } : {}),
        ...(dareOn ? { dare: '1' } : {}),
        ...(dropOn ? { drop: '1' } : {}),
        ...(guessOn ? { guess: '1' } : {}),
        ...(forfeit ? { forfeit } : {}),
      },
    });

  async function takePhoto() {
    if (busy || (glowOn ? !glowRef.current : lensOn ? !lensRef.current : !cameraRef.current)) return;
    setBusy(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    // Selfie cameras have no flash, so the screen becomes the flash: bright white for a moment, then the photo.
    const screenFlash = flash === 'on' && facing === 'front';
    if (screenFlash) {
      flashOverlay.set(withTiming(1, { duration: 80 }));
      await new Promise((resolve) => setTimeout(resolve, 280));
    } else {
      flashOverlay.set(withSequence(withTiming(0.85, { duration: 60 }), withTiming(0, { duration: 300 })));
    }
    try {
      if (glowOn && glowRef.current) {
        const shot = await glowRef.current.capture();
        openEditor(shot.uri, 'cover');
        return;
      }
      if (lensOn && lensRef.current) {
        const shot = await lensRef.current.capture();
        openEditor(shot.uri, 'cover', false, shot.items);
        return;
      }
      if (!cameraRef.current) return;
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.85 });
      openEditor(photo.uri, 'cover');
    } catch (error) {
      Alert.alert('Could not take photo', friendlyError(error));
    } finally {
      if (screenFlash) flashOverlay.set(withTiming(0, { duration: 250 }));
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
    if (busy || recording) return;
    if (!lensOn && !glowOn && !cameraRef.current) return;
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
    // With a lens: the normal camera takes over while you record (the lens camera can't record video reliably
    // yet). The googly eyes go on the video as stickers where they were when you started.
    if (glowOn) {
      // Soft Glow: the normal camera records the video (the glow isn't in videos yet).
      setLensRecording(true);
      await new Promise((resolve) => setTimeout(resolve, 900));
    } else if (lensOn && lensRef.current) {
      lensVideoItems.current = lensRef.current.currentItems();
      setLensRecording(true);
      // The normal camera needs a moment to start up.
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
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
      if (video?.uri) openEditor(video.uri, 'cover', true, lensVideoItems.current);
      else if (!withSound) Alert.alert('No video', 'Something went wrong while recording. Try again!');
    } catch (error) {
      Alert.alert('Could not record', friendlyError(error));
    } finally {
      cancelAnimation(recordProgress);
      recordProgress.set(0);
      setRecording(false);
      setMode('picture');
      setBusy(false);
      setLensRecording(false);
      lensVideoItems.current = [];
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
    // A new camera starts un-zoomed.
    camZoomShared.set(0);
    setCamZoom(0);
  }

  // Pinch anywhere on the camera to zoom; double-tap to flip between the front and back camera.
  const pinchZoom = usePinchGesture({
    onActivate: () => {
      'worklet';
      zoomStart.set(camZoomShared.get());
    },
    onUpdate: (event) => {
      'worklet';
      const next = Math.min(1, Math.max(0, zoomStart.get() + (event.scale - 1) * 0.45));
      camZoomShared.set(next);
      scheduleOnRN(setCamZoom, next);
    },
  });
  const doubleTapFlip = useTapGesture({
    numberOfTaps: 2,
    onActivate: () => {
      'worklet';
      scheduleOnRN(tapFlip);
    },
  });
  const cameraGestures = useSimultaneousGestures(pinchZoom, doubleTapFlip);
  function tapFlip() {
    Haptics.selectionAsync();
    flipCamera();
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
        glowOn && !lensRecording && SoftGlow ? (
          <SoftGlow ref={glowRef} active={active} facing={facing} flash={flash} zoom={camZoom} />
        ) : lensOn && !lensRecording && FaceLens ? (
          <FaceLens ref={lensRef} active={active} facing={facing} flash={flash} zoom={camZoom} />
        ) : active || warm ? (
          <CameraView
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            facing={facing}
            zoom={camZoom}
            // Flash during a video: the back camera's light stays on the whole time.
            enableTorch={recording && flash === 'on' && facing === 'back'}
            // The selfie camera uses the screen as its flash instead (see takePhoto).
            flash={facing === 'back' ? flash : 'off'}
            mirror={facing === 'front'}
            mode={mode}
            mute={!(mic?.granted ?? false)}
            // Small, quick-to-upload videos: 720p at a modest quality (about 9–10 MB for 30 seconds).
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

      {permission?.granted ? (
        <GestureDetector gesture={cameraGestures}>
          <View style={StyleSheet.absoluteFill} accessible={false} />
        </GestureDetector>
      ) : null}
      <Animated.View style={[styles.flash, flashStyle]} pointerEvents="none" />
      {/* Flash during a selfie video: a bright ring light around the screen edges lights up your face. */}
      {recording && flash === 'on' && facing === 'front' ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <View style={styles.selfieLightFill} />
          <View style={styles.selfieLightEdge} />
        </View>
      ) : null}

      {/* Top: your picture on the left (with a count of new friend requests), flip and flash on the right */}
      <SafeEdge edge="top" style={styles.top} pointerEvents="box-none">
        <View style={styles.topLeftColumn} pointerEvents="box-none">
          {isHome ? (
            <Pressable onPress={() => router.push(`/profile/${userId}`)} accessibilityLabel="My profile">
              <Avatar path={profile?.avatar_path} name={profile?.display_name || profile?.username} size={44} ring />
              <CountBadge count={requestCount} />
            </Pressable>
          ) : (
            <IconButton icon="close" label="Close camera" onPress={() => router.back()} />
          )}
          {/* Paying a forfeit: a reminder of what you owe */}
          {forfeit ? (
            <View style={styles.forfeitNote}>
              <Text style={styles.forfeitLabel}>💀 YOUR FORFEIT</Text>
              <Text style={styles.forfeitText}>{forfeitText}</Text>
            </View>
          ) : null}
          {/* Taking your drop photo: the countdown, and today's dare in case you'd rather do that */}
          {drop || autoDrop ? <DropTimer /> : null}
          {lateDrop ? <DropPill /> : null}
          {drop ? <DarePill done={null} /> : null}
          {/* Taking the dare photo: a quick reminder of what the dare is */}
          {dare && !bannerGone ? <DareBanner onDismiss={hideBanner} /> : null}
        </View>
        <View style={styles.tools}>
          <IconButton icon="camera-reverse" label="Flip camera" size={40} onPress={flipCamera} />
          <IconButton
            icon={flash === 'on' ? 'flash' : 'flash-off'}
            label="Flash"
            size={40}
            color={flash === 'on' ? colors.yellow : colors.white}
            onPress={() => setFlash(flash === 'on' ? 'off' : 'on')}
          />
        </View>
      </SafeEdge>

      {/* Bottom: gallery · the big shutter button · friend map (on the home screen, just above the tab bar) */}
      <SafeEdge edge="bottom" style={[styles.bottom, isHome && styles.bottomAboveTabs]} pointerEvents="box-none">
        {/* Home camera: what you're posting (Dare · Drop · Googly · Guess Who). Swipe the bubbles or tap one – no words on screen. */}
        {isHome ? (
          <ModeDial
            mode={homeMode}
            onChange={changeMode}
            dots={{ dare: dareDone === false }}
          />
        ) : lensesHere ? (
          // In a chat: just the lenses.
          <ModeDial mode={homeMode} onChange={changeMode} lensesOnly />
        ) : null}
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
            accessibilityLabel={autoDrop ? 'Take your Peekaboo drop photo' : 'Take photo, or hold to record a video'}
            pressScale={0.82}
            style={[
              styles.shutter,
              lensesHere && { borderColor: autoDrop ? MODE_RING.drop : MODE_RING[homeMode] },
              recording && styles.shutterRecording,
            ]}>
            <View style={[styles.shutterInner, recording && styles.shutterInnerRecording]} />
          </Bouncy>
          {isHome ? (
            <IconButton icon="map" label="Friend map" onPress={() => router.push('/map')} />
          ) : (
            <View style={styles.shutterSpacer} />
          )}
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
  forfeitNote: {
    alignSelf: 'stretch',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: radius.md,
    padding: space.md,
    gap: 2,
  },
  forfeitLabel: {
    color: colors.purple,
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  forfeitText: {
    color: colors.white,
    fontSize: 15,
    fontWeight: '700',
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
    flexDirection: 'row',
    gap: space.sm,
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
  // A see-through wash of light over the preview plus a bright thin edge – lights your face in the dark
  // without hiding any of the picture.
  selfieLightFill: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(255, 248, 240, 0.28)',
  },
  selfieLightEdge: {
    ...StyleSheet.absoluteFill,
    borderWidth: 12,
    borderColor: 'rgba(255, 248, 240, 0.95)',
    borderRadius: 28,
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
