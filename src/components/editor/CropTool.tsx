import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Image as RNImage, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { SafeEdge } from '@/components/SafeEdge';
import { friendlyError } from '@/lib/errors';
import { colors, radius, space } from '@/theme';

// The smallest the crop box can get (screen points).
const MIN = 60;
// Room around the photo for the handles and buttons.
const TOP_ROOM = 120;
const BOTTOM_ROOM = 190;

type Shape = { key: string; label: string; ratio: number | null };
const SHAPES: Shape[] = [
  { key: 'free', label: 'Free', ratio: null },
  { key: 'square', label: 'Square', ratio: 1 },
  { key: '45', label: '4:5', ratio: 4 / 5 },
  { key: '916', label: '9:16', ratio: 9 / 16 },
];

type Edge = 'left' | 'right' | 'top' | 'bottom' | 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight' | 'move';

// Crop a photo: drag the sides or corners of the box (or drag inside it to move it), pick a shape if you like,
// then Done. Gives back the cropped photo.
export function CropTool({ uri, onDone, onCancel }: { uri: string; onDone: (cropped: string) => void; onCancel: () => void }) {
  const { width: screenW, height: screenH } = useWindowDimensions();
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [shape, setShape] = useState<Shape>(SHAPES[0]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    RNImage.getSize(uri, (w, h) => setSize({ w, h }), () => setSize({ w: screenW, h: screenH }));
  }, [uri, screenW, screenH]);

  // Where the whole photo sits on screen (fitted inside the space between the top and bottom bars).
  const areaW = screenW - space.lg * 2;
  const areaH = screenH - TOP_ROOM - BOTTOM_ROOM;
  const scale = size ? Math.min(areaW / size.w, areaH / size.h) : 1;
  const shownW = size ? size.w * scale : areaW;
  const shownH = size ? size.h * scale : areaH;
  const left0 = (screenW - shownW) / 2;
  const top0 = TOP_ROOM + (areaH - shownH) / 2;

  // The crop box, in screen points.
  const x = useSharedValue(left0);
  const y = useSharedValue(top0);
  const w = useSharedValue(shownW);
  const h = useSharedValue(shownH);
  const ratio = useSharedValue<number | null>(null);

  // Start with the whole photo once its size is known.
  useEffect(() => {
    x.set(left0);
    y.set(top0);
    w.set(shownW);
    h.set(shownH);
  }, [left0, top0, shownW, shownH, x, y, w, h]);

  function pickShape(next: Shape) {
    Haptics.selectionAsync();
    setShape(next);
    ratio.set(next.ratio);
    if (!next.ratio) return;
    // The biggest box of that shape that fits the photo, in the middle.
    let bw = shownW;
    let bh = bw / next.ratio;
    if (bh > shownH) {
      bh = shownH;
      bw = bh * next.ratio;
    }
    x.set(left0 + (shownW - bw) / 2);
    y.set(top0 + (shownH - bh) / 2);
    w.set(bw);
    h.set(bh);
  }

  async function done() {
    if (!size || busy) return;
    setBusy(true);
    try {
      // Screen box → the photo's own pixels.
      const originX = Math.max(0, Math.round((x.get() - left0) / scale));
      const originY = Math.max(0, Math.round((y.get() - top0) / scale));
      const width = Math.min(size.w - originX, Math.round(w.get() / scale));
      const height = Math.min(size.h - originY, Math.round(h.get() / scale));
      const rendered = await ImageManipulator.manipulate(uri).crop({ originX, originY, width, height }).renderAsync();
      const saved = await rendered.saveAsync({ compress: 0.92, format: SaveFormat.JPEG });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onDone(saved.uri);
    } catch (error) {
      Alert.alert('Could not crop', friendlyError(error));
      setBusy(false);
    }
  }

  const boxStyle = useAnimatedStyle(() => ({ left: x.get(), top: y.get(), width: w.get(), height: h.get() }));
  // The dark cover over everything outside the box (four strips).
  const topShade = useAnimatedStyle(() => ({ left: 0, right: 0, top: 0, height: y.get() }));
  const bottomShade = useAnimatedStyle(() => ({ left: 0, right: 0, top: y.get() + h.get(), bottom: 0 }));
  const leftShade = useAnimatedStyle(() => ({ left: 0, width: x.get(), top: y.get(), height: h.get() }));
  const rightShade = useAnimatedStyle(() => ({ left: x.get() + w.get(), right: 0, top: y.get(), height: h.get() }));

  return (
    <View style={styles.fill}>
      {size ? (
        <Image source={{ uri }} style={{ position: 'absolute', left: left0, top: top0, width: shownW, height: shownH }} contentFit="fill" />
      ) : (
        <ActivityIndicator color={colors.white} style={styles.loading} />
      )}
      {size ? (
        <>
          <Animated.View style={[styles.shade, topShade]} pointerEvents="none" />
          <Animated.View style={[styles.shade, bottomShade]} pointerEvents="none" />
          <Animated.View style={[styles.shade, leftShade]} pointerEvents="none" />
          <Animated.View style={[styles.shade, rightShade]} pointerEvents="none" />
          <Animated.View style={[styles.box, boxStyle]}>
            {/* Thirds grid, to help line things up */}
            <View style={[styles.gridLine, { left: '33.33%', top: 0, bottom: 0, width: 1 }]} pointerEvents="none" />
            <View style={[styles.gridLine, { left: '66.66%', top: 0, bottom: 0, width: 1 }]} pointerEvents="none" />
            <View style={[styles.gridLine, { top: '33.33%', left: 0, right: 0, height: 1 }]} pointerEvents="none" />
            <View style={[styles.gridLine, { top: '66.66%', left: 0, right: 0, height: 1 }]} pointerEvents="none" />
            <Handle edge="move" style={styles.moveArea} bounds={{ left0, top0, shownW, shownH }} box={{ x, y, w, h, ratio }} />
            <Handle edge="left" style={styles.sideLeft} bounds={{ left0, top0, shownW, shownH }} box={{ x, y, w, h, ratio }} />
            <Handle edge="right" style={styles.sideRight} bounds={{ left0, top0, shownW, shownH }} box={{ x, y, w, h, ratio }} />
            <Handle edge="top" style={styles.sideTop} bounds={{ left0, top0, shownW, shownH }} box={{ x, y, w, h, ratio }} />
            <Handle edge="bottom" style={styles.sideBottom} bounds={{ left0, top0, shownW, shownH }} box={{ x, y, w, h, ratio }} />
            <Handle edge="topLeft" style={[styles.corner, { left: -14, top: -14 }]} bounds={{ left0, top0, shownW, shownH }} box={{ x, y, w, h, ratio }} corner />
            <Handle edge="topRight" style={[styles.corner, { right: -14, top: -14 }]} bounds={{ left0, top0, shownW, shownH }} box={{ x, y, w, h, ratio }} corner />
            <Handle edge="bottomLeft" style={[styles.corner, { left: -14, bottom: -14 }]} bounds={{ left0, top0, shownW, shownH }} box={{ x, y, w, h, ratio }} corner />
            <Handle edge="bottomRight" style={[styles.corner, { right: -14, bottom: -14 }]} bounds={{ left0, top0, shownW, shownH }} box={{ x, y, w, h, ratio }} corner />
          </Animated.View>
        </>
      ) : null}

      <SafeEdge edge="top" style={styles.top}>
        <Pressable onPress={onCancel} style={styles.topButton} accessibilityRole="button">
          <Text style={styles.topText}>Cancel</Text>
        </Pressable>
        <Text style={styles.title}>✂️ Crop</Text>
        <Pressable onPress={done} disabled={busy || !size} style={[styles.topButton, styles.doneButton]} accessibilityRole="button">
          {busy ? <ActivityIndicator color={colors.onAccent} /> : <Text style={[styles.topText, styles.doneText]}>Done</Text>}
        </Pressable>
      </SafeEdge>

      <SafeEdge edge="bottom" style={styles.bottom}>
        <Text style={styles.hint}>Drag the sides or corners · drag inside to move</Text>
        <View style={styles.shapes}>
          {SHAPES.map((item) => (
            <Pressable
              key={item.key}
              onPress={() => pickShape(item)}
              style={[styles.shape, shape.key === item.key && styles.shapeOn]}
              accessibilityRole="button"
              accessibilityState={{ selected: shape.key === item.key }}>
              <Text style={[styles.shapeText, shape.key === item.key && styles.shapeTextOn]}>{item.label}</Text>
            </Pressable>
          ))}
          <Pressable onPress={() => pickShape(SHAPES[0])} style={styles.reset} accessibilityLabel="Reset">
            <Ionicons name="refresh" size={18} color={colors.white} />
          </Pressable>
        </View>
      </SafeEdge>
    </View>
  );
}

