# Face mesh (MediaPipe): the Soft Glow and Golden Hour lenses

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
- `src/components/lens/lensPaint.ts`: the drawing for both looks (Skia), used live AND for the saved photo.
  - ✨ Soft Glow (`'glow'`): soft warm glow on the skin (not the eyes, brows or lips), light blush (a bit
    stronger when smiling), brighter eyes + small catchlight (hidden while blinking), a few twinkling sparkles.
  - 🌅 Golden Hour (`'golden'`): low evening sun from the top-left. Warm light on the cheekbone, temple and jaw
    on the side that faces the sun, a touch of shade on the other side, a soft golden rim on the lit edge, a
    warm haze and a few faint flare circles from the top-left corner, and a slightly warmer picture with warm
    corners. How much each spot faces the sun comes from the face's 3D points (`src/lib/goldenLight.ts`,
    tested in `tests/unit/golden-light.test.mjs`).
  All faint on purpose.
- `src/components/lens/LensOverlay.tsx`: draws the look live on top of the camera (a Skia picture per frame).
- `src/components/lens/bakeLook.ts`: draws the same look onto the saved photo (see "The look in the photo").
- `src/components/lens/SoftGlowCamera.tsx`: VisionCamera + photo output + face mesh output + the overlay.
  `look` prop picks the look. Same props as `FaceLensCamera` otherwise. Smooths the points (calm when still,
  quick when moving).
- Camera wiring: `ModeDial` shows ✨ and 🌅 bubbles only when `FACE_MESH_AVAILABLE`; both are Peekaboo+ (without
  Plus, tapping one opens `/plus`). `CameraPage` shows `SoftGlowCamera` for either mode.

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

- **The look in the photo.** `capture()` takes the real photo, then `bakeLook` draws the same look on it with
  Skia off screen, using the face points from the moment the button was pressed. A screenshot of the screen
  (`react-native-view-shot`) wasn't used: the camera picture often comes out black in it on iPhone, and it
  would only be screen-sized. The view shows the photo "zoomed to fill", so the drawing is scaled from view
  points onto the photo. This assumes the preview and the photo show the same area (both 4:3, the usual
  case); if the look sits a bit off in saved photos only, check that first. If baking fails, the plain photo
  is used, so a photo is never lost. Videos still have no look (the normal camera records them).
- **Live overlay can't truly blur skin.** The overlay is drawn on top of the camera view, so it can soften,
  brighten and tint, but not blur the pixels below. Real live smoothing needs the camera frames drawn inside
  Skia (`react-native-vision-camera-skia` + `react-native-vision-camera-worklets`, both 5.2.4, more native code).
- Coordinates: native code turns MediaPipe's points into VisionCamera camera coordinates
  (iOS: `metadataOutputRectConverted`; Android: CameraX's sensor-to-buffer matrix, turned around). JS then
  uses the Camera's `convertCameraPointToViewPoint`. If the glow is offset or mirrored on a phone, this is the
  place to look.
- MediaPipe's "left"/"right" blendshape names may be mirrored compared with the person; only blink uses them.
