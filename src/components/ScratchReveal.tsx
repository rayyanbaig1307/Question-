import { Blur, Canvas, Group, Image as SkiaImage, Path, Skia, useImage } from '@shopify/react-native-skia';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, {
  FadeOut,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { colors, radius } from '@/theme';

// How wide your "scratching finger" is, how finely we track what's uncovered, and when it counts as revealed.
const BRUSH = 64;
const GRID_COLUMNS = 12;
const REVEALED_AT = 0.6;
const TICK_MS = 80;

// Hold to reveal: the photo starts blurred, and the blur wipes away wherever your finger moves – like scratching a
// lottery ticket. Hold for a moment first (so a quick swipe still scrolls the feed), with a tiny buzz while
// scratching and a "pop" when it's all revealed.
export function ScratchReveal({ uri, shape, onRevealed }: {
  uri: string;
  // width ÷ height of the photo
  shape: number;
  onRevealed: () => void;
}) {
  const [width, setWidth] = useState(0);
  const height = width / shape;
  const image = useImage(uri);
  const [scratching, setScratching] = useState(false);

  // Your scratches so far: drawn up on the fly (builder), and the finished shape that's drawn on screen (path).
  const builder = useSharedValue(Skia.PathBuilder.Make());
  const path = useSharedValue(Skia.Path.Make());
  const cover = useSharedValue(1); // 1 = blur fully on top, 0 = gone
  const pop = useSharedValue(1);
  const lastTick = useSharedValue(0);
  const done = useSharedValue(false);
  // Which bits of the photo have been scratched (a grid of little squares), and how many.
  const rows = Math.max(1, Math.round(GRID_COLUMNS / shape));
  const cells = useSharedValue<number[]>([]);
  const uncovered = useSharedValue(0);

  const tick = () => Haptics.selectionAsync();
  const finish = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onRevealed();
  };

  const scratch = usePanGesture({
    activateAfterLongPress: 150,
    minDistance: 0,
    onActivate: (event) => {
      'worklet';
      builder.get().moveTo(event.x, event.y).lineTo(event.x + 0.1, event.y);
      path.set(builder.get().build());
      scheduleOnRN(setScratching, true);
      scheduleOnRN(tick);
    },
    onUpdate: (event) => {
      'worklet';
      if (done.get() || width === 0) return;
      builder.get().lineTo(event.x, event.y);
      path.set(builder.get().build());

      // Mark the little squares under the finger as uncovered.
      const cellW = width / GRID_COLUMNS;
      const cellH = height / rows;
      const reach = BRUSH / 2;
      const grid = cells.get().length === GRID_COLUMNS * rows ? cells.get() : new Array(GRID_COLUMNS * rows).fill(0);
      let count = uncovered.get();
      for (let c = Math.max(0, Math.floor((event.x - reach) / cellW)); c <= Math.min(GRID_COLUMNS - 1, Math.floor((event.x + reach) / cellW)); c++) {
        for (let r = Math.max(0, Math.floor((event.y - reach) / cellH)); r <= Math.min(rows - 1, Math.floor((event.y + reach) / cellH)); r++) {
          if (grid[r * GRID_COLUMNS + c] === 0) {
            grid[r * GRID_COLUMNS + c] = 1;
            count += 1;
          }
        }
      }
      cells.set(grid);
      uncovered.set(count);

      // A tiny buzz every so often while you scratch.
      const now = Date.now();
      if (now - lastTick.get() > TICK_MS) {
        lastTick.set(now);
        scheduleOnRN(tick);
      }

      // Mostly uncovered: clear the rest with a little "pop".
      if (count / (GRID_COLUMNS * rows) >= REVEALED_AT) {
        done.set(true);
        cover.set(withTiming(0, { duration: 250 }));
        pop.set(withSequence(withSpring(1.04, { damping: 8, stiffness: 400 }), withSpring(1)));
        scheduleOnRN(finish);
      }
    },
  });

  const coverOpacity = useDerivedValue(() => cover.get());
  const popStyle = useAnimatedStyle(() => ({ transform: [{ scale: pop.get() }] }));

  return (
    <Animated.View
      style={[styles.box, { aspectRatio: shape }, popStyle]}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      {image && width > 0 ? (
        <GestureDetector gesture={scratch}>
          <Canvas style={{ width, height }}>
            {/* The real photo underneath… */}
            <SkiaImage image={image} x={0} y={0} width={width} height={height} fit="cover" />
            {/* …and a blurred copy on top, with your scratches cut out of it. */}
            <Group layer opacity={coverOpacity}>
              <SkiaImage image={image} x={0} y={0} width={width} height={height} fit="cover">
                <Blur blur={24} mode="clamp" />
              </SkiaImage>
              <Path
                path={path}
                style="stroke"
                strokeWidth={BRUSH}
                strokeCap="round"
                strokeJoin="round"
                color="black"
                blendMode="clear"
              />
            </Group>
          </Canvas>
        </GestureDetector>
      ) : (
        // Still loading: show a blurry version so nothing is given away.
        <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" blurRadius={25} />
      )}
      {!scratching ? (
        <Animated.View exiting={FadeOut.duration(200)} style={styles.hint} pointerEvents="none">
          <Text style={styles.hintText}>👆 Hold & scratch to reveal</Text>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  box: {
    width: '100%',
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: colors.card,
  },
  hint: {
    position: 'absolute',
    alignSelf: 'center',
    top: '45%',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  hintText: {
    color: colors.white,
    fontWeight: '900',
    fontSize: 14,
  },
});