type Box = {
  x: ReturnType<typeof useSharedValue<number>>;
  y: ReturnType<typeof useSharedValue<number>>;
  w: ReturnType<typeof useSharedValue<number>>;
  h: ReturnType<typeof useSharedValue<number>>;
  ratio: ReturnType<typeof useSharedValue<number | null>>;
};

// One draggable part of the crop box: a side, a corner, or the inside (moves the whole box).
function Handle({ edge, style, bounds, box, corner = false }: {
  edge: Edge;
  style: object;
  bounds: { left0: number; top0: number; shownW: number; shownH: number };
  box: Box;
  corner?: boolean;
}) {
  const start = useSharedValue({ x: 0, y: 0, w: 0, h: 0 });
  const { left0, top0, shownW, shownH } = bounds;
  const pan = usePanGesture({
    minDistance: 0,
    onActivate: () => {
      'worklet';
      start.set({ x: box.x.get(), y: box.y.get(), w: box.w.get(), h: box.h.get() });
      scheduleOnRN(Haptics.selectionAsync);
    },
    onUpdate: (event) => {
      'worklet';
      const s = start.get();
      const right0 = left0 + shownW;
      const bottom0 = top0 + shownH;
      let { x, y, w, h } = s;
      const dx = event.translationX;
      const dy = event.translationY;
      if (edge === 'move') {
        x = Math.min(right0 - w, Math.max(left0, s.x + dx));
        y = Math.min(bottom0 - h, Math.max(top0, s.y + dy));
      } else {
        const movesLeft = edge === 'left' || edge === 'topLeft' || edge === 'bottomLeft';
        const movesRight = edge === 'right' || edge === 'topRight' || edge === 'bottomRight';
        const movesTop = edge === 'top' || edge === 'topLeft' || edge === 'topRight';
        const movesBottom = edge === 'bottom' || edge === 'bottomLeft' || edge === 'bottomRight';
        if (movesLeft) {
          const nx = Math.min(s.x + s.w - MIN, Math.max(left0, s.x + dx));
          w = s.w + (s.x - nx);
          x = nx;
        }
        if (movesRight) w = Math.min(right0 - s.x, Math.max(MIN, s.w + dx));
        if (movesTop) {
          const ny = Math.min(s.y + s.h - MIN, Math.max(top0, s.y + dy));
          h = s.h + (s.y - ny);
          y = ny;
        }
        if (movesBottom) h = Math.min(bottom0 - s.y, Math.max(MIN, s.h + dy));
        // A fixed shape: the height follows the width.
        const r = box.ratio.get();
        if (r) {
          h = w / r;
          if (movesTop) y = s.y + s.h - h;
          if (y < top0) {
            y = top0;
            h = (movesTop ? s.y + s.h : bottom0) - top0;
            w = h * r;
            if (movesLeft) x = s.x + s.w - w;
          }
          if (y + h > bottom0) {
            h = bottom0 - y;
            w = h * r;
            if (movesLeft) x = s.x + s.w - w;
          }
        }
      }
      box.x.set(x);
      box.y.set(y);
      box.w.set(w);
      box.h.set(h);
    },
  });
  return (
    <GestureDetector gesture={pan}>
      <View style={[styles.handle, style]}>{corner ? <View style={styles.cornerMark} /> : null}</View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  fill: {
    ...StyleSheet.absoluteFill,
    backgroundColor: colors.black,
  },
  loading: {
    marginTop: '60%',
  },
  shade: {
    position: 'absolute',
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  box: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: colors.white,
  },
  gridLine: {
    position: 'absolute',
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  handle: {
    position: 'absolute',
  },
  moveArea: {
    left: 24,
    right: 24,
    top: 24,
    bottom: 24,
  },
  sideLeft: {
    left: -16,
    width: 32,
    top: 24,
    bottom: 24,
  },
  sideRight: {
    right: -16,
    width: 32,
    top: 24,
    bottom: 24,
  },
  sideTop: {
    top: -16,
    height: 32,
    left: 24,
    right: 24,
  },
  sideBottom: {
    bottom: -16,
    height: 32,
    left: 24,
    right: 24,
  },
  corner: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cornerMark: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.white,
    borderWidth: 2,
    borderColor: colors.accent,
  },
  top: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
  },
  title: {
    color: colors.white,
    fontSize: 17,
    fontWeight: '900',
  },
  topButton: {
    paddingHorizontal: space.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.15)',
    minWidth: 76,
    alignItems: 'center',
  },
  doneButton: {
    backgroundColor: colors.accent,
  },
  topText: {
    color: colors.white,
    fontSize: 15,
    fontWeight: '800',
  },
  doneText: {
    color: colors.onAccent,
  },
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    gap: space.md,
    paddingBottom: space.lg,
  },
  hint: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 13,
    fontWeight: '700',
  },
  shapes: {
    flexDirection: 'row',
    gap: space.sm,
    alignItems: 'center',
  },
  shape: {
    paddingHorizontal: space.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  shapeOn: {
    backgroundColor: colors.white,
  },
  shapeText: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '800',
  },
  shapeTextOn: {
    color: colors.black,
  },
  reset: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
});
