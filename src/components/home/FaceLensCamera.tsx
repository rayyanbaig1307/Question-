import { FlipType, ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { useImperativeHandle, useRef, useState, type Ref } from 'react';
import { StyleSheet, View } from 'react-native';
import { usePhotoOutput } from 'react-native-vision-camera';
import { Camera as FaceCamera, type Face } from 'react-native-vision-camera-face-detector';

import { LENS_BOX } from '@/components/editor/LensStickers';
import { SpecialSticker } from '@/components/editor/SpecialSticker';
import { LOOK_STICKER, SKIA_AVAILABLE, type EyePair, type FaceLook, type FaceShape, type LensShot, type Pt } from '@/lib/faceLens';

// The live Glam / Glow drawing needs Skia (in the app download).
const LiveLook: typeof import('./LiveLook').LiveLook | null = SKIA_AVAILABLE
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./LiveLook').LiveLook
  : null;

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
export function FaceLensCamera({ ref, active, facing, flash, look = 'googly' }: {
  ref: Ref<FaceLensHandle>;
  active: boolean;
  facing: 'front' | 'back';
  flash: 'on' | 'off';
  // Which drawing goes on every face.
  look?: FaceLook;
}) {
  const sticker = LOOK_STICKER[look];
  // Glam and Glow follow the real face outlines (lips, eyes, face shape) instead of a sticker.
  const painted = look === 'makeup' || look === 'glow';
  // The drawing's box (googly eyes are 146 × 70); the point between the eyes is its middle.
  const box = sticker === 'lens-pup' ? LENS_BOX['lens-pup'] : { width: PAIR_WIDTH, height: PAIR_HEIGHT };
  const [shapes, setShapes] = useState<FaceShape[]>([]);
  const latestShapes = useRef<FaceShape[]>([]);
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
    if (painted) {
      const before = new Map(latestShapes.current.map((shape) => [shape.key, shape]));
      const nextShapes = faces
        .slice(0, MAX_FACES)
        .map((face, index) => shapeOf(face, index))
        .filter((shape): shape is FaceShape => shape !== null)
        .map((shape) => {
          const last = before.get(shape.key);
          return last ? glide(last, shape) : shape;
        });
      latestShapes.current = nextShapes;
      setShapes(nextShapes);
    }
  }

  useImperativeHandle(
    ref,
    () => ({
      async capture() {
        const items = sticker ? latest.current.map(({ x, y, scale, rotation }) => ({ x, y, scale, rotation, sticker })) : [];
        const shapesNow = latestShapes.current;
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
        return { uri: saved.uri, items, shapes: shapesNow };
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
        mirrorMode="auto"
        cameraFacing={facing}
        // Face positions come back already lined up with the preview on screen.
        autoMode
        runLandmarks
        // Glam and Glow need the outlines of the lips, eyes and face.
        runContours={painted}
        trackingEnabled
        performanceMode="fast"
        onFacesDetected={handleFaces}
        onError={(error) => console.warn('Googly lens', error)}
      />
      {painted && active && LiveLook ? <LiveLook shapes={shapes} look={look === 'glow' ? 'glow' : 'makeup'} /> : null}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        {active && sticker
          ? pairs.map((pair) => (
              <View
                key={pair.key}
                style={[
                  styles.pair,
                  {
                    width: box.width,
                    height: box.height,
                    left: pair.x - box.width / 2,
                    top: pair.y - box.height / 2,
                    transform: [{ rotateZ: `${pair.rotation}rad` }, { scale: pair.scale }],
                  },
                ]}>
                <SpecialSticker id={sticker ?? ''} />
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

// The real outlines of one face (for Glam and Glow), or null if the tracker didn't give them.
function shapeOf(face: Face, index: number): FaceShape | null {
  const c = face.contours;
  const outline = (list: Pt[] | undefined) => (list ?? []).map((p) => ({ x: p.x, y: p.y }));
  const faceLine = outline(c?.FACE);
  if (faceLine.length < 8) return null;
  const xs = faceLine.map((p) => p.x);
  const cheek = (contour: Pt[] | undefined, landmark: Pt | undefined) => {
    const point = contour?.[0] ?? landmark;
    return point ? { x: point.x, y: point.y } : null;
  };
  return {
    key: String(face.trackingId ?? index),
    face: faceLine,
    // Each lip as one closed outline: its top edge, then its bottom edge back the other way.
    upperLip: [...outline(c?.UPPER_LIP_TOP), ...outline(c?.UPPER_LIP_BOTTOM).reverse()],
    lowerLip: [...outline(c?.LOWER_LIP_TOP), ...outline(c?.LOWER_LIP_BOTTOM).reverse()],
    leftEye: outline(c?.LEFT_EYE),
    rightEye: outline(c?.RIGHT_EYE),
    leftBrow: [...outline(c?.LEFT_EYEBROW_TOP), ...outline(c?.LEFT_EYEBROW_BOTTOM).reverse()],
    rightBrow: [...outline(c?.RIGHT_EYEBROW_TOP), ...outline(c?.RIGHT_EYEBROW_BOTTOM).reverse()],
    leftCheek: cheek(c?.LEFT_CHEEK, face.landmarks?.LEFT_CHEEK),
    rightCheek: cheek(c?.RIGHT_CHEEK, face.landmarks?.RIGHT_CHEEK),
    width: Math.max(...xs) - Math.min(...xs),
  };
}

// Move smoothly from the last outline to the new one (so the makeup doesn't jitter).
function glide(last: FaceShape, next: FaceShape): FaceShape {
  const mix = (a: Pt[], b: Pt[]) =>
    a.length === b.length ? b.map((p, i) => ({ x: a[i].x + (p.x - a[i].x) * FOLLOW, y: a[i].y + (p.y - a[i].y) * FOLLOW })) : b;
  const one = (a: Pt | null, b: Pt | null) => (a && b ? { x: a.x + (b.x - a.x) * FOLLOW, y: a.y + (b.y - a.y) * FOLLOW } : b);
  return {
    key: next.key,
    face: mix(last.face, next.face),
    upperLip: mix(last.upperLip, next.upperLip),
    lowerLip: mix(last.lowerLip, next.lowerLip),
    leftEye: mix(last.leftEye, next.leftEye),
    rightEye: mix(last.rightEye, next.rightEye),
    leftBrow: mix(last.leftBrow, next.leftBrow),
    rightBrow: mix(last.rightBrow, next.rightBrow),
    leftCheek: one(last.leftCheek, next.leftCheek),
    rightCheek: one(last.rightCheek, next.rightCheek),
    width: last.width + (next.width - last.width) * FOLLOW,
  };
}

const styles = StyleSheet.create({
  pair: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
