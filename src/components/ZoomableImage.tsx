import { Image } from 'expo-image';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import {
  GestureDetector,
  usePanGesture,
  usePinchGesture,
  useSimultaneousGestures,
  useTapGesture,
} from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

const MAX_ZOOM = 5;
const DOUBLE_TAP_ZOOM = 2.5;
// After a pinch, double taps are ignored for this long. Two fingers going down and coming up a moment apart
// can look like a double tap to the phone, and that used to zoom the photo back out in the middle of a pinch
// (the owner's friend's photo ended up stuck half off the screen). Same fix as the camera (CameraPage.tsx).
const PINCH_QUIET_MS = 700;
// A double tap must be two taps in about the same spot – not two fingers far apart.
const DOUBLE_TAP_MAX_DISTANCE = 24;

// The time now in milliseconds, readable from the gesture code that runs off the main thread.
function nowMs(): number {
  'worklet';
  return Date.now();
}

// A photo you can zoom into: pinch with two fingers (it zooms towards your fingers), drag it around while
// zoomed, and double-tap to zoom in on that spot (or back out).
// `contentFit`: 'contain' shows the whole photo (default), 'cover' fills the frame (full-screen peeks).
// `doubleTapZoom`: turn off where a single tap already does something (a peek closes on tap).
// `onZoomChange`: told when you start zooming and when the photo is back to normal.
export function ZoomableImage({ uri, cacheKey, style, contentFit = 'contain', doubleTapZoom = true, onZoomChange }: {
  uri: string;
  cacheKey?: string;
  style?: StyleProp<ViewStyle>;
  contentFit?: 'contain' | 'cover';
  doubleTapZoom?: boolean;
  onZoomChange?: (zoomed: boolean) => void;
}) {
  const report = (value: boolean) => onZoomChange?.(value);
  const width = useSharedValue(0);
  const height = useSharedValue(0);
  // Where the photo is on screen right now (these move smoothly during an animation).
  const scale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  // Where the photo will be once any animation has finished. Every decision is made from these, never from the
  // in-between values above: zoom and position must always head for the same resting place, or the photo can
  // end up back at normal size but pushed half off the screen.
  const goalScale = useSharedValue(1);
  const goalX = useSharedValue(0);
  const goalY = useSharedValue(0);
  // Dragging only moves the photo while it's zoomed in (otherwise it leaves the screen's own swipes alone).
  const zoomed = useSharedValue(false);
  // When the last pinch moved (so lifting your fingers isn't taken as a double tap).
  const pinchedAt = useSharedValue(0);
  // The photo's own shape (its width ÷ its height), set each time a photo has loaded. 0 = not known yet.
  const shape = useSharedValue(0);

  // How wide and tall the photo itself is drawn at normal size. With 'contain', a photo that's a different shape
  // from the frame has black bars above and below it (or at the sides) – those bars aren't part of the photo, so
  // they mustn't count when working out how far you can drag. With 'cover' the photo fills the whole frame.
  // Until the photo has loaded, the whole frame counts.
  function shownWidth() {
    'worklet';
    const ratio = shape.get();
    if (contentFit === 'cover' || !(ratio > 0)) return width.get();
    return Math.min(width.get(), height.get() * ratio);
  }
  function shownHeight() {
    'worklet';
    const ratio = shape.get();
    if (contentFit === 'cover' || !(ratio > 0)) return height.get();
    return Math.min(height.get(), width.get() / ratio);
  }

  // How far the photo can move at this zoom before its edge comes into view (the photo's edge, not the
  // frame's – otherwise the black bar beside a photo gets dragged onto the screen). While the zoomed photo is
  // still smaller than the screen in one direction, it stays centred that way.
  function clampX(value: number, zoom: number) {
    'worklet';
    const max = Math.max(0, (shownWidth() * zoom - width.get()) / 2);
    return Math.min(max, Math.max(-max, value));
  }
  function clampY(value: number, zoom: number) {
    'worklet';
    const max = Math.max(0, (shownHeight() * zoom - height.get()) / 2);
    return Math.min(max, Math.max(-max, value));
  }

  // Glide to a new zoom and position (all three together).
  function glideTo(nextScale: number, nextX: number, nextY: number) {
    'worklet';
    goalScale.set(nextScale);
    goalX.set(nextX);
    goalY.set(nextY);
    scale.set(withTiming(nextScale));
    x.set(withTiming(nextX));
    y.set(withTiming(nextY));
  }

  // Jump straight to a zoom and position (while your fingers are moving it).
  function jumpTo(nextScale: number, nextX: number, nextY: number) {
    'worklet';
    goalScale.set(nextScale);
    goalX.set(nextX);
    goalY.set(nextY);
    scale.set(nextScale);
    x.set(nextX);
    y.set(nextY);
  }

  function zoomOut() {
    'worklet';
    glideTo(1, 0, 0);
    zoomed.set(false);
    scheduleOnRN(report, false);
  }

  // After a pinch or drag: barely zoomed → back to normal; otherwise keep the photo's edges in view.
  // Uses where the photo is heading, so it's right even when it's called in the middle of an animation.
  function settle() {
    'worklet';
    const zoom = goalScale.get();
    if (zoom < 1.05) {
      zoomOut();
      return;
    }
    glideTo(zoom, clampX(goalX.get(), zoom), clampY(goalY.get(), zoom));
    zoomed.set(true);
  }

  const pinch = usePinchGesture({
    onBegin: () => {
      'worklet';
      pinchedAt.set(nowMs());
    },
    onActivate: () => {
      'worklet';
      pinchedAt.set(nowMs());
      scheduleOnRN(report, true);
    },
    onUpdate: (event) => {
      'worklet';
      pinchedAt.set(nowMs());
      const before = scale.get();
      const after = Math.min(MAX_ZOOM, Math.max(0.8, before * event.scaleChange));
      const factor = after / before;
      // Keep the spot under your fingers in place while zooming.
      const focusX = event.focalX - width.get() / 2;
      const focusY = event.focalY - height.get() / 2;
      jumpTo(after, focusX - (focusX - x.get()) * factor, focusY - (focusY - y.get()) * factor);
    },
    onDeactivate: () => {
      'worklet';
      settle();
    },
    onFinalize: () => {
      'worklet';
      pinchedAt.set(nowMs());
    },
  });

  const pan = usePanGesture({
    enabled: zoomed,
    onUpdate: (event) => {
      'worklet';
      // Only the position moves (a zoom that's still gliding carries on).
      const nextX = x.get() + event.changeX;
      const nextY = y.get() + event.changeY;
      goalX.set(nextX);
      goalY.set(nextY);
      x.set(nextX);
      y.set(nextY);
    },
    onDeactivate: () => {
      'worklet';
      settle();
    },
  });

  const doubleTap = useTapGesture({
    enabled: doubleTapZoom,
    numberOfTaps: 2,
    maxDistance: DOUBLE_TAP_MAX_DISTANCE,
    onActivate: (event) => {
      'worklet';
      // Fingers lifting during or just after a pinch: not a real double tap.
      if (nowMs() - pinchedAt.get() < PINCH_QUIET_MS) return;
      if (goalScale.get() > 1.05) {
        zoomOut();
        return;
      }
      const focusX = event.x - width.get() / 2;
      const focusY = event.y - height.get() / 2;
      glideTo(
        DOUBLE_TAP_ZOOM,
        clampX(-focusX * (DOUBLE_TAP_ZOOM - 1), DOUBLE_TAP_ZOOM),
        clampY(-focusY * (DOUBLE_TAP_ZOOM - 1), DOUBLE_TAP_ZOOM),
      );
      zoomed.set(true);
      scheduleOnRN(report, true);
    },
  });

  const gesture = useSimultaneousGestures(pinch, pan, doubleTap);

  const zoomStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() }, { translateY: y.get() }, { scale: scale.get() }],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <View
        style={[styles.frame, style]}
        onLayout={(event) => {
          width.set(event.nativeEvent.layout.width);
          height.set(event.nativeEvent.layout.height);
        }}>
        <Animated.View style={[StyleSheet.absoluteFill, zoomStyle]}>
          <Image
            source={{ uri, cacheKey }}
            style={StyleSheet.absoluteFill}
            contentFit={contentFit}
            transition={200}
            onLoad={(event) => {
              // The photo's real size (only its shape matters), for the zoom limits above.
              const photoWidth = event.source?.width ?? 0;
              const photoHeight = event.source?.height ?? 0;
              shape.set(photoWidth > 0 && photoHeight > 0 ? photoWidth / photoHeight : 0);
            }}
          />
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  frame: {
    overflow: 'hidden',
  },
});
