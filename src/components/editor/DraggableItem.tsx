import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import {
  GestureDetector,
  usePanGesture,
  usePinchGesture,
  useRotationGesture,
  useSimultaneousGestures,
  useTapGesture,
} from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { textOn, type OverlayItem } from './stickers';

export type TrashZone = { top: number; left: number; right: number };

type Props = {
  item: OverlayItem;
  trash: TrashZone;
  onDragChange: (dragging: boolean) => void;
  onDelete: (id: string) => void;
  onTap: (id: string) => void;
};

// A piece of text or a sticker you can drag (1 finger), resize and turn (2 fingers),
// tap to edit, or drop on the trash can to remove.
export function DraggableItem({ item, trash, onDragChange, onDelete, onTap }: Props) {
  const { width } = useWindowDimensions();
  const x = useSharedValue(item.startX);
  const y = useSharedValue(item.startY);
  const scale = useSharedValue(1);
  const rotation = useSharedValue(0);
  const overTrash = useSharedValue(false);

  const pan = usePanGesture({
    onActivate: () => {
      'worklet';
      scheduleOnRN(onDragChange, true);
    },
    onUpdate: (event) => {
      'worklet';
      x.set(x.get() + event.changeX);
      y.set(y.get() + event.changeY);
      overTrash.set(
        event.absoluteY > trash.top && event.absoluteX > trash.left && event.absoluteX < trash.right,
      );
    },
    onDeactivate: (event) => {
      'worklet';
      const drop = event.absoluteY > trash.top && event.absoluteX > trash.left && event.absoluteX < trash.right;
      overTrash.set(false);
      scheduleOnRN(onDragChange, false);
      if (drop) scheduleOnRN(onDelete, item.id);
    },
  });

  const pinch = usePinchGesture({
    onUpdate: (event) => {
      'worklet';
      scale.set(Math.min(6, Math.max(0.3, scale.get() * event.scaleChange)));
    },
  });

  const rotate = useRotationGesture({
    onUpdate: (event) => {
      'worklet';
      rotation.set(rotation.get() + event.rotationChange);
    },
  });

  const tap = useTapGesture({
    maxDistance: 10,
    onActivate: () => {
      'worklet';
      scheduleOnRN(onTap, item.id);
    },
  });

  const gesture = useSimultaneousGestures(pan, pinch, rotate, tap);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: overTrash.get() ? 0.5 : 1,
    transform: [
      { translateX: x.get() },
      { translateY: y.get() },
      { scale: scale.get() * (overTrash.get() ? 0.5 : 1) },
      { rotateZ: `${rotation.get()}rad` },
    ],
  }));

  return (
    <View style={styles.layer} pointerEvents="box-none">
      <GestureDetector gesture={gesture}>
        <Animated.View style={animatedStyle}>
          {item.kind === 'sticker' ? (
            <Text style={styles.sticker}>{item.content}</Text>
          ) : (
            <Text
              style={[
                styles.text,
                { maxWidth: width * 0.85 },
                item.look === 'pill'
                  ? [styles.pill, { backgroundColor: item.color, color: textOn(item.color) }]
                  : [styles.shadow, { color: item.color }],
              ]}>
              {item.content}
            </Text>
          )}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sticker: {
    fontSize: 84,
  },
  text: {
    fontSize: 34,
    fontWeight: '900',
    textAlign: 'center',
  },
  shadow: {
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 8,
  },
  pill: {
    overflow: 'hidden',
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
});
