import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';

// The 4 stretchy filters need the camera's own pixels, which only the newest downloads have (the package
// react-native-vision-camera-worklets). Every app update also goes to the older downloads (App Store build 10,
// TestFlight 7–9, old Android APKs, Expo Go), which must keep working exactly as before. These checks guard that:
// - nothing loads react-native-vision-camera-worklets itself, in any way (import, side-effect import, export …
//   from, require, import(), or a file inside the package): loading it on an old download closes the app;
// - only warp/FrameFeed.tsx uses the camera hooks that load that package (useFrameOutput, useDepthOutput,
//   useAsyncRunner), and FrameFeed is only loaded when FRAME_ACCESS_AVAILABLE;
// - the camera's `zoom` and `exposure` are only ever given plain numbers: given a moving value (a Reanimated
//   SharedValue), the camera loads that package too. This is checked with TypeScript's own types, on every
//   <Camera> (VisionCamera's and the face detector's) and every call into those packages, and the check is
//   tried on a made-up file that does it wrong, to prove it catches it;
// - FRAME_ACCESS_AVAILABLE (src/lib/frameAccess.ts) is false wherever the pixels can't be had;
// - markFramesBroken remembers a failure for this download only when the stretchy filters themselves must be
//   the cause (or a camera error came just after they switched on, in two different app starts) – never for
//   failed camera pictures (they are skipped, and only switch the filters off until the app closes);
// - the stretchy filters' fix of 12 Nov stays in: no Canvas onSize (it included the pager's shrink: 92 % size),
//   YUV pictures on iPhone (never 'native'), and the readout's parts load nothing from the camera packages.

const root = resolve(import.meta.dirname, '../..');
const WORKLETS = 'react-native-vision-camera-worklets';

function sourceFiles(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name)) found.push(path);
  }
  return found;
}

const files = sourceFiles(join(root, 'src'));

// The code only (comments may name the package and the hook to explain them).
function codeOf(file) {
  const text = readFileSync(file, 'utf8');
  // Comments out (a TypeScript scan keeps strings and code as they are).
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, file.endsWith('x') ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard, text);
  let out = '';
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) continue;
    out += scanner.getTokenText();
  }
  return out;
}

// Everything a file loads, as TypeScript itself finds it (comments are skipped): import … from, import '…',
// export … from, require('…') and import('…').
function loadedBy(text) {
  return ts.preProcessFile(text, true, true).importedFiles.map((f) => f.fileName);
}
const loadsWorklets = (spec) => spec === WORKLETS || spec.startsWith(`${WORKLETS}/`);

it('the import finder sees every way of loading the package (so the check below means something)', () => {
  const sample = [
    `import '${WORKLETS}';`,
    `import x from '${WORKLETS}/lib/index';`,
    `export { y } from '${WORKLETS}';`,
    `const z = require('${WORKLETS}/lib/module');`,
    `const w = import('${WORKLETS}');`,
    `// require('${WORKLETS}') in a comment is fine`,
  ].join('\n');
  expect(loadedBy(sample).filter(loadsWorklets)).toEqual([WORKLETS, `${WORKLETS}/lib/index`, WORKLETS, `${WORKLETS}/lib/module`, WORKLETS]);
});

it('no app file loads react-native-vision-camera-worklets (the camera loads it itself, only when it is needed)', () => {
  expect(files.length).toBeGreaterThan(50);
  for (const file of files) {
    expect(loadedBy(readFileSync(file, 'utf8')).filter(loadsWorklets), relative(root, file)).toEqual([]);
  }
});

