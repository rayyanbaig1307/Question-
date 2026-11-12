import { FlipType, ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { Component, useCallback, useImperativeHandle, useRef, useState, type ComponentType, type ReactNode, type Ref } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';
import { Camera, usePhotoOutput, type CameraOutput, type CameraRef } from 'react-native-vision-camera';

import { cameraAxes, toScreenPointsFrom, useFaceMeshOutput, type FaceMeshFace } from '@/lib/faceMesh';
import { FRAME_ACCESS_AVAILABLE, FRAME_SETUP_MS, markFramesBroken, useWarpLooksOn } from '@/lib/frameAccess';
import { lensDiagnosticsOn, type WarpStats } from '@/lib/lensDiagnostics';
import { isWarpLook } from '@/lib/lensLooks';

import { bakeLook } from './bakeLook';
import { newTrackMemory, trackFaces, type RawFace } from './faceTrack';
import { LensOverlay } from './LensOverlay';
import { MAX_LENS_FACES, type LensFace, type LensLook } from './lensPaint';
import type { FrameShot, ViewAxes } from './warp/frameMatrix';
import { WarpDiagnostics } from './warp/WarpDiagnostics';

type FrameFeedProps = {
  shot: SharedValue<FrameShot | null>;
  onOutput: (output: CameraOutput | null) => void;
  facing: 'front' | 'back';
  inUse: boolean;
  onStats?: (stats: WarpStats | null) => void;
  probeDark?: boolean;
};

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

// The small readout line for the stretchy filters: only on the `testing` update channel (lib/lensDiagnostics.ts).
const DIAGNOSTICS_ON = FrameFeed !== null && lensDiagnosticsOn();

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
// The 4 stretchy Peekaboo+ filters (🫥 🗿 😃 👾) also need the camera's own pictures: on downloads that have
// them, FrameFeed hands them to the overlay while one of them is on, and the overlay draws the camera picture
// itself, stretched. FrameFeed is added the first time a stretchy filter is picked and then stays until this
// camera closes (adding or removing it restarts the camera's set-up, which flashes the picture, and the bubble
// row has other filters between the stretchy ones). Every other filter works exactly as before.
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
  // True once a stretchy filter was on while this camera was showing: from then on FrameFeed stays (`attached`)
  // until this camera closes, and is only told whether its pictures are wanted right now (`inUse`).
  const [framesWanted, setFramesWanted] = useState(false);
  const wantsFrames = FrameFeed !== null && warpsOn && active && isWarpLook(look);
  if (wantsFrames && !framesWanted) setFramesWanted(true);
  const attached = FrameFeed !== null && warpsOn && (framesWanted || wantsFrames);
  const inUse = attached && active && isWarpLook(look);
  // Which camera FrameFeed is for. It follows the camera only while its pictures are wanted: flipping the camera
  // with another filter on keeps the same FrameFeed and camera output (so the camera is set up once, as it was
  // before the stretchy filters). FrameFeed changes camera (a new one, see `key` below) only when a stretchy filter
  // is on: right away when you flip with one on, or when you pick one again after flipping.
  const [feedFacing, setFeedFacing] = useState(facing);
  if (inUse && feedFacing !== facing) setFeedFacing(facing);
  const feedFor = inUse ? facing : feedFacing;
  // The moment the live filter is showing (seconds), so the photo gets the same shine and twinkles.
  const shownTime = useSharedValue(0);
  const last = useRef<LensFace[]>([]);
  // The size of the camera view on screen (the face points are in these units), from onLayout: `viewSize` for
  // the photo (bakeLook) and `viewSizeLive` for the live overlay, so both use the very same size.
  const viewSize = useRef({ width: 0, height: 0 });
  const viewSizeLive = useSharedValue({ width: 0, height: 0 });
  // The camera view's converter (the one the face points use), for the stretchy filters' second opinion on which
  // way up the camera picture goes, and for the testing readout.
  const axes = useSharedValue<ViewAxes | null>(null);
  const axesNow = useRef<ViewAxes | null>(null);
  // Testing readout only: FrameFeed's counts, and how many times the camera was set up since it opened.
  const warpStats = useRef<WarpStats | null>(null);
  const setups = useRef(0);
  const handleStats = useCallback((stats: WarpStats | null) => {
    warpStats.current = stats;
  }, []);
  // The faces seen lately, so each face keeps its smoothing and its filter memory from frame to frame.
  const track = useRef(newTrackMemory());

  // Keeps the converter's numbers (only when they changed, so the drawing thread isn't told for nothing).
  function noteAxes(found: { ox: number; oy: number; ax: number; ay: number; bx: number; by: number }) {
    const next: ViewAxes = { ...found, front: facing === 'front' };
    const was = axesNow.current;
    const same = was !== null && was.front === next.front
      && (['ox', 'oy', 'ax', 'ay', 'bx', 'by'] as const).every((key) => Math.abs(was[key] - next[key]) < 0.01);
    if (same) return;
    axesNow.current = next;
    axes.set(next);
  }

  function handleFaces(found: FaceMeshFace[]) {
    const cam = camera.current;
    if (!cam?.preview) return;
    const raw: RawFace[] = [];
    const usable = found.slice(0, MAX_LENS_FACES).filter((face) => face.points.length >= 478 * 3);
    if (usable.length > 0) {
      // Where the camera's points land on the screen (3 quick questions to the camera view, once for all faces).
      const converter = cameraAxes(cam);
      if (!converter) return;
      noteAxes(converter);
      for (const face of usable) raw.push({ pts: toScreenPointsFrom(face, converter), shapes: face.blendshapes });
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
  if (attached && frameOutput) outputs.push(frameOutput);

  function handleCameraError(error: unknown) {
    console.warn('Face filter camera', error);
    // The camera reported an error while it was also giving pictures to the stretchy filters: switch those off
    // at once, so the camera goes back to how it works on every other download. Many camera errors have
    // nothing to do with them (a zoom the camera can't do, the phone's media system restarting), so that is
    // only until the app is closed – unless it came just after their pictures were switched on, which is what
    // it looks like when adding them breaks the camera (lib/frameAccess.ts, 'strike').
    if (!attached || !frameOutput) return;
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

  // The camera view's size without the camera page's shrink animation (the overlay's own Canvas size includes
  // it): the same number for the live overlay and for the photo.
  function onLayout(event: LayoutChangeEvent) {
    const size = { width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height };
    viewSize.current = size;
    viewSizeLive.set(size);
  }

  // Each one is a camera set-up (a short black flash): counted for the testing readout.
  function handleConfigured() {
    setups.current += 1;
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
        onConfigured={handleConfigured}
      />
      {FrameFeed && attached ? (
        <FrameFeedGuard>
          {/* key: a FrameFeed is only ever for one camera; a new one starts for the other camera (FrameFeed.tsx explains why). */}
          <FrameFeed key={feedFor} shot={shot} onOutput={handleFrameOutput} facing={feedFor} inUse={inUse} onStats={handleStats} probeDark={DIAGNOSTICS_ON} />
        </FrameFeedGuard>
      ) : null}
      {active ? <LensOverlay faces={faces} look={look} shownTime={shownTime} shot={shot} viewSize={viewSizeLive} axes={axes} /> : null}
      {DIAGNOSTICS_ON && inUse ? <WarpDiagnostics stats={warpStats} axes={axesNow} viewSize={viewSize} setups={setups} facing={facing} /> : null}
    </View>
  );
}
