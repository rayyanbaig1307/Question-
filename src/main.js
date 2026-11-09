import { VISION_BUNDLE, VISION_WASM, FACE_MODEL, DELEGATE, DEBUG, INITIAL_FILTER } from './config.js';
import { FILTERS, byId } from './filters/index.js';
import { toPixels, faceMetrics, blendMap, Smoother, FACE_OVAL } from './landmarks.js';
import { label } from './fx.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('canvas');
const ctx = canvas.getContext('2d', { alpha: false });

const ui = {
  status: $('status'),
  statusText: $('status-text'),
  startBtn: $('start-btn'),
  filterName: $('filter-name'),
  hint: $('hint'),
  meter: $('meter'),
  fps: $('fps'),
  filters: $('filters'),
  viewport: $('viewport'),
};

const app = {
  landmarker: null,
  current: null,
  mirrored: true,
  debug: DEBUG,
  running: false,
  lastVideoTime: -1,
  lastResult: null,
  lastT: performance.now(),
  frames: 0,
  fpsAcc: 0,
  fpsN: 0,
  errors: [],
  faceFrames: 0,
  // Per-filter persistent state and smoothing.
  states: new Map(),
  smoothers: new Map(),
};
// Exposed for debugging and automated tests.
window.__peekaboo = app;

// ---------------------------------------------------------------------------
// Filter picker UI

function buildFilterChips() {
  ui.filters.innerHTML = '';
  for (const filt of FILTERS) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.id = filt.id;
    b.innerHTML = `<span class="emoji">${filt.emoji}</span><span class="name">${filt.name}</span><span class="sub">${filt.hint}</span>`;
    b.addEventListener('click', () => selectFilter(filt.id));
    ui.filters.appendChild(b);
  }
}

function selectFilter(id) {
  const filt = byId(id) || FILTERS[0];
  app.current = filt;
  if (!app.states.has(filt.id)) app.states.set(filt.id, {});
  if (!app.smoothers.has(filt.id)) app.smoothers.set(filt.id, new Smoother());
  ui.filterName.textContent = filt.name;
  ui.hint.textContent = filt.hint;
  for (const chip of ui.filters.children) {
    const active = chip.dataset.id === filt.id;
    chip.classList.toggle('active', active);
    if (active) chip.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }
  const url = new URL(location.href);
  url.searchParams.set('filter', filt.id);
  history.replaceState(null, '', url);
}

function stepFilter(delta) {
  const i = FILTERS.indexOf(app.current);
  selectFilter(FILTERS[(i + delta + FILTERS.length) % FILTERS.length].id);
}

// ---------------------------------------------------------------------------
// Model + camera

async function loadModel() {
  ui.statusText.textContent = 'Loading face model…';
  const vision = await import(/* @vite-ignore */ VISION_BUNDLE);
  const fileset = await vision.FilesetResolver.forVisionTasks(VISION_WASM);
  const make = (delegate) =>
    vision.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: FACE_MODEL, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: false,
    });
  try {
    app.landmarker = await make(DELEGATE);
    app.delegate = DELEGATE;
  } catch (err) {
    if (DELEGATE === 'CPU') throw err;
    console.warn('GPU delegate failed, falling back to CPU', err);
    app.landmarker = await make('CPU');
    app.delegate = 'CPU';
  }
}

async function startCamera() {
  ui.statusText.textContent = 'Starting camera…';
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 1280 } },
    audio: false,
  });
  video.srcObject = stream;
  await new Promise((res) => {
    if (video.readyState >= 2) return res();
    video.onloadeddata = () => res();
  });
  await video.play();
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  // Let portrait/landscape cameras both fit the stage.
  ui.viewport.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
}

// ---------------------------------------------------------------------------
// Render loop

