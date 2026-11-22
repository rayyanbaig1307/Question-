import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';

// Main Character Mode 🌆: where your face goes (src/components/mainCharacter/fit.ts). Your face is turned,
// scaled and moved so your two eye middles land on the character's, the height follows the top of your forehead
// (but only ±15 %), the poster fills the view ("cover"), and the lite way's camera-view transform lands every
// point where the poster shows it – and never hands a broken number to the native camera view.
// Invented faces and art only.

const root = resolve(import.meta.dirname, '../..');

function compile(path, cache = new Map()) {
  const full = resolve(root, path);
  if (cache.has(full)) return cache.get(full).exports;
  const code = ts.transpileModule(readFileSync(full, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  cache.set(full, module);
  vm.runInNewContext(code, {
    module, exports: module.exports, Math, Number,
    require: (id) => {
      if (id === '@/lib/mainCharacter/config') return compile('src/lib/mainCharacter/config.ts', cache);
      if (id.startsWith('.')) return compile(`${join(dirname(full), id)}.ts`, cache);
      throw new Error(`fit.ts must not load ${id}`);
    },
  });
  return module.exports;
}

const fit = compile('src/components/mainCharacter/fit.ts');
const { FIT } = compile('src/lib/mainCharacter/config.ts');

// ---------------------------------------------------------------------------
// Invented faces and art.
// ---------------------------------------------------------------------------

// A face as the back camera sees it, around (0, 0): the person's right eye (points 33 and 133) on the left of the
// picture, the forehead (10) 60 above the eye line, the chin (152) and the lips below. The eye middles are
// (−30, 0) and (30, 0).
function templateFace({ foreheadUp = 60, chinDown = 90, irisShift = 0 } = {}) {
  const pts = new Array(478 * 2).fill(0);
  for (let i = 0; i < 478; i++) { pts[i * 2] = Math.cos(i) * 50; pts[i * 2 + 1] = 20 + Math.sin(i) * 60; }
  const set = (i, x, y) => { pts[i * 2] = x; pts[i * 2 + 1] = y; };
  set(33, -45, 0); set(133, -15, 0); set(263, 45, 0); set(362, 15, 0);
  set(10, 0, -foreheadUp); set(152, 0, chinDown);
  set(468, -30 + irisShift, 0); set(473, 30 + irisShift, 0);
  return pts;
}

// Moves a face onto the screen: optionally mirrored (the selfie camera), turned, scaled and moved.
function place(pts, { mirror = false, turn = 0, scale = 1, x = 195, y = 400 } = {}) {
  const out = [];
  for (let i = 0; i < pts.length; i += 2) {
    const px = mirror ? -pts[i] : pts[i];
    const py = pts[i + 1];
    out.push(x + scale * (Math.cos(turn) * px - Math.sin(turn) * py), y + scale * (Math.sin(turn) * px + Math.cos(turn) * py));
  }
  return out;
}

const point = (pts, i) => [pts[i * 2], pts[i * 2 + 1]];
const middle = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const apply = (m, [x, y]) => [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
const eyeMid = (pts, outer, inner) => middle(point(pts, outer), point(pts, inner));

// An invented character: the face hole round (0.5, 0.2) in art 0–1, about a quarter of the picture wide.
function anchors() {
  const hole = [];
  for (let k = 0; k < 36; k++) {
    const a = -Math.PI / 2 + (k / 36) * Math.PI * 2;
    hole.push([0.5 + 0.12 * Math.cos(a), 0.19 + 0.075 * Math.sin(a)]);
  }
  return {
    eyes: [[0.444, 0.17], [0.556, 0.17]], nose: [0.5, 0.205], chin: [0.5, 0.265], forehead: [0.5, 0.11],
    hole, faceWidth: 0.25, skinTone: [204, 153, 102], toneSure: true,
  };
}
const art = fit.placeArt(anchors());

function expectClose(actual, expected, digits = 6, label = '') {
  expect(actual.length, label).toBe(expected.length);
  actual.forEach((v, i) => expect(v, `${label} [${i}]`).toBeCloseTo(expected[i], digits));
}

// ---------------------------------------------------------------------------

it('the poster numbers: the character box, cover on a 390 × 844 phone, and the art in poster pixels', () => {
  const box = fit.characterRect();
  expect(box.x).toBeCloseTo(43.2, 9);
  expect(box.y).toBeCloseTo(153.6, 9);
  expect(box.w).toBeCloseTo(993.6, 9);
  expect(box.h).toBeCloseTo(1766.4, 9);
  // Cover: the poster's height fills the view, 42 points cut off each side.
  const c = fit.posterToView(390, 844);
  expect(c[0]).toBeCloseTo(0.4396, 4);
  expect(c[4]).toBe(c[0]);
  expect(c[1]).toBe(0);
  expect(c[3]).toBe(0);
  expect(c[2]).toBeCloseTo(-42.4, 1);
  expect(c[5]).toBeCloseTo(0, 9);
  // A wide view: the width fills it, top and bottom cut off.
  const wide = fit.posterToView(1080, 1080);
  expect(wide[0]).toBe(1);
  expect(wide[5]).toBe(-420);
  // placeArt: art 0–1 through the box; skin 0–255 → 0–1; 36 hole points → 72 numbers.
  expect(art.eyes[0]).toBeCloseTo(43.2 + 0.444 * 993.6, 9);
  expect(art.eyes[1]).toBeCloseTo(153.6 + 0.17 * 1766.4, 9);
  expect(art.forehead[1]).toBeCloseTo(153.6 + 0.11 * 1766.4, 9);
  expect(art.chin[1]).toBeCloseTo(153.6 + 0.265 * 1766.4, 9);
  expect(art.nose[0]).toBeCloseTo(540, 9);
  expect(art.hole).toHaveLength(72);
  expect(art.hole[0]).toBeCloseTo(540, 9);
  expectClose(art.tone, [0.8, 0.6, 0.4], 9);
  expect(art.toneSure).toBe(true);
  expect(fit.placeArt({ ...anchors(), toneSure: false, skinTone: [300, -5, Number.NaN] })).toMatchObject({ toneSure: false, tone: [1, 0, 0] });
});

it('coverCrop takes the biggest middle part with the right shape', () => {
  expect(fit.coverCrop(1080, 1920, 9 / 16)).toEqual({ x: 0, y: 0, w: 1080, h: 1920 });
  const wide = fit.coverCrop(1200, 1920, 9 / 16);
  expect(wide.x).toBeCloseTo(60, 9);
  expect(wide.w).toBeCloseTo(1080, 9);
  expect(wide.y).toBe(0);
  const tall = fit.coverCrop(1080, 2000, 9 / 16);
  expect(tall.y).toBeCloseTo(40, 9);
  expect(tall.h).toBeCloseTo(1920, 9);
  for (const [w, h, a] of [[0, 100, 1], [100, -1, 1], [Number.NaN, 100, 1], [100, 100, 0], [100, Infinity, 1]]) {
    expect(fit.coverCrop(w, h, a)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  }
});

it('the small helpers: two matrices in one, points through a matrix, points grown about their middle', () => {
  const p = [2, 0, 5, 0, 3, -1];
  const q = [0, -1, 10, 1, 0, 20];
  for (const pt of [[0, 0], [7, -3], [100, 42]]) expectClose(apply(fit.mul(p, q), pt), apply(p, apply(q, pt)), 9);
  expect(fit.mapPoints(p, [1, 1, 2, 2])).toEqual([7, 2, 9, 5]);
  expect(fit.scaleAround([0, 0, 10, 0, 10, 10, 0, 10], 2)).toEqual([-5, -5, 15, -5, 15, 15, -5, 15]);
  expect(fit.scaleAround([], 2)).toEqual([]);
});

it('eyeMiddles uses the eye corners (33/133 and 263/362) and refuses broken or missing points', () => {
  const pts = templateFace();
  expect(fit.eyeMiddles(pts)).toEqual([-30, 0, 30, 0]);
  expect(fit.eyeMiddles(pts.slice(0, 600))).toBeNull();
  expect(fit.eyeMiddles(null)).toBeNull();
  const broken = [...pts];
  broken[362 * 2 + 1] = Number.NaN;
  expect(fit.eyeMiddles(broken)).toBeNull();
});

it('the fit puts your eye middles exactly on the character\'s, turned and scaled, on both cameras', () => {
  for (const mirror of [false, true]) {
    for (const turn of [0, 0.3, -0.5, 1.2]) {
      for (const scale of [0.6, 1, 1.7]) {
        const pts = place(templateFace(), { mirror, turn, scale, x: 180 + turn * 10, y: 410 - scale * 5 });
        const f = fit.faceFit(pts, art);
        const label = `mirror ${mirror}, turn ${turn}, scale ${scale}`;
        expect(f, label).not.toBeNull();
        const m = fit.fitMatrix(f);
        // The eye that is on the left of the screen lands on the art's picture-left eye.
        const one = eyeMid(pts, 33, 133);
        const two = eyeMid(pts, 263, 362);
        const [left, right] = mirror ? [two, one] : [one, two];
        expectClose(apply(m, left), art.eyes.slice(0, 2), 6, `${label}: left eye`);
        expectClose(apply(m, right), art.eyes.slice(2, 4), 6, `${label}: right eye`);
        // The forehead (straight above the eye middle on both) lands on the art's forehead too.
        expectClose(apply(m, point(pts, 10)), art.forehead, 6, `${label}: forehead`);
        // Turned and scaled, never flipped: the matrix keeps left and right.
        expect(m[0] * m[4] - m[1] * m[3], label).toBeGreaterThan(0);
        expect(f.sx, label).toBeGreaterThan(0);
        expect(f.sy, label).toBeGreaterThan(0);
      }
    }
  }
});

it('your eyes in the mirrored order are swapped (dot product), not flipped', () => {
  const plain = fit.faceFit(place(templateFace(), { mirror: false }), art);
  const mirrored = fit.faceFit(place(templateFace(), { mirror: true }), art);
  // Both upright: the eye line's angle is 0, not 180°.
  expect(plain.turnUser).toBeCloseTo(0, 9);
  expect(mirrored.turnUser).toBeCloseTo(0, 9);
  expect(mirrored.sx).toBeCloseTo(plain.sx, 9);
  expect(mirrored.sy).toBeCloseTo(plain.sy, 9);
  // The order is never picked by name: a face turned half way round has its eyes swapped too, and the eye on
  // the left of the screen still lands on the art's left eye.
  const pts = place(templateFace(), { turn: Math.PI });
  const flipped = fit.faceFit(pts, art);
  expect(Math.abs(flipped.turnUser)).toBeCloseTo(0, 6);
  expectClose(apply(fit.fitMatrix(flipped), eyeMid(pts, 263, 362)), art.eyes.slice(0, 2), 6);
});

it('an open mouth (the chin moves) and looking around (the irises move) change nothing', () => {
  const still = fit.faceFit(place(templateFace(), { turn: 0.2, scale: 1.3 }), art);
  const open = fit.faceFit(place(templateFace({ chinDown: 140 }), { turn: 0.2, scale: 1.3 }), art);
  const looking = fit.faceFit(place(templateFace({ irisShift: 8 }), { turn: 0.2, scale: 1.3 }), art);
  for (const key of Object.keys(still)) {
    expect(open[key], key).toBeCloseTo(still[key], 12);
    expect(looking[key], key).toBeCloseTo(still[key], 12);
  }
});

it('the forehead height is limited to ±15 %, and your eye middle still lands exactly', () => {
  for (const foreheadUp of [20, 30, 200, 400]) {
    const pts = place(templateFace({ foreheadUp }), { turn: 0.4, scale: 1.2 });
    const f = fit.faceFit(pts, art);
    expect(f, `forehead ${foreheadUp}`).not.toBeNull();
    const stretch = f.sy / f.sx;
    expect(stretch).toBeLessThanOrEqual(FIT.maxStretch + 1e-9);
    expect(stretch).toBeGreaterThanOrEqual(1 / FIT.maxStretch - 1e-9);
    expect(Math.abs(Math.log(stretch))).toBeCloseTo(Math.log(FIT.maxStretch), 9);
    const m = fit.fitMatrix(f);
    expectClose(apply(m, middle(eyeMid(pts, 33, 133), eyeMid(pts, 263, 362))), [(art.eyes[0] + art.eyes[2]) / 2, (art.eyes[1] + art.eyes[3]) / 2], 6);
    // The eye line still lies along the art's eye line.
    const a = apply(m, eyeMid(pts, 33, 133));
    const b = apply(m, eyeMid(pts, 263, 362));
    expect(Math.atan2(b[1] - a[1], b[0] - a[0])).toBeCloseTo(0, 9);
  }
  // A forehead height of 0 can't be trusted: the fit uses the eye gap for both directions.
  const flat = fit.faceFit(templateFace({ foreheadUp: 0 }), art);
  expect(flat.sy).toBeCloseTo(flat.sx, 12);
});

it('a scale outside the FIT limits, eyes too close together or broken art gives no fit', () => {
  // Eyes 3 points apart (below FIT.minEyeGap).
  expect(fit.faceFit(place(templateFace(), { scale: 0.05 }), art)).toBeNull();
  // A tiny face far away: the scale would be over FIT.maxScale.
  expect(fit.faceFit(place(templateFace(), { scale: 0.2 }), art)).toBeNull();
  // A huge face right up close: under FIT.minScale.
  expect(fit.faceFit(place(templateFace(), { scale: 15 }), art)).toBeNull();
  // Just inside the limits works.
  expect(fit.faceFit(place(templateFace(), { scale: 0.3 }), art)).not.toBeNull();
  expect(fit.faceFit(place(templateFace(), { scale: 8 }), art)).not.toBeNull();
  // Broken art.
  expect(fit.faceFit(templateFace(), { ...art, eyes: [Number.NaN, 1, 2, 3] })).toBeNull();
  expect(fit.faceFit(templateFace(), { ...art, eyes: [500, 400, 500, 400] })).toBeNull();
  expect(fit.faceFit(templateFace(), null)).toBeNull();
  // Broken face points.
  const broken = templateFace();
  broken[133 * 2] = Infinity;
  expect(fit.faceFit(broken, art)).toBeNull();
});

// React Native turns and scales a view about its middle: it moves the view's middle to (0, 0), applies the list
// (the last item first, like CSS), and moves it back.
function reactNativeMatrix(list, viewW, viewH) {
  const ox = viewW / 2;
  const oy = viewH / 2;
  let m = [1, 0, ox, 0, 1, oy];
  for (const item of list) {
    const [key, value] = Object.entries(item)[0];
    let step;
    if (key === 'translateX') step = [1, 0, value, 0, 1, 0];
    else if (key === 'translateY') step = [1, 0, 0, 0, 1, value];
    else if (key === 'scaleX') step = [value, 0, 0, 0, 1, 0];
    else if (key === 'scaleY') step = [1, 0, 0, 0, value, 0];
    else if (key === 'rotate') {
      expect(value).toMatch(/^-?[0-9.e-]+rad$/);
      const a = Number.parseFloat(value);
      step = [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0];
    } else throw new Error(`unexpected ${key}`);
    m = fit.mul(m, step);
  }
  return fit.mul(m, [1, 0, -ox, 0, 1, -oy]);
}

it('the lite camera-view transform puts every camera point where the poster shows it: C(M(p))', () => {
  for (const [viewW, viewH] of [[390, 844], [430, 932], [375, 667], [1024, 1366]]) {
    for (const mirror of [false, true]) {
      for (const [turn, scale] of [[0, 1], [0.35, 1.4], [-0.8, 0.7]]) {
        const pts = place(templateFace({ foreheadUp: 50 }), { mirror, turn, scale, x: viewW * 0.45, y: viewH * 0.55 });
        const f = fit.faceFit(pts, art);
        const list = fit.liteTransform(f, viewW, viewH);
        expect(list).not.toBeNull();
        expect(list.map((item) => Object.keys(item)[0])).toEqual(['translateX', 'translateY', 'rotate', 'scaleX', 'scaleY', 'rotate']);
        const rn = reactNativeMatrix(list, viewW, viewH);
        const target = fit.mul(fit.posterToView(viewW, viewH), fit.fitMatrix(f));
        for (const p of [[0, 0], [viewW, viewH], [viewW / 2, viewH / 3], point(pts, 33), point(pts, 10), [-50, 1200]]) {
          expectClose(apply(rn, p), apply(target, p), 6, `${viewW}×${viewH} mirror ${mirror} turn ${turn}`);
        }
      }
    }
  }
});

it('the lite transform never hands a broken number to the camera view', () => {
  const good = fit.faceFit(place(templateFace(), { turn: 0.2 }), art);
  expect(fit.liteTransform(good, 390, 844)).not.toBeNull();
  // No fit, no size, a broken size.
  expect(fit.liteTransform(null, 390, 844)).toBeNull();
  for (const [w, h] of [[0, 844], [390, 0], [-390, 844], [390, -1], [Number.NaN, 844], [390, Infinity], [-Infinity, 844]]) {
    expect(fit.liteTransform(good, w, h), `${w}×${h}`).toBeNull();
  }
  // Any broken number in the fit, or a scale outside the FIT limits.
  for (const key of Object.keys(good)) {
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      expect(fit.liteTransform({ ...good, [key]: bad }, 390, 844), `${key} = ${bad}`).toBeNull();
    }
  }
  for (const [sx, sy] of [[0, 1], [1, 0], [-1, 1], [FIT.maxScale * 2, 1], [1, FIT.minScale / 2]]) {
    expect(fit.liteTransform({ ...good, sx, sy }, 390, 844)).toBeNull();
  }
  // Broken face points never get as far as a transform.
  for (const index of [33, 133, 263, 362, 10]) {
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      const pts = place(templateFace(), { turn: 0.2 });
      pts[index * 2 + (index % 2)] = bad;
      const f = fit.faceFit(pts, art);
      const list = fit.liteTransform(f, 390, 844);
      if (list !== null) {
        for (const item of list) {
          const value = Object.values(item)[0];
          expect(Number.isFinite(typeof value === 'string' ? Number.parseFloat(value) : value)).toBe(true);
        }
      }
      if (index !== 10) expect(list).toBeNull();
    }
  }
  // A lot of invented faces, some with broken points: always null or only real numbers.
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let n = 0; n < 300; n++) {
    const pts = place(templateFace({ foreheadUp: 10 + random() * 120 }), { mirror: random() > 0.5, turn: (random() - 0.5) * 7, scale: random() * 4, x: random() * 400, y: random() * 900 });
    if (random() > 0.7) pts[Math.floor(random() * pts.length)] = [Number.NaN, Infinity, -Infinity][n % 3];
    const list = fit.liteTransform(fit.faceFit(pts, art), random() > 0.1 ? 390 : 0, 844);
    if (list === null) continue;
    for (const item of list) {
      const value = Object.values(item)[0];
      expect(Number.isFinite(typeof value === 'string' ? Number.parseFloat(value) : value)).toBe(true);
    }
  }
});

it('biggestFace picks the face with the widest eye gap and skips broken ones', () => {
  const small = { id: 'small', pts: place(templateFace(), { scale: 0.8 }) };
  const big = { id: 'big', pts: place(templateFace(), { scale: 1.5, x: 300 }) };
  const brokenPts = place(templateFace(), { scale: 3 });
  brokenPts[263 * 2] = Number.NaN;
  const broken = { id: 'broken', pts: brokenPts };
  expect(fit.biggestFace([small, big, broken]).id).toBe('big');
  expect(fit.biggestFace([broken, small]).id).toBe('small');
  expect(fit.biggestFace([broken])).toBeNull();
  expect(fit.biggestFace([])).toBeNull();
  expect(fit.biggestFace(null)).toBeNull();
});
