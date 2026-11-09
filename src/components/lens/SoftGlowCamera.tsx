import { FlipType, ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { useImperativeHandle, useRef, type Ref } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';
import { Camera, usePhotoOutput, type CameraOutput, type CameraRef } from 'react-native-vision-camera';

import { toScreenPoints, useFaceMeshOutput, type FaceMeshFace } from '@/lib/faceMesh';

import { bakeLook } from './bakeLook';
import { newTrackMemory, trackFaces, type RawFace } from './faceTrack';
import { LensOverlay } from './LensOverlay';
import { MAX_LENS_FACES, type LensFace, type LensLook } from './lensPaint';

// ---------------------------------------------------------------------------
// The live camera with a face filter, using MediaPipe's 478 face points: ✨ Soft Glow (look="glow"),
// 🌅 Golden Hour (look="golden") and the Peekaboo+ filters 👀 😭 🧠 ⚡ 😘 (the list is in lib/lensLooks.ts).
// The drawing is in lensPaint.ts; following the faces and the filters' memory is in faceTrack.ts.
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
  // The faces seen lately, so each face keeps its smoothing and its filter memory from frame to frame.
  const track = useRef(newTrackMemory());

  function handleFaces(found: FaceMeshFace[]) {
    const cam = camera.current;
    if (!cam?.preview) return;
    const raw: RawFace[] = [];
    for (const face of found.slice(0, MAX_LENS_FACES)) {
      if (face.points.length < 478 * 3) continue;
      raw.push({ pts: toScreenPoints(face, cam), shapes: face.blendshapes });
    }
    const next = trackFaces(raw, track.current, look, performance.now() / 1000);
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
