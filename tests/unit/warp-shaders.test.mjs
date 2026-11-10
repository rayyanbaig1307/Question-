import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { beforeAll, expect, it } from 'vitest';

// The 4 stretchy filters' GPU programs (src/components/lens/warp/shaders.ts), compiled and run with Skia's own
// web version (CanvasKit, the same Skia family as the app). Each one is drawn on a test pattern (a checkerboard
// with a soft colour ramp): outside its area the picture must stay exactly the same (so it can be drawn over
// the camera with no seam), and inside it the picture must really change. With two faces close together, the
// second face's warp must leave the first face's warp alone wherever it changes nothing itself (each warp is
// see-through there), instead of painting the plain picture back over it.

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../..');

function loadShaders() {
  const code = ts.transpileModule(readFileSync(resolve(root, 'src/components/lens/warp/shaders.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: (id) => { throw new Error(`shaders.ts must not import ${id}`); } });
  return module.exports;
}

const SIZE = 200;
let CK;
let shaders;
let effects;
let pattern;

beforeAll(async () => {
  const ckPath = require.resolve('canvaskit-wasm/bin/canvaskit.js');
  CK = await require(ckPath)({ locateFile: (file) => resolve(dirname(ckPath), file) });
  shaders = loadShaders();
  effects = {};
  for (const name of Object.keys(shaders.SHADERS)) {
    let error = '';
    effects[name] = CK.RuntimeEffect.Make(shaders.SHADERS[name], (e) => { error = e; });
    if (!effects[name]) throw new Error(`${name} did not compile: ${error}`);
  }
  // The test pattern: 8-pixel checkerboard squares on a slow colour ramp.
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const on = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0;
      const i = (y * SIZE + x) * 4;
      pixels[i] = on ? 230 : 30;
      pixels[i + 1] = Math.round((x / SIZE) * 200);
      pixels[i + 2] = Math.round((y / SIZE) * 200);
      pixels[i + 3] = 255;
    }
  }
  pattern = CK.MakeImage(
    { width: SIZE, height: SIZE, alphaType: CK.AlphaType.Premul, colorType: CK.ColorType.RGBA_8888, colorSpace: CK.ColorSpace.SRGB },
    pixels,
    SIZE * 4,
  );
}, 60_000);

function imageShader() {
  return pattern.makeShaderOptions(CK.TileMode.Clamp, CK.TileMode.Clamp, CK.FilterMode.Linear, CK.MipmapMode.None, CK.Matrix.identity());
}

// Draws the pattern (like the camera picture), then optionally the warp over the whole picture; gives the pixels.
function render(name, uniforms) {
  return renderPasses(name ? [[name, uniforms]] : []);
}

// The pattern, then each warp [name, uniforms] in turn, each one over the whole picture (like two faces, one
// after the other); gives the pixels.
function renderPasses(passes) {
  const surface = CK.MakeSurface(SIZE, SIZE);
  const canvas = surface.getCanvas();
  const paint = new CK.Paint();
  paint.setShader(imageShader());
  canvas.drawRect(CK.XYWHRect(0, 0, SIZE, SIZE), paint);
  for (const [name, uniforms] of passes) {
    const warp = new CK.Paint();
    warp.setShader(effects[name].makeShaderWithChildren(uniforms, [imageShader()]));
    canvas.drawRect(CK.XYWHRect(0, 0, SIZE, SIZE), warp);
    warp.delete();
  }
  paint.delete();
  surface.flush();
  const image = surface.makeImageSnapshot();
  const out = image.readPixels(0, 0, { width: SIZE, height: SIZE, alphaType: CK.AlphaType.Premul, colorType: CK.ColorType.RGBA_8888, colorSpace: CK.ColorSpace.SRGB });
  image.delete();
  surface.delete();
  return out;
}

// Compares the warped picture with the plain one: how many pixels changed inside `inside(x, y)` and how many
// changed where `outside(x, y)` is true.
function compare(name, uniforms, inside, outside) {
  const plain = render(null);
  const warped = render(name, uniforms);
  let changedIn = 0;
  let totalIn = 0;
  let changedOut = 0;
  let totalOut = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const diff = Math.max(...[0, 1, 2, 3].map((c) => Math.abs(plain[i + c] - warped[i + c])));
      const px = x + 0.5;
      const py = y + 0.5;
      if (inside(px, py)) {
        totalIn++;
        if (diff > 8) changedIn++;
      }
      if (outside(px, py)) {
        totalOut++;
        if (diff > 2) changedOut++;
      }
    }
  }
  return { changedIn, totalIn, changedOut, totalOut };
}

