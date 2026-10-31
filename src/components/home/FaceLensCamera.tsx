import { FlipType, ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { useImperativeHandle, useRef, useState, type Ref } from 'react';
import { StyleSheet, View } from 'react-native';
import { usePhotoOutput } from 'react-native-vision-camera';
import { Camera as FaceCamera, type Face } from 'react-native-vision-camera-face-detector';

import { SpecialSticker } from '@/components/editor/SpecialSticker';
import type { EyePair, LensShot } from '@/lib/faceLens';

// The googly-eyes sticker is two 70-point eyes with a 6-point gap: 146 × 70, eye centres 76 apart.
const PAIR_WIDTH = 146;
const PAIR_HEIGHT = 70;
const PAIR_EYE_DISTANCE = 76;
// How much a new position counts vs. the last one (smaller = smoother but a bit laggy).
const FOLLOW = 0.55;
const MAX_FACES = 4;

export type FaceLensHandle = { capture: () => Promise<LensShot> };

type TrackedPair = EyePair & { key: string };

// Only loaded on phones that have face tracking (see lib/faceLens.ts).
// The live camera with googly eyes stuck on every face it sees. `capture()` takes the photo and says where the
// eyes were, so the editor can put real stickers there (drag, resize or delete them like any sticker).
export function FaceLensCamera({ ref, active, facing, flash }: {
  ref: Ref<FaceLensHandle>;
  active: boolean;
  facing: 'front' | 'back';
  flash: 'on' | 'off';
}) {
  const photoOutput = usePhotoOutput({ quality: 0.9 });
  const [pairs, setPairs] = useState<TrackedPair[]>([]);
  const latest = useRef<TrackedPair[]>([]);

  function handleFaces(faces: Face[]) {
    const before = new Map(latest.current.map((pair) => [pair.key, pair]));
    const next = faces.slice(0, MAX_FACES).map((face, index) => {
      const pair = eyesOf(face, index);
      const last = before.get(pair.key);
      // Glide from where the eyes were, so they don't jitter.
      return last
        ? {
            key: pair.key,
            x: last.x + (pair.x - last.x) * FOLLOW,
            y: last.y + (pair.y - last.y) * FOLLOW,
            scale: last.scale + (pair.scale - last.scale) * FOLLOW,
            rotation: last.rotation + (pair.rotation - last.rotation) * FOLLOW,
          }
        : pair;
    });
    latest.current = next;
    setPairs(next);
  }

  useImperativeHandle(
    ref,
    () => ({
      async capture() {
        const eyes = latest.current.map(({ x, y, scale, rotation }) => ({ x, y, scale, rotation }));
        const file = await photoOutput.capturePhotoToFile(
          // Front cameras usually have no flash.
          { flashMode: flash === 'on' && facing === 'back' ? 'on' : 'off' },
          {},
        );
        // Save it the way it looked on screen: upright, and mirrored for selfies (like the preview).
        let photo = ImageManipulator.manipulate(`file://${file.filePath}`);
        if (facing === 'front' && !file.isMirrored) photo = photo.flip(FlipType.Horizontal);
        const rendered = await photo.renderAsync();
        const saved = await rendered.saveAsync({ compress: 0.9, format: SaveFormat.JPEG });
        return { uri: saved.uri, eyes };
      },
    }),
    [photoOutput, flash, facing],
  );

  return (
    <View style={StyleSheet.absoluteFill}>
      <FaceCamera
        style={StyleSheet.absoluteFill}
        device={facing}
        isActive={active}
        outputs={[photoOutput]}
        resizeMode="cover"
        mirrorMode="auto"
        cameraFacing={facing}
        // Face positions come back already lined up with the preview on screen.
        autoMode
        runLandmarks
        trackingEnabled
        performanceMode="fast"
        onFacesDetected={handleFaces}
        onError={(error) => console.warn('Googly lens', error)}
      />
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        {active
          ? pairs.map((pair) => (
              <View
                key={pair.key}
                style={[
                  styles.pair,
                  {
                    left: pair.x - PAIR_WIDTH / 2,
                    top: pair.y - PAIR_HEIGHT / 2,
                    transform: [{ rotateZ: `${pair.rotation}rad` }, { scale: pair.scale }],
                  },
                ]}>
                <SpecialSticker id="googly-eyes" />
              </View>
            ))
          : null}
      </View>
    </View>
  );
}

// Where the googly eyes go on one face: on its eyes (or, if the eyes weren't found, where eyes usually are).
export function eyesOf(face: Face, index: number): TrackedPair {
  const box = face.bounds;
  const one = face.landmarks?.LEFT_EYE ?? { x: box.x + box.width * 0.3, y: box.y + box.height * 0.4 };
  const two = face.landmarks?.RIGHT_EYE ?? { x: box.x + box.width * 0.7, y: box.y + box.height * 0.4 };
  // Measured left to right on screen, so the eyes are never upside down.
  const [left, right] = one.x <= two.x ? [one, two] : [two, one];
  const distance = Math.hypot(right.x - left.x, right.y - left.y) || box.width * 0.4;
  return {
    key: String(face.trackingId ?? index),
    x: (left.x + right.x) / 2,
    y: (left.y + right.y) / 2,
    scale: Math.max(0.2, distance / PAIR_EYE_DISTANCE),
    rotation: Math.atan2(right.y - left.y, right.x - left.x),
  };
}

const styles = StyleSheet.create({
  pair: {
    position: 'absolute',
    width: PAIR_WIDTH,
    height: PAIR_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
