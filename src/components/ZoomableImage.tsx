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

const MAX_ZOOM = 5;
const DOUBLE_TAP_ZOOM = 2.5;

// A photo you can zoom into: pinch with two fingers (it zooms towards your fingers), drag it around while
// zoomed, and double-tap to zoom in on that spot (or back out).
export function ZoomableImage({ uri, cacheKey, style }: {
  uri: string;
  cacheKey?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const width = useSharedValue(0);
  const height = useSharedValue(0);
  const scale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  // Dragging only moves the photo while it's zoomed in (otherwise it leaves the screen's own swipes alone).
  const zoomed = useSharedValue(false);

  // How far the photo can move at this zoom before its edge comes into view.
  function clampX(value: number, zoom: number) {
    'worklet';
    const max = (width.get() * (zoom - 1)) / 2;
    return Math.min(max, Math.max(-max, value));
  }
  function clampY(value: number, zoom: number) {
    'worklet';
    const max = (height.get() * (zoom - 1)) / 2;
    return Math.min(max, Math.max(-max, value));
  }

  function zoomOut() {
    'worklet';
    scale.set(withTiming(1));
    x.set(withTiming(0));
    y.set(withTiming(0));
    zoomed.set(false);
  }

  // After a pinch or drag: barely zoomed → back to normal; otherwise keep the photo's edges in view.
  function settle() {
    'worklet';
    if (scale.get() < 1.05) {
      zoomOut();
      return;
    }
    x.set(withTiming(clampX(x.get(), scale.get())));
    y.set(withTiming(clampY(y.get(), scale.get())));
    zoomed.set(true);
  }

  const pinch = usePinchGesture({
    onUpdate: (event) => {
      'worklet';
      const before = scale.get();
      const after = Math.min(MAX_ZOOM, Math.max(0.8, before * event.scaleChange));
      const factor = after / before;
      // Keep the spot under your fingers in place while zooming.
      const focusX = event.focalX - width.get() / 2;
      const focusY = event.focalY - height.get() / 2;
      x.set(focusX - (focusX - x.get()) * factor);
      y.set(focusY - (focusY - y.get()) * factor);
      scale.set(after);
    },
    onDeactivate: () => {
      'worklet';
      settle();
    },
  });

  const pan = usePanGesture({
    enabled: zoomed,
    onUpdate: (event) => {
      'worklet';
      x.set(x.get() + event.changeX);
      y.set(y.get() + event.changeY);
    },
    onDeactivate: () => {
      'worklet';
      settle();
    },
  });

  const doubleTap = useTapGesture({
    numberOfTaps: 2,
    onActivate: (event) => {
      'worklet';
      if (scale.get() > 1.05) {
        zoomOut();
        return;
      }
      const focusX = event.x - width.get() / 2;
      const focusY = event.y - height.get() / 2;
      scale.set(withTiming(DOUBLE_TAP_ZOOM));
      x.set(withTiming(clampX(-focusX * (DOUBLE_TAP_ZOOM - 1), DOUBLE_TAP_ZOOM)));
      y.set(withTiming(clampY(-focusY * (DOUBLE_TAP_ZOOM - 1), DOUBLE_TAP_ZOOM)));
      zoomed.set(true);
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
          <Image source={{ uri, cacheKey }} style={StyleSheet.absoluteFill} contentFit="contain" transition={200} />
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