it('all 4 shaders compile and take exactly the numbers the drawing code hands them', () => {
  expect(Object.keys(shaders.SHADERS).sort()).toEqual(['BALLOON', 'PIXEL', 'SHRINK', 'STRETCH']);
  for (const [name, floats] of Object.entries(shaders.UNIFORM_FLOATS)) {
    expect(effects[name].getUniformFloatCount(), name).toBe(floats);
  }
  expect(shaders.UNIFORM_FLOATS).toEqual({ BALLOON: 7, SHRINK: 10, STRETCH: 11, PIXEL: 36 });
  expect(shaders.MAX_SLICES).toBe(7);
});

it('😃 BALLOON magnifies inside its oval and leaves everything outside exactly as it was', () => {
  const r = (x, y) => Math.hypot((x - 100) / 40, (y - 100) / 30);
  const { changedIn, totalIn, changedOut, totalOut } = compare('BALLOON', [100, 100, 1, 0, 40, 30, 2], (x, y) => r(x, y) < 0.6, (x, y) => r(x, y) > 1.03);
  expect(totalOut).toBeGreaterThan(30000);
  expect(changedOut).toBe(0);
  expect(changedIn / totalIn).toBeGreaterThan(0.3);
  // Scale 1 (or less) changes nothing at all.
  expect(compare('BALLOON', [100, 100, 1, 0, 40, 30, 1], () => true, () => true).changedOut).toBe(0);
});

it('🫥 SHRINK puts a smaller copy in its oval with a soft edge and leaves the rest alone', () => {
  const r = (x, y) => Math.hypot((x - 100) / 45, (y - 110) / 55);
  const { changedIn, totalIn, changedOut } = compare('SHRINK', [100, 100, 100, 110, 1, 0, 45, 55, 0.35, 0.5], (x, y) => r(x, y) < 0.45, (x, y) => r(x, y) > 1.03);
  expect(changedOut).toBe(0);
  expect(changedIn / totalIn).toBeGreaterThan(0.3);
});

it('🗿 STRETCH stretches only under the lip line and inside its width, and eases back to the plain picture', () => {
  const height = 50;
  const sy = 1.6;
  const release = 0.35 * height * sy;
  const uniforms = [100, 60, 1, 0, 0, 1, 50, height, 1.15, sy, release];
  const { changedIn, totalIn, changedOut, totalOut } = compare(
    'STRETCH', uniforms,
    (x, y) => Math.abs(x - 100) < 30 && y > 70 && y < 60 + height * sy,
    // Above the lip line, beside it, and below where the stretch has eased back.
    (x, y) => y < 59 || Math.abs(x - 100) > 51 || y > 60 + height * sy + release + 1,
  );
  expect(totalOut).toBeGreaterThan(20000);
  expect(changedOut).toBe(0);
  expect(changedIn / totalIn).toBeGreaterThan(0.3);
});

it('👾 PIXEL pixelates the face box and tears slices, and leaves the rest of the picture alone', () => {
  const slices = [70, 10, 20, 0, 100, 8, -15, 1];
  while (slices.length < 28) slices.push(0, 0, 0, 0);
  const uniforms = [60, 60, 80, 80, 10, 0.3, 1, 2, ...slices];
  const { changedIn, totalIn, changedOut, totalOut } = compare(
    'PIXEL', uniforms,
    (x, y) => Math.hypot(x - 100, y - 100) < 25,
    (x, y) => x < 30 || x > 175 || y < 59 || y > 141,
  );
  expect(totalOut).toBeGreaterThan(15000);
  expect(changedOut).toBe(0);
  expect(changedIn / totalIn).toBeGreaterThan(0.3);
  // No glitch (block 0, no slices): nothing changes anywhere.
  const calm = [60, 60, 80, 80, 0, 0.3, 0, 0, ...new Array(28).fill(0)];
  expect(compare('PIXEL', calm, () => true, () => true).changedOut).toBe(0);
});

