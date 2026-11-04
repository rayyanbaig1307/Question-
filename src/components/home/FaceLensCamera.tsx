import { FlipType, ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { useImperativeHandle, useRef, type Ref } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { usePhotoOutput } from 'react-native-vision-camera';
import { Camera as FaceCamera, type Face } from 'react-native-vision-camera-face-detector';

import { SpecialSticker } from '@/components/editor/SpecialSticker';
import { LOOK_STICKER, type EyePair, type LensShot } from '@/lib/faceLens';

// The googly-eyes sticker is two 70-point eyes with a 6-point gap: 146 × 70, eye centres 76 apart.
const PAIR_WIDTH = 146;
const PAIR_HEIGHT = 70;
const PAIR_EYE_DISTANCE = 76;
const MAX_FACES = 4;
// Tiny wobbles in where the tracker says your eyes are (a pixel or two) are ignored, so the eyes don't shiver
// when you hold still. Anything bigger than this many points is followed straight away.
const STILL = 1.5;
// The eyes on screen are moved by the animation thread, not by redrawing the whole screen, so they keep up
// with your face. One slot per face the tracker can follow at once.
type Slot = { on: boolean; x: number; y: number; scale: number; rotation: number };
const EMPTY_SLOT: Slot = { on: false, x: 0, y: 0, scale: 1, rotation: 0 };

export type FaceLensHandle = {
  capture: () => Promise<LensShot>;
  // Where the drawings are right now (videos are recorded by the normal camera, with these as stickers).
  currentItems: () => LensShot['items'];
};

type TrackedPair = EyePair & { key: string };

// Only loaded on phones that have face tracking (see lib/faceLens.ts).
// The live camera with googly eyes stuck on every face it sees. `capture()` takes the photo and says where the
// eyes were, so the editor can put real stickers there (drag, resize or delete them like any sticker).
export function FaceLensCamera({ ref, active, facing, flash, zoom = 0 }: {
  ref: Ref<FaceLensHandle>;
  active: boolean;
  facing: 'front' | 'back';
  flash: 'on' | 'off';
  // Pinch zoom from the camera screen: 0 = not zoomed, 1 = as far as it goes (here up to 4×).
  zoom?: number;
}) {
  const sticker = LOOK_STICKER.googly;
  const photoOutput = usePhotoOutput({ quality: 0.9 });
  const latest = useRef<TrackedPair[]>([]);

  // Which face (tracker id) each slot is showing right now, so a face keeps its slot while it moves.
  const slotKeys = useRef<(string | null)[]>(Array(MAX_FACES).fill(null));
  const slots = [useSharedValue<Slot>(EMPTY_SLOT), useSharedValue<Slot>(EMPTY_SLOT), useSharedValue<Slot>(EMPTY_SLOT), useSharedValue<Slot>(EMPTY_SLOT)];

  function handleFaces(faces: Face[]) {
    const before = new Map(latest.current.map((pair) => [pair.key, pair]));
    const next = faces.slice(0, MAX_FACES).map((face, index) => {
      const pair = eyesOf(face, index);
      const last = before.get(pair.key);
      if (!last) return pair;
      // Holding still: ignore the tracker's tiny wobble. Moving: go straight to where the eyes are now.
      const moved = Math.hypot(pair.x - last.x, pair.y - last.y);
      if (moved < STILL && Math.abs(pair.scale - last.scale) < 0.02 && Math.abs(pair.rotation - last.rotation) < 0.02) {
        return { ...last, key: pair.key };
      }
      return pair;
    });
    latest.current = next;
    placeEyes(next);
  }

  // Hand each face's eyes to its slot on the animation thread (same face → same slot; empty slots are hidden).
  function placeEyes(pairs: TrackedPair[]) {
    const keys = slotKeys.current;
    const taken = new Set<number>();
    const placed: (TrackedPair | null)[] = Array(MAX_FACES).fill(null);
    for (const pair of pairs) {
      const index = keys.indexOf(pair.key);
      if (index >= 0 && !taken.has(index)) {
        placed[index] = pair;
        taken.add(index);
      }
    }
    for (const pair of pairs) {
      if (placed.includes(pair)) continue;
      const free = placed.findIndex((slot, index) => slot === null && !taken.has(index));
      if (free < 0) break;
      placed[free] = pair;
      taken.add(free);
    }
    placed.forEach((pair, index) => {
      keys[index] = pair?.key ?? null;
      const now = slots[index].get();
      if (pair) {
        if (!now.on || now.x !== pair.x || now.y !== pair.y || now.scale !== pair.scale || now.rotation !== pair.rotation) {
          slots[index].set({ on: true, x: pair.x, y: pair.y, scale: pair.scale, rotation: pair.rotation });
        }
      } else if (now.on) {
        slots[index].set(EMPTY_SLOT);
      }
    });
  }

  useImperativeHandle(
    ref,
    () => ({
      async capture() {
        const items = latest.current.map(({ x, y, scale, rotation }) => ({ x, y, scale, rotation, sticker }));
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
        return { uri: saved.uri, items };
      },
      // Where the drawings are right now (for a video, which is recorded by the normal camera).
      currentItems() {
        return latest.current.map(({ x, y, scale, rotation }) => ({ x, y, scale, rotation, sticker }));
      },
    }),
    [photoOutput, flash, facing, sticker],
  );

  return (
    <View style={StyleSheet.absoluteFill}>
      <FaceCamera
        style={StyleSheet.absoluteFill}
        device={facing}
        isActive={active}
        outputs={[photoOutput]}
        resizeMode="cover"
        zoom={zoom > 0 ? 1 + zoom * 3 : undefined}
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
          ? slots.map((slot, index) => <EyesOnFace key={index} slot={slot} sticker={sticker} width={PAIR_WIDTH} height={PAIR_HEIGHT} />)
          : null}
      </View>
    </View>
  );
}

// One face's drawing, moved by the animation thread as its slot changes (hidden when the slot has no face).
function EyesOnFace({ slot, sticker, width, height }: { slot: SharedValue<Slot>; sticker: string; width: number; height: number }) {
  const place = useAnimatedStyle(() => {
    const s = slot.get();
    return {
      opacity: s.on ? 1 : 0,
      transform: [{ translateX: s.x - width / 2 }, { translateY: s.y - height / 2 }, { rotateZ: `${s.rotation}rad` }, { scale: s.scale }],
    };
  });
  return (
    <Animated.View style={[styles.pair, { width, height }, place]}>
      <SpecialSticker id={sticker} />
    </Animated.View>
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
    left: 0,
    top: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
