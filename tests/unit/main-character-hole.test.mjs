// Main Character Mode 🌆: the face-hole finder and the naming rules for online art
// (src/lib/mainCharacter/holeFinder.ts), on made-up pictures drawn here pixel by pixel. The app uses the finder
// only for an online character that came without its .json: it must find the face hole even when a character has
// other closed gaps (between an arm and the body), skip any hole that doesn't have the usual face shape, and read
// the skin colour without being fooled by a red collar or dark hair. No real art, no network.
import { beforeAll, describe, expect, it } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

let finder;
let config;
beforeAll(() => {
  finder = loadLibrary('mainCharacter/holeFinder');
  config = loadLibrary('mainCharacter/config');
});

const W = 270;
const H = 480;
const SKIN = [230, 110, 70];
const CLEAR = [0, 0, 0, 0];

// A made-up picture: `paint(x, y)` gives [r, g, b, a] for each pixel middle.
function picture(paint, w = W, h = H) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) rgba.set(paint(x + 0.5, y + 0.5), (y * w + x) * 4);
  }
  return rgba;
}
const inOval = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 < 1;
// A character standing on the bottom edge (a solid block with see-through space round it), face hole near the top.
const body = (x, y) => x > 40 && x < 230 && y > 30;
const FACE = { cx: 135, cy: 110, rx: 32, ry: 35 };   // 64 × 70 pixels: 0.237 of the width, shape 0.914
function character({ face = FACE, gaps = [], colour = () => [...SKIN, 255] } = {}) {
  return picture((x, y) => {
    if (!body(x, y)) return CLEAR;
    if (face && inOval(x, y, face.cx, face.cy, face.rx, face.ry)) return CLEAR;
    if (gaps.some((g) => inOval(x, y, g.cx, g.cy, g.rx, g.ry))) return CLEAR;
    return colour(x, y);
  });
}
const pointsOf = (shape) => Array.from({ length: shape.points.length / 2 }, (_, i) => [shape.points[i * 2] * W, shape.points[i * 2 + 1] * H]);
const goodShape = () => finder.findFaceHole(character(), W, H);

describe('findFaceHole', () => {
  it('finds the one face hole: its box, how much of the box it fills, and 36 points on its edge', () => {
    const shape = goodShape();
    expect(shape).not.toBeNull();
    expect(shape.box.x * W).toBeCloseTo(FACE.cx - FACE.rx, 0);
    expect(shape.box.y * H).toBeCloseTo(FACE.cy - FACE.ry, 0);
    expect(Math.abs(shape.box.w * W - 2 * FACE.rx)).toBeLessThanOrEqual(1);
    expect(Math.abs(shape.box.h * H - 2 * FACE.ry)).toBeLessThanOrEqual(1);
    expect(shape.fill).toBeGreaterThan(0.76);   // an oval fills π/4 ≈ 0.785 of its box
    expect(shape.fill).toBeLessThan(0.81);
    expect(shape.points).toHaveLength(72);
    // Every point sits on the oval's edge (within a pixel).
    for (const [x, y] of pointsOf(shape)) {
      const edge = Math.hypot((x - FACE.cx) / FACE.rx, (y - FACE.cy) / FACE.ry);
      expect(Math.abs(edge - 1) * FACE.rx).toBeLessThan(1);
    }
    expect(finder.holeLooksRight(shape)).toBe(true);
  });

  it('starts straight up from the middle and goes round clockwise on screen', () => {
    const p = pointsOf(goodShape());
    expect(p[0][0]).toBeCloseTo(FACE.cx, 0);              // top
    expect(p[0][1]).toBeCloseTo(FACE.cy - FACE.ry, 0);
    expect(p[9][0]).toBeCloseTo(FACE.cx + FACE.rx, 0);    // 90°: the picture's right
    expect(p[18][1]).toBeCloseTo(FACE.cy + FACE.ry, 0);   // 180°: the bottom
    expect(p[27][0]).toBeCloseTo(FACE.cx - FACE.rx, 0);   // 270°: the picture's left
    let turn = 0;                                         // > 0 = clockwise when y points down
    for (let i = 0; i < p.length; i++) {
      const [x1, y1] = p[i];
      const [x2, y2] = p[(i + 1) % p.length];
      turn += x1 * y2 - x2 * y1;
    }
    expect(turn).toBeGreaterThan(0);
  });

  it('finds the face, not the gaps between the arms and the body, when the face is the biggest', () => {
    const gaps = [{ cx: 60, cy: 300, rx: 8, ry: 40 }, { cx: 210, cy: 300, rx: 8, ry: 40 }];
    const shape = finder.findFaceHole(character({ gaps }), W, H);
    expect(shape.box.y * H).toBeCloseTo(FACE.cy - FACE.ry, 0);
    expect(finder.holeLooksRight(shape)).toBe(true);
  });

  it('always takes the biggest closed gap – a bigger arm gap is taken, and then the shape check says no', () => {
    const gaps = [{ cx: 135, cy: 330, rx: 50, ry: 60 }];
    const shape = finder.findFaceHole(character({ gaps }), W, H);
    expect((shape.box.y + shape.box.h / 2) * H).toBeCloseTo(330, 0);
    expect(finder.holeLooksRight(shape)).toBe(false);   // in the bottom half
  });

  it('finds nothing when there is no closed see-through gap', () => {
    expect(finder.findFaceHole(character({ face: null }), W, H)).toBeNull();
    expect(finder.findFaceHole(picture(() => CLEAR), W, H)).toBeNull();
    expect(finder.findFaceHole(picture(() => [...SKIN, 255]), W, H)).toBeNull();
    // A face-shaped gap with an open path to the space round the character is not a hole.
    const open = picture((x, y) => {
      if (!body(x, y)) return CLEAR;
      if (inOval(x, y, FACE.cx, FACE.cy, FACE.rx, FACE.ry) || (Math.abs(x - FACE.cx) < 3 && y < FACE.cy)) return CLEAR;
      return [...SKIN, 255];
    });
    expect(finder.findFaceHole(open, W, H)).toBeNull();
  });

  it('half see-through paint counts by its alpha: below 128 is see-through', () => {
    const faint = character({ face: null, colour: (x, y) => (inOval(x, y, FACE.cx, FACE.cy, FACE.rx, FACE.ry) ? [...SKIN, 127] : [...SKIN, 255]) });
    expect(finder.findFaceHole(faint, W, H)).not.toBeNull();
    const firm = character({ face: null, colour: (x, y) => (inOval(x, y, FACE.cx, FACE.cy, FACE.rx, FACE.ry) ? [...SKIN, 128] : [...SKIN, 255]) });
    expect(finder.findFaceHole(firm, W, H)).toBeNull();
  });

  it('gives up safely on bad input', () => {
    expect(finder.findFaceHole(new Uint8Array(10), W, H)).toBeNull();
    expect(finder.findFaceHole(character(), 0, H)).toBeNull();
    expect(finder.findFaceHole(character(), W, Number.NaN)).toBeNull();
    expect(finder.findFaceHole(null, W, H)).toBeNull();
  });
});

