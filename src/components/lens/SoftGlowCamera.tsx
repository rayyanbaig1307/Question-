import { FlipType, ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { useImperativeHandle, useRef, type Ref } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';
import { Camera, usePhotoOutput, type CameraOutput, type CameraRef } from 'react-native-vision-camera';

import { BLENDSHAPE, MESH, toScreenPoints, useFaceMeshOutput, type FaceMeshFace } from '@/lib/faceMesh';
import { faceLight } from '@/lib/goldenLight';

import { bakeLook } from './bakeLook';
import { LensOverlay } from './LensOverlay';
import { MAX_LENS_FACES, type LensFace, type LensLook } from './lensPaint';

// ---------------------------------------------------------------------------
// The live camera with a face filter, using MediaPipe's 478 face points: ✨ Soft Glow (look="glow") or
// 🌅 Golden Hour (look="golden"). The drawing is in lensPaint.ts.
//
// Only load this file when FACE_MESH_AVAILABLE is true (lib/faceMesh.ts), the same way CameraPage loads
// FaceLensCamera only when FACE_LENS_AVAILABLE is true:
//
//   const SoftGlow = FACE_MESH_AVAILABLE ? require('@/components/lens/SoftGlowCamera').SoftGlowCamera : null;
//
// It takes the same props and handle as FaceLensCamera (plus `look`), so it can sit in the same place.
// See docs/FACE_MESH.md.
// ---------------------------------------------------------------------------

export type SoftGlowHandle = {
  // Takes the photo with the look drawn on it (bakeLook.ts). If that fails, you still get the plain photo.
  capture: () => Promise<{ uri: string }>;
};

// The tracker's points shiver by a pixel or so even when you hold still. Small moves are smoothed a lot,
// big moves are followed straight away, so the glow stays calm but never lags behind.
const CALM = 0.35;

export function SoftGlowCamera({ ref, look = 'glow', active, facing, flash, zoom = 0 }: {
  ref: Ref<SoftGlowHandle>;
  look?: LensLook;
  active: boolean;
  facing: 'front' | 'back';
  flash: 'on' | 'off';
  // Pinch zoom: 0 = not zoomed, 1 = as far as it goes (here up to 4×).
  zoom?: number;
}) {
  const camera = useRef<CameraRef | null>(null);
  const photoOutput = usePhotoOutput({ quality: 0.9 });
  const faces = useSharedValue<LensFace[]>([]);
  // The moment the live filter is showing (seconds), so the photo gets the same shine and twinkles.
  const shownTime = useSharedValue(0);
  const last = useRef<LensFace[]>([]);
  // The size of the camera view on screen (the face points are in these units).
  const viewSize = useRef({ width: 0, height: 0 });

  function handleFaces(found: FaceMeshFace[]) {
    const cam = camera.current;
    if (!cam?.preview) return;
    const next: LensFace[] = [];
    for (const face of found.slice(0, MAX_LENS_FACES)) {
      if (face.points.length < 478 * 3) continue;
      const pts = toScreenPoints(face, cam);
      const shapes = face.blendshapes;
      // Golden Hour: how the face is turned to the sun, from its 3D shape (each point's depth).
      const depth = new Array<number>(478);
      for (let i = 0; i < 478; i++) depth[i] = face.points[i * 3 + 2];
      const { light, rim } = faceLight(pts, depth);
      const glow: LensFace = {
        pts,
        blinkLeft: shapes[BLENDSHAPE.eyeBlinkLeft] ?? 0,
        blinkRight: shapes[BLENDSHAPE.eyeBlinkRight] ?? 0,
        smile: ((shapes[BLENDSHAPE.mouthSmileLeft] ?? 0) + (shapes[BLENDSHAPE.mouthSmileRight] ?? 0)) / 2,
        light,
        rim,
      };
      next.push(smooth(glow, closest(glow, last.current)));
    }
    last.current = next;
    faces.set(next);
  }

  function handleError(error: Error) {
    console.warn('Face filter', error);
  }

  // A problem with one frame must never close the app: skip that frame.
  function safeHandleFaces(found: FaceMeshFace[]) {
    try {
      handleFaces(found);
    } catch (error) {
      console.warn('Face filter frame', error);
    }
  }

  const meshOutput = useFaceMeshOutput({ maxFaces: MAX_LENS_FACES, blendshapes: true, onFaces: safeHandleFaces, onError: handleError });
  const outputs: CameraOutput[] = meshOutput ? [photoOutput, meshOutput] : [photoOutput];

  useImperativeHandle(
    ref,
    () => ({
      async capture() {
        // The faces as they were when you pressed the button (the photo takes a moment).
        const shotFaces = last.current;
        // The same moment of the moving shine, glints and twinkles as on screen when you pressed the button.
        const shown = shownTime.get();
        const shotTime = shown > 0 ? shown : (Date.now() % 600_000) / 1000;
        const file = await photoOutput.capturePhotoToFile({ flashMode: flash === 'on' && facing === 'back' ? 'on' : 'off' }, {});
        // Upright, and mirrored for selfies like the preview.
        let photo = ImageManipulator.manipulate(`file://${file.filePath}`);
        if (facing === 'front' && !file.isMirrored) photo = photo.flip(FlipType.Horizontal);
        const rendered = await photo.renderAsync();
        const saved = await rendered.saveAsync({ compress: 0.9, format: SaveFormat.JPEG });
        try {
          return { uri: await bakeLook(saved.uri, look, shotFaces, viewSize.current, shotTime) };
        } catch (error) {
          // Never lose the photo: without the look is better than nothing.
          console.warn('Could not put the face filter on the photo', error);
          return { uri: saved.uri };
        }
      },
    }),
    [photoOutput, flash, facing, look, shownTime],
  );

  function onLayout(event: LayoutChangeEvent) {
    viewSize.current = { width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height };
  }

  return (
    <View style={StyleSheet.absoluteFill} onLayout={onLayout}>
      <Camera
        ref={camera}
        style={StyleSheet.absoluteFill}
        device={facing}
        isActive={active}
        outputs={outputs}
        resizeMode="cover"
        zoom={zoom > 0 ? 1 + zoom * 3 : undefined}
        mirrorMode="auto"
        onError={(error) => console.warn('Face filter camera', error)}
      />
      {active ? <LensOverlay faces={faces} look={look} shownTime={shownTime} /> : null}
    </View>
  );
}

// The face from the last frame that is nearest to this one (by the nose tip), so each face is smoothed with
// its own history even when two people are in the picture.
function closest(face: LensFace, before: LensFace[]): LensFace | undefined {
  const nx = face.pts[MESH.noseTip * 2];
  const ny = face.pts[MESH.noseTip * 2 + 1];
  let best: LensFace | undefined;
  let bestDistance = Infinity;
  for (const old of before) {
    const d = Math.hypot(old.pts[MESH.noseTip * 2] - nx, old.pts[MESH.noseTip * 2 + 1] - ny);
    if (d < bestDistance) {
      best = old;
      bestDistance = d;
    }
  }
  const width = Math.hypot(
    face.pts[MESH.leftFaceSide * 2] - face.pts[MESH.rightFaceSide * 2],
    face.pts[MESH.leftFaceSide * 2 + 1] - face.pts[MESH.rightFaceSide * 2 + 1],
  );
  // Too far away to be the same face.
  return bestDistance < width * 0.5 ? best : undefined;
}

function smooth(face: LensFace, before: LensFace | undefined): LensFace {
  if (!before || before.pts.length !== face.pts.length) return face;
  const width =
    Math.hypot(
      face.pts[MESH.leftFaceSide * 2] - face.pts[MESH.rightFaceSide * 2],
      face.pts[MESH.leftFaceSide * 2 + 1] - face.pts[MESH.rightFaceSide * 2 + 1],
    ) || 1;
  // How far the face moved, compared with its size. Still → heavy smoothing; moving → none.
  const moved = Math.hypot(
    face.pts[MESH.noseTip * 2] - before.pts[MESH.noseTip * 2],
    face.pts[MESH.noseTip * 2 + 1] - before.pts[MESH.noseTip * 2 + 1],
  ) / width;
  const follow = Math.min(1, CALM + moved * 10);
  const pts = new Array<number>(face.pts.length);
  for (let i = 0; i < pts.length; i++) pts[i] = before.pts[i] + (face.pts[i] - before.pts[i]) * follow;
  const ease = (a: number, b: number) => a + (b - a) * 0.5;
  return {
    pts,
    blinkLeft: ease(before.blinkLeft, face.blinkLeft),
    blinkRight: ease(before.blinkRight, face.blinkRight),
    smile: ease(before.smile, face.smile),
    light: before.light.length === face.light.length ? face.light.map((value, i) => ease(before.light[i], value)) : face.light,
    rim: ease(before.rim, face.rim),
  };
}