function loop() {
  if (!app.running) return;
  requestAnimationFrame(loop);

  const now = performance.now();
  const dt = Math.min(0.05, (now - app.lastT) / 1000) || 0.016;
  app.lastT = now;
  const W = canvas.width, H = canvas.height;

  // Only run inference on new video frames.
  if (video.currentTime !== app.lastVideoTime && video.readyState >= 2) {
    app.lastVideoTime = video.currentTime;
    try {
      app.lastResult = app.landmarker.detectForVideo(video, now);
    } catch (err) {
      app.errors.push(String(err));
      console.error(err);
    }
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (app.mirrored) ctx.setTransform(-1, 0, 0, 1, W, 0);
  ctx.drawImage(video, 0, 0, W, H);

  const result = app.lastResult;
  const lm = result?.faceLandmarks?.[0];
  const filt = app.current;
  let meter = 0;

  if (lm && filt) {
    app.faceFrames++;
    const pts = toPixels(lm, W, H);
    const frame = {
      ctx, video, W, H,
      mirrored: app.mirrored,
      pts,
      m: faceMetrics(pts),
      blend: blendMap(result.faceBlendshapes?.[0]?.categories),
      t: now / 1000,
      dt,
      smooth: app.smoothers.get(filt.id),
      state: app.states.get(filt.id),
    };
    try {
      ctx.save();
      filt.draw(frame);
      ctx.restore();
      meter = filt.trigger(frame);
    } catch (err) {
      ctx.restore();
      app.errors.push(`${filt.id}: ${err?.stack || err}`);
      console.error(err);
    }
    if (app.debug) drawDebug(frame);
  } else if (filt) {
    label({ ctx, W, mirrored: app.mirrored }, 'Show me your face 👀', W / 2, H * 0.1, {
      size: Math.round(W * 0.04), bg: 'rgba(0,0,0,0.5)', radius: 10,
    });
  }

  ui.meter.style.width = `${Math.round(Math.min(1, meter) * 100)}%`;

  app.frames++;
  app.fpsAcc += dt; app.fpsN++;
  if (app.fpsAcc >= 0.5) {
    ui.fps.textContent = `${Math.round(app.fpsN / app.fpsAcc)} fps · ${app.delegate}`;
    app.fpsAcc = 0; app.fpsN = 0;
  }
}

function drawDebug(f) {
  const { ctx, pts } = f;
  ctx.save();
  ctx.fillStyle = 'rgba(0,255,180,0.7)';
  for (const p of pts) ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
  ctx.strokeStyle = 'rgba(255,255,0,0.8)';
  ctx.beginPath();
  FACE_OVAL.forEach((i, k) => (k ? ctx.lineTo(pts[i].x, pts[i].y) : ctx.moveTo(pts[i].x, pts[i].y)));
  ctx.closePath(); ctx.stroke();
  ctx.restore();
  const top = Object.entries(f.blend).sort((a, b) => b[1] - a[1]).slice(0, 6);
  top.forEach(([k, v], i) => {
    label(f, `${k} ${v.toFixed(2)}`, 8, 20 + i * 18, { size: 13, align: 'left', bg: 'rgba(0,0,0,0.5)', color: '#9dffc8', radius: 4, padX: 6 });
  });
}

// ---------------------------------------------------------------------------
// Snapshot

function snapshot() {
  const flash = document.createElement('div');
  flash.className = 'flash';
  ui.viewport.appendChild(flash);
  flash.addEventListener('animationend', () => flash.remove());
  canvas.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `peekaboo-${app.current.id}-${Date.now()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, 'image/png');
}

// ---------------------------------------------------------------------------
// Boot

async function boot() {
  buildFilterChips();
  selectFilter(INITIAL_FILTER || FILTERS[0].id);

  $('prev-btn').onclick = () => stepFilter(-1);
  $('next-btn').onclick = () => stepFilter(1);
  $('snap-btn').onclick = snapshot;
  $('mirror-btn').onclick = (e) => {
    app.mirrored = !app.mirrored;
    e.currentTarget.textContent = `Mirror: ${app.mirrored ? 'on' : 'off'}`;
  };
  $('debug-btn').onclick = (e) => {
    app.debug = !app.debug;
    e.currentTarget.textContent = `Debug: ${app.debug ? 'on' : 'off'}`;
  };
  window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') stepFilter(1);
    else if (e.key === 'ArrowLeft') stepFilter(-1);
    else if (e.key === ' ') { e.preventDefault(); snapshot(); }
    else if (/^[1-9]$/.test(e.key)) selectFilter(FILTERS[Number(e.key) - 1]?.id);
  });

  try {
    await loadModel();
  } catch (err) {
    console.error(err);
    ui.status.querySelector('.spinner').remove();
    ui.statusText.textContent = `Could not load the face model: ${err?.message || err}`;
    return;
  }

  const begin = async () => {
    ui.startBtn.hidden = true;
    try {
      await startCamera();
    } catch (err) {
      console.error(err);
      ui.statusText.textContent = `Camera unavailable: ${err?.message || err}. Allow camera access and retry.`;
      ui.startBtn.hidden = false;
      ui.startBtn.textContent = 'Retry';
      return;
    }
    ui.status.hidden = true;
    app.running = true;
    app.lastT = performance.now();
    loop();
  };

  // Browsers want a user gesture before autoplay on some platforms; show a
  // Start button, but try immediately where it is permitted.
  ui.status.querySelector('.spinner')?.remove();
  ui.statusText.textContent = 'Ready. Allow camera access to start.';
  ui.startBtn.hidden = false;
  ui.startBtn.onclick = begin;
  if (navigator.mediaDevices?.getUserMedia) begin();
}

boot();
