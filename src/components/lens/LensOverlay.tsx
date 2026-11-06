import { Canvas, Picture, createPicture, useClock } from '@shopify/react-native-skia';
import { StyleSheet } from 'react-native';
import { useAnimatedReaction, useDerivedValue, useSharedValue, type SharedValue } from 'react-native-reanimated';

import { paintLook, type LensFace, type LensLook } from './lensPaint';

// ---------------------------------------------------------------------------
// The live face filter, drawn on top of the camera every frame. The drawing itself is in lensPaint.ts – the
// same code that puts the look on the saved photo (bakeLook.ts), so both look the same.
// ---------------------------------------------------------------------------

// `shownTime` (optional) is told the moment on screen (in seconds), so a photo taken now can use the very same moment
// of the moving shine and twinkles as you saw.
export function LensOverlay({ faces, look, shownTime }: { faces: SharedValue<LensFace[]>; look: LensLook; shownTime?: SharedValue<number> }) {
  const clock = useClock();
  const size = useSharedValue({ width: 0, height: 0 });
  useAnimatedReaction(
    () => clock.value,
    (now) => {
      shownTime?.set(now / 1000);
    },
  );
  // Safety net: if the drawing ever fails, the filter stops drawing instead of closing the app (an error on
  // the drawing thread would otherwise stop the whole app).
  const broken = useSharedValue(false);
  const picture = useDerivedValue(() =>
    createPicture((canvas) => {
      if (broken.value) return;
      try {
        paintLook(canvas, look, faces.value, size.value.width, size.value.height, clock.value / 1000);
      } catch (error) {
        // Say why once, so a filter that stops drawing is never a silent mystery again.
        broken.value = true;
        console.warn('Face filter stopped drawing', error);
      }
    }),
  );
  return (
    <Canvas style={StyleSheet.absoluteFill} pointerEvents="none" onSize={size}>
      <Picture picture={picture} />
    </Canvas>
  );
}
