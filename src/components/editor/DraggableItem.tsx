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

import { SpecialSticker } from './SpecialSticker';
import { type OverlayItem } from './stickers';
import { PlacedText, resolveText } from './TextLook';

export type TrashZone = { top: number; left: number; right: number };

type Props = {
  item: OverlayItem;
  trash: TrashZone;
  onDragChange: (dragging: boolean) => void;
  onDelete: (id: string) => void;
  onTap: (id: string) => void;
  // True while the editor takes the final picture: animated text sits still at its resting look.
  still?: boolean;
};

// A piece of text or a sticker you can drag (1 finger), resize and turn (2 fingers),
// tap to edit, or drop on the trash can to remove.
export function DraggableItem({ item, trash, onDragChange, onDelete, onTap, still = false }: Props) {
  const { width } = useWindowDimensions();
  const x = useSharedValue(item.startX);
  const y = useSharedValue(item.startY);
  const scale = useSharedValue(item.startScale ?? 1);
  const rotation = useSharedValue(item.startRotation ?? 0);
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
          {item.kind === 'special' ? (
            <SpecialSticker id={item.content} />
          ) : item.kind === 'sticker' ? (
            <Text style={styles.sticker}>{item.content}</Text>
          ) : (
            <PlacedText spec={resolveText(item)} maxWidth={width * 0.85} still={still} />
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
});
