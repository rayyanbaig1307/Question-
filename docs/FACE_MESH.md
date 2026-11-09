# Face mesh (MediaPipe): the face filters

Status: **switched on** in the iPhone builds that have face tracking (App Store build 10, and TestFlight builds
7–9). Seven filters use it, all Peekaboo+: ✨ Soft Glow, 🌅 Golden Hour, and (9 Nov, by OTA) 👀 Peekaboo Eyes,
🧠 Brain Buffering, 😭 Crybaby, ⚡ Aura Overload and 😘 Heart Eyes. **Android has no face mesh yet** (no APK
has been built with it), so Android shows none of these bubbles. Whether the live drawing lines up with the
face on a phone is checked by the owner (docs/TESTING.md, Step 67).

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
- `src/lib/lensLooks.ts`: the list of filters (key, emoji, name, VoiceOver hint, Plus or not), in the order
  they sit on the mode row. No imports at all, so the mode row and the camera screen can use it on every
  download, even ones without face tracking.
- `src/components/lens/lensPaint.ts`: the drawing (Skia), used live AND for the saved photo. `paintLook`
  picks the look; a look it doesn't know is an error, never a quiet Soft Glow. Soft Glow and Golden Hour are
  drawn here:
  - ✨ Soft Glow (`'glow'`): "heavenly gold" – warm gold on the skin (not the eyes, brows or lips) brightest
    at the forehead, soft light from above with a glow over the head, golden highlights, warm blush (a bit
    stronger when smiling), warmer eyes + small catchlight (hidden while blinking), twinkling gold glitter on
    the skin and cream star sparkles all round the face.
  - 🌅 Golden Hour (`'golden'`, redesigned 6 Nov because the owner found the two too alike): "liquid gold in
    the low sun". Warm gold over the whole face (both sides; the nostrils, moustache, lips, eyes and brows keep
    their own colour), polished highlights on the forehead, nose, cheekbones and lower lip, a thin gleam that
    glides across the face every 5 s and flashes glints on the high points, a low sun just past the left edge
    with a thin light streak and soft sunbeams, a light amber tint with warm dark corners, and a few soft
    golden orbs drifting away from faces. No sparkles, glitter or halo (those are Soft Glow's). It no longer
    uses `src/lib/goldenLight.ts`, and since 9 Nov the camera no longer works those numbers out either.
  Both are soft on purpose: real light, not stickers. `tests/unit/face-looks.test.mjs` checks the two stay
  different and that Golden Hour stays cheap enough to draw every frame.
- `src/components/lens/filters/`: the five Peekaboo+ filters ported from the web version (branch
  `claude/wonderful-planck-oe81zm`, `src/filters/*.js`; never merged). Each is on as soon as it sees a face
  (like the web's always-on level), and an expression turns it up:
  - 👀 Peekaboo Eyes (`peekabooEyes.ts`): giant glossy googly eyes with purple irises that look where you look
    and wobble when you move your head. **Raise your brows** and they pop out bigger (a bouncy spring).
  - 🧠 Brain Buffering (`brainBuffering.ts`): a loading spinner above the forehead with a % in the middle.
    **Hold still** and it loads to 100 % in about 9 s; moving drains it. At 100 % the ring turns green, a tick
    shows and the picture flashes green. **Shake your head** to start again. The number is drawn with bars
    (like a clock radio) and the web's caption became three "loading" dots, because the drawing thread has
    no fonts.
  - 😭 Crybaby (`crybaby.ts`): streams of cartoon tears thrown sideways out of both eyes, falling away, and a
    pink glow under the eyes. **Squint** (or scrunch your eyes) for more and bigger tears.
  - ⚡ Aura Overload (`auraOverload.ts`): a pulsing purple ring round the head, crackling lightning, orbiting
    stars, glowing eyes and purple corners. **Open your mouth** to charge it to full power.
  - 😘 Heart Eyes (`heartEyes.ts`): beating glossy hearts over the eyes, blush with white "/" lines, and hearts
    floating up from the lips. **Blow a kiss** for many more hearts.
  - `triggers.ts`: how strongly each filter reacts (the rest level and the expression formulas), shared by the
    drawing and `faceTrack.ts`. `kit.ts`: shared drawing helpers (paints, face size and directions, heart,
    star, tear and bolt shapes, bar digits, the "random" `hash01`).
- `src/components/lens/faceTrack.ts`: follows each face from one camera frame to the next (by the nose, with a
  1 s memory, so a short tracking drop doesn't restart anything), smooths the points and expressions, and
  steps each face's filter memory: the googly eyes' spring and wobble, the brain's progress and flash, the
  aura's charge. All of it is kept on the face (`LensFace`), on the app's main thread, in real seconds.
- `src/components/lens/LensOverlay.tsx`: draws the look live on top of the camera (a Skia picture per frame).
  If one look's drawing ever fails, only that look stops (with a warning in the log); the others still draw.
- `src/components/lens/bakeLook.ts`: draws the same look onto the saved photo (see "The look in the photo").
- `src/components/lens/SoftGlowCamera.tsx`: VisionCamera + photo output + face mesh output + the overlay.
  `look` prop picks the look (switching looks never restarts the camera). Same props as `FaceLensCamera`
  otherwise. Each face-tracking frame goes through `faceTrack.ts`.
- Camera wiring: `ModeDial` shows the filter bubbles (from `lensLooks.ts`) only when `FACE_MESH_AVAILABLE`; all
  are Peekaboo+. `CameraPage` shows `SoftGlowCamera` for any of them and handles the Plus check (see
  docs/HANDOFF.md).

## How it was switched on (for reference)

The module is in `package.json` (`"peekaboo-face-mesh": "file:modules/face-mesh"`); autolinking adds the
`PeekabooFaceMesh` pod with `MediaPipeTasksVision 0.10.21` and the Android library with
`com.google.mediapipe:tasks-vision:0.10.29`. `CameraPage` loads `SoftGlowCamera` only when
`FACE_MESH_AVAILABLE` is true (`require` behind the guard), so Expo Go and older downloads never load it and
can't crash. Only one camera view is open at a time (the googly `FaceCamera` or `SoftGlowCamera`), never both.
A new filter that only draws (like the five Plus ones) needs no new build: it ships by OTA.

## Rules for filter code

Each of these broke the live camera once, or would have:

- **Every drawing function starts with `'worklet'`** – it also runs on the camera's drawing thread, where a
  normal function can't be called at all. Helpers sit **above** the functions that use them. No parameter
  defaults that read outside names (write `x ?? DEFAULT` in the body). `tests/unit/worklet-order.test.mjs` and
  `tests/unit/lens-ui-thread.test.mjs` (runs every look the way the phone's drawing thread does) check this.
- **Memory lives on the face, not in the drawing.** Anything that has to remember the last frame (springs,
  progress, charge) is stepped in `faceTrack.ts` and stored on `LensFace`. The drawing only reads it, so the
  saved photo (which gets the same faces) matches the screen.
- **Particles come from time + a fixed hash.** Tears, hearts, sparks and data squares are worked out from the
  time and `hash01(face.seed, slot, n)`, never `Math.random` or `Date.now`. The same moment always draws the
  same particles, so the photo shows them where you saw them.
- **No text, no blend modes, no random.** There are no fonts on the drawing thread (no `matchFont`); blend
  modes can't mix with the live camera picture (and would make the photo differ); only see-through colours,
  gradients and a few blurs.
- **Guard broken numbers.** Read every face number through `num()`, skip faces that fail `faceOk()`.
- **Stay cheap.** With two faces each new filter makes at most 30 draws and 4 blurred draws per frame
  (`tests/unit/face-looks.test.mjs` checks it). Many particles go into one shape, drawn once.
- **Filter files only `import type` from `../lensPaint`.** A normal import there goes round in a circle and the
  drawing thread gets `undefined`.
- Points are already on screen and mirrored for selfies: never hard-code left or right. "Out" for an eye is
  away from the point between the eyes; "up" is from the bottom of the nose to the top of the forehead.

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
- Expression scores: `BLENDSHAPE` holds their places in MediaPipe's standard list of 52 (the native part puts
  each score at its category's index; `tests/unit/face-track.test.mjs` checks every place against the full
  list). MediaPipe's "left"/"right" names may be mirrored compared with the person; every filter uses both
  sides together (the average or the bigger one), so it doesn't matter.
- Videos have no filter: holding the shutter swaps in the normal camera, which records a plain video.
