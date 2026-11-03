import Ionicons from '@expo/vector-icons/Ionicons';
import { randomUUID } from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { Alert, Image, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { GestureDetector, usePanGesture, usePinchGesture, useSimultaneousGestures, useTapGesture } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withSequence, withTiming } from 'react-native-reanimated';
import { captureRef } from 'react-native-view-shot';
import { scheduleOnRN } from 'react-native-worklets';
import { StatusBar } from 'expo-status-bar';

import { DraggableItem, type TrashZone } from '@/components/editor/DraggableItem';
import { FilterLayers, FILTERS } from '@/components/editor/filters';
import { StickerPicker } from '@/components/editor/StickerPicker';
import { randomOffset, TEXT_COLORS, type OverlayItem } from '@/components/editor/stickers';
import { TextComposer, type TextDraft } from '@/components/editor/TextComposer';
import { IconButton } from '@/components/IconButton';
import { useOverlays } from '@/components/Overlays';
import { SafeEdge } from '@/components/SafeEdge';
import { VideoClip } from '@/components/VideoClipSafe';
import { useMe } from '@/lib/auth';
import { sendSnap } from '@/lib/chat';
import { friendlyError } from '@/lib/errors';
import { addKeep, CAN_SAVE_TO_PHOTOS, saveToPhotos } from '@/lib/keeps';
import { resizePhoto, type Capture } from '@/lib/media';
import type { EyePair } from '@/lib/faceLens';
import { colors, radius, space } from '@/theme';

const WORD_COLORS = [colors.pink, colors.purple, colors.blue, colors.yellow, colors.green, colors.orange];

