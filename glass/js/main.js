import * as THREE from 'three';
import { RoundedBoxGeometry } from '../vendor/addons/RoundedBoxGeometry.js';
import { RoomEnvironment } from '../vendor/addons/RoomEnvironment.js';
import { groundVertex, groundFragment } from './shaders.js';
import { drawPhoto, roundRect } from './photo.js';
import { Sound } from './sound.js';

// ------------------------------------------------------------------ time and views
const params = new URLSearchParams(location.search);
const frozen = params.has('t') ? parseFloat(params.get('t')) || 0 : null;
const viewName = params.get('view');
const clockStart = performance.now();
const now = () => (frozen !== null ? frozen : (performance.now() - clockStart) / 1000);

const coarse = matchMedia('(pointer: coarse)').matches;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const isChromium = !!(navigator.userAgentData && navigator.userAgentData.brands?.some((b) => /Chrom/.test(b.brand)));

const sound = new Sound();

// ------------------------------------------------------------------ smooth scroll
const content = document.getElementById('content');
const smooth = !coarse && frozen === null;
if (smooth) document.documentElement.classList.add('smooth');
let scrollY = window.scrollY;
let smoothY = scrollY;
function sizeBody() {
  if (smooth) document.body.style.height = content.scrollHeight + 'px';
}
new ResizeObserver(sizeBody).observe(content);
document.querySelectorAll('a[href^="#"]').forEach((a) => {
  a.addEventListener('click', (e) => {
    const el = document.querySelector(a.getAttribute('href'));
    if (!el) return;
    e.preventDefault();
    window.scrollTo({ top: el.offsetTop - (a.getAttribute('href') === '#top' ? 0 : 40), behavior: smooth ? 'instant' : 'smooth' });
  });
});

// ------------------------------------------------------------------ renderer
const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
const maxDpr = Math.min(window.devicePixelRatio || 1, 2);
let dpr = maxDpr;
renderer.setPixelRatio(dpr);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 100);
camera.position.set(0, 0, 9);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
scene.environmentIntensity = 1.15;

// ------------------------------------------------------------------ the ground (full-screen shader)
const wordCanvas = document.createElement('canvas');
const wordTex = new THREE.CanvasTexture(wordCanvas);
wordTex.generateMipmaps = true;
wordTex.minFilter = THREE.LinearMipmapLinearFilter;
wordTex.colorSpace = THREE.NoColorSpace;

const dropUniform = Array.from({ length: 12 }, () => new THREE.Vector4());
const groundMat = new THREE.ShaderMaterial({
  vertexShader: groundVertex,
  fragmentShader: groundFragment,
  uniforms: {
    uView: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uScroll: { value: 0 },
    uDrops: { value: dropUniform },
    uCount: { value: 0 },
    uWord: { value: wordTex },
    uWordRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uPhone: { value: new THREE.Vector4() },
    uPhoneTilt: { value: 0 },
    uPosts: { value: null },
    uPostsScale: { value: 1200 },
  },
  depthTest: false,
  depthWrite: false,
  toneMapped: false,
});
const groundTri = new THREE.Mesh(new THREE.BufferGeometry(), groundMat);
groundTri.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
groundTri.frustumCulled = false;
groundTri.renderOrder = -1000;
scene.add(groundTri);

let view = { w: innerWidth, h: innerHeight };

async function drawWord() {
  try {
    await document.fonts.load('800 200px "Bricolage Grotesque"');
  } catch {}
  const W = 3072;
  const ctx = wordCanvas.getContext('2d');
  const font = '"Bricolage Grotesque", "Inter Tight", system-ui, sans-serif';
  ctx.font = `800 400px ${font}`;
  const m = ctx.measureText('peekaboo');
  const fontPx = (400 * (W * 0.985)) / m.width;
  ctx.font = `800 ${fontPx}px ${font}`;
  const mm = ctx.measureText('peekaboo');
  const asc = mm.actualBoundingBoxAscent, desc = mm.actualBoundingBoxDescent;
  const H = Math.ceil(asc + desc + fontPx * 0.06);
  wordCanvas.width = W;
  wordCanvas.height = H;
  const c2 = wordCanvas.getContext('2d');
  c2.fillStyle = '#000';
  c2.fillRect(0, 0, W, H);
  c2.font = `800 ${fontPx}px ${font}`;
  c2.letterSpacing = `${-fontPx * 0.045}px`;
  const m2 = c2.measureText('peekaboo');
  c2.fillStyle = '#fff';
  c2.textBaseline = 'alphabetic';
  c2.fillText('peekaboo', (W - m2.width) / 2 - mm.actualBoundingBoxLeft * 0, asc + fontPx * 0.03);
  wordTex.needsUpdate = true;
  wordAspect = H / W;
  layoutWord();
}
let wordAspect = 0.3;
function layoutWord() {
  const pad = Math.max(20, Math.min(88, view.w * 0.05));
  const w = view.w - pad * 0.6;
  const h = w * wordAspect;
  const top = view.w < 860 ? view.h * 0.16 : Math.max(86, view.h * 0.12);
  groundMat.uniforms.uWordRect.value.set((view.w - w) / 2, top, w, h);
}