describe('holeLooksRight (HOLE_CHECK)', () => {
  const variant = (change) => {
    const shape = goodShape();
    return { ...shape, box: { ...shape.box }, ...change(shape) };
  };
  it('says no to holes that are too small, too wide, square, in the bottom half, off to the side, star-shaped or boxy', () => {
    const H9 = (w, aspect) => (w * 9) / (16 * aspect);   // the box height that gives this width:height on a 9:16 picture
    const cases = {
      tooSmall: (s) => ({ box: { ...s.box, w: 0.12, h: H9(0.12, 0.92) } }),
      tooWide: (s) => ({ box: { ...s.box, w: 0.36, h: H9(0.36, 0.92) } }),
      square: (s) => ({ box: { ...s.box, h: H9(s.box.w, 1.2) } }),
      tall: (s) => ({ box: { ...s.box, h: H9(s.box.w, 0.6) } }),
      bottomHalf: (s) => ({ box: { ...s.box, y: 0.6 } }),
      offToTheSide: (s) => ({ box: { ...s.box, x: 0.02 } }),
      starShaped: () => ({ fill: 0.5 }),
      boxy: () => ({ fill: 0.97 }),
      brokenNumber: (s) => ({ box: { ...s.box, w: Number.NaN } }),
      tooFewPoints: (s) => ({ points: s.points.slice(0, 70) }),
    };
    for (const [name, change] of Object.entries(cases)) expect(finder.holeLooksRight(variant(change)), name).toBe(false);
    expect(finder.holeLooksRight(variant(() => ({})))).toBe(true);
  });

  it('says no to real drawn holes with the wrong shape', () => {
    // A square hole fills its whole box.
    const square = character({ face: null, gaps: [] });
    for (let y = 80; y < 140; y++) for (let x = 105; x < 165; x++) square[(y * W + x) * 4 + 3] = 0;
    const squareShape = finder.findFaceHole(square, W, H);
    expect(squareShape.fill).toBeGreaterThan(0.95);
    expect(finder.holeLooksRight(squareShape)).toBe(false);
    // A 5-pointed star fills less than half of its box.
    const star = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? 36 : 14;
      const turn = (i * Math.PI) / 5;
      star.push([FACE.cx + r * Math.sin(turn), FACE.cy - r * Math.cos(turn)]);
    }
    const inStar = (x, y) => {
      let yes = false;
      for (let i = 0, j = star.length - 1; i < star.length; j = i++) {
        const [xi, yi] = star[i];
        const [xj, yj] = star[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) yes = !yes;
      }
      return yes;
    };
    const starShape = finder.findFaceHole(character({ face: null, colour: (x, y) => (inStar(x, y) ? CLEAR : [...SKIN, 255]) }), W, H);
    expect(starShape.fill).toBeLessThan(0.6);
    expect(finder.holeLooksRight(starShape)).toBe(false);
  });
});