it('only warp/FrameFeed.tsx uses the camera hooks that load the package, and nothing imports FrameFeed for real', () => {
  const users = files.filter((file) => /\b(useFrameOutput|useDepthOutput|useAsyncRunner)\b/.test(codeOf(file))).map((file) => relative(root, file));
  expect(users).toEqual(['src/components/lens/warp/FrameFeed.tsx']);
  for (const file of files) {
    const code = codeOf(file);
    // Types are fine (they vanish); a real import would load it on every download.
    expect(code, relative(root, file)).not.toMatch(/import[^;]*from\s*['"][^'"]*FrameFeed['"]/);
    if (!file.endsWith('SoftGlowCamera.tsx')) expect(code, relative(root, file)).not.toMatch(/require\s*\(\s*['"][^'"]*FrameFeed['"]/);
  }
});

// ---------------------------------------------------------------------------
// The camera's `zoom` and `exposure`: plain numbers only. VisionCamera 5.2.4 also takes a Reanimated SharedValue
// there (smoother pinch zoom), but then it loads react-native-vision-camera-worklets (useZoomUpdater,
// useExposureUpdater), which closes the app on every older download. Checked with TypeScript's own types on every
// <Camera> from VisionCamera or the face detector (attributes and {...spreads}) and every call into those packages
// (like useCamera({ zoom })), however they are imported or renamed.
// ---------------------------------------------------------------------------

const CAMERA_PACKAGE = /[\\/]node_modules[\\/]react-native-vision-camera(-face-detector)?[\\/]/;
const PROBE = join(root, 'src/__frame_guard_probe__.tsx');
// A made-up file (never written to disk) that gets it wrong in every way the check must catch.
const PROBE_TEXT = `
import { Camera, useCamera } from 'react-native-vision-camera';
import { Camera as FaceCamera } from 'react-native-vision-camera-face-detector';
import { useSharedValue } from 'react-native-reanimated';
export function Probe({ n }: { n: number }) {
  const zoom = useSharedValue(1);
  const props = { exposure: zoom };
  useCamera({ device: 'back', isActive: true, outputs: [], zoom });
  return (
    <>
      <Camera device="back" isActive outputs={[]} zoom={zoom} />
      <Camera device="back" isActive outputs={[]} zoom={n > 0 ? 1 + n : undefined} exposure={0} />
      <FaceCamera {...props} />
      <FaceCamera {...(props as any)} />
    </>
  );
}`;

// Every place in `fileNames` that gives the camera a zoom or exposure that isn't a plain number (or undefined).
function cameraNumberProblems(fileNames, extra = null) {
  const parsed = ts.getParsedCommandLineOfConfigFile(join(root, 'tsconfig.json'), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); },
  });
  const options = { ...parsed.options, noEmit: true };
  const host = ts.createCompilerHost(options, true);
  if (extra) {
    const { getSourceFile, fileExists, readFile } = host;
    const isExtra = (name) => resolve(name) === extra.file;
    host.getSourceFile = (name, language, ...rest) => (isExtra(name) ? ts.createSourceFile(name, extra.text, language, true, ts.ScriptKind.TSX) : getSourceFile.call(host, name, language, ...rest));
    host.fileExists = (name) => isExtra(name) || fileExists.call(host, name);
    host.readFile = (name) => (isExtra(name) ? extra.text : readFile.call(host, name));
  }
  const program = ts.createProgram({ rootNames: extra ? [...fileNames, extra.file] : fileNames, options, host });
  const checker = program.getTypeChecker();
  const fromCameraPackage = (node) => {
    let symbol = checker.getSymbolAtLocation(node);
    if (!symbol) return false;
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return (symbol.declarations ?? []).some((d) => CAMERA_PACKAGE.test(d.getSourceFile().fileName));
  };
  const plainNumber = (type) => !(type.flags & ts.TypeFlags.Any)
    && (type.isUnion() ? type.types : [type]).every((part) => part.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.Undefined));
  const problems = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (!fileNames.includes(sourceFile.fileName) && !(extra && resolve(sourceFile.fileName) === extra.file)) continue;
    const visit = (node) => {
      const where = () => `${relative(root, sourceFile.fileName)}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
      const checkType = (key, type) => { if (!plainNumber(type)) problems.push(`${where()} ${key}: ${checker.typeToString(type)}`); };
      // Props given as one object (a {...spread}, or useCamera's argument): its zoom and exposure, if it has them.
      const checkProps = (type, anyIsWrong) => {
        if (type.flags & ts.TypeFlags.Any) {
          if (anyIsWrong) problems.push(`${where()} props that can't be checked (any)`);
          return;
        }
        for (const key of ['zoom', 'exposure']) {
          const prop = type.getProperty(key);
          if (prop) checkType(key, checker.getTypeOfSymbol(prop));
        }
      };
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && fromCameraPackage(node.tagName)) {
        for (const attr of node.attributes.properties) {
          if (ts.isJsxSpreadAttribute(attr)) checkProps(checker.getTypeAtLocation(attr.expression), true);
          else if (['zoom', 'exposure'].includes(attr.name.getText())) {
            const value = attr.initializer && ts.isJsxExpression(attr.initializer) ? attr.initializer.expression : attr.initializer;
            checkType(attr.name.getText(), value ? checker.getTypeAtLocation(value) : checker.getAnyType());
          }
        }
      }
      if (ts.isCallExpression(node) && fromCameraPackage(node.expression)) {
        const isUseCamera = /\buseCamera$/.test(node.expression.getText());
        for (const arg of node.arguments) checkProps(checker.getTypeAtLocation(arg), isUseCamera);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return problems;
}