// a wall of friends' posts, hidden under the white (seamless, so it can drift forever)
function buildPostsWall() {
  const S = 2048, cols = 4, gap = 40;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const bg = ctx.createLinearGradient(0, 0, S, S);
  bg.addColorStop(0, '#ff3d8e');
  bg.addColorStop(0.5, '#8a4dff');
  bg.addColorStop(1, '#38b6ff');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, S, S);
  const tw = S / cols - gap, th = tw * 1.25;
  const tile = document.createElement('canvas');
  tile.width = Math.round(tw);
  tile.height = Math.round(th);
  let v = 0;
  for (let col = 0; col < cols; col++) {
    const shift = (col % 2) * (th + gap) * 0.5;
    for (let row = -1; row < Math.ceil(S / (th + gap)) + 1; row++) {
      const x = col * (tw + gap) + gap / 2;
      const y = row * (th + gap) + shift;
      drawPhoto(tile.getContext('2d'), tile.width, tile.height, (v++ * 5 + col) % 6);
      for (const oy of [0, S]) {
        ctx.save();
        roundRect(ctx, x, y - oy, tw, th, 36);
        ctx.clip();
        ctx.drawImage(tile, x, y - oy);
        ctx.restore();
      }
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 4;
  return tex;
}
groundMat.uniforms.uPosts.value = buildPostsWall();

// ------------------------------------------------------------------ the glass phone
const phone = new THREE.Group();
scene.add(phone);

const glass = new THREE.MeshPhysicalMaterial({
  color: 0xffffff,
  metalness: 0,
  roughness: 0.03,
  transmission: 1,
  thickness: 1.4,
  ior: 1.5,
  dispersion: 0.55,
  attenuationColor: new THREE.Color(0xd6e2ff),
  attenuationDistance: 1.4,
  clearcoat: 1,
  clearcoatRoughness: 0.02,
  specularIntensity: 1,
  envMapIntensity: 1.35,
});
const PW = 1.0, PH = 2.06, PD = 0.19;
const body = new THREE.Mesh(new RoundedBoxGeometry(PW, PH, PD, 10, 0.16), glass);
phone.add(body);

// side buttons, also glass
const btnGeo = new RoundedBoxGeometry(0.03, 0.26, 0.07, 3, 0.012);
for (const [x, y, s] of [[PW / 2 + 0.008, 0.42, 1], [-PW / 2 - 0.008, 0.5, 0.55], [-PW / 2 - 0.008, 0.28, 1], [-PW / 2 - 0.008, 0.04, 1]]) {
  const b = new THREE.Mesh(btnGeo, glass);
  b.position.set(x, y, 0);
  b.scale.y = s;
  phone.add(b);
}

// the screen inside the glass
const SW = 0.8, SH = 1.8, SR = 0.1;
function roundedPlane(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  const g = new THREE.ShapeGeometry(s, 12);
  const pos = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) + w / 2) / w, (pos.getY(i) + h / 2) / h);
  return g;
}
const screenCanvas = document.createElement('canvas');
screenCanvas.width = 1032;
screenCanvas.height = 2280;
const screenTex = new THREE.CanvasTexture(screenCanvas);
screenTex.colorSpace = THREE.SRGBColorSpace;
screenTex.anisotropy = 8;
const screen = new THREE.Mesh(roundedPlane(SW, SH, SR), new THREE.MeshBasicMaterial({ map: screenTex, toneMapped: false }));
screen.position.z = 0.035;
phone.add(screen);
const panel = new THREE.Mesh(roundedPlane(SW + 0.012, SH + 0.012, SR + 0.006), new THREE.MeshBasicMaterial({ color: 0x1a1724 }));
panel.position.z = 0.03;
phone.add(panel);

// camera lenses seen through the clear back
const lensMat = new THREE.MeshPhysicalMaterial({ color: 0x0b0a12, roughness: 0.15, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.03 });
const ringMat = new THREE.MeshPhysicalMaterial({ color: 0xdedfe6, roughness: 0.25, metalness: 1 });
const lensGeo = new THREE.CylinderGeometry(0.068, 0.068, 0.02, 40);
const ringGeo = new THREE.TorusGeometry(0.075, 0.008, 10, 48);
for (const [x, y] of [[-0.27, 0.82], [-0.27, 0.62], [-0.1, 0.72]]) {
  const l = new THREE.Mesh(lensGeo, lensMat);
  l.rotation.x = Math.PI / 2;
  l.position.set(x, y, -0.07);
  phone.add(l);
  const r = new THREE.Mesh(ringGeo, ringMat);
  r.position.set(x, y, -0.06);
  phone.add(r);
}

const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(-3, 4, 5);
scene.add(key);

// the phone's screen: the Peekaboo feed with one blurred post and a finger holding to reveal it
const sharp = document.createElement('canvas');
const blurred = document.createElement('canvas');
const scratchLayer = document.createElement('canvas');
function prepScreenArt() {
  const w = 476, h = 595;
  sharp.width = blurred.width = scratchLayer.width = w;
  sharp.height = blurred.height = scratchLayer.height = h;
  drawPhoto(sharp.getContext('2d'), w, h, 0);
  const b = blurred.getContext('2d');
  b.filter = 'blur(24px) saturate(1.1)';
  b.drawImage(sharp, -30, -30, w + 60, h + 60);
  b.filter = 'none';
  b.fillStyle = 'rgba(11,11,16,0.18)';
  b.fillRect(0, 0, w, h);
}

// The app's own colours (src/theme.ts, the dark theme) so the phone looks like the real Home screen.
const APP = { bg: '#0B0B10', card: '#1E1E2A', border: '#2E2E40', text: '#FFFFFF', muted: '#A6A6BD', faint: '#6E6E86', pink: '#FF4F9A', purple: '#9B5CFF', green: '#3DDC97' };
const UI = '"Inter Tight", system-ui, sans-serif';

