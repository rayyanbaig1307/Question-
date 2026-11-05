# Face mesh (MediaPipe) and the Soft Glow lens

Status: built, **not switched on yet**. The app works exactly as before until the steps in "Switching it on"
are done and a new native build (APK + TestFlight) is made. Nothing here has run on a phone yet.

## What it is

Google's MediaPipe Face Landmarker finds **478 points** on each face (outline, eyes, irises, brows, lips…) and
**52 expression scores** (blink, smile, jaw open…). The googly lens today uses ML Kit, which only gives a box,
a few landmarks and contours. 478 points let lenses follow the real shape of a face.

- `modules/face-mesh/`: our own small native module (Swift + Kotlin). It's a VisionCamera v5 *camera output*,
  built the same way as `react-native-vision-camera-face-detector` (the ML Kit one we already use). It adds a
  small extra video stream (about 640 × 480), runs Face Landmarker on it and sends the points to JS.
  `nitrogen/` is generated code: after changing `src/specs/FaceMeshFactory.nitro.ts`, run
  `npx nitrogen@0.37.1` inside `modules/face-mesh` (must match `react-native-nitro-modules`).
- `modules/face-mesh/assets/face_landmarker.task`: Google's model, float16, 3,758,596 bytes (3.6 MB), from
  `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`
  (sha256 `64184e22…0bc9ff`). The podspec copies it into the iPhone app; `android/build.gradle` adds the same
  folder as Android assets. No config plugin is needed for it.
- `src/lib/faceMesh.ts`: the guard (`FACE_MESH_AVAILABLE`), `useFaceMeshOutput`, `toScreenPoints` (camera
  coordinates → screen points) and the names of the useful points (`MESH`) and scores (`BLENDSHAPE`).
- `src/components/lens/SoftGlowOverlay.tsx`: the Soft Glow drawing (Skia): soft warm glow on the skin (not the
  eyes, brows or lips), light blush (a bit stronger when smiling), brighter eyes + small catchlight (hidden while
  blinking), a few small twinkling sparkles. All faint on purpose.
- `src/components/lens/SoftGlowCamera.tsx`: VisionCamera + photo output + face mesh output + the overlay.
  Same props as `FaceLensCamera`. Smooths the points (calm when still, quick when moving).

## Switching it on (needs a new native build)

1. Add the module to `package.json` dependencies and install:
   `"peekaboo-face-mesh": "file:./modules/face-mesh"`, then `npm install`.
   (Autolinking then adds the `PeekabooFaceMesh` pod with `MediaPipeTasksVision 0.10.21`, and the Android
   library with `com.google.mediapipe:tasks-vision:0.10.29`.)
2. Make a test build on both phones (`preview` APK, `testflight`). Check it opens, then try the lens.
3. Wire it into the camera (not done yet):
   ```ts
   import { FACE_MESH_AVAILABLE } from '@/lib/faceMesh';
   const SoftGlow: typeof import('@/components/lens/SoftGlowCamera').SoftGlowCamera | null = FACE_MESH_AVAILABLE
     ? // eslint-disable-next-line @typescript-eslint/no-require-imports
       require('@/components/lens/SoftGlowCamera').SoftGlowCamera
     : null;
   // In CameraPage, where FaceLens is shown: when the Soft Glow bubble is picked and SoftGlow exists,
   // render <SoftGlow ref={…} active facing={…} flash={…} zoom={…} /> instead of <FaceLens …/>.
   ```
   Add a bubble in `ModeDial` only when `FACE_MESH_AVAILABLE` is true. Old builds and Expo Go never load the
   file, so they can't crash.
4. Only one camera view should be open at a time (the googly `FaceCamera` or `SoftGlowCamera`), never both.

## Things to know

- **The glow isn't in the photo yet.** `capture()` returns the plain photo. To keep the look, either take a
  `react-native-view-shot` of camera + overlay, or (better) redraw the glow on the photo with Skia offscreen
  using the same points mapped to the photo.
- **Live overlay can't truly blur skin.** The overlay is drawn on top of the camera view, so it can soften,
  brighten and tint, but not blur the pixels below. Real live smoothing needs the camera frames drawn inside
  Skia (`react-native-vision-camera-skia` + `react-native-vision-camera-worklets`, both 5.2.4, more native code).
- Coordinates: native code turns MediaPipe's points into VisionCamera camera coordinates
  (iOS: `metadataOutputRectConverted`; Android: CameraX's sensor-to-buffer matrix, turned around). JS then
  uses the Camera's `convertCameraPointToViewPoint`. If the glow is offset or mirrored on a phone, this is the
  place to look.
- MediaPipe's "left"/"right" blendshape names may be mirrored compared with the person; only blink uses them.
