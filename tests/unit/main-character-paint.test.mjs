import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { beforeAll, expect, it } from 'vitest';

// Main Character Mode 🌆: the one drawing of the poster (src/components/mainCharacter/paintScene.ts), the poster
// made from the screen (snapPoster.ts) and the poster made from the photo (bakeMainCharacter.ts).
// First with a pretend Skia that writes down every draw, clip, blur and Skia object (the warp-looks.test.mjs way):
// what is drawn in each case (full, lite, no face, photo), that it stays cheap, and that every Skia object made
// is handed back for letting go – also when a draw fails halfway. Then for real with Skia's web version
// (CanvasKit): the face really lands in the hole, the scene behind, the character in front.
// Invented faces, pictures and art only.

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../..');

function compile(path, mods, cache) {
  const full = resolve(root, path);
  if (cache.has(full)) return cache.get(full).exports;
  const code = ts.transpileModule(readFileSync(full, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  cache.set(full, module);
  vm.runInNewContext(code, {
    module, exports: module.exports, Math, Number, Uint8Array, Date, globalThis, console: mods.console ?? console,
    require: (id) => {
      if (id in mods) return mods[id];
      if (id === '@/lib/faceMesh') return compile('src/lib/faceMesh.ts', { react: {}, 'react-native': { TurboModuleRegistry: { get: () => null } } }, cache);
      if (id === '@/lib/mainCharacter/config') return compile('src/lib/mainCharacter/config.ts', {}, cache);
      if (id.startsWith('.')) return compile(`${join(dirname(full), id)}.ts`, mods, cache);
      throw new Error(`${path} loads ${id}`);
    },
  });
  return module.exports;
}

// The Main Character drawing files, with these stand-ins for Skia and the rest.
function loadAll(skiaModule, extra = {}) {
  const cache = new Map();
  const mods = { '@shopify/react-native-skia': skiaModule, '@/lib/frameAccess': { FRAME_PLACEMENT: 'rule' }, ...extra };
  return {
    paint: compile('src/components/mainCharacter/paintScene.ts', mods, cache),
    fit: compile('src/components/mainCharacter/fit.ts', mods, cache),
    shader: compile('src/components/mainCharacter/comicShader.ts', mods, cache),
    frame: compile('src/components/lens/warp/frameMatrix.ts', mods, cache),
    config: compile('src/lib/mainCharacter/config.ts', mods, cache),
    MESH: compile('src/lib/faceMesh.ts', { react: {}, 'react-native': { TurboModuleRegistry: { get: () => null } } }, cache).MESH,
    load: (path) => compile(path, mods, cache),
  };
}

const ENUMS = {
  BlurStyle: { Normal: 0, Solid: 1, Outer: 2, Inner: 3 }, ClipOp: { Difference: 0, Intersect: 1 }, FillType: { Winding: 0, EvenOdd: 1 },
  FilterMode: { Nearest: 0, Linear: 1 }, MipmapMode: { None: 0, Nearest: 1, Linear: 2 }, TileMode: { Clamp: 0, Repeat: 1, Mirror: 2, Decal: 3 },
  ImageFormat: { JPEG: 3, PNG: 4, WEBP: 6 },
};

// ---------------------------------------------------------------------------
// The pretend Skia: every object it makes is written down (and knows whether it was let go of).
// ---------------------------------------------------------------------------

function pretendSkia() {
  const made = [];
  const log = [];
  const make = (kind, extra) => {
    const thing = { kind, disposed: false, ...extra };
    thing.dispose = () => { thing.disposed = true; };
    made.push(thing);
    return thing;
  };
  const finite = (...values) => { for (const v of values) if (!Number.isFinite(v)) throw new Error(`broken number ${v}`); };
  const Skia = {
    Paint: () => {
      const p = make('paint', { color: null, alpha: 1, blur: 0, shader: null });
      return Object.assign(p, {
        setAntiAlias() {}, setColor(c) { p.color = c; }, setAlphaf(a) { finite(a); p.alpha = a; }, setMaskFilter(m) { p.blur = m.sigma; },
        setShader(s) { p.shader = s; }, setStyle() {}, setStrokeWidth() {},
        setBlendMode() { throw new Error('blend modes cannot work over the live camera'); },
        setImageFilter() { throw new Error('no image filters here'); },
      });
    },
    Color: (c) => c,
    XYWHRect: (x, y, width, height) => { finite(x, y, width, height); return { x, y, width, height }; },
    Matrix: (m) => { finite(...m); return make('matrix', { m: [...m] }); },
    MaskFilter: { MakeBlur: (style, sigma, ctm) => { finite(sigma); return make('mask', { sigma, ctm }); } },
    PathBuilder: {
      Make: () => {
        const b = make('builder', { fill: 'winding', loops: 0, points: [] });
        return Object.assign(b, {
          setFillType(f) { b.fill = f === ENUMS.FillType.EvenOdd ? 'evenOdd' : 'winding'; },
          moveTo(x, y) { finite(x, y); b.loops++; b.points.push(x, y); },
          lineTo(x, y) { finite(x, y); b.points.push(x, y); },
          quadTo(x1, y1, x2, y2) { finite(x1, y1, x2, y2); b.points.push(x2, y2); },
          close() {},
          // A finished path can't be changed (Skia 2.14): no setFillType, no transform.
          detach() { return make('path', { fill: b.fill, loops: b.loops, points: [...b.points] }); },
        });
      },
    },
    Surface: {},
    Data: {},
    Image: {},
  };
  return { module: { ...ENUMS, Skia }, made, log };
}

// A pretend picture (made by the caller, so not on the drawing's own list).
function pretendImage(env, name, width = 1080, height = 1920) {
  return {
    kind: 'image', name, w: width, h: height,
    width: () => width, height: () => height,
    makeShaderOptions(tx, ty, fm, mm, matrix) {
      const shader = { kind: 'imageShader', from: name, fm, mm, matrix: matrix.m, disposed: false };
      shader.dispose = () => { shader.disposed = true; };
      env.made.push(shader);
      return shader;
    },
  };
}

// A pretend comic effect: writes down the numbers it is given.
function pretendEffect(env) {
  return {
    makeShaderWithChildren(uniforms, children) {
      const shader = { kind: 'comic', uniforms: [...uniforms], child: children[0], disposed: false };
      shader.dispose = () => { shader.disposed = true; };
      env.made.push(shader);
      return shader;
    },
  };
}

// A canvas that writes down what is drawn. `failOn(step)` makes a draw fail (like a broken frame on the phone).
function pretendCanvas(failOn = () => false) {
  const steps = [];
  const note = (step) => { if (failOn(step)) throw new Error('broken frame'); steps.push(step); };
  const paintInfo = (p) => ({ color: p.color, alpha: p.alpha, blur: p.blur, shader: p.shader });
  return {
    steps,
    canvas: {
      save() { steps.push({ kind: 'save' }); },
      restore() { steps.push({ kind: 'restore' }); },
      clipPath(path, op, aa) { steps.push({ kind: 'clip', path, op, aa }); },
      drawRect(rect, paint) { note({ kind: 'rect', rect, ...paintInfo(paint) }); },
      drawPath(path, paint) { note({ kind: 'path', path, ...paintInfo(paint) }); },
      drawImageRectOptions(image, from, to, fm, mm, paint) { note({ kind: 'image', image: image.name, from, to, fm, mm, ...paintInfo(paint) }); },
      drawImageRect() { throw new Error('drawImageRect samples the nearest pixel: use drawImageRectOptions'); },
      drawText() { throw new Error('no text on the drawing thread'); },
    },
  };
}

// ---------------------------------------------------------------------------
// An invented face and an invented character.
// ---------------------------------------------------------------------------

// A face in a 390 × 844 view: eye middles (165, 380) and (225, 380), forehead (point 10) 60 above them, the face
// outline an oval round (195, 425), eyes, brows and lips where a face has them.
function makeFace(MESH, shift = [0, 0], scale = 1) {
  const pts = new Array(478 * 2).fill(0);
  for (let i = 0; i < 478; i++) { pts[i * 2] = 195 + Math.cos(i) * 40; pts[i * 2 + 1] = 430 + Math.sin(i) * 50; }
  const set = (i, x, y) => { pts[i * 2] = x; pts[i * 2 + 1] = y; };
  const ring = (ids, cx, cy, rx, ry) => ids.forEach((id, k) => {
    const a = -Math.PI / 2 + (k / ids.length) * Math.PI * 2;
    set(id, cx + rx * Math.cos(a), cy + ry * Math.sin(a));
  });
  ring(MESH.faceOval, 195, 425, 80, 105);
  ring(MESH.rightEye, 165, 380, 16, 6);
  ring(MESH.leftEye, 225, 380, 16, 6);
  ring(MESH.rightBrow, 165, 362, 20, 4);
  ring(MESH.leftBrow, 225, 362, 20, 4);
  ring(MESH.lips, 195, 470, 30, 12);
  set(33, 150, 380); set(133, 180, 380); set(263, 240, 380); set(362, 210, 380);
  const moved = pts.map((v, i) => (i % 2 === 0 ? 195 + (v - 195) * scale + shift[0] : 425 + (v - 425) * scale + shift[1]));
  return { pts: moved, blinkLeft: 0, blinkRight: 0, smile: 0, light: [], rim: 0, browUp: 0, squint: 0, jawOpen: 0, pucker: 0, seed: 1 };
}

// A character whose face hole is a wide oval round (0.5, 0.2) of the picture (art 0–1).
const HOLE = { cx: 0.5, cy: 0.2, rx: 0.22, ry: 0.13 };
function anchors(toneSure = true) {
  const hole = [];
  for (let k = 0; k < 36; k++) {
    const a = -Math.PI / 2 + (k / 36) * Math.PI * 2;
    hole.push([HOLE.cx + HOLE.rx * Math.cos(a), HOLE.cy + HOLE.ry * Math.sin(a)]);
  }
  return {
    eyes: [[0.444, 0.17], [0.556, 0.17]], nose: [0.5, 0.205], chin: [0.5, 0.265], forehead: [0.5, 0.11],
    hole, faceWidth: 0.25, skinTone: [200, 150, 110], toneSure,
  };
}

function sceneFor(lib, character, background, toneSure = true) {
  return {
    key: 'app:test-hero|app:test-scene',
    character, characterCrop: { x: 0, y: 0, w: character.w, h: character.h },
    background, backgroundCrop: background ? { x: 0, y: 0, w: background.w, h: background.h } : { x: 0, y: 0, w: 0, h: 0 },
    art: lib.fit.placeArt(anchors(toneSure)),
  };
}

// ---------------------------------------------------------------------------
// With the pretend Skia.
// ---------------------------------------------------------------------------

function setup(toneSure = true) {
  const env = pretendSkia();
  const lib = loadAll(env.module);
  const scene = sceneFor(lib, pretendImage(env, 'character'), pretendImage(env, 'background'), toneSure);
  const face = makeFace(lib.MESH);
  const fit = lib.fit.faceFit(face.pts, scene.art);
  return { env, lib, scene, face, fit, fx: pretendEffect(env) };
}

// Draws once; gives the steps, the draws, the blurs and the trash list.
function draw(t, { face = t.face, fit = t.fit, src, live, fx = t.fx, failOn, scene = t.scene } = {}) {
  t.env.made.length = 0;
  const { canvas, steps } = pretendCanvas(failOn);
  const trash = [];
  let error = null;
  try {
    t.lib.paint.paintMainCharacter(canvas, scene, face, fit, src, live, fx, trash);
  } catch (e) {
    error = e;
  }
  const draws = steps.filter((s) => ['rect', 'path', 'image'].includes(s.kind));
  return { steps, draws, blurs: draws.filter((d) => d.blur > 0), trash, made: [...t.env.made], error };
}

const cameraSource = (t, toView = [1, 0, 0, 0, 1, 0], mipmaps = false) => ({ image: pretendImage(t.env, 'camera', 390, 844), toView, mipmaps });
const kinds = (steps) => steps.map((s) => (s.kind === 'image' ? `image:${s.image}` : s.kind));
const SKIN_COLOUR = 'rgba(200,150,110,1)';

it('full: scene, skin plate, your face with the comic look, the skin-only tone pull (clipped), then the character', () => {
  const t = setup();
  expect(t.fit).not.toBeNull();
  for (const live of [true, false]) {
    const src = cameraSource(t, [0.5, 0, 3, 0, 0.5, -2], !live);
    const { steps, draws, blurs, trash, made, error } = draw(t, { src, live });
    expect(error).toBeNull();
    expect(kinds(steps)).toEqual(['image:background', 'path', 'path', 'save', 'clip', 'rect', 'restore', 'image:character']);
    expect(draws).toHaveLength(5);
    expect(blurs).toHaveLength(2);
    const [scene, plate, faceDraw, skinDraw, character] = draws;
    // The scene fills the poster; the character sits in its box.
    expect(scene.to).toEqual({ x: 0, y: 0, width: 1080, height: 1920 });
    expect(scene.fm).toBe(ENUMS.FilterMode.Linear);
    expect(character.to.x).toBeCloseTo(43.2, 9);
    expect(character.to.y).toBeCloseTo(153.6, 9);
    expect(character.to.width).toBeCloseTo(993.6, 9);
    expect(character.to.height).toBeCloseTo(1766.4, 9);
    // The plate: the hole a little bigger, in the character's skin colour, soft edge.
    expect(plate.color).toBe(SKIN_COLOUR);
    expect(plate.blur).toBe(t.lib.config.SKIN.edgeBlur);
    expect(plate.path.loops).toBe(1);
    expect(plate.path.fill).toBe('winding');
    // Your face: the comic look over the camera picture, placed with the fit and the picture's own matrix.
    expect(faceDraw.shader.kind).toBe('comic');
    expect(faceDraw.blur).toBe(t.lib.config.SKIN.edgeBlur);
    const picture = faceDraw.shader.child;
    expect(picture.kind).toBe('imageShader');
    expect(picture.from).toBe('camera');
    expect(picture.mm).toBe(live ? ENUMS.MipmapMode.None : ENUMS.MipmapMode.Linear);
    const expected = t.lib.fit.mul(t.lib.fit.fitMatrix(t.fit), src.toView);
    picture.matrix.slice(0, 6).forEach((v, i) => expect(v).toBeCloseTo(expected[i], 9));
    expect(picture.matrix.slice(6)).toEqual([0, 0, 1]);
    // The first face draw has no tone pull; the skin-only draw has it, on the same picture.
    const { COMIC, COMIC_LIVE } = t.lib.shader;
    expect(faceDraw.shader.uniforms[4]).toBe(0);
    expect(skinDraw.shader.kind).toBe('comic');
    expect(skinDraw.shader.uniforms[4]).toBe(COMIC.toneMix);
    expect(skinDraw.shader.child).toBe(picture);
    expect(skinDraw.blur).toBe(0);
    // Live: the gentler banding and ink. Saved poster: the still numbers.
    expect(faceDraw.shader.uniforms[8]).toBe(live ? COMIC_LIVE.posterMix : COMIC.posterMix);
    expect(faceDraw.shader.uniforms[13]).toBe(live ? COMIC_LIVE.inkAmount : COMIC.inkAmount);
    expect(faceDraw.shader.uniforms.slice(1, 4)).toEqual(t.scene.art.tone);
    // The skin draw is clipped to the skin path: even-odd, set on the PathBuilder (the face minus eyes, brows, lips).
    const clip = steps.find((s) => s.kind === 'clip');
    expect(clip.op).toBe(ENUMS.ClipOp.Intersect);
    expect(clip.aa).toBe(true);
    expect(clip.path.fill).toBe('evenOdd');
    expect(clip.path.loops).toBe(6);
    // Every Skia object made here is on the trash list (and nothing was let go of too early).
    expect(made.length).toBeGreaterThan(10);
    for (const thing of made) expect(trash, thing.kind).toContain(thing);
    expect(made.every((thing) => !thing.disposed)).toBe(true);
  }
});

it('full, for a character whose skin colour isn\'t sure: no tone pull at all', () => {
  const t = setup(false);
  const { steps, draws, blurs, made, trash } = draw(t, { src: cameraSource(t), live: true });
  expect(kinds(steps)).toEqual(['image:background', 'path', 'path', 'image:character']);
  expect(draws).toHaveLength(4);
  expect(blurs).toHaveLength(2);
  const comics = made.filter((m) => m.kind === 'comic');
  expect(comics).toHaveLength(1);
  expect(comics[0].uniforms[4]).toBe(0);
  for (const thing of made) expect(trash).toContain(thing);
});

it('full without the comic look (its shader could not be made): the plain picture, then a warm tint on the skin', () => {
  const t = setup();
  const { steps, draws, blurs, made } = draw(t, { src: cameraSource(t), live: true, fx: null });
  expect(kinds(steps)).toEqual(['image:background', 'path', 'path', 'path', 'image:character']);
  expect(draws).toHaveLength(5);
  // At most 2 blurs: the tint has none here.
  expect(blurs).toHaveLength(2);
  expect(draws[2].shader.kind).toBe('imageShader');
  const tint = draws[3];
  expect(tint.path.fill).toBe('evenOdd');
  expect(tint.path.loops).toBe(6);
  expect(tint.alpha).toBe(t.lib.config.SKIN.liteTint);
  expect(tint.blur).toBe(0);
  expect(made.some((m) => m.kind === 'comic')).toBe(false);
});

it('lite: the scene leaves the hole open, a skin ring round your face, a warm tint on the skin, no camera picture used', () => {
  const t = setup();
  const { steps, draws, blurs, made, trash } = draw(t, { src: null, live: true });
  expect(kinds(steps)).toEqual(['save', 'clip', 'image:background', 'restore', 'path', 'path', 'image:character']);
  expect(draws).toHaveLength(4);
  expect(blurs).toHaveLength(2);
  // The hole (a little bigger) is cut out of the scene, so the moved camera view shows through.
  const clip = steps[1];
  expect(clip.op).toBe(ENUMS.ClipOp.Difference);
  expect(clip.aa).toBe(true);
  expect(clip.path.loops).toBe(1);
  // One ring path, even-odd: the hole's outline and your face outline (a little smaller).
  const ring = draws[1];
  expect(ring.path.fill).toBe('evenOdd');
  expect(ring.path.loops).toBe(2);
  expect(ring.color).toBe(SKIN_COLOUR);
  expect(ring.blur).toBe(t.lib.config.SKIN.edgeBlur);
  // The tint: skin colour with a little sunset orange, see-through, soft, on the skin path only.
  const tint = draws[2];
  expect(tint.path.fill).toBe('evenOdd');
  expect(tint.path.loops).toBe(6);
  expect(tint.color).toBe('rgba(217,156,104,1)');
  expect(tint.alpha).toBe(t.lib.config.SKIN.liteTint);
  expect(tint.blur).toBe(6);
  // Never a camera shader or the comic look.
  expect(made.some((m) => m.kind === 'imageShader' || m.kind === 'comic')).toBe(false);
  expect(draws.every((d) => d.shader === null)).toBe(true);
  for (const thing of made) expect(trash).toContain(thing);
});

it('no face: the hole is filled with the character\'s skin colour (no clip), live and on a still', () => {
  const t = setup();
  for (const [face, fit, src, live] of [[null, null, null, true], [null, null, cameraSource(t), false], [t.face, null, cameraSource(t), true],
    // A still with a face but nothing to take it from, and a fit without its face.
    [t.face, t.fit, null, false], [null, t.fit, cameraSource(t), true]]) {
    const { steps, draws, blurs } = draw(t, { face, fit, src, live });
    expect(kinds(steps)).toEqual(['image:background', 'path', 'image:character']);
    expect(draws[1].color).toBe(SKIN_COLOUR);
    expect(draws[1].alpha).toBe(1);
    expect(steps.some((s) => s.kind === 'clip')).toBe(false);
    expect(blurs.length).toBeLessThanOrEqual(2);
  }
});

it('the photo: the same full drawing from the small photo, with mipmaps and the still numbers', () => {
  const t = setup();
  const toView = t.lib.frame.photoToView(1600, 1200, 1, 390, 844);
  const photo = { image: pretendImage(t.env, 'photo', 1600, 1200), toView, mipmaps: true };
  const { draws } = draw(t, { src: photo, live: false });
  expect(draws).toHaveLength(5);
  const picture = draws[2].shader.child;
  expect(picture.from).toBe('photo');
  expect(picture.mm).toBe(ENUMS.MipmapMode.Linear);
  expect(draws[2].shader.uniforms[8]).toBe(t.lib.shader.COMIC.posterMix);
});

it('broken numbers never reach a draw: a broken camera matrix goes lite (live) or no face (still), broken points no face', () => {
  const t = setup();
  const badSrc = cameraSource(t, [Number.NaN, 0, 0, 0, 1, 0]);
  expect(kinds(draw(t, { src: badSrc, live: true }).steps)).toEqual(['save', 'clip', 'image:background', 'restore', 'path', 'path', 'image:character']);
  expect(kinds(draw(t, { src: badSrc, live: false }).steps)).toEqual(['image:background', 'path', 'image:character']);
  // A broken face outline point (the fit only uses the eyes and the forehead, so it is still made).
  const face = makeFace(t.lib.MESH);
  face.pts[t.lib.MESH.faceOval[5] * 2] = Infinity;
  const fit = t.lib.fit.faceFit(face.pts, t.scene.art);
  expect(fit).not.toBeNull();
  expect(kinds(draw(t, { face, fit, src: cameraSource(t), live: true }).steps)).toEqual(['image:background', 'path', 'image:character']);
  // Broken art: no hole stuff at all, just the scene and the character.
  const art = { ...t.scene.art, hole: t.scene.art.hole.map((v, i) => (i === 7 ? Number.NaN : v)) };
  expect(kinds(draw(t, { scene: { ...t.scene, art }, src: cameraSource(t), live: true }).steps)).toEqual(['image:background', 'image:character']);
  // No scene picture: a plain dark sky fills the poster instead.
  const { draws } = draw(t, { scene: { ...t.scene, background: null }, src: cameraSource(t), live: true });
  expect(draws[0].kind).toBe('rect');
  expect(draws[0].rect).toEqual({ x: 0, y: 0, width: 1080, height: 1920 });
  expect(draws[0].alpha).toBe(1);
  // No scene at all: nothing drawn.
  expect(draw(t, { scene: null, src: cameraSource(t), live: true }).steps).toEqual([]);
});

it('never more than 7 draws and 2 blurs, whatever the face does', () => {
  const t = setup();
  let checked = 0;
  for (const scale of [0.6, 1, 1.4]) {
    for (const shift of [[0, 0], [40, -30], [-60, 80]]) {
      const face = makeFace(t.lib.MESH, shift, scale);
      const fit = t.lib.fit.faceFit(face.pts, t.scene.art);
      for (const [src, live, fx] of [[cameraSource(t), true, t.fx], [cameraSource(t), false, t.fx], [null, true, t.fx], [cameraSource(t), true, null], [null, false, null]]) {
        const { draws, blurs, error } = draw(t, { face, fit, src, live, fx });
        expect(error).toBeNull();
        expect(draws.length).toBeLessThanOrEqual(7);
        expect(blurs.length).toBeLessThanOrEqual(2);
        checked++;
      }
    }
  }
  expect(checked).toBe(45);
});

it('every Skia object made is on the trash list, also when a draw fails halfway (and the canvas is restored)', () => {
  const t = setup();
  const cases = [
    // The face draw fails (full).
    [{ src: cameraSource(t), live: true }, (s) => s.kind === 'path' && s.shader && s.shader.kind === 'comic'],
    // The skin draw inside the clip fails (full).
    [{ src: cameraSource(t), live: true }, (s) => s.kind === 'rect'],
    // The scene inside the clip fails (lite).
    [{ src: null, live: true }, (s) => s.kind === 'image' && s.image === 'background'],
    // The tint fails (lite).
    [{ src: null, live: true }, (s) => s.kind === 'path' && s.alpha < 1],
    // The character fails (no face).
    [{ face: null, fit: null, src: null, live: true }, (s) => s.kind === 'image' && s.image === 'character'],
  ];
  for (const [options, failOn] of cases) {
    const { error, made, trash, steps } = draw(t, { ...options, failOn });
    expect(error?.message).toBe('broken frame');
    expect(made.length).toBeGreaterThan(0);
    for (const thing of made) expect(trash, thing.kind).toContain(thing);
    expect(steps.filter((s) => s.kind === 'save').length).toBe(steps.filter((s) => s.kind === 'restore').length);
  }
});

// ---------------------------------------------------------------------------
// The poster from the screen (snapPoster) and from the photo (bakeMainCharacter), with the pretend Skia.
// ---------------------------------------------------------------------------

// A pretend surface: its canvas writes down what is drawn; its snapshot is a picture that can be copied or saved.
function pretendSurfaces(t, steps, options = {}) {
  const surfaces = [];
  const makeSurface = (kind) => (width, height) => {
    if (options.noSurface === kind) return null;
    const surface = { kind, width, height, disposed: false, flushed: 0, snapshots: [] };
    surface.dispose = () => { surface.disposed = true; };
    const record = pretendCanvas(options.failOn);
    surface.steps = record.steps;
    surface.getCanvas = () => record.canvas;
    surface.flush = () => { surface.flushed++; };
    surface.makeImageSnapshot = () => {
      if (options.snapshotFails) throw new Error('no snapshot');
      const image = { kind: 'snapshot', of: kind, width: () => width, height: () => height, disposed: false };
      image.dispose = () => { image.disposed = true; };
      image.makeNonTextureImage = () => ({ kind: 'plain copy', of: image });
      image.encodeToBytes = (format, quality) => {
        steps.push({ kind: 'encode', format, quality });
        return options.emptyJpeg ? new Uint8Array(0) : new Uint8Array([0xff, 0xd8, 0xff]);
      };
      image.makeShaderOptions = (tx, ty, fm, mm, matrix) => {
        const shader = { kind: 'imageShader', from: 'small photo', fm, mm, matrix: matrix.m, disposed: false };
        shader.dispose = () => { shader.disposed = true; };
        t.env.made.push(shader);
        return shader;
      };
      surface.snapshots.push(image);
      return image;
    };
    surfaces.push(surface);
    return surface;
  };
  t.env.module.Skia.Surface = { Make: makeSurface('cpu'), MakeOffscreen: makeSurface('gpu') };
  return surfaces;
}

it('snapPoster draws the poster once more off screen from the shown camera picture and hands back a plain copy', () => {
  const t = setup();
  const steps = [];
  const surfaces = pretendSurfaces(t, steps);
  const snap = t.lib.load('src/components/mainCharacter/snapPoster.ts');
  const shot = { image: pretendImage(t.env, 'camera', 1920, 1440), w: 1920, h: 1440, turn: 270, mirror: true, label: 90, front: true };
  const out = snap.snapPoster(t.scene, [t.face], shot, { width: 390, height: 844 }, null, t.fx);
  expect(out.kind).toBe('plain copy');
  expect(surfaces).toHaveLength(1);
  const [surface] = surfaces;
  expect([surface.kind, surface.width, surface.height]).toEqual(['gpu', 1080, 1920]);
  expect(surface.flushed).toBe(1);
  // Drawn the full way, with the still numbers, from the camera picture placed like the screen places it.
  const draws = surface.steps.filter((s) => ['rect', 'path', 'image'].includes(s.kind));
  expect(draws).toHaveLength(5);
  const picture = draws[2].shader.child;
  expect(picture.from).toBe('camera');
  expect(picture.mm).toBe(ENUMS.MipmapMode.None);
  const placed = t.lib.frame.placeShot(shot, 390, 844, null, 'rule');
  const expected = t.lib.fit.mul(t.lib.fit.fitMatrix(t.fit), placed.m);
  picture.matrix.slice(0, 6).forEach((v, i) => expect(v).toBeCloseTo(expected[i], 9));
  expect(draws[2].shader.uniforms[8]).toBe(t.lib.shader.COMIC.posterMix);
  // Everything except the plain copy is let go of.
  expect(surface.disposed).toBe(true);
  expect(surface.snapshots[0].disposed).toBe(true);
  expect(t.env.made.every((thing) => thing.disposed)).toBe(true);
});

it('snapPoster gives null (the caller uses the photo) when it can\'t, and still lets go of everything', () => {
  const view = { width: 390, height: 844 };
  const t = setup();
  const shot = { image: pretendImage(t.env, 'camera', 1920, 1440), w: 1920, h: 1440, turn: 270, mirror: true, label: 90, front: true };
  const warnings = [];
  const quiet = { warn: (...args) => warnings.push(args.join(' ')), log() {} };
  for (const [options, args] of [
    [{}, [t.scene, [t.face], null, view]],
    [{}, [t.scene, [], shot, view]],
    [{}, [t.scene, [makeFace(t.lib.MESH, [0, 0], 0.02)], shot, view]],
    [{}, [t.scene, [t.face], shot, { width: 0, height: 844 }]],
    [{}, [null, [t.face], shot, view]],
    [{ noSurface: 'gpu' }, [t.scene, [t.face], shot, view]],
    [{ failOn: (s) => s.kind === 'image' && s.image === 'character' }, [t.scene, [t.face], shot, view]],
    [{ snapshotFails: true }, [t.scene, [t.face], shot, view]],
  ]) {
    t.env.made.length = 0;
    const surfaces = pretendSurfaces(t, [], options);
    const lib = loadAll(t.env.module, { console: quiet });
    const snap = lib.load('src/components/mainCharacter/snapPoster.ts');
    expect(snap.snapPoster(...args, null, t.fx)).toBeNull();
    for (const surface of surfaces) {
      expect(surface.disposed).toBe(true);
      for (const image of surface.snapshots) expect(image.disposed).toBe(true);
    }
    expect(t.env.made.every((thing) => thing.disposed)).toBe(true);
  }
  expect(warnings).toHaveLength(2);
});

function bakeSetup(options = {}) {
  const t = setup();
  const steps = [];
  const surfaces = pretendSurfaces(t, steps, options);
  const files = [];
  const things = { data: null, whole: null, fromURI: 0, decoded: 0 };
  t.env.module.Skia.Data = {
    fromURI: async (uri) => {
      things.fromURI++;
      steps.push({ kind: 'read', uri });
      things.data = { kind: 'data', disposed: false };
      things.data.dispose = () => { things.data.disposed = true; };
      return things.data;
    },
  };
  t.env.module.Skia.Image = {
    MakeImageFromEncoded: () => {
      const [width, height] = options.photoSize ?? [4032, 3024];
      const whole = pretendImage(t.env, 'whole photo', width, height);
      whole.disposed = false;
      whole.dispose = () => { whole.disposed = true; };
      things.whole = whole;
      return whole;
    },
  };
  class File {
    constructor(dir, name) { this.uri = `${dir}/${name}`; files.push(this); }
    async write(bytes) { this.bytes = bytes; steps.push({ kind: 'write', uri: this.uri }); }
  }
  const lib = loadAll(t.env.module, { 'expo-file-system': { File, Paths: { cache: 'file:///cache' } } });
  const bake = lib.load('src/components/mainCharacter/bakeMainCharacter.ts');
  return { t, steps, surfaces, files, things, bake };
}

it('bakeMainCharacter makes the photo small first, draws the full poster from it and saves a JPEG 92 in the cache', async () => {
  const { t, steps, surfaces, files, things, bake } = bakeSetup();
  const uri = await bake.bakeMainCharacter('file:///photo.jpg', [t.face], { width: 390, height: 844 }, t.scene, t.fx);
  expect(uri).toMatch(/^file:\/\/\/cache\/main-character-\d+-\d+\.jpg$/);
  expect(files).toHaveLength(1);
  expect(files[0].bytes.length).toBeGreaterThan(0);
  // The small copy: 4032 × 3024 → at most PHOTO_MAX_SIDE on its long side, on the CPU.
  const [small, poster] = surfaces;
  expect([small.kind, small.width, small.height]).toEqual(['cpu', 1600, 1200]);
  const shrinkDraws = small.steps.filter((s) => s.kind === 'image');
  expect(shrinkDraws).toHaveLength(1);
  expect(shrinkDraws[0].image).toBe('whole photo');
  expect(shrinkDraws[0].to).toEqual({ x: 0, y: 0, width: 1600, height: 1200 });
  expect(shrinkDraws[0].fm).toBe(ENUMS.FilterMode.Linear);
  // The poster: 1080 × 1920, the full drawing from the small photo (with mipmaps), the still numbers.
  expect([poster.kind, poster.width, poster.height]).toEqual(['gpu', 1080, 1920]);
  const draws = poster.steps.filter((s) => ['rect', 'path', 'image'].includes(s.kind));
  expect(draws).toHaveLength(5);
  const picture = draws[2].shader.child;
  expect(picture.from).toBe('small photo');
  expect(picture.mm).toBe(ENUMS.MipmapMode.Linear);
  const expected = t.lib.fit.mul(t.lib.fit.fitMatrix(t.fit), t.lib.frame.photoToView(1600, 1200, 1, 390, 844));
  picture.matrix.slice(0, 6).forEach((v, i) => expect(v).toBeCloseTo(expected[i], 9));
  expect(steps.find((s) => s.kind === 'encode')).toEqual({ kind: 'encode', format: ENUMS.ImageFormat.JPEG, quality: 92 });
  // Everything let go of: the drawing's objects, the small photo, both surfaces, the poster picture, the data.
  expect(t.env.made.every((thing) => thing.disposed)).toBe(true);
  expect(things.whole.disposed).toBe(true);
  expect(things.data.disposed).toBe(true);
  for (const surface of surfaces) {
    expect(surface.disposed).toBe(true);
    for (const image of surface.snapshots) expect(image.disposed).toBe(true);
  }
});

it('bakeMainCharacter never makes a small photo bigger', async () => {
  const { t, surfaces, bake } = bakeSetup({ photoSize: [900, 1200] });
  await bake.bakeMainCharacter('file:///photo.jpg', [t.face], { width: 390, height: 844 }, t.scene, null);
  expect([surfaces[0].width, surfaces[0].height]).toEqual([900, 1200]);
});

it('bakeMainCharacter says NO_FACE (\'no-face\', what the screen looks for) before reading the photo, and throws (letting go of everything) when it can\'t', async () => {
  const none = bakeSetup();
  // The very same words the camera uses and the screen checks for (MainCharacterStudio.tsx shows "look at the
  // camera" only for these): the face was there a moment ago but is gone, or too small, by the time of the photo.
  expect(none.t.lib.config.NO_FACE).toBe('no-face');
  // (Its Error comes from the loaded file's own sandbox, so only the message is compared.)
  const exactly = (error) => error?.message === none.t.lib.config.NO_FACE;
  await expect(none.bake.bakeMainCharacter('file:///photo.jpg', [], { width: 390, height: 844 }, none.t.scene, none.t.fx)).rejects.toSatisfy(exactly);
  await expect(none.bake.bakeMainCharacter('file:///photo.jpg', [makeFace(none.t.lib.MESH, [0, 0], 0.02)], { width: 390, height: 844 }, none.t.scene, none.t.fx)).rejects.toSatisfy(exactly);
  await expect(none.bake.bakeMainCharacter('file:///photo.jpg', [none.t.face], { width: 0, height: 844 }, none.t.scene, none.t.fx)).rejects.toThrow();
  expect(none.things.fromURI).toBe(0);

  for (const options of [{ failOn: (s) => s.kind === 'path' }, { emptyJpeg: true }, { noSurface: 'cpu' }]) {
    const { t, surfaces, things, files, bake } = bakeSetup(options);
    await expect(bake.bakeMainCharacter('file:///photo.jpg', [t.face], { width: 390, height: 844 }, t.scene, t.fx)).rejects.toThrow();
    expect(files).toHaveLength(0);
    expect(t.env.made.every((thing) => thing.disposed)).toBe(true);
    expect(things.whole.disposed).toBe(true);
    expect(things.data.disposed).toBe(true);
    for (const surface of surfaces) {
      expect(surface.disposed).toBe(true);
      for (const image of surface.snapshots) expect(image.disposed).toBe(true);
    }
  }
});

// ---------------------------------------------------------------------------
// For real, with Skia's web version (CanvasKit).
// ---------------------------------------------------------------------------

let CK;
beforeAll(async () => {
  const ckPath = require.resolve('canvaskit-wasm/bin/canvaskit.js');
  CK = await require(ckPath)({ locateFile: (file) => resolve(dirname(ckPath), file) });
}, 60_000);

// The app's Skia calls, done by CanvasKit ("dispose" is CanvasKit's "delete").
function realSkia() {
  const disposable = (thing) => {
    thing.dispose = () => thing.delete();
    return thing;
  };
  const Skia = {
    Paint: () => disposable(new CK.Paint()),
    Color: (c) => CK.parseColorString(c),
    XYWHRect: (x, y, w, h) => CK.XYWHRect(x, y, w, h),
    Matrix: (m) => Object.assign([...m], { dispose() {} }),
    MaskFilter: { MakeBlur: (style, sigma, ctm) => disposable(CK.MaskFilter.MakeBlur(style, sigma, ctm)) },
    PathBuilder: {
      Make: () => {
        const builder = new CK.PathBuilder();
        return {
          setFillType: (f) => builder.setFillType(f),
          moveTo: (x, y) => builder.moveTo(x, y),
          quadTo: (a, b, c, d) => builder.quadTo(a, b, c, d),
          lineTo: (x, y) => builder.lineTo(x, y),
          close: () => builder.close(),
          detach: () => disposable(builder.detach()),
          dispose: () => builder.delete(),
        };
      },
    },
  };
  const module = {
    Skia, BlurStyle: CK.BlurStyle, ClipOp: CK.ClipOp, FillType: CK.FillType, FilterMode: CK.FilterMode, MipmapMode: CK.MipmapMode, TileMode: CK.TileMode,
  };
  return module;
}

// A picture from a function (x, y) → [r, g, b, a], wrapped like an SkImage.
function realImage(width, height, colour) {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = colour(x + 0.5, y + 0.5);
      const i = (y * width + x) * 4;
      pixels.set([Math.round((r * a) / 255), Math.round((g * a) / 255), Math.round((b * a) / 255), a], i);
    }
  }
  const ck = CK.MakeImage({ width, height, alphaType: CK.AlphaType.Premul, colorType: CK.ColorType.RGBA_8888, colorSpace: CK.ColorSpace.SRGB }, pixels, width * 4);
  return {
    ck, w: width, h: height,
    makeShaderOptions: (tx, ty, fm, mm, matrix) => {
      const shader = ck.makeShaderOptions(tx, ty, fm, mm, matrix);
      shader.dispose = () => shader.delete();
      return shader;
    },
  };
}

