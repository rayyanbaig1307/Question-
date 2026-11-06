import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';

// The face filters (src/components/lens/lensPaint.ts), drawn on a pretend canvas that writes down every circle,
// path, gradient and blur. The owner (5 Nov): Soft Glow should be golden and "majestic", lit on the whole face,
// not only one side. The owner (6 Nov): the two filters looked too alike – Golden Hour must be "less similar,
// more golden and shiny", so it has none of Soft Glow's sparkles or glitter.

function compile(path, mods) {
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, Math, require: (id) => { if (id in mods) return mods[id]; throw new Error(`missing ${id}`); } });
  return module.exports;
}

function load() {
  const paths = [];
  const gradients = [];
  const skia = {
    BlurStyle: { Normal: 0, Solid: 1 }, ClipOp: { Intersect: 1, Difference: 0 }, FillType: { EvenOdd: 1, Winding: 0 }, PaintStyle: { Stroke: 1, Fill: 0 },
    StrokeCap: { Butt: 0, Round: 1, Square: 2 }, TileMode: { Clamp: 0 },
    Skia: {
      Paint: () => {
        const p = { alpha: 1, color: '', blur: false };
        return Object.assign(p, {
          setAntiAlias() {}, setColor(c) { p.color = c; }, setAlphaf(a) { p.alpha = a; }, setMaskFilter(m) { p.blur = !!m; }, setShader() {}, setStyle() {},
          setStrokeWidth() {}, setStrokeCap() {}, copy: () => ({ ...p }),
          setBlendMode() { throw new Error('blend modes cannot work over the live camera'); },
        });
      },
      Color: (c) => c,
      XYWHRect: (x, y, width, height) => ({ x, y, width, height }),
      PathBuilder: {
        Make: () => {
          const shape = { moves: [] };
          return { setFillType() {}, moveTo: (x, y) => shape.moves.push([x, y]), lineTo() {}, quadTo() {}, cubicTo() {}, close() {}, addCircle() {}, addOval() {}, addRect() {}, detach: () => { paths.push(shape); return shape; } };
        },
      },
      MaskFilter: { MakeBlur: () => ({}) },
      Shader: {
        MakeRadialGradient: (center) => { gradients.push({ kind: 'radial', center }); return {}; },
        MakeLinearGradient: () => ({}),
        MakeTwoPointConicalGradient: () => ({}),
        MakeSweepGradient: (cx, cy) => { gradients.push({ kind: 'sweep', center: { x: cx, y: cy } }); return {}; },
      },
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
  // Draws one moment. `faces` is how many faces (0–2; the second is smaller and to the right), `fill` the area the
  // whole-picture parts must cover (the camera view unless given).
  const draw = (look, time, faces = 1, fill) => {
    const circles = [];
    const drawn = [];
    paths.length = 0;
    gradients.length = 0;
    const record = (kind, paint) => drawn.push({ kind, color: paint.color, blur: paint.blur });
    const canvas = {
      save() {}, restore() {}, clipPath() {}, translate() {}, rotate() {}, scale() {},
      drawRect: (rect, paint) => record('rect', paint),
      drawPath: (path, paint) => record('path', paint),
      drawCircle: (x, y, r, paint) => { record('circle', paint); circles.push({ x, y, r, color: paint.color, alpha: paint.alpha }); },
    };
    const second = { ...face, pts: face.pts.map((v, i) => (i % 2 === 0 ? 290 + (v - 200) * 0.5 : 300 + (v - 400) * 0.5)) };
    lens.paintLook(canvas, look, [face, second].slice(0, faces), 400, 800, time, fill);
    // Sparkles: each four-pointed star starts at its top point (moveTo) – count them across every path.
    const stars = paths.flatMap((p) => p.moves).length;
    return { circles, stars, drawn, gradients: [...gradients] };
  };
  return { draw };
}

it('both looks draw without errors at many moments (the twinkles change over time)', () => {
  const { draw } = load();
  for (const look of ['glow', 'golden']) for (let t = 0; t < 12; t += 0.37) for (const faces of [0, 1, 2]) expect(() => draw(look, t, faces)).not.toThrow();
  // Odd moments too: the very start, and far into a long session.
  for (const t of [0, 59.9, 599.9, 1e6]) expect(() => draw('golden', t, 2)).not.toThrow();
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

it('Golden Hour looks nothing like Soft Glow: no star sparkles, no glitter, no sparkle halos', () => {
  const { draw } = load();
  // Soft Glow's own colours: star sparkles (#FFEDB5), glitter on the skin (#FFE08A), the glow round each sparkle
  // (#FFD27A, and the old Golden Hour's #FFD58A) and the old Golden Hour's gold dust (#FFE3A0).
  const softGlowOnly = ['#FFEDB5', '#FFE08A', '#FFD27A', '#FFD58A', '#FFE3A0'];
  for (let t = 0; t < 12; t += 0.5) {
    const { drawn } = draw('golden', t, 2);
    expect(drawn.filter((d) => softGlowOnly.includes(d.color))).toEqual([]);
  }
  // And Soft Glow still has them (so the check above means something).
  expect(draw('glow', 1.3).drawn.some((d) => softGlowOnly.includes(d.color))).toBe(true);
});

it('Golden Hour is light enough to draw every frame on the live camera, even with two faces', () => {
  const { draw } = load();
  for (let t = 0; t < 12; t += 0.25) {
    const { drawn } = draw('golden', t, 2);
    expect(drawn.length).toBeLessThanOrEqual(50);
    // Soft blurs are the costly part on the phone.
    expect(drawn.filter((d) => d.blur).length).toBeLessThanOrEqual(12);
  }
  // With nobody in the picture it still draws the evening light (the sun and the warm tint).
  expect(draw('golden', 1.3, 0).drawn.length).toBeGreaterThan(2);
});

it('Golden Hour places the sun from the whole picture, so the saved photo has it in the same place as the camera', () => {
  const { draw } = load();
  // The camera view (400 wide) and a saved photo that reaches 100 further on each side.
  const live = draw('golden', 1.3, 1, { x: 0, y: 0, width: 400, height: 800 }).gradients[0].center;
  const photo = draw('golden', 1.3, 1, { x: -100, y: 0, width: 600, height: 800 }).gradients[0].center;
  // The sun sits just past the left edge in both, so in the wider photo it is further left.
  expect(live.x).toBeLessThan(0);
  expect(live.x).toBeGreaterThan(-40);
  expect(photo.x).toBeLessThan(-100);
  expect(photo.x).toBeGreaterThan(-160);
  expect(photo.y).toBeCloseTo(live.y, 5);
});