// Decorate your photo or video: swipe left/right for a color filter (photos), add text and stickers, move them
// around, then send it.
export default function Editor() {
  const { uri, fit, video, to, dare, drop, guess, forfeit, eyes, lens, filter: startFilter } = useLocalSearchParams<{
    uri: string;
    fit?: 'cover' | 'contain';
    // '1' when it's a video
    video?: string;
    to?: string;
    dare?: string;
    drop?: string;
    guess?: string;
    forfeit?: string;
    // From the googly lens: where the eyes were on each face (JSON). (Older copies of the app.)
    eyes?: string;
    // From a face lens: the drawing on each face and where it was (JSON list of LensItem).
    lens?: string;
    // Start with this filter on (its name, e.g. 'Glow ✨' from the Glow lens).
    filter?: string;
  }>();
  const { width, height } = useWindowDimensions();
  const canvasRef = useRef<ComponentRef<typeof View>>(null);

  // A photo from the googly lens starts with its eyes on the faces – real stickers you can move or delete.
  const [items, setItems] = useState<OverlayItem[]>(() => lensItems(lens ?? eyes, width, height));
  const [dragging, setDragging] = useState(false);
  const [composer, setComposer] = useState<{ editingId: string | null; draft: TextDraft } | null>(null);
  const [stickersOpen, setStickersOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const isVideo = video === '1';
  const { userId } = useMe();
  const { showToast } = useOverlays();
  // Opened from a chat's camera: the peek goes straight to that one friend – no "Send to…" list.
  const straightToChat = !!to && !dare && !drop && !guess && !forfeit;
  // Which color filter is on (0 = none), and a counter that makes its name flash up each time it changes.
  const [filterIndex, setFilterIndex] = useState(() => Math.max(0, FILTERS.findIndex((f) => f.name === startFilter)));
  const [filterFlash, setFilterFlash] = useState(0);
  const filter = FILTERS[filterIndex];

  function changeFilter(step: number) {
    Haptics.selectionAsync();
    setFilterIndex((current) => (current + step + FILTERS.length) % FILTERS.length);
    setFilterFlash((count) => count + 1);
  }

  // Zoom and crop: pinch the photo to zoom in, drag it to frame it, double-tap to go back.
  // What's on screen is what gets sent, so zooming in is how you crop.
  const zoom = useSharedValue(1);
  const panX = useSharedValue(0);
  const panY = useSharedValue(0);
  const clampPan = (value: number, size: number, z: number) => {
    'worklet';
    const max = (size * (z - 1)) / 2;
    return Math.min(max, Math.max(-max, value));
  };
  const pinch = usePinchGesture({
    onUpdate: (event) => {
      'worklet';
      const before = zoom.get();
      const after = Math.min(5, Math.max(1, before * event.scaleChange));
      const factor = after / before;
      // Zoom towards your fingers.
      const fx = event.focalX - width / 2;
      const fy = event.focalY - height / 2;
      zoom.set(after);
      panX.set(clampPan(fx - (fx - panX.get()) * factor, width, after));
      panY.set(clampPan(fy - (fy - panY.get()) * factor, height, after));
    },
  });
  // One finger: while zoomed in it moves the photo; otherwise swipe left/right for filters, like Snapchat.
  const swipe = usePanGesture({
    minDistance: 12,
    onUpdate: (event) => {
      'worklet';
      if (zoom.get() <= 1.02) return;
      panX.set(clampPan(panX.get() + event.changeX, width, zoom.get()));
      panY.set(clampPan(panY.get() + event.changeY, height, zoom.get()));
    },
    onDeactivate: (event) => {
      'worklet';
      if (zoom.get() > 1.02) return;
      if (Math.abs(event.translationY) > Math.abs(event.translationX)) return;
      if (event.translationX < -40) scheduleOnRN(changeFilter, 1);
      else if (event.translationX > 40) scheduleOnRN(changeFilter, -1);
    },
  });
  const resetZoom = useTapGesture({
    numberOfTaps: 2,
    onActivate: () => {
      'worklet';
      zoom.set(withTiming(1));
      panX.set(withTiming(0));
      panY.set(withTiming(0));
    },
  });
  const photoGestures = useSimultaneousGestures(pinch, swipe, resetZoom);
  const zoomStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: panX.get() }, { translateY: panY.get() }, { scale: zoom.get() }],
  }));

  const trash: TrashZone = { top: height - 150, left: width / 2 - 70, right: width / 2 + 70 };

  function addItem(item: Omit<OverlayItem, 'id' | 'startX' | 'startY'>) {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setItems((current) => [
      ...current,
      { ...item, id: randomUUID(), startX: randomOffset(width * 0.4), startY: randomOffset(height * 0.3) },
    ]);
  }

  function removeItem(id: string) {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setItems((current) => current.filter((item) => item.id !== id));
  }

  function editItem(id: string) {
    const item = items.find((entry) => entry.id === id);
    if (item?.kind === 'text') {
      setComposer({ editingId: id, draft: { content: item.content, color: item.color, look: item.look } });
    }
  }

  function finishText(draft: TextDraft) {
    const editingId = composer?.editingId;
    setComposer(null);
    if (editingId) {
      setItems((current) =>
        draft.content
          ? current.map((item) => (item.id === editingId ? { ...item, ...draft } : item))
          : current.filter((item) => item.id !== editingId),
      );
    } else if (draft.content) {
      addItem({ kind: 'text', ...draft });
    }
  }

  function close() {
    if (items.length === 0 && filterIndex === 0) {
      router.back();
      return;
    }
    Alert.alert('Throw this photo away?', undefined, [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Throw away', style: 'destructive', onPress: () => router.back() },
    ]);
  }

  // The finished picture (or the video plus its text/sticker layer), ready to send or keep.
  async function finish(): Promise<Capture> {
    if (isVideo) {
      return {
        kind: 'video',
        uri,
        overlayUri: items.length > 0 ? await captureRef(canvasRef, { format: 'png', result: 'tmpfile' }) : null,
      };
    }
    return { kind: 'photo', uri: await resizePhoto(await captureRef(canvasRef, { format: 'jpg', quality: 0.9, result: 'tmpfile' }), 1080) };
  }

  // Save it with everything on it: to the phone's Photos and to your Keeps in Peekaboo.
  const [saved, setSaved] = useState(false);
  async function keep() {
    if (busy || saved) return;
    setBusy(true);
    try {
      const capture = await finish();
      await addKeep(userId, capture);
      const inPhotos = CAN_SAVE_TO_PHOTOS ? await saveToPhotos(capture.uri).catch(() => false) : false;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSaved(true);
      showToast(inPhotos ? 'Saved to Photos and your Keeps 📦' : 'Saved to your Keeps 📦');
    } catch (error) {
      Alert.alert('Could not save', friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  async function next() {
    setBusy(true);
    try {
      const extra = {
        ...(to ? { to } : {}),
        ...(dare ? { dare } : {}),
        ...(drop ? { drop } : {}),
        ...(guess ? { guess } : {}),
        ...(forfeit ? { forfeit } : {}),
      };
      if (straightToChat) {
        const photo: Capture = isVideo
          ? {
              kind: 'video',
              uri,
              overlayUri: items.length > 0 ? await captureRef(canvasRef, { format: 'png', result: 'tmpfile' }) : null,
            }
          : { kind: 'photo', uri: await resizePhoto(await captureRef(canvasRef, { format: 'jpg', quality: 0.9, result: 'tmpfile' }), 1080) };
        await sendSnap(userId, [to], photo);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        showToast('Peek sent 👀');
        router.dismissTo(`/chat/${to}`);
        return;
      }
      if (isVideo) {
        // Videos keep their text and stickers as a see-through picture that's shown on top while it plays.
        const overlay =
          items.length > 0 ? await captureRef(canvasRef, { format: 'png', result: 'tmpfile' }) : undefined;
        router.push({ pathname: '/share', params: { uri, video: '1', ...(overlay ? { overlay } : {}), ...extra } });
        return;
      }
      // Take a "screenshot" of the photo with all the text and stickers on it.
      const finished = await captureRef(canvasRef, { format: 'jpg', quality: 0.9, result: 'tmpfile' });
      router.push({ pathname: '/share', params: { uri: finished, ...extra } });
    } catch (error) {
      Alert.alert(straightToChat ? 'Could not send' : 'Could not save the photo', friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.fill}>
      <StatusBar style="light" />
      {isVideo ? <VideoClip uri={uri} playing loop style={StyleSheet.absoluteFill} /> : null}
      <View ref={canvasRef} collapsable={false} style={[styles.canvas, isVideo && styles.seeThrough]}>
        {isVideo ? null : (
          <GestureDetector gesture={photoGestures}>
            <View style={styles.photo}>
              <Animated.View style={[StyleSheet.absoluteFill, zoomStyle]}>
              {fit === 'contain' ? (
                <>
                  {/* Photos from the camera roll keep their shape. Instead of black bars around them,
                      a blurry, zoomed-in copy of the same photo fills the empty space. */}
                  <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" blurRadius={40} />
                  <View style={styles.dim} />
                  <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="contain" />
                </>
              ) : (
                <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
              )}
              </Animated.View>
              <FilterLayers filter={filter} />
            </View>
          </GestureDetector>
        )}
        {items.map((item) => (
          <DraggableItem
            key={item.id}
            item={item}
            trash={trash}
            onDragChange={setDragging}
            onDelete={removeItem}
            onTap={editItem}
          />
        ))}
      </View>

      {!dragging && !composer ? (
        <>
          <SafeEdge edge="top" style={styles.top} pointerEvents="box-none">
            <IconButton icon="close" label="Close" onPress={close} />
            <View style={styles.tools}>
              <IconButton
                icon="text"
                label="Add text"
                onPress={() =>
                  setComposer({ editingId: null, draft: { content: '', color: TEXT_COLORS[0], look: 'shadow' } })
                }
              />
              <IconButton icon="happy-outline" label="Add sticker" onPress={() => setStickersOpen(true)} />
              {/* One tap: a pair of googly eyes to drag onto someone's eyes (pinch to resize) */}
              <IconButton
                icon="eye-outline"
                label="Add googly eyes"
                onPress={() => {
                  Haptics.selectionAsync();
                  addItem({ kind: 'special', content: 'googly-eyes', color: colors.white, look: 'shadow' });
                }}
              />
              {items.length > 0 ? (
                <IconButton icon="arrow-undo" label="Undo" onPress={() => setItems((current) => current.slice(0, -1))} />
              ) : null}
            </View>
          </SafeEdge>

          <SafeEdge edge="bottom" style={styles.bottom} pointerEvents="box-none">
            {isVideo ? null : (
              <View style={styles.dots} pointerEvents="none">
                {FILTERS.map((entry, index) => (
                  <View key={entry.name} style={[styles.dot, index === filterIndex && styles.dotOn]} />
                ))}
              </View>
            )}
            {items.length === 0 ? (
              <Text style={styles.hint}>
                {isVideo ? 'Add text or stickers, or just send it!' : 'Pinch to zoom & crop · swipe ← → for filters'}
              </Text>
            ) : (
              <Text style={styles.hint}>Drag to move · pinch to resize · drop on 🗑️ to remove</Text>
            )}
            <View style={styles.bottomRow}>
              {/* Bottom-left corner: save it (to Photos and your Keeps). */}
              <Pressable
                onPress={keep}
                disabled={busy || saved}
                style={({ pressed }) => [styles.save, saved && styles.saveDone, pressed && styles.sendPressed]}
                accessibilityRole="button"
                accessibilityLabel={saved ? 'Saved' : 'Save to Photos and Keeps'}>
                <Text style={styles.saveEmoji}>{saved ? '✅' : '📥'}</Text>
                <Text style={styles.saveText}>{saved ? 'Saved' : 'Save'}</Text>
              </Pressable>
              <Pressable
                onPress={next}
                disabled={busy}
                style={({ pressed }) => [styles.send, (pressed || busy) && styles.sendPressed]}
                accessibilityRole="button">
                <Text style={styles.sendText}>{busy ? (straightToChat ? 'Sending…' : 'Saving…') : straightToChat ? 'Send' : 'Send to'}</Text>
                <Ionicons name="send" size={18} color={colors.onAccent} />
              </Pressable>
            </View>
          </SafeEdge>
        </>
      ) : null}

      {filterFlash > 0 && !composer ? <FilterName key={filterFlash} name={filter.name} /> : null}

      {dragging ? (
        <View style={[styles.trash, { top: trash.top + 20, left: width / 2 - 36 }]} pointerEvents="none">
          <Ionicons name="trash" size={30} color={colors.white} />
        </View>
      ) : null}

      {composer ? <TextComposer initial={composer.draft} onDone={finishText} /> : null}

      <StickerPicker
        visible={stickersOpen}
        onClose={() => setStickersOpen(false)}
        onPickEmoji={(emoji) => {
          setStickersOpen(false);
          addItem({ kind: 'sticker', content: emoji, color: colors.white, look: 'shadow' });
        }}
        onPickSpecial={(id) => {
          setStickersOpen(false);
          addItem({ kind: 'special', content: id, color: colors.white, look: 'shadow' });
        }}
        onPickWord={(word) => {
          setStickersOpen(false);
          const color = WORD_COLORS[Math.floor(Math.random() * WORD_COLORS.length)];
          addItem({ kind: 'text', content: word, color, look: 'pill' });
        }}
      />
    </View>
  );
}

// A face lens's drawings (screen points) → stickers placed from the middle of the photo.
// (Googly eyes from older copies of the app come without a `sticker`.)
function lensItems(json: string | undefined, width: number, height: number): OverlayItem[] {
  if (!json) return [];
  try {
    const pairs = JSON.parse(json) as (EyePair & { sticker?: string })[];
    return pairs.map((pair) => ({
      id: randomUUID(),
      kind: 'special' as const,
      content: pair.sticker ?? 'googly-eyes',
      color: colors.white,
      look: 'shadow' as const,
      startX: pair.x - width / 2,
      startY: pair.y - height / 2,
      startScale: pair.scale,
      startRotation: pair.rotation,
    }));
  } catch {
    return [];
  }
}

// The filter's name flashes up in the middle for a moment when you swipe to it.
function FilterName({ name }: { name: string }) {
  const opacity = useSharedValue(0);
  useEffect(() => {
    opacity.set(withSequence(withTiming(1, { duration: 120 }), withDelay(700, withTiming(0, { duration: 350 }))));
  }, [opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  return (
    <Animated.View style={[styles.filterName, style]} pointerEvents="none">
      <Text style={styles.filterNameText}>{name}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  photo: {
    ...StyleSheet.absoluteFill,
    isolation: 'isolate',
    overflow: 'hidden',
  },
  filterName: {
    position: 'absolute',
    top: '42%',
    alignSelf: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  filterNameText: {
    color: colors.white,
    fontSize: 22,
    fontWeight: '900',
  },
  dots: {
    flexDirection: 'row',
    alignSelf: 'center',
    gap: 6,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.45)',
  },
  dotOn: {
    backgroundColor: colors.pink,
    transform: [{ scale: 1.3 }],
  },
  fill: {
    flex: 1,
    backgroundColor: colors.black,
  },
  canvas: {
    ...StyleSheet.absoluteFill,
    backgroundColor: colors.black,
    overflow: 'hidden',
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
  seeThrough: {
    backgroundColor: 'transparent',
  },
  dim: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  tools: {
    gap: space.md,
  },
  bottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: 'flex-end',
    paddingHorizontal: space.lg,
    paddingBottom: space.lg,
    gap: space.md,
  },
  hint: {
    alignSelf: 'center',
    color: 'rgba(255,255,255,0.85)',
    fontWeight: '700',
    fontSize: 13,
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowRadius: 6,
  },
  bottomRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  save: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.35)',
  },
  saveDone: {
    borderColor: colors.green,
  },
  saveEmoji: {
    fontSize: 24,
    lineHeight: 28,
  },
  saveText: {
    color: colors.white,
    fontSize: 10,
    fontWeight: '800',
  },
  send: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: colors.accent,
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    borderRadius: radius.pill,
  },
  sendPressed: {
    opacity: 0.8,
    transform: [{ scale: 0.97 }],
  },
  sendText: {
    color: colors.onAccent,
    fontWeight: '900',
    fontSize: 17,
  },
  trash: {
    position: 'absolute',
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(255,77,94,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