// Draws the poster at a quarter size (270 × 480) and gives a way to read its pixels in poster pixels.
function renderPoster(lib, scene, face, src, live, fx) {
  const surface = CK.MakeSurface(270, 480);
  const ck = surface.getCanvas();
  ck.clear(CK.TRANSPARENT);
  ck.scale(0.25, 0.25);
  const canvas = {
    save: () => ck.save(), restore: () => ck.restore(), clipPath: (p, op, aa) => ck.clipPath(p, op, aa),
    drawRect: (r, p) => ck.drawRect(r, p), drawPath: (p, paint) => ck.drawPath(p, paint),
    drawImageRectOptions: (image, from, to, fm, mm, paint) => ck.drawImageRectOptions(image.ck, from, to, fm, mm, paint),
  };
  const fit = face ? lib.fit.faceFit(face.pts, scene.art) : null;
  const trash = [];
  try {
    lib.paint.paintMainCharacter(canvas, scene, face, fit, src, live, fx, trash);
  } finally {
    for (const thing of trash.reverse()) thing.dispose();
  }
  surface.flush();
  const snap = surface.makeImageSnapshot();
  const pixels = snap.readPixels(0, 0, { width: 270, height: 480, alphaType: CK.AlphaType.Unpremul, colorType: CK.ColorType.RGBA_8888, colorSpace: CK.ColorSpace.SRGB });
  snap.delete();
  surface.delete();
  return (x, y) => {
    const i = (Math.floor(y / 4) * 270 + Math.floor(x / 4)) * 4;
    return Array.from(pixels.slice(i, i + 4));
  };
}