function ring(c, x, y, r, on) {
  if (on) {
    const g = c.createLinearGradient(x - r, y - r, x + r, y + r);
    g.addColorStop(0, APP.pink);
    g.addColorStop(1, APP.purple);
    c.strokeStyle = g;
  } else c.strokeStyle = APP.border;
  c.lineWidth = 4;
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.stroke();
}
function face(c, x, y, r, a, b2, letter) {
  const g = c.createLinearGradient(x - r, y - r, x + r, y + r);
  g.addColorStop(0, a);
  g.addColorStop(1, b2);
  c.fillStyle = g;
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = '#fff';
  c.font = `800 ${Math.round(r * 0.9)}px ${UI}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(letter, x, y + r * 0.06);
  c.textAlign = 'left';
}
// Little line icons, drawn like the app's (heart, comment, bell, chat, camera, home).
function icon(c, name, x, y, s, color, filled) {
  c.save();
  c.translate(x, y);
  c.scale(s / 24, s / 24);
  c.strokeStyle = c.fillStyle = color;
  c.lineWidth = 2;
  c.lineJoin = c.lineCap = 'round';
  c.beginPath();
  if (name === 'heart') {
    c.moveTo(12, 20.5);
    c.bezierCurveTo(4, 14.5, 2, 10.5, 2, 7.5);
    c.bezierCurveTo(2, 4.5, 4.4, 2.5, 7, 2.5);
    c.bezierCurveTo(9, 2.5, 11, 3.7, 12, 5.6);
    c.bezierCurveTo(13, 3.7, 15, 2.5, 17, 2.5);
    c.bezierCurveTo(19.6, 2.5, 22, 4.5, 22, 7.5);
    c.bezierCurveTo(22, 10.5, 20, 14.5, 12, 20.5);
  } else if (name === 'comment' || name === 'chat') {
    c.moveTo(12, 3);
    c.bezierCurveTo(6.5, 3, 2.5, 6.8, 2.5, 11.5);
    c.bezierCurveTo(2.5, 13.6, 3.3, 15.5, 4.6, 17);
    c.lineTo(3.4, 21);
    c.lineTo(7.8, 19.3);
    c.bezierCurveTo(9.1, 19.8, 10.5, 20, 12, 20);
    c.bezierCurveTo(17.5, 20, 21.5, 16.2, 21.5, 11.5);
    c.bezierCurveTo(21.5, 6.8, 17.5, 3, 12, 3);
  } else if (name === 'bell') {
    c.moveTo(5, 17);
    c.lineTo(19, 17);
    c.bezierCurveTo(17.5, 15.5, 17.5, 13, 17.5, 10.5);
    c.bezierCurveTo(17.5, 7, 15, 4.5, 12, 4.5);
    c.bezierCurveTo(9, 4.5, 6.5, 7, 6.5, 10.5);
    c.bezierCurveTo(6.5, 13, 6.5, 15.5, 5, 17);
    c.moveTo(10, 20);
    c.lineTo(14, 20);
  } else if (name === 'camera') {
    c.moveTo(4, 7.5);
    c.lineTo(7.5, 7.5);
    c.lineTo(9, 5);
    c.lineTo(15, 5);
    c.lineTo(16.5, 7.5);
    c.lineTo(20, 7.5);
    c.quadraticCurveTo(21.5, 7.5, 21.5, 9);
    c.lineTo(21.5, 18);
    c.quadraticCurveTo(21.5, 19.5, 20, 19.5);
    c.lineTo(4, 19.5);
    c.quadraticCurveTo(2.5, 19.5, 2.5, 18);
    c.lineTo(2.5, 9);
    c.quadraticCurveTo(2.5, 7.5, 4, 7.5);
    c.moveTo(15.6, 13.3);
    c.arc(12, 13.3, 3.6, 0, Math.PI * 2);
  } else if (name === 'home') {
    c.moveTo(3, 11);
    c.lineTo(12, 3);
    c.lineTo(21, 11);
    c.lineTo(21, 20.5);
    c.lineTo(14.5, 20.5);
    c.lineTo(14.5, 14.5);
    c.lineTo(9.5, 14.5);
    c.lineTo(9.5, 20.5);
    c.lineTo(3, 20.5);
    c.closePath();
  }
  if (filled) c.fill();
  c.stroke();
  c.restore();
}

// Where the scratching finger is at a moment in time (a loose figure of eight over the photo).
function fingerAt(s, w, h) {
  return [w * (0.5 + 0.33 * Math.sin(s * 1.9) * Math.cos(s * 0.45)), h * (0.5 + 0.3 * Math.sin(s * 1.25 + 0.7))];
}

function drawScreen(t) {
  const c = screenCanvas.getContext('2d');
  // drawn at twice the size so the small words stay sharp
  c.setTransform(2, 0, 0, 2, 0, 0);
  const W = screenCanvas.width / 2, H = screenCanvas.height / 2;
  c.textBaseline = 'middle';
  c.textAlign = 'left';
  c.fillStyle = APP.bg;
  c.fillRect(0, 0, W, H);

  // camera notch
  c.fillStyle = '#000';
  roundRect(c, W / 2 - 62, 18, 124, 34, 17);
  c.fill();

  // header: the wordmark (two eyes + the name), and the bell
  for (const ex of [36, 62]) {
    c.beginPath();
    c.arc(ex, 100, 11, 0, Math.PI * 2);
    c.fillStyle = '#fff';
    c.fill();
    c.beginPath();
    c.arc(ex + 3, 101, 5, 0, Math.PI * 2);
    c.fillStyle = APP.bg;
    c.fill();
  }
  c.fillStyle = APP.text;
  c.font = '800 38px "Bricolage Grotesque", system-ui, sans-serif';
  c.fillText('peekaboo', 84, 100);
  icon(c, 'bell', W - 64, 84, 32, APP.text, false);

  // story row: My Story (+), Guess Who, then friends with a glowing ring when they have a new story
  const sy = 190, sr = 37;
  const stories = [
    { name: 'My Story', a: '#38B6FF', b: '#9B5CFF', l: 'Y', on: false, plus: true },
    { name: 'Guess Who', guess: true, on: true },
    { name: 'maya', a: '#FF4F9A', b: '#9B5CFF', l: 'M', on: true },
    { name: 'jay', a: '#FF8A3D', b: '#FF4F9A', l: 'J', on: true },
    { name: 'sam', a: '#3DDC97', b: '#38B6FF', l: 'S', on: false },
  ];
  stories.forEach((st, i) => {
    const x = 58 + i * 100;
    ring(c, x, sy, sr + 6, st.on);
    if (st.guess) {
      c.fillStyle = APP.card;
      c.beginPath();
      c.arc(x, sy, sr, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = APP.text;
      c.font = `800 40px ${UI}`;
      c.textAlign = 'center';
      c.fillText('?', x, sy + 2);
      c.textAlign = 'left';
    } else face(c, x, sy, sr, st.a, st.b, st.l);
    if (st.plus) {
      c.fillStyle = APP.pink;
      c.beginPath();
      c.arc(x + 28, sy + 28, 13, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = APP.bg;
      c.lineWidth = 3;
      c.stroke();
      c.strokeStyle = '#fff';
      c.lineWidth = 3;
      c.beginPath();
      c.moveTo(x + 22, sy + 28);
      c.lineTo(x + 34, sy + 28);
      c.moveTo(x + 28, sy + 22);
      c.lineTo(x + 28, sy + 34);
      c.stroke();
    }
    c.fillStyle = st.on || st.plus ? APP.text : APP.faint;
    c.font = `600 17px ${UI}`;
    c.textAlign = 'center';
    c.fillText(st.name, x, sy + sr + 28);
    c.textAlign = 'left';
  });

  // the post card: who posted, when, and the "On time" drop badge
  const hy = 318;
  ring(c, 44, hy, 24, true);
  face(c, 44, hy, 19, '#FF4F9A', '#9B5CFF', 'M');
  c.fillStyle = APP.text;
  c.font = `700 23px ${UI}`;
  c.fillText('maya', 80, hy - 12);
  c.fillStyle = APP.muted;
  c.font = `500 17px ${UI}`;
  c.fillText('2m', 80, hy + 14);
  c.fillStyle = 'rgba(61,220,151,0.16)';
  roundRect(c, 112, hy + 2, 86, 25, 12.5);
  c.fill();
  c.fillStyle = APP.green;
  c.font = `700 15px ${UI}`;
  c.fillText('On time', 127, hy + 15);
  c.fillStyle = APP.muted;
  for (const dx of [0, 10, 20]) {
    c.beginPath();
    c.arc(W - 58 + dx, hy, 2.6, 0, Math.PI * 2);
    c.fill();
  }

  // the photo: blurred, and wiped clear where the finger has scratched
  const px = 20, py = 360, pw = W - 40, ph = pw * 1.25;
  c.save();
  roundRect(c, px, py, pw, ph, 26);
  c.clip();
  c.drawImage(blurred, px, py, pw, ph);
  const sc = scratchLayer.getContext('2d');
  sc.globalCompositeOperation = 'source-over';
  sc.clearRect(0, 0, scratchLayer.width, scratchLayer.height);
  // the last few seconds of scratching; the hand lifts every so often and the blur comes back
  const cycle = 9, local = ((t % cycle) + cycle) % cycle;
  const held = Math.min(local, 6.5);
  sc.lineCap = sc.lineJoin = 'round';
  sc.lineWidth = 104;
  sc.strokeStyle = '#000';
  sc.globalAlpha = local > 7.2 ? Math.max(0, 1 - (local - 7.2) / 1.2) : 1;
  sc.beginPath();
  const base = t - local;
  for (let s = 0; s <= held; s += 0.06) {
    const [x, y] = fingerAt(base * 0.37 + s, scratchLayer.width, scratchLayer.height);
    if (s === 0) sc.moveTo(x, y);
    else sc.lineTo(x, y);
  }
  sc.stroke();
  sc.globalAlpha = 1;
  sc.globalCompositeOperation = 'source-in';
  sc.drawImage(sharp, 0, 0);
  c.drawImage(scratchLayer, px, py, pw, ph);
  // the fingertip
  if (local < 6.5) {
    const [fx0, fy0] = fingerAt(base * 0.37 + held, scratchLayer.width, scratchLayer.height);
    const fx = px + fx0, fy = py + fy0;
    const g = c.createRadialGradient(fx, fy, 2, fx, fy, 40);
    g.addColorStop(0, 'rgba(255,255,255,0.75)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.22)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.beginPath();
    c.arc(fx, fy, 40, 0, Math.PI * 2);
    c.fill();
  }
  // the app's hint
  c.fillStyle = 'rgba(0,0,0,0.55)';
  roundRect(c, px + pw / 2 - 138, py + ph - 68, 276, 46, 23);
  c.fill();
  c.fillStyle = '#fff';
  c.font = `700 19px ${UI}`;
  c.textAlign = 'center';
  c.fillText('Hold & scratch to reveal', px + pw / 2, py + ph - 44);
  c.textAlign = 'left';
  c.restore();

  // like and comment
  const ay = py + ph + 18;
  icon(c, 'heart', 28, ay, 34, APP.text, false);
  icon(c, 'comment', 84, ay + 1, 32, APP.text, false);

  // the bar at the bottom: Chat · Camera · Home
  const by = H - 104;
  c.fillStyle = APP.bg;
  c.fillRect(0, by, W, 104);
  c.fillStyle = APP.border;
  c.fillRect(0, by, W, 1.5);
  [['chat', 'Chat'], ['camera', 'Camera'], ['home', 'Home']].forEach(([name, label], i) => {
    const x = W * (0.5 + (i - 1) * 0.31), on = i === 2;
    const col = on ? APP.pink : APP.muted;
    icon(c, name, x - 16, by + 16, 32, col, on);
    c.fillStyle = col;
    c.font = `${on ? 800 : 600} 15px ${UI}`;
    c.textAlign = 'center';
    c.fillText(label, x, by + 66);
    c.textAlign = 'left';
  });
  screenTex.needsUpdate = true;
}

// ------------------------------------------------------------------ drops
const pointer = { x: -9999, y: -9999, sx: 0, sy: 0, active: false, last: 0 };
addEventListener('pointermove', (e) => {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  if (!pointer.active) { pointer.sx = e.clientX; pointer.sy = e.clientY; }
  pointer.active = true;
  pointer.last = performance.now();
}, { passive: true });

// Each drop drifts on its own slow path; pairs pass close so they merge and split again.
const dropDefs = [
  { bx: 0.18, by: 0.32, ax: 0.10, ay: 0.08, fx: 0.11, fy: 0.15, p: 0.0, r: 0.105 },
  { bx: 0.30, by: 0.30, ax: 0.08, ay: 0.06, fx: 0.13, fy: 0.09, p: 2.1, r: 0.07 },
  { bx: 0.55, by: 0.22, ax: 0.14, ay: 0.06, fx: 0.07, fy: 0.12, p: 4.0, r: 0.085 },
  { bx: 0.48, by: 0.42, ax: 0.10, ay: 0.08, fx: 0.10, fy: 0.08, p: 1.0, r: 0.055 },
  { bx: 0.82, by: 0.30, ax: 0.07, ay: 0.10, fx: 0.09, fy: 0.13, p: 5.2, r: 0.075 },
  { bx: 0.12, by: 0.78, ax: 0.08, ay: 0.06, fx: 0.08, fy: 0.11, p: 3.3, r: 0.065 },
  { bx: 0.40, by: 0.80, ax: 0.12, ay: 0.06, fx: 0.06, fy: 0.10, p: 0.7, r: 0.045 },
  { bx: 0.70, by: 0.75, ax: 0.10, ay: 0.07, fx: 0.12, fy: 0.07, p: 2.9, r: 0.06 },
  { bx: 0.92, by: 0.62, ax: 0.05, ay: 0.12, fx: 0.10, fy: 0.06, p: 4.6, r: 0.05 },
  { bx: 0.62, by: 0.36, ax: 0.05, ay: 0.05, fx: 0.15, fy: 0.17, p: 1.7, r: 0.032 },
  { bx: 0.27, by: 0.55, ax: 0.06, ay: 0.05, fx: 0.16, fy: 0.12, p: 3.9, r: 0.028 },
];
const mouseDrop = { x: 0, y: 0, r: 0, vx: 0, vy: 0, init: false };
let lastMerge = new Map();

function updateDrops(t, dt) {
  const m = Math.min(view.w, view.h);
  const small = view.w < 860;
  const list = [];
  const defs = small ? dropDefs.slice(0, 8) : dropDefs;
  const scale = small ? 1.45 : 1.0;
  defs.forEach((d, i) => {
    const s = t * (reduced ? 0.25 : 1);
    const x = (d.bx + d.ax * Math.sin(s * d.fx * 2.0 + d.p) + 0.03 * Math.sin(s * 0.31 + i)) * view.w;
    const y = (d.by + d.ay * Math.cos(s * d.fy * 2.0 + d.p * 1.3) + 0.02 * Math.cos(s * 0.27 + i * 2)) * view.h;
    const r = d.r * m * scale * (1 + 0.06 * Math.sin(s * 0.8 + d.p));
    list.push([x, y, r, d.p * 3.1]);
  });
  // the drop you steer with the mouse (it wanders on its own until you move)
  const idle = !pointer.active || performance.now() - pointer.last > 6000;
  const tx = idle ? view.w * (0.5 + 0.3 * Math.sin(t * 0.21)) : pointer.x;
  const ty = idle ? view.h * (0.36 + 0.14 * Math.sin(t * 0.33 + 1.0)) : pointer.y;
  if (!mouseDrop.init) { mouseDrop.x = tx; mouseDrop.y = ty; mouseDrop.init = true; }
  if (frozen !== null && idle) { mouseDrop.x = tx; mouseDrop.y = ty; }
  else {
    // a soft spring, so it trails behind the cursor like a heavy drop
    const k = 26, damp = 9;
    mouseDrop.vx += ((tx - mouseDrop.x) * k - mouseDrop.vx * damp) * dt;
    mouseDrop.vy += ((ty - mouseDrop.y) * k - mouseDrop.vy * damp) * dt;
    mouseDrop.x += mouseDrop.vx * dt;
    mouseDrop.y += mouseDrop.vy * dt;
  }
  const speed = Math.hypot(mouseDrop.vx, mouseDrop.vy);
  const targetR = m * (small ? 0.13 : 0.095) * (1 + Math.min(speed / 4000, 0.15));
  mouseDrop.r += (targetR - mouseDrop.r) * Math.min(1, dt * 6);
  list.push([mouseDrop.x, mouseDrop.y, mouseDrop.r, 1.234]);

  // a soft glass "tink" when two drops touch
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const touching = Math.hypot(a[0] - b[0], a[1] - b[1]) < (a[2] + b[2]) * 0.92;
      const key2 = i * 32 + j;
      if (touching && !lastMerge.get(key2)) sound.tink((a[2] + b[2]) / m);
      lastMerge.set(key2, touching);
    }
  }
  groundMat.uniforms.uCount.value = list.length;
  list.forEach((d, i) => dropUniform[i].set(d[0], d[1], d[2], d[3]));
}

// ------------------------------------------------------------------ glass that bends what's behind it
const defs = document.getElementById('filters');
const SVGNS = 'http://www.w3.org/2000/svg';
function bendMap(w, h, radius, bezel) {
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(w));
  c.height = Math.max(2, Math.round(h));
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(c.width, c.height);
  const r = Math.min(radius, w / 2, h / 2);
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      // distance from the edge of a rounded box, and which way the edge faces
      const px = x + 0.5 - w / 2, py = y + 0.5 - h / 2;
      const qx = Math.abs(px) - (w / 2 - r), qy = Math.abs(py) - (h / 2 - r);
      const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
      const outside = Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
      const e = -outside; // depth into the glass
      let nx = 0, ny = 0;
      if (qx > 0 && qy > 0) { const l = Math.hypot(qx, qy) || 1; nx = qx / l; ny = qy / l; }
      else if (qx > qy) nx = 1; else ny = 1;
      nx *= Math.sign(px); ny *= Math.sign(py);
      const a = e < bezel ? Math.pow(1 - Math.max(e, 0) / bezel, 2.2) : 0;
      const i = (y * c.width + x) * 4;
      img.data[i] = 128 - nx * a * 127;
      img.data[i + 1] = 128 - ny * a * 127;
      img.data[i + 2] = 128;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL();
}
let filterId = 0;
function makeBend(el) {
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
  const id = el.dataset.filterId || `bend${filterId++}`;
  el.dataset.filterId = id;
  let f = document.getElementById(id);
  if (!f) {
    f = document.createElementNS(SVGNS, 'filter');
    f.id = id;
    f.setAttribute('color-interpolation-filters', 'sRGB');
    f.setAttribute('x', '0');
    f.setAttribute('y', '0');
    f.setAttribute('width', '100%');
    f.setAttribute('height', '100%');
    defs.appendChild(f);
  }
  const bezel = Math.min(28, Math.min(rect.width, rect.height) * 0.42);
  const strength = el.dataset.bend === 'card' ? 46 : 34;
  f.innerHTML = `
    <feImage href="${bendMap(rect.width, rect.height, radius, bezel)}" x="0" y="0" width="${rect.width}" height="${rect.height}" result="map" preserveAspectRatio="none"/>
    <feDisplacementMap in="SourceGraphic" in2="map" scale="${strength}" xChannelSelector="R" yChannelSelector="G" result="bent"/>
    <feGaussianBlur in="bent" stdDeviation="${el.dataset.bend === 'card' ? 7 : 3}" />`;
  el.style.backdropFilter = `url(#${id}) saturate(1.75) brightness(1.05)`;
}
function makeAllBends() {
  if (!isChromium) return;
  document.querySelectorAll('.bend').forEach(makeBend);
}

// ------------------------------------------------------------------ type that comes into focus
const warpEls = [...document.querySelectorAll('.warp-type')].map((el, i) => {
  const f = document.createElementNS(SVGNS, 'filter');
  f.id = `warp${i}`;
  f.setAttribute('x', '-10%');
  f.setAttribute('y', '-20%');
  f.setAttribute('width', '120%');
  f.setAttribute('height', '140%');
  f.innerHTML = `
    <feTurbulence type="fractalNoise" baseFrequency="0.006 0.018" numOctaves="2" seed="${i * 7 + 3}" result="n"/>
    <feDisplacementMap in="SourceGraphic" in2="n" scale="0" xChannelSelector="R" yChannelSelector="G" result="d"/>
    <feGaussianBlur in="d" stdDeviation="0"/>`;
  defs.appendChild(f);
  return { el, disp: f.querySelector('feDisplacementMap'), blur: f.querySelector('feGaussianBlur'), turb: f.querySelector('feTurbulence'), last: -1 };
});
function updateWarp(t) {
  for (const w of warpEls) {
    const r = w.el.getBoundingClientRect();
    const mid = (r.top + r.height / 2) / view.h;
    // below the middle of the screen the words sit behind thick glass; they sharpen as they rise
    let a = Math.min(1, Math.max(0, (mid - 0.5) / 0.42));
    a = a * a * (3 - 2 * a);
    if (Math.abs(a - w.last) < 0.004) continue;
    w.last = a;
    if (a < 0.01) { w.el.style.filter = 'none'; continue; }
    w.disp.setAttribute('scale', (a * 90).toFixed(1));
    w.blur.setAttribute('stdDeviation', (a * 7).toFixed(2));
    w.turb.setAttribute('baseFrequency', `${(0.006 + a * 0.002).toFixed(4)} ${(0.018 - a * 0.004).toFixed(4)}`);
    w.el.style.filter = `url(#${w.el.dataset.f || (w.el.dataset.f = w.disp.parentNode.id)})`;
    w.el.style.opacity = (1 - a * 0.55).toFixed(3);
  }
}

// ------------------------------------------------------------------ dares marquee (dares from the app)
const DARES = [
  'Read your last 5 searches out loud on camera',
  'Do 2 minutes of stand-up for your friends, no notes',
  'Let a friend pick your phone wallpaper for a week',
  'Give everyone in the group chat a superhero name and a power',
  'Order your food in your best movie-trailer voice',
  'Sing a whole song out loud somewhere busy',
  'Let a friend write a word on your arm in marker',
  'Do your best runway walk through a busy park',
  'Show your screen time report to the group',
  'Wear an outfit your friends pick out for an hour',
];
function fillRow(el, items) {
  const html = items.map((d) => `<span class="dare glass-soft"><b>Dare</b>${d}</span>`).join('');
  el.innerHTML = html + html;
}
const rowA = document.getElementById('dareRowA');
const rowB = document.getElementById('dareRowB');
fillRow(rowA, DARES.slice(0, 5));
fillRow(rowB, DARES.slice(5));

// ------------------------------------------------------------------ hold to reveal demo
const rc = document.getElementById('revealCanvas');
const rctx = rc.getContext('2d');
const rSharp = document.createElement('canvas');
const rBlur = document.createElement('canvas');
const rMask = document.createElement('canvas');
const rTmp = document.createElement('canvas');
const pct = document.getElementById('revealPct');
const hint = document.getElementById('postHint');
const hold = { down: false, x: 0, y: 0, since: 0, touched: false, lastX: null, lastY: null, last: 0, lastMove: 0 };
function sizeReveal() {
  const r = rc.getBoundingClientRect();
  const s = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(10, Math.round(r.width * s)), h = Math.max(10, Math.round(r.height * s));
  if (rc.width === w && rc.height === h) return;
  for (const c of [rc, rSharp, rBlur, rMask, rTmp]) { c.width = w; c.height = h; }
  drawPhoto(rSharp.getContext('2d'), w, h, 1);
  const b = rBlur.getContext('2d');
  b.filter = `blur(${Math.round(w * 0.045)}px) saturate(1.2)`;
  b.drawImage(rSharp, -w * 0.08, -h * 0.08, w * 1.16, h * 1.16);
  b.filter = 'none';
  b.fillStyle = 'rgba(255,255,255,0.12)';
  b.fillRect(0, 0, w, h);
}
function stamp(x, y, rad, strength = 1) {
  const m = rMask.getContext('2d');
  const g = m.createRadialGradient(x, y, 0, x, y, rad);
  g.addColorStop(0, `rgba(0,0,0,${strength})`);
  g.addColorStop(0.6, `rgba(0,0,0,${strength * 0.85})`);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  m.fillStyle = g;
  m.beginPath();
  m.arc(x, y, rad, 0, Math.PI * 2);
  m.fill();
}
function brush(x, y, rad) {
  if (hold.lastX !== null) {
    const dx = x - hold.lastX, dy = y - hold.lastY, dist = Math.hypot(dx, dy);
    const steps = Math.ceil(dist / (rad * 0.25));
    for (let i = 1; i <= steps; i++) stamp(hold.lastX + (dx * i) / steps, hold.lastY + (dy * i) / steps, rad, 0.5);
  } else stamp(x, y, rad, 0.5);
  hold.lastX = x;
  hold.lastY = y;
}
function toCanvas(e) {
  const r = rc.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * rc.width, ((e.clientY - r.top) / r.height) * rc.height];
}
rc.addEventListener('pointerdown', (e) => {
  rc.setPointerCapture(e.pointerId);
  [hold.x, hold.y] = toCanvas(e);
  hold.down = true;
  hold.touched = true;
  hold.since = performance.now();
  hold.lastX = null;
  hint.style.opacity = '0';
  sound.swish(true);
});
rc.addEventListener('pointermove', (e) => { if (hold.down) [hold.x, hold.y] = toCanvas(e); });
const release = () => { if (hold.down) sound.swish(false); hold.down = false; hold.lastX = null; hold.lastMove = performance.now(); };
rc.addEventListener('pointerup', release);
rc.addEventListener('pointercancel', release);