it('the camera\'s zoom and exposure are only ever plain numbers (a moving value would load the package)', () => {
  const cameraFiles = files.filter((file) => /\.tsx?$/.test(file) && /react-native-vision-camera/.test(readFileSync(file, 'utf8')));
  // Both cameras the app uses are among them.
  expect(cameraFiles.map((file) => relative(root, file))).toEqual(expect.arrayContaining([
    'src/components/home/FaceLensCamera.tsx', 'src/components/lens/SoftGlowCamera.tsx',
  ]));
  // The check finds every wrong way in the made-up file…
  expect(cameraNumberProblems([], { file: PROBE, text: PROBE_TEXT })).toEqual([
    'src/__frame_guard_probe__.tsx:8 zoom: SharedValue<number>',
    'src/__frame_guard_probe__.tsx:11 zoom: SharedValue<number>',
    'src/__frame_guard_probe__.tsx:13 exposure: SharedValue<number>',
    "src/__frame_guard_probe__.tsx:14 props that can't be checked (any)",
  ]);
  // …and the app has none.
  expect(cameraNumberProblems(cameraFiles)).toEqual([]);
}, 60_000);

// Loads a .tsx/.ts file with every import replaced by `mods` (anything missing is an error).
function loadWith(file, mods, required = []) {
  const code = ts.transpileModule(readFileSync(join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, console: { warn() {}, log() {}, error() {} }, Promise,
    require: (id) => {
      required.push(id);
      if (id in mods) {
        const value = mods[id];
        if (value instanceof Error) throw value;
        return value;
      }
      throw new Error(`unexpected import ${id}`);
    },
  });
  return module.exports;
}

// `channel`: what lensDiagnosticsOn asks (it must not even be asked on a download without the camera's pixels).
function softGlowMods(available, broken, asked = []) {
  const reactStub = { Component: class {}, useCallback: (f) => f, useImperativeHandle() {}, useRef: (v) => ({ current: v }), useState: (v) => [v, () => {}] };
  return {
    'expo-image-manipulator': { FlipType: {}, ImageManipulator: {}, SaveFormat: {} },
    react: reactStub,
    'react/jsx-runtime': { jsx() {}, jsxs() {}, Fragment: 'Fragment' },
    'react-native': { StyleSheet: { absoluteFill: {} }, View: 'View' },
    'react-native-reanimated': { useSharedValue: (v) => ({ value: v }) },
    'react-native-vision-camera': { Camera: 'Camera', usePhotoOutput() {} },
    '@/lib/faceMesh': { cameraAxes() {}, toScreenPointsFrom() {}, useFaceMeshOutput() {} },
    '@/lib/frameAccess': { FRAME_ACCESS_AVAILABLE: available, FRAME_SETUP_MS: 4000, markFramesBroken: (why) => broken.push(why), useWarpLooksOn: () => available },
    '@/lib/lensDiagnostics': { lensDiagnosticsOn: () => { asked.push('channel'); return false; } },
    '@/lib/lensLooks': { isWarpLook: () => false },
    './bakeLook': { bakeLook() {} },
    './faceTrack': { newTrackMemory() {}, trackFaces() {} },
    './LensOverlay': { LensOverlay: 'LensOverlay' },
    './lensPaint': { MAX_LENS_FACES: 2 },
    './warp/FrameFeed': new Error('FrameFeed must not load here'),
    './warp/WarpDiagnostics': { WarpDiagnostics: 'WarpDiagnostics' },
  };
}

it('SoftGlowCamera never loads FrameFeed on a download without the camera\'s pixels', () => {
  const required = [];
  const broken = [];
  const asked = [];
  expect(() => loadWith('src/components/lens/SoftGlowCamera.tsx', softGlowMods(false, broken, asked), required)).not.toThrow();
  expect(required).not.toContain('./warp/FrameFeed');
  expect(broken).toEqual([]);
  // The readout's channel isn't even asked for there.
  expect(asked).toEqual([]);
});

