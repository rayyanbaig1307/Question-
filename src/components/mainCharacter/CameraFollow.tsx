import type { ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import Animated, { useAnimatedReaction, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import { LITE_CAMERA_MOVE } from '@/lib/mainCharacter/config';

import type { CustomLookProps } from '../lens/SoftGlowCamera';
import { biggestFace, faceFit, liteTransform, type LiteTransform } from './fit';
import type { McExtra } from './MainCharacterOverlay';

// ---------------------------------------------------------------------------
// Main Character Mode 🌆, the lite way (downloads without camera pictures, or while they pause): moves the real
// camera view so your face shows through the character's face hole (docs/MAIN_CHARACTER.md). SoftGlowCamera puts
// this round the camera view only (its `custom.CameraWrap`); the poster (MainCharacterOverlay.tsx) is drawn on top
// with the hole left open.
//
// It is on for every download: on the full way the moved camera view is hidden under the poster's scene, and it
// is exactly what shows if the camera pictures stop.
//
// The face points don't move when this view is moved (the camera view's own converter works inside the view), so
// the fit always starts from where your face really is in the camera view. fit.ts liteTransform works out the
// plain move / turn / stretch list and gives null for anything broken (no face, no view size, a broken number,
// a stretch outside the limits): a broken number in a native view's transform can close the app on iPhone. Then
// the last good one stays; before the first good one there is no transform at all.
// LITE_CAMERA_MOVE = 'off' (app update switch): never moved (a fixed hole: line your face up yourself).
// ---------------------------------------------------------------------------

export function CameraFollow({ faces, viewSize, extra, children }: CustomLookProps<McExtra> & { children: ReactNode }) {
  const { scene } = extra;
  // The last good transform (null = none yet).
  const good = useSharedValue<LiteTransform | null>(null);
  useAnimatedReaction(
    () => {
      if (LITE_CAMERA_MOVE === 'off') return null;
      try {
        const live = scene.value;
        if (!live) return null;
        const face = biggestFace(faces.value);
        const fit = face ? faceFit(face.pts, live.art) : null;
        return liteTransform(fit, viewSize.value.width, viewSize.value.height);
      } catch {
        return null;
      }
    },
    (next) => {
      // A broken or missing one keeps the last good one.
      if (next) good.value = next;
    },
  );
  const moved = useAnimatedStyle(() => {
    const transform = good.value;
    return { transform: transform ?? [] };
  });
  return <Animated.View style={[StyleSheet.absoluteFill, moved]}>{children}</Animated.View>;
}
