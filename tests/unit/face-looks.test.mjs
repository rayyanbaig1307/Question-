import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';

// The face filters (src/components/lens/lensPaint.ts and the Peekaboo+ filters in src/components/lens/filters),
// drawn on a pretend canvas that writes down every circle, path, gradient and blur. The owner (5 Nov): Soft Glow
// should be golden and "majestic", lit on the whole face, not only one side. The owner (6 Nov): the two filters
// looked too alike – Golden Hour must be "less similar, more golden and shiny", so it has none of Soft Glow's
// sparkles or glitter. The owner (9 Nov): five more Peekaboo+ filters (👀 🧠 😭 ⚡ 😘) from the web version.

// Turns a .ts file into code that runs here. Its own imports of other files next to it ('./kit', '../lensPaint')
// are turned too; anything else must be in `mods`.
function compile(path, mods, cache = new Map()) {
  if (cache.has(path)) return cache.get(path).exports;
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  cache.set(path, module);
  vm.runInNewContext(code, {
    module, exports: module.exports, Math,
    require: (id) => {
      if (id in mods) return mods[id];
      if (id.startsWith('.')) return compile(`${join(dirname(path), id)}.ts`, mods, cache);
      throw new Error(`missing ${id}`);
    },
  });
  return module.exports;
}

const { LENS_LOOKS } = compile('src/lib/lensLooks.ts', {});
const LOOKS = LENS_LOOKS.map((look) => look.key);
const NEW_LOOKS = ['peekabooEyes', 'brainBuffering', 'crybaby', 'auraOverload', 'heartEyes'];