it('the readout (WarpDiagnostics) and its pure parts load nothing from the camera packages', () => {
  // Loaded on its own with only what it is allowed: anything else would throw.
  const required = [];
  const mods = {
    react: { useEffect() {}, useState: (v) => [v, () => {}] },
    'react/jsx-runtime': { jsx() {}, jsxs() {}, Fragment: 'Fragment' },
    'react-native': { Platform: { OS: 'ios' }, StyleSheet: { create: (v) => v }, Text: 'Text', View: 'View' },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0 }) },
    '@/lib/frameAccess': { FRAME_PLACEMENT: 'rule' },
    '@/lib/lensDiagnostics': { formatWarpLine: () => '' },
    './frameMatrix': {},
  };
  expect(() => loadWith('src/components/lens/warp/WarpDiagnostics.tsx', mods, required)).not.toThrow();
  const camera = (spec) => /react-native-vision-camera|react-native-worklets|FrameFeed/.test(spec);
  expect(required.filter(camera)).toEqual([]);
  for (const file of ['src/components/lens/warp/feedLogic.ts', 'src/lib/lensDiagnostics.ts', 'src/components/lens/warp/WarpDiagnostics.tsx', 'src/components/lens/warp/frameMatrix.ts']) {
    expect(loadedBy(readFileSync(join(root, file), 'utf8')).filter(camera), file).toEqual([]);
  }
  // feedLogic.ts loads nothing at all; lensDiagnostics.ts only expo-updates (and only when asked).
  expect(loadedBy(readFileSync(join(root, 'src/components/lens/warp/feedLogic.ts'), 'utf8'))).toEqual([]);
  expect(loadedBy(readFileSync(join(root, 'src/lib/lensDiagnostics.ts'), 'utf8'))).toEqual(['expo-updates']);
});

it('only FrameFeed makes the shared counters (so downloads without the camera\'s pixels never make them)', () => {
  const users = files.filter((file) => /\bcreateSynchronizable\b/.test(codeOf(file))).map((file) => relative(root, file));
  expect(users).toEqual(['src/components/lens/warp/FrameFeed.tsx']);
});

it('no Canvas takes its size from onSize (it includes the pager\'s shrink animation: the picture was 92 % big)', () => {
  for (const file of files) {
    expect(codeOf(file), relative(root, file)).not.toMatch(/\bonSize\b/);
  }
});

it('FrameFeed asks for YUV (or RGB) pictures on iPhone, never \'native\', and never remembers failed pictures for good', () => {
  const code = codeOf(join(root, 'src/components/lens/warp/FrameFeed.tsx'));
  expect(code).toMatch(/pixelFormat:\s*IOS\s*\?\s*FRAME_PIXEL_FORMAT\s*:\s*'native'/);
  expect(code).toMatch(/const IOS\s*=\s*Platform\.OS\s*===\s*'ios'/);
  const access = codeOf(join(root, 'src/lib/frameAccess.ts'));
  expect(access).toMatch(/export const FRAME_PIXEL_FORMAT:\s*'yuv'\s*\|\s*'rgb'\s*=\s*'yuv'/);
  // Every switch-off in FrameFeed says how long for; only the shaders failing is remembered for this download.
  const calls = [...code.matchAll(/markFramesBroken\(([^;]*)\);/g)].map((m) => m[1]);
  expect(calls.length).toBe(2);
  for (const args of calls) {
    if (args.includes("'remember'")) expect(args).toMatch(/shaders/);
    else expect(args).toMatch(/'thisRun'\s*$/);
  }
  expect(calls.some((args) => /Camera pictures keep failing/.test(args) && /'thisRun'/.test(args))).toBe(true);
});

it('on a new download it loads FrameFeed, and if that fails the stretchy filters switch off instead of crashing', () => {
  const required = [];
  const broken = [];
  const mods = softGlowMods(true, broken);
  expect(() => loadWith('src/components/lens/SoftGlowCamera.tsx', mods, required)).not.toThrow();
  expect(required).toContain('./warp/FrameFeed');
  expect(broken.length).toBe(1);
  // And when it loads fine, nothing is switched off.
  const fine = [];
  loadWith('src/components/lens/SoftGlowCamera.tsx', { ...softGlowMods(true, fine), './warp/FrameFeed': { FrameFeed: () => null } });
  expect(fine).toEqual([]);
});