describe('anchorsFromHole', () => {
  it('places the eyes, nose, chin and forehead in the box with the HOLE numbers', () => {
    const points = Array.from({ length: 72 }, (_, i) => i / 100);
    const shape = { points, box: { x: 0.4, y: 0.1, w: 0.24, h: 0.15 }, fill: 0.8 };
    const anchors = finder.anchorsFromHole(shape, { rgb: [210, 91, 56], sure: true });
    const { HOLE } = config;
    const middle = 0.4 + 0.12;
    expect(anchors.eyes[0][0]).toBeCloseTo(middle - HOLE.eyeHalf * 0.24, 10);
    expect(anchors.eyes[1][0]).toBeCloseTo(middle + HOLE.eyeHalf * 0.24, 10);
    expect(anchors.eyes[0][1]).toBeCloseTo(0.1 + HOLE.eyeY * 0.15, 10);
    expect(anchors.eyes[1][1]).toBeCloseTo(anchors.eyes[0][1], 10);
    expect(anchors.nose).toEqual([middle, 0.1 + HOLE.noseY * 0.15]);
    expect(anchors.chin).toEqual([middle, 0.1 + HOLE.chinY * 0.15]);
    expect(anchors.forehead).toEqual([middle, 0.1 + HOLE.foreheadY * 0.15]);
    expect(anchors.faceWidth).toBeCloseTo(HOLE.faceWidth * 0.24, 10);
    expect(anchors.hole).toHaveLength(36);
    expect(anchors.hole[1]).toEqual([0.02, 0.03]);
    expect(anchors.skinTone).toEqual([210, 91, 56]);
    expect(anchors.toneSure).toBe(true);
  });

  it('gives a whole, usable set of anchors from a found hole', () => {
    const shape = goodShape();
    const anchors = finder.anchorsFromHole(shape, finder.skinToneAround(character(), W, H, shape));
    const numbers = [...anchors.eyes.flat(), ...anchors.nose, ...anchors.chin, ...anchors.forehead, ...anchors.hole.flat(), anchors.faceWidth];
    expect(numbers.every(Number.isFinite)).toBe(true);
    expect(anchors.eyes[0][1]).toBeGreaterThan(anchors.forehead[1]);
    expect(anchors.nose[1]).toBeGreaterThan(anchors.eyes[0][1]);
    expect(anchors.chin[1]).toBeGreaterThan(anchors.nose[1]);
  });
});

describe('skinToneAround', () => {
  const COLLAR = [200, 30, 30, 255];
  const HAIR = [30, 25, 20, 255];
  const PINK_HAIR = [240, 112, 176, 255];

  it('reads the skin round the hole; a red collar under it and dark or neon-lit hair beside it don\'t change it', () => {
    const rgba = character({
      colour: (x, y) => {
        if (y > FACE.cy + FACE.ry + 3) return COLLAR;                                    // below the chin
        if (Math.abs(x - FACE.cx) > FACE.rx + 4) return y < FACE.cy ? PINK_HAIR : HAIR;  // the sides
        return [...SKIN, 255];
      },
    });
    const shape = finder.findFaceHole(rgba, W, H);
    expect(finder.skinToneAround(rgba, W, H, shape)).toEqual({ rgb: SKIN, sure: true });
  });

  it('takes the lit skin, not the shade under the jaw', () => {
    const rgba = character({ colour: (x, y) => (y > FACE.cy + FACE.ry ? [150, 60, 40, 255] : [...SKIN, 255]) });
    const shape = finder.findFaceHole(rgba, W, H);
    expect(finder.skinToneAround(rgba, W, H, shape)).toEqual({ rgb: SKIN, sure: true });
  });

  it('only reads solid paint (the soft edge of the hole and see-through parts don\'t count)', () => {
    const rgba = character({ colour: (x, y) => (inOval(x, y, FACE.cx, FACE.cy, FACE.rx + 3, FACE.ry + 3) ? [20, 200, 20, 200] : [...SKIN, 255]) });
    const shape = finder.findFaceHole(rgba, W, H);
    expect(finder.skinToneAround(rgba, W, H, shape).rgb).toEqual(SKIN);
  });

  it('is not sure with fewer than 200 skin pixels, and then gives the middle colour of the whole ring', () => {
    const BLUE = [40, 60, 200];
    const rgba = character({ colour: (x, y) => (x > FACE.cx + FACE.rx && y > FACE.cy + 20 ? [...SKIN, 255] : [...BLUE, 255]) });
    const shape = finder.findFaceHole(rgba, W, H);
    expect(finder.skinToneAround(rgba, W, H, shape)).toEqual({ rgb: BLUE, sure: false });
  });

  it('still answers with no paint round the hole at all, and on bad input', () => {
    // A hole in a thin ring of paint with nothing solid further out.
    const thin = picture((x, y) => {
      const d = Math.hypot((x - FACE.cx) / FACE.rx, (y - FACE.cy) / FACE.ry);
      return d >= 1 && d < 1.03 ? [...SKIN, 255] : CLEAR;
    });
    const shape = finder.findFaceHole(thin, W, H);
    const tone = finder.skinToneAround(thin, W, H, shape);
    expect(tone.sure).toBe(false);
    expect(tone.rgb.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)).toBe(true);
    expect(finder.skinToneAround(new Uint8Array(4), W, H, goodShape()).sure).toBe(false);
    expect(finder.skinToneAround(character(), W, H, { points: [], box: { x: 0, y: 0, w: 0, h: 0 }, fill: 0 }).sure).toBe(false);
  });
});

