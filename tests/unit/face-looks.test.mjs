import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';

// The face filters (src/components/lens/lensPaint.ts), drawn on a pretend canvas that writes down every circle
// and sparkle. The owner (5 Nov): Golden Hour is "perfect, just add more sparkles"; Soft Glow should be golden
// and "majestic", lit on the whole face, not only one side.

function compile(path, mods) {
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, Math, require: (id) => { if (id in mods) return mods[id]; throw new Error(`missing ${id}`); } });
  return module.exports;
}

function load() {
  const paths = [];
  const skia = {
    BlurStyle: { Normal: 0, Solid: 1 }, ClipOp: { Intersect: 1 }, FillType: { EvenOdd: 1 }, PaintStyle: { Stroke: 1 }, TileMode: { Clamp: 0 },
    Skia: {
      Paint: () => { const p = { alpha: 1, color: '' }; return Object.assign(p, { setAntiAlias() {}, setColor(c) { p.color = c; }, setAlphaf(a) { p.alpha = a; }, setMaskFilter() {}, setShader() {}, setStyle() {}, setStrokeWidth() {} }); },
      Color: (c) => c,
      XYWHRect: (x, y, w, h) => ({ x, y, w, h }),
      PathBuilder: { Make: () => { const shape = { moves: [] }; return { setFillType() {}, moveTo: (x, y) => shape.moves.push([x, y]), lineTo() {}, quadTo() {}, close() {}, detach: () => { paths.push(shape); return shape; } }; } },
      MaskFilter: { MakeBlur: () => ({}) },
      Shader: { MakeRadialGradient: () => ({}), MakeLinearGradient: () => ({}) },
    },
  };
  const MESH = compile('src/lib/faceMesh.ts', { react: {}, 'react-native': { TurboModuleRegistry: { get: () => null } } }).MESH;
  const golden = compile('src/lib/goldenLight.ts', {});
  const lens = compile('src/components/lens/lensPaint.ts', { '@shopify/react-native-skia': skia, '@/lib/faceMesh': { MESH }, '@/lib/goldenLight': golden });
  // A face in the middle of a 400 × 800 view, symmetric left to right (x = 200 is the middle).
  const pts = new Array(478 * 2).fill(0);
  const set = (i, x, y) => { pts[i * 2] = x; pts[i * 2 + 1] = y; };
  const ring = (ids, cx, cy, rx, ry) => ids.forEach((id, k) => { const a = -Math.PI / 2 + (k / ids.length) * Math.PI * 2; set(id, cx + rx * Math.cos(a), cy + ry * Math.sin(a)); });
  ring(MESH.faceOval, 200, 400, 100, 130);
  ring(MESH.leftEye, 240, 370, 20, 8); ring(MESH.rightEye, 160, 370, 20, 8);
  ring(MESH.leftBrow, 240, 345, 26, 5); ring(MESH.rightBrow, 160, 345, 26, 5);
  ring(MESH.lips, 200, 460, 35, 14);
  for (const [key, x, y] of [['leftIris', 240, 370], ['leftIrisEdge', 247, 370], ['rightIris', 160, 370], ['rightIrisEdge', 167, 370],
    ['leftCheek', 255, 420], ['rightCheek', 145, 420], ['leftFaceSide', 300, 400], ['rightFaceSide', 100, 400], ['leftTemple', 285, 350],
    ['rightTemple', 115, 350], ['leftCheekbone', 270, 400], ['rightCheekbone', 130, 400], ['noseTip', 200, 420], ['chin', 200, 530], ['forehead', 200, 270]]) set(MESH[key], x, y);
  const face = { pts, blinkLeft: 0, blinkRight: 0, smile: 0, light: golden.LIGHT_SPOTS.map(() => 0.5), rim: 0.6 };
  const draw = (look, time) => {
    const circles = [];
    paths.length = 0;
    const canvas = { drawRect() {}, drawPath() {}, save() {}, restore() {}, clipPath() {}, drawCircle: (x, y, r, paint) => circles.push({ x, y, r, color: paint.color, alpha: paint.alpha }) };
    lens.paintLook(canvas, look, [face], 400, 800, time);
    // Sparkles: each four-pointed star starts at its top point (moveTo) – count them across every path.
    const stars = paths.flatMap((p) => p.moves).length;
    return { circles, stars };
  };
  return { draw };
}

it('both looks draw without errors at many moments (the twinkles change over time)', () => {
  const { draw } = load();
  for (const look of ['glow', 'golden']) for (let t = 0; t < 12; t += 0.37) expect(() => draw(look, t)).not.toThrow();
});

it('Soft Glow lights both sides of the face the same: its golden highlights come in mirrored pairs', () => {
  const { draw } = load();
  const { circles } = draw('glow', 1.3);
  const highlights = circles.filter((c) => c.color === '#FFE9B8');
  expect(highlights.length).toBe(4);
  const left = highlights.find((c) => c.x < 190);
  const right = highlights.find((c) => c.x > 210);
  expect(Math.abs((200 - left.x) - (right.x - 200))).toBeLessThan(0.01);
  expect(Math.abs(left.y - right.y)).toBeLessThan(0.01);
  // Gold, not the old near-white glow.
  expect(circles.some((c) => c.color === '#FFFFFF' && c.alpha > 0.4 && c.r > 10)).toBe(false);
});

it('Soft Glow has gold glitter on the skin and sparkles on both sides of the face', () => {
  const { draw } = load();
  let glitter = 0, leftStars = 0, rightStars = 0;
  for (let t = 0; t < 10; t += 0.5) {
    const { circles } = draw('glow', t);
    glitter += circles.filter((c) => c.color === '#FFE08A').length;
    for (const c of circles.filter((x) => x.color === '#FFD27A')) (c.x < 200 ? leftStars++ : rightStars++);
  }
  expect(glitter / 20).toBeGreaterThan(10);   // on average more than 10 glitter dots twinkling at once
  expect(leftStars).toBeGreaterThan(20);
  expect(rightStars).toBeGreaterThan(20);
});

it('Golden Hour has many more sparkles than before (it had none), plus gold dust in the sunbeam', () => {
  const { draw } = load();
  let stars = 0, dust = 0;
  for (let t = 0; t < 10; t += 0.5) {
    const drawn = draw('golden', t);
    stars += drawn.stars;
    dust += drawn.circles.filter((c) => c.color === '#FFE3A0').length;
  }
  expect(stars / 20).toBeGreaterThan(10);
  expect(dust / 20).toBeGreaterThan(8);
});