// Loads src/lib/frameAccess.ts on a pretend phone (one app start). `store`: the phone's storage, shared between
// app starts (a Map), or `saved`: one thing in it.
function frameAccess({ os = 'ios', version = '17.4', nitro = true, objects = ['WorkletQueueFactory', 'CameraFactory'], saved = null, build = '11', nitroThrows = false, store = null } = {}) {
  const stored = store ?? new Map(saved ? [[saved.key, saved.value]] : []);
  const writes = [];
  const required = [];
  const exports = loadWith('src/lib/frameAccess.ts', {
    '@react-native-async-storage/async-storage': {
      __esModule: true,
      default: {
        getItem: async (key) => (stored.has(key) ? stored.get(key) : null),
        setItem: async (key, value) => { writes.push([key, value]); stored.set(key, value); },
      },
    },
    expo: { requireOptionalNativeModule: (name) => (name === 'ExpoApplication' ? { nativeBuildVersion: build } : null) },
    react: { useSyncExternalStore: (subscribe, get) => get() },
    'react-native': {
      Platform: { OS: os, Version: version },
      TurboModuleRegistry: { get: (name) => (name === 'NitroModules' && nitro ? {} : null) },
    },
    'react-native-nitro-modules': nitroThrows
      ? new Error('no nitro')
      : { NitroModules: { hasHybridObject: (name) => objects.includes(name) } },
  }, required);
  return { ...exports, writes, required };
}

it('FRAME_ACCESS_AVAILABLE is true only on iOS 17+ with the new native part (and never loads the worklets package)', () => {
  const yes = frameAccess();
  expect(yes.FRAME_ACCESS_AVAILABLE).toBe(true);
  expect(yes.required).not.toContain('react-native-vision-camera-worklets');
  expect(frameAccess({ version: '18.1' }).FRAME_ACCESS_AVAILABLE).toBe(true);
  // Without Nitro at all (Expo Go, very old downloads).
  expect(frameAccess({ nitro: false }).FRAME_ACCESS_AVAILABLE).toBe(false);
  // Nitro, but no WorkletQueueFactory: App Store build 10, TestFlight 7–9.
  expect(frameAccess({ objects: ['CameraFactory', 'FaceMeshFactory'] }).FRAME_ACCESS_AVAILABLE).toBe(false);
  expect(frameAccess({ objects: ['WorkletQueueFactory'] }).FRAME_ACCESS_AVAILABLE).toBe(false);
  // iOS 16 (no screen-sized camera pictures).
  expect(frameAccess({ version: '16.7' }).FRAME_ACCESS_AVAILABLE).toBe(false);
  // Android: off until a phone passes the checks (WARPS_ON_ANDROID), whatever it has.
  const android = frameAccess({ os: 'android', version: 34 });
  expect(android.WARPS_ON_ANDROID).toBe(false);
  expect(android.FRAME_ACCESS_AVAILABLE).toBe(false);
  expect(android.FRAME_PATH).toBe('copy');
  expect(frameAccess({ os: 'web', version: '' }).FRAME_ACCESS_AVAILABLE).toBe(false);
  // Anything going wrong while checking means "no", never a crash.
  expect(frameAccess({ nitroThrows: true }).FRAME_ACCESS_AVAILABLE).toBe(false);
  expect(yes.WARPS_ENABLED).toBe(true);
  expect(yes.FRAME_PATH).toBe('share');
  expect(yes.FRAME_DELAY).toBeGreaterThanOrEqual(0);
  expect(yes.FRAME_DELAY).toBeLessThanOrEqual(2);
  // The fix of 12 Nov: the last good picture stays 1 s, YUV pictures, the rule places the picture, and a few
  // failed pictures never switch the filters off.
  expect(yes.STALE_MS).toBe(1000);
  expect(yes.FRAME_PIXEL_FORMAT).toBe('yuv');
  expect(yes.FRAME_PLACEMENT).toBe('rule');
  expect(yes.FRAME_ERROR_MIN).toBe(10);
  expect(yes.FRAME_ERROR_RATE).toBe(0.5);
  expect(yes.FRAME_ERROR_WINDOW_MS).toBe(2000);
  expect(yes.LOOK_COOL_DOWN_MS).toBe(1500);
});

