# Peekaboo 👀 — Face Filter Concepts

Real-time webcam face filters that run entirely in the browser. Face tracking
comes from [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker)
(478 landmarks + 52 expression blendshapes); every effect is drawn with the
Canvas 2D API. No build step, no backend, nothing leaves the device.

## The filters

| # | Filter | Trigger | What happens |
|---|--------|---------|--------------|
| 1 | **Peekaboo Eyes** | Raise your brows | Giant glossy googly eyes pop out of your sockets; pupils follow your real gaze and wobble when you move |
| 2 | **Tiny Face** | Just talk | Your features shrink into the middle of a smooth egg-head; talking makes them even smaller |
| 3 | **Gigachin** | Pout to power up | The lower face stretches into a chiselled mega-chin while a power meter charges to `GIGACHIN` |
| 4 | **Brain Buffering** | Hold still | A loading spinner buffers your brain to 100 %; moving stalls it and drains progress |
| 5 | **Crybaby** | Squint for tears | Fountains of cartoon tears gush from both eyes with puffy red under-eyes |
| 6 | **Big Mouth** | Open wide | Your mouth balloons to cartoon size with a bouncy spring |
| 7 | **Aura Overload** | Open your mouth | Glowing eyes, a crackling lightning halo, orbiting stars and a purple screen bloom |
| 8 | **Heart Eyes** | Blow a kiss | Pink hearts over your eyes, anime blush, and a stream of floating hearts from your lips |
| 9 | **Pixel Panic** | Raise your brows | Your face corrupts into heavy pixels, glitch tears, magenta data bars and a flashing `ERROR` tag |

## Run it

```bash
npm install
npm start
```

Open <http://localhost:8080>, allow camera access, and pick a filter from the
strip below the viewfinder.

- `←` / `→` or `1`–`9` switch filters, `space` takes a photo (downloads a PNG).
- **Mirror** flips the preview; **Debug** overlays landmarks and the top blendshapes.
- Query options: `?filter=heart-eyes` opens a filter directly,
  `?delegate=cpu` forces CPU inference, `?vision=local` serves MediaPipe from
  `node_modules` instead of the jsDelivr CDN (handy offline or behind a proxy).

Because it is plain static files, any static host works too. Camera access
requires HTTPS or `localhost`.

## Project layout

```
index.html              page shell + HUD
styles.css              purple/pink Peekaboo theme
src/main.js             camera, model loading, render loop, UI, snapshots
src/config.js           CDN/model URLs and query-string options
src/landmarks.js        landmark indices, face metrics, blendshape map, smoothing
src/fx.js               shared drawing helpers (feathered region warp, particles, shapes, upright text)
src/filters/*.js        one module per filter
src/filters/index.js    filter registry (order = concept sheet order)
scripts/serve.mjs       zero-dependency dev server
scripts/test-filters.mjs headless smoke test (Playwright + fake webcam)
scripts/make-fixtures.sh builds y4m fake-webcam clips from test-fixtures/*.png
```

### Filter module contract

```js
export default {
  id: 'my-filter',          // stable id used in the URL and UI
  name: 'My Filter',
  hint: 'Wink',             // what the user should do
  emoji: '😉',
  trigger(frame) { ... },   // 0..1, drives the HUD meter
  draw(frame)    { ... },   // paint on top of the already-drawn video frame
};
```

`frame` carries `ctx`, `video`, `W`, `H`, `mirrored`, `pts` (landmarks in
pixels), `m` (derived metrics: eye centres, face width/height, roll, mouth…),
`blend` (blendshape name → score), `t`, `dt`, a per-filter `smooth`er and a
persistent `state` object. Register the module in `src/filters/index.js`.

Warps (Tiny Face, Gigachin, Big Mouth, Pixel Panic) use `warpRegion()` in
`src/fx.js`: it copies a rectangle of the video, scales it about an anchor,
optionally pixelates it, feathers the edge with an elliptical mask and
composites it back.

## Testing

```bash
npm install
./scripts/make-fixtures.sh                       # needs ffmpeg
node scripts/test-filters.mjs test-fixtures/neutral.y4m test-output/neutral
node scripts/test-filters.mjs test-fixtures/bigmouth.y4m test-output/bigmouth
node scripts/test-filters.mjs test-fixtures/pout.y4m test-output/pout
```

The test feeds a still image to Chromium as a fake webcam, cycles through every
filter, fails on any runtime error, and writes a screenshot per filter so you
can eyeball the result. Fixtures are crops of the concept sheet: `neutral`
(brain-buffering card), `bigmouth` (open wide), `pout` (gigachin), `kiss`,
`aura`.

## Browser support

Chrome, Edge, Safari 16.4+ and Firefox on desktop and mobile. GPU inference is
used when WebGL is available and falls back to CPU otherwise.
