import { FlipType, ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { Component, useCallback, useImperativeHandle, useRef, useState, type ComponentType, type ReactNode, type Ref } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';
import { Camera, usePhotoOutput, type CameraOutput, type CameraRef } from 'react-native-vision-camera';

import { toScreenPoints, useFaceMeshOutput, type FaceMeshFace } from '@/lib/faceMesh';
import { FRAME_ACCESS_AVAILABLE, FRAME_SETUP_MS, markFramesBroken, useWarpLooksOn } from '@/lib/frameAccess';
import { isWarpLook } from '@/lib/lensLooks';

import { bakeLook } from './bakeLook';
import { newTrackMemory, trackFaces, type RawFace } from './faceTrack';
import { LensOverlay } from './LensOverlay';
import { MAX_LENS_FACES, type LensFace, type LensLook } from './lensPaint';
import type { FrameShot } from './warp/frameMatrix';

type FrameFeedProps = { shot: SharedValue<FrameShot | null>; onOutput: (output: CameraOutput | null) => void; facing: 'front' | 'back' };

// The camera's own pictures, for the 4 stretchy filters (warp/FrameFeed.tsx). Only loaded on downloads that
// have them (lib/frameAccess.ts): on every other download this stays null and nothing about the camera changes.
// If loading it fails anyway, the stretchy filters switch themselves off instead of closing the app.
function loadFrameFeed(): ComponentType<FrameFeedProps> | null {
  if (!FRAME_ACCESS_AVAILABLE) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('./warp/FrameFeed') as typeof import('./warp/FrameFeed')).FrameFeed;
  } catch (error) {
    markFramesBroken(error);
    return null;
  }
}
const FrameFeed = loadFrameFeed();

// If the camera pictures part ever fails while it is being shown, only the stretchy filters switch off (the
// camera and the other filters keep working).
class FrameFeedGuard extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    markFramesBroken(error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

// ---------------------------------------------------------------------------
// The live camera with a face filter, using MediaPipe's 478 face points: ✨ Soft Glow (look="glow"),
// 🌅 Golden Hour (look="golden") and the Peekaboo+ filters 👀 😭 🧠 ⚡ 😘 (the list is in lib/lensLooks.ts).
// The drawing is in lensPaint.ts; following the faces and the filters' memory is in faceTrack.ts.
// The 4 stretchy Peekaboo+ filters (🫥 🗿 😃 👾) also need the camera's own pictures: while one of them is on
// (and only on downloads that have them), FrameFeed hands them to the overlay, which draws the camera picture
// itself, stretched. Every other filter works exactly as before.
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
  // The camera picture to draw for the stretchy filters (FrameFeed fills it, LensOverlay draws it).
  const shot = useSharedValue<FrameShot | null>(null);
  // The camera output that gives those pictures, while it is on, and when it was handed over (milliseconds).
  const [frameOutput, setFrameOutput] = useState<CameraOutput | null>(null);
  const frameOutputSince = useRef(0);
  const handleFrameOutput = useCallback((output: CameraOutput | null) => {
    frameOutputSince.current = output ? Date.now() : 0;
    setFrameOutput(output);
  }, []);
  // False once the stretchy filters switched themselves off on this phone.
  const warpsOn = useWarpLooksOn();
  const feeding = FrameFeed !== null && warpsOn && active && isWarpLook(look);
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
  const outputs: CameraOutput[] = [photoOutput];
  if (meshOutput) outputs.push(meshOutput);
  if (feeding && frameOutput) outputs.push(frameOutput);

  function handleCameraError(error: unknown) {
    console.warn('Face filter camera', error);
    // The camera reported an error while it was also giving pictures to the stretchy filters: switch those off
    // at once, so the camera goes back to how it works on every other download. Many camera errors have
    // nothing to do with them (a zoom the camera can't do, the phone's media system restarting), so that is
    // only until the app is closed – unless it came just after their pictures were switched on, which is what
    // it looks like when adding them breaks the camera (lib/frameAccess.ts, 'strike').
    if (!feeding || !frameOutput) return;
    const settingUp = Date.now() - frameOutputSince.current < FRAME_SETUP_MS;
    markFramesBroken(error, settingUp ? 'strike' : 'thisRun');
  }

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
        onError={handleCameraError}
      />
      {FrameFeed && feeding ? (
        <FrameFeedGuard>
          {/* key: flipping the camera starts a new FrameFeed for the other camera (FrameFeed.tsx explains why). */}
          <FrameFeed key={facing} shot={shot} onOutput={handleFrameOutput} facing={facing} />
        </FrameFeedGuard>
      ) : null}
      {active ? <LensOverlay faces={faces} look={look} shownTime={shownTime} shot={shot} /> : null}
    </View>
  );
}