// Two faces: the first face's warp alone, the second's alone, and both (first, then second). Wherever the second
// face's warp changes nothing (`secondLeavesAlone`), "both" must look exactly like the first face's warp alone.
// Gives how many of the first face's changed pixels are in that area (so the check means something) and how
// many of them the second warp wiped out.
function twoFaces(first, second, secondLeavesAlone) {
  const plain = render(null);
  const onlyFirst = renderPasses([first]);
  const both = renderPasses([first, second]);
  let checked = 0;
  let lost = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (!secondLeavesAlone(x + 0.5, y + 0.5)) continue;
      const i = (y * SIZE + x) * 4;
      const firstChanged = [0, 1, 2].some((c) => Math.abs(onlyFirst[i + c] - plain[i + c]) > 8);
      if (!firstChanged) continue;
      checked++;
      if ([0, 1, 2, 3].some((c) => Math.abs(both[i + c] - onlyFirst[i + c]) > 2)) lost++;
    }
  }
  return { checked, lost };
}

it('👾 two faces side by side: the second face\'s PIXEL pass keeps the first face\'s big pixels', () => {
  const noSlices = new Array(28).fill(0);
  const first = ['PIXEL', [20, 60, 70, 80, 10, 0.3, 1, 0, ...noSlices]];
  // The second face's box starts 10 points to the right of the first one's (its drawn box reaches further left).
  const second = ['PIXEL', [100, 60, 70, 80, 9, 0.3, 1, 0, ...noSlices]];
  const outsideSecondOval = (x, y) => Math.hypot((x - 135) / 35, (y - 100) / 40) > 1.02;
  const { checked, lost } = twoFaces(first, second, outsideSecondOval);
  expect(checked).toBeGreaterThan(2000);
  expect(lost).toBe(0);
});

it('🗿 two tilted heads close together: the second chin\'s STRETCH pass keeps the first stretched chin', () => {
  // One chin's numbers: where the stretch starts, the head's tilt (radians), half the face's width, the height.
  const chin = (x, y, tilt, halfWidth, height) => {
    const downX = -Math.sin(tilt);
    const downY = Math.cos(tilt);
    const sy = 1.6;
    return { uniforms: [x, y, downY, -downX, downX, downY, halfWidth, height, 1.15, sy, 0.35 * height * sy], x, y, downX, downY, halfWidth, height, sy };
  };
  const a = chin(65, 40, 0.35, 40, 45);
  const b = chin(130, 55, -0.3, 40, 45);
  // Where the second stretch changes nothing: above its lip line, beside it, or below where it eased back.
  const secondLeavesAlone = (x, y) => {
    const u = (x - b.x) * b.downY - (y - b.y) * b.downX;
    const v = (x - b.x) * b.downX + (y - b.y) * b.downY;
    const stretched = b.height * b.sy;
    return v < -1 || Math.abs(u) / b.halfWidth > 1.02 || v > stretched + 0.35 * stretched + 1;
  };
  const { checked, lost } = twoFaces(['STRETCH', a.uniforms], ['STRETCH', b.uniforms], secondLeavesAlone);
  expect(checked).toBeGreaterThan(500);
  expect(lost).toBe(0);
});

it('drawn over the camera picture, a see-through pass still leaves a fully solid picture, plain far outside', () => {
  const slices = [70, 10, 20, 0, 100, 8, -15, 1];
  while (slices.length < 28) slices.push(0, 0, 0, 0);
  const pixel = render('PIXEL', [60, 60, 80, 80, 10, 0.3, 1, 2, ...slices]);
  const plain = render(null);
  // Every pixel is fully opaque (nothing see-through is left on the screen).
  for (let i = 3; i < pixel.length; i += 4) expect(pixel[i]).toBe(255);
  // Far outside the box: exactly the plain picture.
  for (const [x, y] of [[5, 5], [190, 190], [5, 190], [190, 5]]) {
    const i = (y * SIZE + x) * 4;
    expect([...pixel.slice(i, i + 4)]).toEqual([...plain.slice(i, i + 4)]);
  }
});