describe('names for online art', () => {
  it('slugFromFile: lower case, dashes, allowed picture types only', () => {
    const cases = {
      'Street Boss.PNG': 'street-boss',
      'street_boss.webp': 'street-boss',
      'characters/mall-cop.webp': 'mall-cop',
      '  Night   Rider .jpg': 'night-rider',
      'Street Boss.JPEG': 'street-boss',
      'street--boss.json': 'street-boss',
      'Café Boss!.png': 'caf-boss',
      'neon-2.webp': 'neon-2',
      [`${'a'.repeat(40)}.png`]: 'a'.repeat(40),
      '.emptyFolderPlaceholder': null,
      'street-boss.gif': null,
      'street-boss.heic': null,
      'street-boss': null,
      '!!!.png': null,
      '.png': null,
      [`${'a'.repeat(41)}.png`]: null,
    };
    for (const [file, slug] of Object.entries(cases)) expect(finder.slugFromFile(file), file).toBe(slug);
    expect(finder.slugFromFile(undefined)).toBeNull();
  });

  it('nameFromSlug: the name people see', () => {
    expect(finder.nameFromSlug('street-boss')).toBe('Street Boss');
    expect(finder.nameFromSlug('mall-cop')).toBe('Mall Cop');
    expect(finder.nameFromSlug('rooftop')).toBe('Rooftop');
    expect(finder.nameFromSlug('neon-2')).toBe('Neon 2');
    expect(finder.nameFromSlug(finder.slugFromFile('Getaway Driver.png'))).toBe('Getaway Driver');
  });

  it('artExtension', () => {
    expect(['a.webp', 'a.PNG', 'a.jpg', 'a.JPEG', 'a.json', 'a.gif', 'noext', '.emptyFolderPlaceholder'].map(finder.artExtension))
      .toEqual(['webp', 'png', 'jpg', 'jpg', 'json', null, null, null]);
  });

  it('pickOnePerSlug: webp over png over jpg, the newest of the same type, and a .json is never a picture', () => {
    const items = [
      { slug: 'boss', ext: 'jpg', updatedAt: '2026-11-03T00:00:00Z' },
      { slug: 'boss', ext: 'webp', updatedAt: '2026-11-01T00:00:00Z' },
      { slug: 'boss', ext: 'png', updatedAt: '2026-11-05T00:00:00Z' },
      { slug: 'boss', ext: 'json', updatedAt: '2026-11-06T00:00:00Z' },
      { slug: 'only-json', ext: 'json', updatedAt: '2026-11-01T00:00:00Z' },
      { slug: 'cop', ext: 'png', updatedAt: '2026-11-01T00:00:00Z' },
      { slug: 'cop', ext: 'png', updatedAt: '2026-11-02T00:00:00Z' },
      { slug: 'odd', ext: 'gif', updatedAt: '2026-11-02T00:00:00Z' },
      { slug: 'street', ext: 'jpg', updatedAt: '2026-11-02T00:00:00Z' },
    ];
    expect(finder.pickOnePerSlug(items)).toEqual([items[1], items[6], items[8]]);
    expect(finder.pickOnePerSlug([])).toEqual([]);
  });
});