function load() {
  const paths = [];
  const gradients = [];
  const skia = {
    BlurStyle: { Normal: 0, Solid: 1 }, ClipOp: { Intersect: 1, Difference: 0 }, FillType: { EvenOdd: 1, Winding: 0 }, PaintStyle: { Stroke: 1, Fill: 0 },
    StrokeCap: { Butt: 0, Round: 1, Square: 2 }, StrokeJoin: { Miter: 0, Round: 1, Bevel: 2 }, TileMode: { Clamp: 0 },
    Skia: {
      Paint: () => {
        const p = { alpha: 1, color: '', blur: false, style: 0, width: 0, shader: false };
        return Object.assign(p, {
          setAntiAlias() {}, setColor(c) { p.color = c; }, setAlphaf(a) { p.alpha = a; }, setMaskFilter(m) { p.blur = !!m; }, setShader(s) { p.shader = !!s; },
          setStyle(s) { p.style = s; }, setStrokeWidth(w) { p.width = w; }, setStrokeCap() {}, setStrokeJoin() {}, copy: () => ({ ...p }),
          setBlendMode() { throw new Error('blend modes cannot work over the live camera'); },
        });
      },
      Color: (c) => c,
      XYWHRect: (x, y, width, height) => ({ x, y, width, height }),
      PathBuilder: {
        Make: () => {
          const shape = { moves: [], cmds: [] };
          const note = (name) => (...args) => { shape.cmds.push([name, ...args]); };
          return {
            setFillType() {}, moveTo: (x, y) => { shape.moves.push([x, y]); shape.cmds.push(['moveTo', x, y]); },
            lineTo: note('lineTo'), quadTo: note('quadTo'), cubicTo: note('cubicTo'), close: note('close'),
            addCircle: note('addCircle'), addOval: note('addOval'), addRect: note('addRect'), addArc: note('addArc'),
            detach: () => { paths.push(shape); return shape; },
          };
        },
      },
      MaskFilter: { MakeBlur: () => ({}) },
      Shader: {
        MakeRadialGradient: (center, r, colors, stops) => { gradients.push({ kind: 'radial', center, r, colors, stops }); return {}; },
        MakeLinearGradient: () => ({}),
        MakeTwoPointConicalGradient: (a, ar, b, br, colors, stops) => { gradients.push({ kind: 'conical', center: b, r: br, colors, stops }); return {}; },
        MakeSweepGradient: (cx, cy, colors, stops) => { gradients.push({ kind: 'sweep', center: { x: cx, y: cy }, colors, stops }); return {}; },
      },
    },
  };
  const faceMesh = compile('src/lib/faceMesh.ts', { react: {}, 'react-native': { TurboModuleRegistry: { get: () => null } } });
  const { MESH } = faceMesh;
  const golden = compile('src/lib/goldenLight.ts', {});
  const lens = compile('src/components/lens/lensPaint.ts', { '@shopify/react-native-skia': skia, '@/lib/faceMesh': faceMesh, '@/lib/goldenLight': golden });
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
  // The face filters' memory, all at rest (faceTrack.ts fills these in on the phone).
  const rest = { browUp: 0, squint: 0, jawOpen: 0, pucker: 0, seed: 1, pop: 1.47, popSpeed: 0, wobbleX: 0, wobbleY: 0, wobbleSpeedX: 0, wobbleSpeedY: 0,
    motion: 0, still: 1, progress: 0.37, flash: 0, charge: 0 };
  const face = { pts, blinkLeft: 0, blinkRight: 0, smile: 0, light: golden.LIGHT_SPOTS.map(() => 0.5), rim: 0.6, ...rest };
  // The same face with the points the Peekaboo+ filters also use: real eye corners and eye bottoms, the bottom
  // of the nose, the inner lips, the mouth corners and the blush spots on the cheeks (still symmetric).
  const filterPts = [...pts];
  const put = (i, x, y) => { filterPts[i * 2] = x; filterPts[i * 2 + 1] = y; };
  for (const [key, x, y] of [['rightEyeOuter', 140, 370], ['rightEyeInner', 180, 370], ['rightEyeBottom', 160, 378], ['leftEyeOuter', 260, 370],
    ['leftEyeInner', 220, 370], ['leftEyeBottom', 240, 378], ['noseBottom', 200, 440], ['upperLipInner', 200, 457], ['lowerLipInner', 200, 463],
    ['mouthRightCorner', 165, 460], ['mouthLeftCorner', 235, 460], ['rightBlush', 150, 425], ['leftBlush', 250, 425]]) put(MESH[key], x, y);
  const filterFace = { ...face, pts: filterPts };
  // Draws one moment. `faces` is how many faces (0–2; the second is smaller and to the right) or a list of faces,
  // `fill` the area the whole-picture parts must cover (the camera view unless given).
  const draw = (look, time, faces = 1, fill, base) => {
    const circles = [];
    const drawn = [];
    paths.length = 0;
    gradients.length = 0;
    const record = (kind, paint, extra) => drawn.push({ kind, color: paint.color, alpha: paint.alpha, blur: paint.blur, style: paint.style, width: paint.width, ...extra });
    const canvas = {
      save() { drawn.push({ kind: 'save' }); }, restore() { drawn.push({ kind: 'restore' }); }, clipPath() {},
      translate(x, y) { drawn.push({ kind: 'translate', x, y }); }, rotate(d) { drawn.push({ kind: 'rotate', d }); }, scale(x, y) { drawn.push({ kind: 'scale', x, y }); },
      drawRect: (rect, paint) => record('rect', paint, { rect }),
      drawPath: (path, paint) => record('path', paint, { moves: path.moves.length, cmds: path.cmds }),
      drawCircle: (x, y, r, paint) => { record('circle', paint, { x, y, r }); circles.push({ x, y, r, color: paint.color, alpha: paint.alpha }); },
    };
    const one = base ?? (NEW_LOOKS.includes(look) ? filterFace : face);
    const second = { ...one, seed: 2, pts: one.pts.map((v, i) => (i % 2 === 0 ? 290 + (v - 200) * 0.5 : 300 + (v - 400) * 0.5)) };
    const list = Array.isArray(faces) ? faces : [one, second].slice(0, faces);
    lens.paintLook(canvas, look, list, 400, 800, time, fill);
    // Sparkles: each four-pointed star starts at its top point (moveTo) – count them across every path.
    const stars = paths.flatMap((p) => p.moves).length;
    return { circles, stars, drawn: drawn.filter((d) => !['save', 'restore', 'translate', 'rotate', 'scale'].includes(d.kind)), steps: drawn, gradients: [...gradients] };
  };
  return { draw, face, filterFace, lens };
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

// ---------------------------------------------------------------------------
// The five Peekaboo+ filters (👀 🧠 😭 ⚡ 😘). They must never stop the live camera: an error on the drawing
// thread switches the filter off for the rest of the session on the phone.
// ---------------------------------------------------------------------------

// Every number the pretend canvas was given, so a broken number (NaN, endless) can be spotted.
function numbersIn(value, out = []) {
  if (typeof value === 'number') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => numbersIn(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => numbersIn(v, out));
  return out;
}

it('every look in the list draws without errors at many moments, with 0, 1 and 2 faces', () => {
  const { draw } = load();
  expect(LOOKS).toEqual(['glow', 'golden', ...NEW_LOOKS]);
  for (const look of LOOKS) {
    for (let t = 0; t < 12; t += 0.37) for (const faces of [0, 1, 2]) expect(() => draw(look, t, faces)).not.toThrow();
    for (const t of [0, 599.9, 1e6]) expect(() => draw(look, t, 2)).not.toThrow();
  }
});

it('the new filters draw safely with any expression and any memory, even broken numbers', () => {
  const { draw, filterFace } = load();
  const variants = [];
  for (const level of [0, 1]) {
    for (const memory of [
      { progress: 0, flash: 0, charge: 0, pop: 0 }, { progress: 0.5, flash: 1, charge: 1, pop: 1.7, still: 0 },
      { progress: 1, flash: 1, charge: 1, pop: 1.7, wobbleX: 0.4, wobbleY: -0.3 }, { progress: 1, flash: 0, still: 1 },
    ]) {
      variants.push({ ...filterFace, browUp: level, squint: level, jawOpen: level, pucker: level, blinkLeft: level, blinkRight: level, ...memory });
    }
  }
  // A face whose new numbers are missing, and one whose numbers are all broken.
  const missing = { pts: filterFace.pts, blinkLeft: 0, blinkRight: 0, smile: 0, light: [], rim: 0 };
  const broken = Object.fromEntries(Object.keys(filterFace).map((key) => [key, NaN]));
  broken.pts = filterFace.pts;
  broken.light = [];
  for (const look of NEW_LOOKS) {
    for (const face of variants) {
      for (const t of [0, 1.3, 7.77]) {
        const { steps } = draw(look, t, [face, { ...face, seed: 9 }]);
        expect(numbersIn(steps).every(Number.isFinite)).toBe(true);
      }
    }
    for (const face of [missing, broken]) {
      for (const t of [0, 2.5]) {
        let result;
        expect(() => { result = draw(look, t, [face]); }).not.toThrow();
        expect(numbersIn(result.steps).every(Number.isFinite)).toBe(true);
      }
    }
    // A face with broken points is skipped, not drawn with broken numbers.
    const badPoints = { ...filterFace, pts: filterFace.pts.map((v, i) => (i === 2 * 2 ? NaN : v)) };
    expect(numbersIn(draw(look, 1, [badPoints]).steps).every(Number.isFinite)).toBe(true);
  }
});

it('the new filters are light enough to draw every frame on the live camera, even with two faces', () => {
  const { draw, filterFace } = load();
  for (const look of NEW_LOOKS) {
    for (const level of [0, 1]) {
      const face = { ...filterFace, browUp: level, squint: level, jawOpen: level, pucker: level, charge: level, flash: level, progress: level ? 1 : 0.62, pop: 1.5 };
      for (let t = 0; t < 12; t += 0.25) {
        const { drawn } = draw(look, t, [face, { ...face, seed: 2, pts: face.pts.map((v, i) => (i % 2 === 0 ? v + 40 : v)) }]);
        expect(drawn.length).toBeLessThanOrEqual(30);
        // Soft blurs are the costly part on the phone.
        expect(drawn.filter((d) => d.blur).length).toBeLessThanOrEqual(4);
      }
    }
  }
});

it('an unknown look is an error (never quietly Soft Glow), and the new filters look nothing like Soft Glow', () => {
  const { draw } = load();
  expect(() => draw('nope', 1, 1)).toThrow(/Unknown face filter/);
  const softGlowOnly = ['#FFE9B8', '#FFE08A', '#FFD27A', '#FFEDB5'];
  for (const look of NEW_LOOKS) {
    const { drawn } = draw(look, 1.3, 1);
    expect(drawn.length).toBeGreaterThan(3);
    expect(drawn.filter((d) => softGlowOnly.includes(d.color))).toEqual([]);
  }
});

it('tears, hearts and sparks are the same every time for the same moment (so the photo matches the screen)', () => {
  const { draw, filterFace } = load();
  for (const look of NEW_LOOKS) {
    for (const t of [0.5, 3.21, 9.9]) expect(JSON.stringify(draw(look, t, 2).steps)).toBe(JSON.stringify(draw(look, t, 2).steps));
  }
  // Another face (another seed) cries other tears.
  const one = draw('crybaby', 2.2, [{ ...filterFace, seed: 1 }]).steps;
  const other = draw('crybaby', 2.2, [{ ...filterFace, seed: 2 }]).steps;
  expect(JSON.stringify(one)).not.toBe(JSON.stringify(other));
  // And the tears move from one moment to the next.
  expect(JSON.stringify(draw('crybaby', 2.2, 1).steps)).not.toBe(JSON.stringify(draw('crybaby', 2.25, 1).steps));
});

it('a face cries a good stream of tears and blows a stream of hearts, but never too many to draw', () => {
  const { draw, filterFace } = load();
  let tearsSeen = 0;
  let heartsSeen = 0;
  for (const level of [0, 1]) {
    const face = { ...filterFace, squint: level, pucker: level };
    for (let t = 0; t < 12; t += 0.25) {
      const tears = draw('crybaby', t, [face]).drawn.filter((d) => d.kind === 'path' && d.color === '#5AB4FF').reduce((sum, d) => sum + d.moves, 0);
      expect(tears).toBeLessThanOrEqual(70);
      if (t > 1) expect(tears).toBeGreaterThan(level ? 25 : 8);
      tearsSeen += tears;
      const hearts = draw('heartEyes', t, [face]).drawn.filter((d) => d.kind === 'path' && ['#FF3FA4', '#FF7CC4'].includes(d.color)).reduce((sum, d) => sum + d.moves, 0);
      expect(hearts).toBeLessThanOrEqual(35);
      heartsSeen += hearts;
    }
  }
  expect(tearsSeen).toBeGreaterThan(0);
  expect(heartsSeen).toBeGreaterThan(0);
});

it('the brain\'s green flash and the aura\'s purple corners cover the whole picture (the whole photo when saving)', () => {
  const { draw, filterFace } = load();
  const fill = { x: -100, y: 0, width: 600, height: 800 };
  const flash = draw('brainBuffering', 1, [{ ...filterFace, progress: 1, flash: 1 }], fill).drawn.filter((d) => d.kind === 'rect');
  expect(flash.length).toBe(1);
  expect(flash[0].rect).toEqual(fill);
  expect(flash[0].color).toBe('#9DFFC8');
  // No flash once it has faded: nothing covers the picture.
  expect(draw('brainBuffering', 1, [{ ...filterFace, progress: 1, flash: 0 }], fill).drawn.filter((d) => d.kind === 'rect')).toEqual([]);
  // The aura's glow: once for the whole picture, even with two faces.
  const aura = draw('auraOverload', 1, 2, fill).drawn.filter((d) => d.kind === 'rect');
  expect(aura.length).toBe(1);
  expect(aura[0].rect).toEqual(fill);
  // Without a face there is no aura at all.
  expect(draw('auraOverload', 1, 0, fill).drawn).toEqual([]);
});

it('Peekaboo Eyes: the two googly eyes on a symmetric face mirror each other', () => {
  const { draw } = load();
  const { drawn } = draw('peekabooEyes', 1.3, 1);
  // Each eye: shadow, ball, iris, pupil and two glints; the balls are the second circle of each eye.
  const circles = drawn.filter((d) => d.kind === 'circle');
  expect(circles.length).toBe(12);
  const [a, b] = [circles[1], circles[7]];
  expect(Math.abs((200 - a.x) - (b.x - 200))).toBeLessThan(0.01);
  expect(Math.abs(a.y - b.y)).toBeLessThan(0.01);
  expect(a.r).toBeCloseTo(b.r, 6);
  // Bigger than the real eye (40 wide) and bigger still with raised brows.
  expect(a.r).toBeGreaterThan(40);
  // Popped in from nothing: a face whose eyes haven't sprung in yet draws nothing.
  expect(draw('peekabooEyes', 1.3, [{ ...load().filterFace, pop: 0 }]).drawn).toEqual([]);
});

it('the filter files never import lensPaint for real (only its types): a circle of imports crashes the drawing thread', () => {
  const dir = 'src/components/lens/filters';
  for (const name of readdirSync(dir)) {
    const text = readFileSync(join(dir, name), 'utf8');
    for (const line of text.split('\n').filter((l) => /^import.*from '\.\.\/lensPaint'/.test(l))) expect(line).toMatch(/^import type \{/);
    // `import { type X }` (only types) can be kept as a real import by Babel: always `import type { X }` then.
    for (const [, names] of text.matchAll(/import \{([^}]*)\} from/g)) {
      expect(names.split(',').map((n) => n.trim()).filter(Boolean).every((n) => n.startsWith('type '))).toBe(false);
    }
  }
});