let revealFrame = 0;
function updateReveal(t, dt) {
  const r = rc.getBoundingClientRect();
  if (r.bottom < -50 || r.top > view.h + 50) return;
  sizeReveal();
  const w = rc.width, h = rc.height;
  const m = rMask.getContext('2d');
  // the ghost finger shows how it works until you try it yourself
  let gx = null, gy = null;
  if (!hold.touched) {
    const s = t * 0.7;
    gx = w * (0.5 + 0.3 * Math.sin(s * 1.3) * Math.cos(s * 0.4));
    gy = h * (0.5 + 0.28 * Math.sin(s * 0.9 + 0.6));
    hold.lastX = hold.lastX ?? gx;
    hold.lastY = hold.lastY ?? gy;
    brush(gx, gy, w * 0.13);
  } else if (hold.down) {
    const held = (performance.now() - hold.since) / 1000;
    brush(hold.x, hold.y, w * (0.08 + Math.min(held, 0.8) * 0.08));
  }
  // let go and the blur slowly comes back
  if (!hold.down) {
    m.globalCompositeOperation = 'destination-out';
    m.fillStyle = `rgba(0,0,0,${Math.min(0.06, dt * (hold.touched ? 0.9 : 1.6))})`;
    m.fillRect(0, 0, w, h);
    m.globalCompositeOperation = 'source-over';
  }
  rctx.globalCompositeOperation = 'source-over';
  rctx.drawImage(rBlur, 0, 0);
  const tc = rTmp.getContext('2d');
  tc.globalCompositeOperation = 'source-over';
  tc.clearRect(0, 0, w, h);
  tc.drawImage(rMask, 0, 0);
  tc.globalCompositeOperation = 'source-in';
  tc.drawImage(rSharp, 0, 0);
  rctx.drawImage(rTmp, 0, 0);
  // the finger
  const fx = hold.down ? hold.x : gx, fy = hold.down ? hold.y : gy;
  if (fx !== null) {
    const g = rctx.createRadialGradient(fx, fy, 0, fx, fy, w * 0.06);
    g.addColorStop(0, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.18)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    rctx.fillStyle = g;
    rctx.beginPath();
    rctx.arc(fx, fy, w * 0.06, 0, Math.PI * 2);
    rctx.fill();
    rctx.strokeStyle = 'rgba(255,255,255,0.8)';
    rctx.lineWidth = Math.max(1.5, w * 0.004);
    rctx.beginPath();
    rctx.arc(fx, fy, w * 0.035, 0, Math.PI * 2);
    rctx.stroke();
  }
  if (++revealFrame % 12 === 0) {
    const s = rTmp.getContext('2d');
    const sw = 40, sh = 50;
    s.globalCompositeOperation = 'copy';
    s.drawImage(rMask, 0, 0, sw, sh);
    const data = s.getImageData(0, 0, sw, sh).data;
    let sum = 0;
    for (let i = 3; i < data.length; i += 4) sum += data[i];
    pct.textContent = Math.min(100, Math.round((sum / (sw * sh * 255)) * 100));
    s.globalCompositeOperation = 'source-over';
  }
  if (hold.touched && !hold.down && performance.now() - hold.lastMove > 4000) hint.style.opacity = '1';
}