it('markFramesBroken switches the stretchy filters off, tells the screens, and remembers it for this download', async () => {
  const fa = frameAccess({ build: '11' });
  let told = 0;
  const stop = fa.subscribeFramesBroken(() => { told++; });
  expect(fa.framesBroken()).toBe(false);
  expect(fa.useWarpLooksOn()).toBe(true);
  fa.markFramesBroken(new Error('camera'));
  fa.markFramesBroken(new Error('again'));
  expect(fa.framesBroken()).toBe(true);
  expect(fa.useWarpLooksOn()).toBe(false);
  expect(told).toBe(1);
  stop();
  await new Promise((r) => setTimeout(r, 0));
  expect(fa.writes.length).toBe(1);
  expect(fa.writes[0][0]).toMatch(/framesBroken\.11\./);
  expect(fa.writes[0][1]).toBe('1');

  // Next time the app starts on the same download, they stay off.
  const again = frameAccess({ build: '11', saved: { key: fa.writes[0][0], value: '1' } });
  await new Promise((r) => setTimeout(r, 0));
  expect(again.framesBroken()).toBe(true);
  // A new download (another build number) tries again.
  const next = frameAccess({ build: '12', saved: { key: fa.writes[0][0], value: '1' } });
  await new Promise((r) => setTimeout(r, 0));
  expect(next.framesBroken()).toBe(false);
});

const settle = () => new Promise((r) => setTimeout(r, 0));

it('a camera error while they are on switches them off until the app closes, and remembers nothing', async () => {
  const fa = frameAccess({ build: '11' });
  let told = 0;
  fa.subscribeFramesBroken(() => { told++; });
  fa.markFramesBroken(new Error('zoom out of range'), 'thisRun');
  expect(fa.framesBroken()).toBe(true);
  expect(fa.useWarpLooksOn()).toBe(false);
  expect(told).toBe(1);
  await settle();
  expect(fa.writes).toEqual([]);
  // The next app start shows them again.
  const next = frameAccess({ build: '11', store: new Map() });
  await settle();
  expect(next.framesBroken()).toBe(false);
});

it('a camera error just after they switch on is a strike: remembered only after two different app starts', async () => {
  const store = new Map();
  const first = frameAccess({ build: '11', store });
  first.markFramesBroken(new Error('could not add the output'), 'strike');
  first.markFramesBroken(new Error('again, same app start'), 'strike');
  expect(first.framesBroken()).toBe(true);
  await settle();
  expect(first.writes.filter(([, value]) => value === '1')).toEqual([]);

  // The next app start: still on (one strike isn't enough)…
  const second = frameAccess({ build: '11', store });
  await settle();
  expect(second.framesBroken()).toBe(false);
  // …and it happens again: now the phone remembers it for this download.
  second.markFramesBroken(new Error('could not add the output'), 'strike');
  await settle();
  expect(second.writes.filter(([, value]) => value === '1').map(([key]) => key)).toEqual(['peekaboo.framesBroken.11.2']);
  const third = frameAccess({ build: '11', store });
  await settle();
  expect(third.framesBroken()).toBe(true);
  // A new download (another build number) starts again with no strikes.
  const newBuild = frameAccess({ build: '12', store });
  await settle();
  expect(newBuild.framesBroken()).toBe(false);
});

it('a strike after it was already switched off for this app start still counts', async () => {
  const store = new Map();
  const first = frameAccess({ build: '11', store });
  first.markFramesBroken('media services were reset', 'thisRun');
  first.markFramesBroken('could not add the output', 'strike');
  await settle();
  const second = frameAccess({ build: '11', store });
  second.markFramesBroken('could not add the output', 'strike');
  await settle();
  expect(store.get('peekaboo.framesBroken.11.2')).toBe('1');
  const third = frameAccess({ build: '11', store });
  await settle();
  expect(third.framesBroken()).toBe(true);
});

it('retry round 2: a phone that switched the stretchy filters off for good on build 11 tries them again', async () => {
  // What build 11 wrote after 3 failed camera pictures (retry round 1).
  const store = new Map([['peekaboo.framesBroken.11.1', '1']]);
  const fa = frameAccess({ build: '11', store });
  await settle();
  expect(fa.framesBroken()).toBe(false);
  expect(fa.useWarpLooksOn()).toBe(true);
  // New switch-offs are remembered under the new round.
  fa.markFramesBroken(new Error('shaders'), 'remember');
  await settle();
  expect(fa.writes.map(([key]) => key)).toEqual(['peekaboo.framesBroken.11.2']);
});