const near = (pixel, rgb, tolerance) => rgb.every((v, c) => Math.abs(pixel[c] - v) <= tolerance);

it('for real (CanvasKit): your face lands in the hole with the comic look, the scene behind and the character in front', () => {
  const skiaModule = realSkia();
  const lib = loadAll(skiaModule);
  let error = '';
  const effect = CK.RuntimeEffect.Make(lib.shader.COMIC_SHADER, (e) => { error = e; });
  expect(error).toBe('');
  const fx = { makeShaderWithChildren: (u, kids) => { const s = effect.makeShaderWithChildren(u, kids); s.dispose = () => s.delete(); return s; } };
  // The scene: plain blue. The character: green, see-through above its head and in its face hole.
  const background = realImage(90, 160, () => [20, 40, 230, 255]);
  const character = realImage(108, 192, (x, y) => {
    const inHole = Math.hypot((x / 108 - HOLE.cx) / HOLE.rx, (y / 192 - HOLE.cy) / HOLE.ry) < 1;
    return inHole || y < 4 ? [0, 0, 0, 0] : [30, 190, 60, 255];
  });
  const scene = sceneFor(lib, character, background);
  // The camera picture (the same size as the 390 × 844 view): white, with a red face oval and blue eye spots.
  const face = makeFace(lib.MESH);
  const camera = realImage(390, 844, (x, y) => {
    if (Math.hypot(x - 165, y - 380) < 8 || Math.hypot(x - 225, y - 380) < 8) return [40, 50, 230, 255];
    if (Math.hypot((x - 195) / 82, (y - 425) / 107) < 1) return [220, 50, 40, 255];
    return [255, 255, 255, 255];
  });
  const src = { image: camera, toView: [1, 0, 0, 0, 1, 0], mipmaps: false };
  const art = scene.art;
  // Where things are on the poster (poster pixels).
  const faceMiddle = [540, (art.eyes[1] + art.eyes[3]) / 2 + 80];
  const plateSpot = [art.hole[54] + 26, art.hole[55]];  // inside the hole's left edge, outside your face
  const sky = [540, 60];
  const body = [540, 1500];
  const side = [16, 1200];

  for (const live of [false, true]) {
    const pixel = renderPoster(lib, scene, face, src, live, fx);
    // Your face (red, made more colourful) in the hole, the eyes where the character's eyes are.
    const mid = pixel(...faceMiddle);
    expect(mid[0]).toBeGreaterThan(150);
    expect(mid[1]).toBeLessThan(90);
    expect(mid[3]).toBe(255);
    for (const k of [0, 2]) {
      const eye = pixel(art.eyes[k], art.eyes[k + 1]);
      expect(eye[2], `eye ${k}`).toBeGreaterThan(eye[0]);
    }
    // The skin plate round your face, the sky above the character, the character's body, the scene at the side.
    expect(near(pixel(...plateSpot), [200, 150, 110], 30)).toBe(true);
    expect(near(pixel(...sky), [20, 40, 230], 3)).toBe(true);
    expect(near(pixel(...body), [30, 190, 60], 3)).toBe(true);
    expect(near(pixel(...side), [20, 40, 230], 3)).toBe(true);
  }

  // Without the comic look: still your face in the hole.
  const plain = renderPoster(lib, scene, face, src, true, null);
  expect(plain(...faceMiddle)[0]).toBeGreaterThan(150);
  expect(near(plain(...body), [30, 190, 60], 3)).toBe(true);

  // No face: the hole is the character's skin colour.
  const none = renderPoster(lib, scene, null, src, true, fx);
  expect(near(none(...faceMiddle), [200, 150, 110], 3)).toBe(true);
  expect(none(...faceMiddle)[3]).toBe(255);

  // Lite: the hole is left open (the real camera view shows there), with a skin ring round your face.
  const lite = renderPoster(lib, scene, face, null, true, fx);
  expect(lite(...faceMiddle)[3]).toBeLessThan(60);
  const ring = lite(...plateSpot);
  expect(ring[3]).toBeGreaterThan(240);
  expect(near(ring, [200, 150, 110], 30)).toBe(true);
  expect(near(lite(...sky), [20, 40, 230], 3)).toBe(true);
  expect(near(lite(...body), [30, 190, 60], 3)).toBe(true);
});