// little "hold" demo on the third card in how it works
const holdArt = document.querySelector('.art-hold');

// ------------------------------------------------------------------ sound control
const soundBtn = document.querySelector('.sound');
soundBtn.addEventListener('click', async () => {
  const on = await sound.toggle();
  soundBtn.setAttribute('aria-pressed', String(on));
  soundBtn.querySelector('.sound-label').textContent = on ? 'Sound on' : 'Enable sound';
});
document.querySelectorAll('.btn, .nav-links a, .row').forEach((el) => el.addEventListener('pointerenter', () => sound.tick()));

// ------------------------------------------------------------------ layout
function resize() {
  view = { w: innerWidth, h: innerHeight };
  renderer.setSize(view.w, view.h, false);
  camera.aspect = view.w / view.h;
  camera.updateProjectionMatrix();
  groundMat.uniforms.uView.value.set(view.w, view.h);
  groundMat.uniforms.uPostsScale.value = Math.min(1500, Math.max(760, view.w * 0.78));
  layoutWord();
  sizeBody();
  makeAllBends();
}
addEventListener('resize', resize);

// world units per CSS pixel at the phone's depth
function pxToWorld() {
  const hWorld = 2 * camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  return hWorld / view.h;
}

const downloadEl = document.getElementById('download');
const heroEl = document.getElementById('top');
const tmpV = new THREE.Vector3();
function placePhone(t, dt) {
  const u = pxToWorld();
  const small = view.w < 860;
  const scrollP = smoothY;
  // two places for the phone: in the hero, and back again at the download section
  const dlTop = downloadEl.offsetTop;
  const useDownload = scrollP > (heroEl.offsetHeight + dlTop) / 2;
  let sx, sy, scale, spin;
  if (!useDownload) {
    sx = small ? view.w * 0.62 : view.w * 0.72;
    const baseY = small ? view.h * 0.42 : view.h * 0.52;
    sy = baseY - scrollP * 0.78;
    scale = small ? 0.42 : 1.0;
    spin = scrollP / view.h;
  } else {
    // it peeks up from the bottom of the screen, under the button
    sx = view.w * 0.5;
    sy = dlTop + downloadEl.offsetHeight - scrollP + view.h * (small ? 0.12 : 0.22);
    scale = small ? 0.8 : 1.12;
    spin = (scrollP - dlTop) / view.h;
  }
  const mx = pointer.active ? (pointer.x / view.w - 0.5) : 0.18 * Math.sin(t * 0.3);
  const my = pointer.active ? (pointer.y / view.h - 0.5) : 0.1 * Math.sin(t * 0.23);
  phone.position.set((sx - view.w / 2) * u, -(sy - view.h / 2) * u + Math.sin(t * 0.9) * 0.04, 0);
  phone.scale.setScalar(scale * (view.h < 700 ? 0.85 : 1));
  phone.rotation.set(
    0.08 + my * 0.22 + Math.sin(t * 0.5) * 0.04,
    -0.5 + spin * 1.45 + mx * 0.45 + Math.sin(t * 0.35) * 0.12,
    -0.07 + Math.sin(t * 0.4) * 0.02,
  );
  phone.visible = sy > -view.h * 0.6 && sy < view.h * 1.6;
  // where its shadow falls on the ground
  if (phone.visible) {
    const hw = (PW / 2) * phone.scale.x, hh = (PH / 2) * phone.scale.x;
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const [x, y] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) {
      tmpV.set(x / phone.scale.x, y / phone.scale.x, 0);
      phone.localToWorld(tmpV);
      tmpV.project(camera);
      const px = (tmpV.x * 0.5 + 0.5) * view.w, py = (-tmpV.y * 0.5 + 0.5) * view.h;
      minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    }
    groundMat.uniforms.uPhone.value.set(minX, minY, maxX - minX, maxY - minY);
  } else groundMat.uniforms.uPhone.value.set(0, 0, 0, 0);
}

