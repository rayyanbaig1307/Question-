# Face mesh (MediaPipe): the face filters

Status: **switched on** in the iPhone builds that have face tracking (App Store build 10, and TestFlight builds
7–9). Seven filters use it: ✨ Soft Glow and 🌅 Golden Hour (free), and (9 Nov, by OTA) the Peekaboo+ ones 👀 Peekaboo
Eyes, 🧠 Brain Buffering, 😭 Crybaby, ⚡ Aura Overload and 😘 Heart Eyes. Four more Peekaboo+ ones, the stretchy
🫥 Tiny Face, 🗿 Gigachin, 😃 Big Mouth and 👾 Pixel Panic, need a new native build (version 1.1, see "The stretchy
filters" below); on every older download they don't show at all. **Android has no face mesh yet** (no APK
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
  brighten and tint, but not blur the pixels below. Only the stretchy filters (below) get the camera's own
  pixels, and only while one of them is on; the other filters still draw over the normal camera view.
- Coordinates: native code turns MediaPipe's points into VisionCamera camera coordinates
  (iOS: `metadataOutputRectConverted`; Android: CameraX's sensor-to-buffer matrix, turned around). JS then
  uses the Camera's `convertCameraPointToViewPoint`. If the glow is offset or mirrored on a phone, this is the
  place to look.
- Expression scores: `BLENDSHAPE` holds their places in MediaPipe's standard list of 52 (the native part puts
  each score at its category's index; `tests/unit/face-track.test.mjs` checks every place against the full
  list). MediaPipe's "left"/"right" names may be mirrored compared with the person; every filter uses both
  sides together (the average or the bigger one), so it doesn't matter.
- Videos have no filter: holding the shutter swaps in the normal camera, which records a plain video.

## The stretchy filters (Phase B): 🫥 Tiny Face, 🗿 Gigachin, 😃 Big Mouth, 👾 Pixel Panic

These four (all Peekaboo+, from the web version) change the camera picture itself: they stretch and squash
your face. So they need the camera's own pixels, live, which only downloads built with one more native package
have: `react-native-vision-camera-worklets` (exactly **5.2.4**, the same as `react-native-vision-camera`). That
is version 1.1 (TestFlight build 11, App Store build 12) and Android APK v17. Videos stay plain.

- 😃 **Big Mouth**: your mouth blown up like a balloon, about 1.9× with a still face and 2× wide open, bouncing
  when it changes size. **Open wide.**
- 🫥 **Tiny Face**: your face shrunk to about a third, in the middle of a smooth blurred "egg" head with soft
  shading. **Talk** and it gets even tinier and bobs.
- 🗿 **Gigachin**: everything under your lower lip stretched down and a bit wider. **Pout** to charge the chin: a
  "CHIN POWER 87%" meter above your head fills in about 1.1 s and turns into a gold "GIGACHIN" at 100 %.
- 👾 **Pixel Panic**: your face in big pixels with torn slices shoved sideways (magenta and cyan ghosts), data
  bars, a flickering ERROR tag and now and then a glitch line across the whole picture. **Raise your brows.**

Like the web version they are already on with a still face; the expression turns them up.

### Where the code is

- `src/lib/frameAccess.ts`: the guard. `FRAME_ACCESS_AVAILABLE` is true only on iOS 17+ when Nitro has the
  `WorkletQueueFactory` (the new package) and `CameraFactory`; on Android only once `WARPS_ON_ANDROID` is turned
  on. Switches that an app update can change: `WARPS_ENABLED` (all off), `WARPS_ON_ANDROID`, `FRAME_PATH`
  ('share' on iPhone: no copy; 'copy' on Android), `FRAME_DELAY` (camera pictures held back so the picture
  matches the face points; set 0 if the readout shows `oob`), `STALE_MS` (1 s: how long the last good picture
  stays when no new one comes), `FRAME_PIXEL_FORMAT` ('yuv'; 'rgb' only if the readout shows `err` or wrong
  colours; never 'native' on iPhone), `FRAME_PLACEMENT` ('rule' or 'converter', see "Which way up" below),
  `FRAME_ERROR_*` (when failed pictures switch them off) and `LOOK_COOL_DOWN_MS` (a look whose drawing fails
  pauses 1.5 s, then tries again; off after `LOOK_MAX_FAILS`). `markFramesBroken(why, how)` switches the four off
  on this phone at once (bubbles gone, plain camera). How long for:
  - `'remember'` (for this download's build number): only for failures the new code alone can cause – FrameFeed
    can't load or crashes, or the GPU programs can't be made;
  - `'thisRun'` (until the app is closed): a camera error while their pictures are switched on, or more than half
    of the camera pictures failing in 2 s (at least 10). Lots of things cause camera errors (a zoom the camera
    can't do, the phone's media system restarting), so one of them must not hide the paid filters for good. A
    few failed pictures are just skipped (the last good one stays on screen);
  - `'strike'`: a camera error within `FRAME_SETUP_MS` (4 s) of their camera pictures being switched on, which is
    what it looks like when adding them breaks the camera on that phone. Off until the app is closed; the second
    app start with a strike makes the phone remember it.

  `RETRY_ROUND` lets every phone try again after a fix by OTA (2 since the 12 Nov fix: build 11 switched them off
  for good after just 3 failed pictures). `useWarpLooksOn()` is the hook for screens.
- `src/lib/lensLooks.ts`: the four have `needsFrames: true`; `isWarpLook()` tells them apart. The mode row
  (`ModeDial`) and the chat cameras only list them when `FRAME_ACCESS_AVAILABLE` and not broken.
- `src/components/lens/warp/`:
  - `FrameFeed.tsx`: the **only** file that uses the camera's `useFrameOutput`. `SoftGlowCamera` loads it with
    `require` only when `FRAME_ACCESS_AVAILABLE`. It is added the first time a stretchy filter is picked and then
    **stays until the camera closes**: adding or removing a camera output restarts the camera's set-up (a black
    flash), and the bubble row has other filters between the stretchy ones. While another filter is on (or the
    camera page is away) it gets `inUse={false}`: the camera thread hands every picture straight back, nothing is
    kept (let go of at once) and its every-screen-frame check is paused (`useFrameCallback(…, false)` +
    `setActive(inUse)`), so it doesn't wake the phone 60–120 times a second for nothing. People who never
    pick a stretchy filter pay nothing. The camera thread puts each picture's GPU buffer in a one-picture
    "mailbox" (no copy on iPhone); every screen frame the drawing thread takes it out, makes it a Skia image
    (checking its size) and keeps the last `FRAME_DELAY + 1`; the oldest is shown. A picture that fails is
    skipped (the last good one stays). No new picture for `STALE_MS` (1 s) → nothing is shown, so the normal
    camera view shows through. A FrameFeed is for **one camera for its whole life** (`key` in `SoftGlowCamera`):
    flipping with a stretchy filter on throws the old one away with every picture it kept and starts one for the
    other camera (two quick camera set-ups, as on build 11). Flipping with another filter on keeps the same one
    and its camera output, so the camera is set up once (its pictures aren't wanted then); it is swapped for the
    other camera's only when a stretchy filter is picked again. Not one FrameFeed for both cameras: a picture
    can't say which camera it came from (VisionCamera's `isMirrored` is always false with `mirrorMode` 'auto'),
    the old camera's pictures still come for a moment after a flip, and the iPhone rule needs to know the camera
    (the wrong one turns the picture upside down). Each picture (`FrameShot`) says itself how it is turned and
    whether it is mirrored. It also counts what goes wrong (dropped pictures by reason, failed pictures, gaps,
    late pictures, frame rate) for the readout below. `feedLogic.ts` has its small sums (no imports).
  - `frameMatrix.ts`: where a camera picture goes on the screen (stood up, mirrored for selfies, "cover" like the
    camera view) and where the saved photo goes (`photoToView`, exactly like `bakeLook`). `MIRROR_FRONT`: if the
    stretched picture ever moves the wrong way on the selfie camera, flip it.
  - `shaders.ts`: the four GPU programs (SkSL): BALLOON (Big Mouth), SHRINK (Tiny Face), STRETCH (Gigachin) and
    PIXEL (Pixel Panic). Each one is exactly the plain picture at its edge, so there is no seam, and each one is
    **see-through wherever it changes nothing** (it returns nothing, never the plain picture): with two faces close
    together, the second face's box would otherwise paint the plain picture back over the first face's warp.
    `warpEffects.ts` makes them once, on the main thread, the first time one is used.
  - `paintWarp.ts`: the drawing (worklets, same rules as the other filters). `lensPaint.ts` `paintLook` sends the
    four looks here with `src` (the camera picture as a shader in screen points, plus the GPU programs); without
    `src` they draw nothing at all. Every Skia object it makes from the camera picture (a GPU program's shader,
    the paint that draws it, the blur) goes on `src.trash` as soon as it is made, before drawing with it.
  - `pixelText.ts`: words made of little squares (5 × 7), since the drawing thread has no fonts.
  - `warpTrack.ts`: the memory on each face (`mouth`, `mouthSpeed`, `tiny`, `chin`, `glitch`, `warpLevel`),
    stepped from `faceTrack.ts` (one call in `stepFace`), in real seconds.
- `LensOverlay.tsx`: for a stretchy filter it first draws the whole camera picture (from FrameFeed) over the
  normal camera view, placed exactly like it (`placeShot`), then the filter stretches that. Its size is
  `viewSize` from SoftGlowCamera's `onLayout` – the same size `bakeLook` uses – **never Canvas `onSize`**: that
  comes from Reanimated `measure()`, which includes the camera page's 0.92 shrink animation (the pager animates
  on the native side, so the shrink stays in the layout tree), and made the picture 8 % too small (TestFlight
  build 11). Right after each frame it lets go (`dispose`) of everything on `src.trash`, the paint under the
  filter and the picture's shader, newest first, also when the drawing failed. Each finished drawing (the
  `SkPicture`) holds its camera picture, and so the camera's buffer, until it is let go of: the overlay lets go
  of each drawing **two drawings later** (never the newest or the one before: the main thread may still read
  it), and of the last two when it closes (swiping to Chat; by then Reanimated has stopped its updaters, and the
  screen keeps its own copy until it is torn down). Left to the garbage collector, the camera ran out of buffers, no picture came, the overlay fell back to
  the plain camera and then snapped back (build 11's "snapping and freezing"). The Canvas children are made once
  (switching looks never re-builds the canvas on the JS thread), and the very first drawing (which runs on the
  JS thread) never uses the camera picture. A look whose drawing fails pauses for `LOOK_COOL_DOWN_MS` with the
  camera picture still shown, then tries again. For every other filter nothing changed.
- `warp/WarpDiagnostics.tsx` + `lib/lensDiagnostics.ts`: the readout line (below).
- `bakeLook.ts`: the photo gets the same filter, with the photo itself as the picture to stretch (blur and pixel
  sizes are in screen points, so the photo matches the screen).

### Which way up (the 12 Nov fix)

The camera never turns its pictures (`enablePhysicalBufferRotation: false`); `frameMatrix.ts` stands them up while
drawing. On iPhone the pictures are sideways (e.g. 1920 × 1440). VisionCamera 5.2.4 labels each picture with the
camera connection's angle C, but it reads the **selfie** camera's label (AVFoundation "landscape left") with the
same table as the back camera's, so it says 90°. The selfie camera faces you, so its label counts the other way
round: its pictures need the same 270° turn as the back camera's. Following the label drew the selfie picture
upside down (the owner's screenshots). The rule (`iosShotTurn`): back camera turn = C, selfie camera turn =
360° − C, plus the mirror. On every iPhone today both are 270°. FrameFeed keeps C as the most common label it has
seen (one odd picture never turns the picture). On the owner's phone (1920 × 1440 into 390 × 844) the selfie
matrix is `[0, 0.4396, −121.5, 0.4396, 0, 0]` and the back one `[0, −0.4396, 511.5, 0.4396, 0, 0]`.

As a second opinion, the camera view's own converter (`convertCameraPointToViewPoint`, the one the face points
use; `lib/faceMesh.ts` `cameraAxes`) gives a turn too (`turnFromAxes`). It is used only where the rule can't
decide (an odd label or an upright picture), and only for the turn and mirror: the size and place always come
from the view (cover), so pinch zoom can't move the picture. `FRAME_PLACEMENT = 'converter'` (by OTA) asks it
first. Never combine VisionCamera's `Frame.convertFramePointToCameraPoint` with the view converter: they use
different coordinate spaces. Android keeps the label as it is (not checked on a phone; it's switched off).

### The readout (testing channel only)

On the `testing` update channel (`Updates.channel`), with a stretchy filter on, one small line shows just under the
top buttons (never on `production` or `preview`, in Expo Go or in development; it's not in the photo). For example
`1920×1440 90→270m R✓ 30fps 390×844 ok`: the camera picture's size, the camera's label → the turn drawn ("m" =
mirrored), how the turn was decided (R rule, C converter, F fixed 270) and whether the converter agrees (✓ yes,
≈ same turn but another size – normal while zoomed in, ✗ no, ? not yet), pictures per second, the view's size,
then `ok` or the problem counts: `late` (a picture over 0.1 s late), `gap` (no picture for 1 s: the plain camera
showed), `drop` (pictures the camera dropped), `oob` (dropped because it ran out of buffers), `err` (failed
pictures), `dark` (the middle of the camera picture on screen was black; the check makes the drawing thread wait
for the graphics chip, so it runs only in a screen frame with no new picture, soon after the pictures (re)start –
never twice within 2 s – and otherwise every 10 s) and `cfg` (camera set-ups
since it opened, shown above 1). Expected: selfie `… 90→270m R✓ … ok`, back `… 270→270 R✓ … ok`. What to do:
- picture right but `✗`: harmless (the converter's assumption is wrong for that camera; the rule is in charge);
- picture wrong but `✓`: set `FRAME_PLACEMENT = 'converter'` by OTA;
- `oob` above 0: set `FRAME_DELAY = 0` by OTA; if it stays, the next suspect is Skia's camera texture cache,
  which is never flushed (native: a patch to Skia and a new build);
- `gap` or `cfg` climbing while switching looks: the "stays until the camera closes" part isn't working;
- `dark` above 0: the camera itself delivered black pictures (native);
- the view size isn't the screen size in points: the size fix didn't land.

### Rules (on top of "Rules for filter code")

- **Never import `react-native-vision-camera-worklets`** anywhere: on older downloads just loading it closes the
  app. The camera's `useFrameOutput` loads it itself, and that only happens in `warp/FrameFeed.tsx`.
- **Never import `FrameFeed` for real**: only the guarded `require` in `SoftGlowCamera.tsx` (and types).
- Anything worked out from `lensLooks.ts` (like `isWarpLook`) is worked out on the main thread and handed to the
  drawing as a plain true/false: those functions aren't worklets.
- **Never give the camera a moving `zoom` or `exposure`** (a Reanimated SharedValue), on VisionCamera's
  `<Camera>`, the face detector's `<Camera>` or `useCamera`: VisionCamera then loads the worklets package too, and
  the camera crashes on every older download. Plain numbers only.
- The other camera hooks that load the package (`useDepthOutput`, `useAsyncRunner`) follow the same rule as
  `useFrameOutput`: only in `warp/FrameFeed.tsx`.
- **Never use Canvas `onSize`** for the overlay's size (it includes the pager's shrink animation): use the
  `viewSize` from SoftGlowCamera's `onLayout`.
- **Never `pixelFormat: 'native'` on iPhone** (it can deliver kinds of picture Skia can't read).
- `tests/unit/frame-guard.test.mjs` checks these (with TypeScript's own import finder and types, tried on a
  made-up file that gets each one wrong), and that `FRAME_ACCESS_AVAILABLE` is false without Nitro, without the
  new native part, on iOS 16 and on Android with the switch off.

### Tests

`tests/unit/warp-shaders.test.mjs` (compiles and runs the four GPU programs with CanvasKit on a test pattern:
nothing changes outside each warp, the inside really changes, and with two faces close together the second
face's Pixel Panic or Gigachin pass keeps the first face's warp), `frame-matrix.test.mjs` (also the iPhone rule,
the owner's numbers and a regression test for the upside-down screenshot), `feed-logic.test.mjs` (the label vote,
frame rate, 1 s stale, the error rule), `lens-diagnostics.test.mjs` (the readout), `warp-track.test.mjs`
(the bouncy mouth stays calm, the chin meter fills in about 1.1 s), `warp-looks.test.mjs` (draws with 0, 1 and 2
faces, nothing without a camera picture, the right number of numbers for each GPU program, the same moment gives
the same picture, cheap enough, and everything made from the camera picture goes on `src.trash`, also when a
frame fails halfway), `frame-guard.test.mjs` (the rules above, and how long `markFramesBroken` keeps them off),
and `lens-ui-thread.test.mjs` (the four drawn the way the phone's drawing thread does).
`tests/frontend/lens-overlay.test.cjs` checks the camera picture under the filter (full view size from
`viewSize`, no `onSize`), its mirror, that everything made from it is let go of after each frame, that each
drawing is let go of two drawings later and the last two when it closes, the JS-thread first drawing and the
look pause;
`tests/frontend/frame-feed.test.cjs` checks camera errors (this app start only, or a strike), the camera flip (a
new FrameFeed for the other camera with a stretchy filter on; the same one and output with another filter on),
that switching looks keeps the camera's outputs, that the overlay and the
photo get the same size, the readout only on `testing`, and in FrameFeed the turn and mirror of each camera, the
held label, skipped pictures, the 1 s stale rule, `inUse` (paused, everything let go of at once, nothing left in
the mailbox), the black-picture check's timing, the drop counts and the error rule. Only a phone can check the rest (docs/TESTING.md): that the picture lines up and moves the right
way, heat over a few minutes, and Android.
