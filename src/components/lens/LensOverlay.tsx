import { Canvas, Picture, createPicture, useClock } from '@shopify/react-native-skia';
import { StyleSheet } from 'react-native';
import { useDerivedValue, useSharedValue, type SharedValue } from 'react-native-reanimated';

import { paintLook, type LensFace, type LensLook } from './lensPaint';

// ---------------------------------------------------------------------------
// The live face filter, drawn on top of the camera every frame. The drawing itself is in lensPaint.ts – the
// same code that puts the look on the saved photo (bakeLook.ts), so both look the same.
// ---------------------------------------------------------------------------

export function LensOverlay({ faces, look }: { faces: SharedValue<LensFace[]>; look: LensLook }) {
  const clock = useClock();
  const size = useSharedValue({ width: 0, height: 0 });
  const picture = useDerivedValue(() =>
    createPicture((canvas) => paintLook(canvas, look, faces.value, size.value.width, size.value.height, clock.value / 1000)),
  );
  return (
    <Canvas style={StyleSheet.absoluteFill} pointerEvents="none" onSize={size}>
      <Picture picture={picture} />
    </Canvas>
  );
}