// ------------------------------------------------------------------ the loop
let last = performance.now();
let ema = 16;
let slowFrames = 0, fastFrames = 0;
let screenFrame = 0;
const stats = { frames: 0, ms: 0 };
window.__stats = stats;

function frame() {
  const nowMs = performance.now();
  const dt = Math.min(0.05, (nowMs - last) / 1000);
  last = nowMs;
  const t = now();

  // smooth scroll
  scrollY = window.scrollY;
  if (smooth) {
    smoothY += (scrollY - smoothY) * (1 - Math.exp(-dt * 7.5));
    if (Math.abs(scrollY - smoothY) < 0.05) smoothY = scrollY;
    content.style.transform = `translate3d(0, ${-smoothY.toFixed(2)}px, 0)`;
  } else smoothY = scrollY;

  groundMat.uniforms.uTime.value = t;
  groundMat.uniforms.uScroll.value = smoothY;
  updateDrops(t, dt);
  placePhone(t, dt);
  if (phone.visible && (frozen !== null || ++screenFrame % 2 === 0 || screenFrame < 3)) drawScreen(t);
  updateWarp(t);
  updateReveal(t, dt);
  if (holdArt) {
    holdArt.style.setProperty('--hx', `${50 + 26 * Math.sin(t * 0.9)}%`);
    holdArt.style.setProperty('--hy', `${50 + 22 * Math.sin(t * 0.7 + 1)}%`);
  }
  rowA.style.transform = `translate3d(${-((t * 38 + smoothY * 0.25) % (rowA.scrollWidth / 2))}px,0,0)`;
  rowB.style.transform = `translate3d(${-(rowB.scrollWidth / 2) + ((t * 32 + smoothY * 0.2) % (rowB.scrollWidth / 2))}px,0,0)`;

  renderer.render(scene, camera);

  // keep it smooth: lower the internal resolution when frames take too long
  ema = ema * 0.92 + (nowMs - (frame.prev || nowMs - 16)) * 0.08;
  frame.prev = nowMs;
  stats.frames++;
  stats.ms = ema;
  if (frozen === null) {
    if (ema > 21) { if (++slowFrames > 30 && dpr > 0.5) { dpr = Math.max(0.5, dpr * 0.85); renderer.setPixelRatio(dpr); renderer.setSize(view.w, view.h, false); slowFrames = 0; } }
    else slowFrames = 0;
    if (ema < 13) { if (++fastFrames > 180 && dpr < maxDpr) { dpr = Math.min(maxDpr, dpr * 1.1); renderer.setPixelRatio(dpr); renderer.setSize(view.w, view.h, false); fastFrames = 0; } }
    else fastFrames = 0;
  }
  stats.dpr = dpr;
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ start
prepScreenArt();
resize();
drawScreen(0);
drawWord().then(() => { prepScreenArt(); });
document.fonts.ready.then(() => { makeAllBends(); sizeBody(); });
if (viewName) {
  const el = document.querySelector(`[data-view="${viewName}"]`);
  if (el) {
    const y = el.offsetTop;
    window.scrollTo(0, y);
    smoothY = scrollY = y;
    if (!smooth) document.documentElement.scrollTop = y;
  }
}
requestAnimationFrame(frame);
