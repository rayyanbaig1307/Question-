import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

import { codeOf, loadTs, root, sourceOf, valueExports, valueLoads } from './liveLoad.mjs';

// Lives 🔴 need LiveKit's native parts, which only downloads from version 1.2.0 have. Every app update also
// reaches the older downloads (App Store 1.0/1.1, old TestFlight builds, old APKs, Expo Go), and on those just
// LOADING LiveKit closes the app. Asking the phone for LiveKit's parts also CREATES them (it starts the WebRTC
// sound engine), so that may only happen right before a live is used. These checks guard all of that:
// - only components/live/LiveStage.tsx loads LiveKit, and only lib/liveAccess.ts loads LiveStage (lazily);
// - liveAccess.ts asks the phone (NativeModules) only inside isLiveAvailable(), which only the Go live and live
//   screens call; nothing runs at load time; old downloads, Expo Go, Android (for now) and the web say "no";
// - the names it asks for are exactly what the installed LiveKit packages read when they load;
// - no app file listens to LiveKit chat, streams or RPC (viewers may send data; only hearts are acted on);
// - expo-keep-awake is never imported; the four LiveKit packages are pinned exactly; app.json is right.

const SRC = join(root, 'src');
function sourceFiles(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name)) found.push(relative(root, path).split('\\').join('/'));
  }
  return found;
}
const files = sourceFiles(SRC);
const isLiveKit = (spec) => spec === 'livekit-client' || spec.startsWith('livekit-client/') || spec.startsWith('@livekit/');
const isLiveStage = (spec) => /(^|\/)components\/live\/LiveStage$/.test(spec) || spec === './LiveStage' || spec === '@/components/live/LiveStage';

it('the load finder tells real loads from types (so the checks below mean something)', () => {
  const probe = 'src/__live_guard_probe__.ts';
  const text = [
    "import type { Room } from 'livekit-client';",
    "import { type Track } from 'livekit-client';",
    "import { Room as R } from 'livekit-client';",
    "import '@livekit/react-native';",
    "export { x } from '@livekit/react-native-webrtc';",
    "export type { y } from '@livekit/react-native-webrtc';",
    "type M = typeof import('@/components/live/LiveStage');",
    "function later() { return require('@/components/live/LiveStage'); }",
    "const z = import('livekit-client');",
  ].join('\n');
  const loads = valueLoads(probe, text).map((l) => l.spec);
  expect(loads).toEqual(['livekit-client', '@livekit/react-native', '@livekit/react-native-webrtc', '@/components/live/LiveStage', 'livekit-client']);
  expect(valueLoads(probe, text).find((l) => l.spec === '@/components/live/LiveStage').inFunction).toBe('later');
  // And on a real file: liveAccess.ts only uses LiveStage's types at the top, and requires it inside loadLiveStage.
  expect(valueLoads('src/lib/liveAccess.ts').filter((l) => isLiveStage(l.spec))).toEqual([{ spec: '@/components/live/LiveStage', inFunction: 'loadLiveStage' }]);
});

it('only components/live/LiveStage.tsx loads LiveKit', () => {
  expect(files.length).toBeGreaterThan(50);
  const loaders = files.filter((file) => valueLoads(file).some((l) => isLiveKit(l.spec)));
  expect(loaders).toEqual(['src/components/live/LiveStage.tsx']);
});

it('only lib/liveAccess.ts loads LiveStage, and only inside loadLiveStage() (never at app start)', () => {
  const loaders = files.filter((file) => valueLoads(file).some((l) => isLiveStage(l.spec)));
  expect(loaders).toEqual(['src/lib/liveAccess.ts']);
  for (const load of valueLoads('src/lib/liveAccess.ts')) {
    if (isLiveStage(load.spec)) expect(load.inFunction).toBe('loadLiveStage');
    // Nothing from LiveKit there, not even lazily.
    expect(isLiveKit(load.spec)).toBe(false);
  }
});

it('liveAccess.ts asks the phone (NativeModules) only inside isLiveAvailable()', () => {
  const source = sourceOf('src/lib/liveAccess.ts');
  const uses = [];
  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === 'NativeModules' && !ts.isImportSpecifier(node.parent)) {
      let fn = null;
      for (let p = node.parent; p; p = p.parent) if (ts.isFunctionDeclaration(p)) { fn = p.name?.text ?? null; break; }
      uses.push(fn);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(uses.length).toBeGreaterThan(0);
  expect(new Set(uses)).toEqual(new Set(['isLiveAvailable']));
});

it('only loadLiveStage() and the Go live / live screens run the real check (never the camera, Home or start-up)', () => {
  const allowed = new Set([
    'src/lib/liveAccess.ts', 'src/lib/liveAccess.web.ts',
    'src/components/live/GoLiveSheet.tsx', 'src/app/(app)/go-live.tsx', 'src/app/(app)/live/[id].tsx',
  ]);
  const callers = files.filter((file) => /\bisLiveAvailable\s*\(/.test(codeOf(file)));
  expect(callers).toContain('src/lib/liveAccess.ts');
  for (const file of callers) expect(allowed.has(file), file).toBe(true);
  // Inside liveAccess.ts: only loadLiveStage calls it.
  const source = sourceOf('src/lib/liveAccess.ts');
  const inside = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'isLiveAvailable') {
      let fn = null;
      for (let p = node.parent; p; p = p.parent) if (ts.isFunctionDeclaration(p)) { fn = p.name?.text ?? null; break; }
      inside.push(fn);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(inside).toEqual(['loadLiveStage']);
});

it('nobody imports expo-keep-awake (only the phone part ExpoKeepAwake, through requireOptionalNativeModule)', () => {
  for (const file of files) {
    const loads = valueLoads(file).map((l) => l.spec);
    expect(loads.filter((spec) => spec === 'expo-keep-awake' || spec.startsWith('expo-keep-awake/')), file).toEqual([]);
    expect(readFileSync(join(root, file), 'utf8'), file).not.toMatch(/from\s+['"]expo-keep-awake['"]/);
  }
  expect(codeOf('src/lib/liveAccess.ts')).toMatch(/requireOptionalNativeModule<[\s\S]*?>\(\s*'ExpoKeepAwake'\s*\)/);
});

it('no app file listens to LiveKit chat, text/byte streams, RPC or transcriptions', () => {
  const forbidden = /\b(registerRpcMethod|registerTextStreamHandler|registerByteStreamHandler|useChat|TranscriptionReceived|useTrackTranscription|useDataChannel)\b|RoomEvent\s*\.\s*ChatMessage/;
  for (const file of files) expect(codeOf(file), file).not.toMatch(forbidden);
  // The one data listener checks the topic and the sender.
  const stage = codeOf('src/components/live/LiveStage.tsx');
  expect(stage.match(/RoomEvent\.DataReceived/g)).toHaveLength(1);
  expect(stage).toMatch(/participantIdentity\s*\?\?\s*participant\?\.identity/);
});

// What the installed packages read from NativeModules when they load (destructuring or a property read).
function nativeNamesRead(dir) {
  const names = new Set();
  const walk = (path) => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
        const source = ts.createSourceFile(full, readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true, name.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        const visit = (node) => {
          if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'NativeModules') names.add(node.name.text);
          if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.initializer) && node.initializer.text === 'NativeModules'
            && ts.isObjectBindingPattern(node.name)) {
            for (const element of node.name.elements) names.add((element.propertyName ?? element.name).getText());
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
    }
  };
  walk(dir);
  return names;
}

it('LIVE_NATIVE_MODULES is exactly what the installed LiveKit packages read from the phone', () => {
  const read = new Set([
    ...nativeNamesRead(join(root, 'node_modules/@livekit/react-native-webrtc/src')),
    ...nativeNamesRead(join(root, 'node_modules/@livekit/react-native/src')),
  ]);
  const code = codeOf('src/lib/liveAccess.ts').replace(/\s+/g, '');
  const listed = JSON.parse(code.match(/LIVE_NATIVE_MODULES=(\[[^\]]*\])asconst/)[1].replace(/'/g, '"'));
  expect([...read].sort()).toEqual([...listed].sort());
  expect(listed).toEqual(['WebRTCModule', 'LivekitReactNativeModule']);
  // The two files the design names read them at load time.
  expect(readFileSync(join(root, 'node_modules/@livekit/react-native-webrtc/src/EventEmitter.ts'), 'utf8')).toMatch(/const \{ WebRTCModule \} = NativeModules/);
  expect(readFileSync(join(root, 'node_modules/@livekit/react-native/src/LKNativeModule.ts'), 'utf8')).toMatch(/NativeModules\.LivekitReactNativeModule/);
});

it('the four LiveKit packages are pinned exactly, in package.json and in the lockfile', () => {
  const pins = {
    '@livekit/react-native': '3.1.0',
    '@livekit/react-native-webrtc': '150.1.1',
    '@livekit/react-native-expo-plugin': '1.1.0',
    'livekit-client': '2.23.0',
  };
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  for (const [name, version] of Object.entries(pins)) {
    expect(pkg.dependencies[name], name).toBe(version);
    expect(lock.packages[''].dependencies[name], name).toBe(version);
    expect(lock.packages[`node_modules/${name}`].version, name).toBe(version);
    expect(JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version, name).toBe(version);
  }
});

it('LiveKit is set up without its automatic sound takeover, and the app keeps its own URL helpers', () => {
  const code = codeOf('src/components/live/LiveStage.tsx').replace(/\s+/g, '');
  expect(code.match(/registerGlobals\(/g)).toHaveLength(1);
  expect(code).toMatch(/registerGlobals\(\{autoConfigureAudioSession:false\}\)/);
  expect(code).toMatch(/constkeepURL=globalThis\.URL;constkeepSearch=globalThis\.URLSearchParams;registerGlobals/);
  expect(code).toMatch(/registerGlobals\(\{autoConfigureAudioSession:false\}\);globalThis\.URL=keepURL;globalThis\.URLSearchParams=keepSearch;/);
});

it('app.json: version 1.2.0, the LiveKit plugin, no background modes, and the same permission words everywhere', () => {
  const app = JSON.parse(readFileSync(join(root, 'app.json'), 'utf8')).expo;
  expect(app.version).toBe('1.2.0');
  expect(app.runtimeVersion).toEqual({ policy: 'sdkVersion' });
  const plugins = app.plugins.map((p) => (Array.isArray(p) ? p : [p, undefined]));
  const names = plugins.map(([name]) => name);
  const livekit = plugins.find(([name]) => name === '@livekit/react-native-expo-plugin');
  expect(livekit?.[1]).toEqual({ android: { audioType: 'communication' } });
  expect(names.indexOf('@livekit/react-native-expo-plugin')).toBe(names.indexOf('expo-camera') + 1);
  expect(JSON.stringify(app)).not.toMatch(/UIBackgroundModes|enableMultitaskingCameraAccess|enableScreenShareService/);
  expect(app.ios.config.usesNonExemptEncryption).toBe(false);
  const options = (name) => plugins.find(([n]) => n === name)?.[1];
  const camera = 'Peekaboo uses your camera to take photos and videos for your friends, for face filters like googly eyes, and to go live with your friends.';
  const mic = 'Peekaboo uses your microphone to record sound for your videos, to send voice notes, and so your friends can hear you when you go live.';
  expect(options('expo-camera').cameraPermission).toBe(camera);
  expect(options('expo-image-picker').cameraPermission).toBe(camera);
  expect(options('expo-camera').microphonePermission).toBe(mic);
  expect(options('expo-image-picker').microphonePermission).toBe(mic);
  expect(options('expo-audio').microphonePermission).toBe(mic);
});

it('the web twins have the same names and load nothing of LiveKit (LiveKit never gets into the website)', () => {
  expect(valueExports('src/lib/liveAccess.web.ts')).toEqual(valueExports('src/lib/liveAccess.ts'));
  expect(valueExports('src/components/live/LiveStage.web.tsx')).toEqual(valueExports('src/components/live/LiveStage.tsx'));
  expect(valueLoads('src/lib/liveAccess.web.ts')).toEqual([]);
  expect(valueLoads('src/components/live/LiveStage.web.tsx')).toEqual([]);
});

// ---------------------------------------------------------------------------
// The guard itself, on pretend phones (one app start each).
// ---------------------------------------------------------------------------

function phone({ os = 'ios', version = '1.2.0', expoGo = false, modules = ['WebRTCModule', 'LivekitReactNativeModule'], stage = { createStage() {} }, appThrows = false } = {}) {
  const reads = [];
  const asked = [];
  const required = [];
  const NativeModules = new Proxy({}, {
    get(_, name) {
      reads.push(String(name));
      return modules.includes(name) ? {} : undefined;
    },
  });
  const access = loadTs('src/lib/liveAccess.ts', {
    expo: {
      requireOptionalNativeModule: (name) => {
        asked.push(name);
        if (name === 'ExpoApplication') {
          if (appThrows) throw new Error('no app module');
          return { nativeApplicationVersion: version };
        }
        return null;
      },
    },
    'expo-constants': { __esModule: true, default: { executionEnvironment: expoGo ? 'storeClient' : 'standalone' }, ExecutionEnvironment: { StoreClient: 'storeClient' } },
    react: { useSyncExternalStore: (_subscribe, get) => get() },
    'react-native': { NativeModules, Platform: { OS: os } },
    '@/components/live/LiveStage': stage,
  }, { required });
  return { access, reads, asked, required };
}

it('loading liveAccess.ts does nothing: no phone parts asked for, nothing required', () => {
  const p = phone();
  expect(p.reads).toEqual([]);
  expect(p.asked).toEqual([]);
  expect(p.required.filter((id) => id.includes('LiveStage') || isLiveKit(id))).toEqual([]);
});

it('a 1.2 iPhone: the cheap check says yes without touching LiveKit; the real check asks for exactly the two parts', () => {
  const p = phone();
  expect(p.access.liveMaybeAvailable()).toBe(true);
  expect(p.reads).toEqual([]);
  expect(p.access.liveUnavailableReason()).toBe(null);
  expect(p.access.isLiveAvailable()).toBe(true);
  expect(p.reads.sort()).toEqual(['LivekitReactNativeModule', 'WebRTCModule']);
  // Remembered: asked once.
  p.access.isLiveAvailable();
  expect(p.reads).toHaveLength(2);
  expect(p.required).not.toContain('@/components/live/LiveStage');
  const stage = p.access.loadLiveStage();
  expect(typeof stage.createStage).toBe('function');
  expect(p.required.filter((id) => id === '@/components/live/LiveStage')).toHaveLength(1);
  expect(p.access.loadLiveStage()).toBe(stage);
});

it('old downloads, Expo Go, Android (switched off) and the web say no – and never ask the phone for LiveKit', () => {
  for (const [options, reason] of [
    [{ version: '1.1.0' }, 'update'],
    [{ version: '1.0' }, 'update'],
    [{ version: null }, 'update'],
    [{ appThrows: true }, 'update'],
    [{ expoGo: true, version: '58.0.4' }, 'broken'],
    [{ os: 'android' }, 'android'],
    [{ os: 'web' }, 'broken'],
  ]) {
    const p = phone(options);
    expect(p.access.liveMaybeAvailable(), JSON.stringify(options)).toBe(false);
    expect(p.access.isLiveAvailable(), JSON.stringify(options)).toBe(false);
    expect(p.access.loadLiveStage(), JSON.stringify(options)).toBe(null);
    expect(p.reads, JSON.stringify(options)).toEqual([]);
    expect(p.required.filter((id) => id.includes('LiveStage')), JSON.stringify(options)).toEqual([]);
    expect(p.access.liveUnavailableReason(), JSON.stringify(options)).toBe(reason);
    expect(p.access.LIVE_UNAVAILABLE_WORDS[reason]).toBeTruthy();
  }
  const words = phone().access.LIVE_UNAVAILABLE_WORDS;
  expect(words.update).toBe('Update Peekaboo to watch lives 🔴');
  expect(words.android).toBe("Lives aren't on Android yet – soon! 🔴");
  expect(words.off).toBe('Lives are switched off for now.');
  expect(words.broken).toBe("Lives aren't working on this phone right now.");
});

it('a 1.2 download without the native parts hides lives for this app start (and never loads LiveStage)', () => {
  const p = phone({ modules: ['LivekitReactNativeModule'] });
  let told = 0;
  p.access.subscribeLiveBroken(() => { told++; });
  expect(p.access.liveMaybeAvailable()).toBe(true);
  expect(p.access.isLiveAvailable()).toBe(false);
  expect(told).toBe(1);
  expect(p.access.liveBroken()).toBe(true);
  expect(p.access.liveMaybeAvailable()).toBe(false);
  expect(p.access.liveUnavailableReason()).toBe('broken');
  expect(p.access.loadLiveStage()).toBe(null);
  expect(p.required.filter((id) => id.includes('LiveStage'))).toEqual([]);
});

it('if loading LiveStage fails, lives switch off for this app start instead of closing the app', () => {
  const p = phone({ stage: new Error('native part missing') });
  expect(p.access.loadLiveStage()).toBe(null);
  expect(p.access.liveBroken()).toBe(true);
  expect(p.access.liveMaybeAvailable()).toBe(false);
  expect(p.access.isLiveAvailable()).toBe(false);
  expect(p.access.loadLiveStage()).toBe(null);
  expect(p.required.filter((id) => id.includes('LiveStage'))).toHaveLength(1);
});

it('the switches ship as planned: lives on, Android off, hearts on, from 1.2.0', () => {
  const { access } = phone();
  expect(access.LIVE_ENABLED).toBe(true);
  expect(access.LIVE_ON_ANDROID).toBe(false);
  expect(access.HEARTS_ENABLED).toBe(true);
  expect(access.LIVE_MIN_APP_VERSION).toBe('1.2.0');
});

it('versionAtLeast compares numbers, not text (live-version)', () => {
  const { versionAtLeast } = phone().access;
  expect(versionAtLeast('1.2.0', '1.2.0')).toBe(true);
  expect(versionAtLeast('1.10.0', '1.2.0')).toBe(true);
  expect(versionAtLeast('1.2', '1.2.0')).toBe(true);
  expect(versionAtLeast('1.2.1', '1.2.0')).toBe(true);
  expect(versionAtLeast('2.0', '1.2.0')).toBe(true);
  expect(versionAtLeast('1.1.9', '1.2.0')).toBe(false);
  expect(versionAtLeast('1.1', '1.2.0')).toBe(false);
  expect(versionAtLeast('1', '1.2.0')).toBe(false);
  expect(versionAtLeast(null, '1.2.0')).toBe(false);
  expect(versionAtLeast(undefined, '1.2.0')).toBe(false);
  expect(versionAtLeast('', '1.2.0')).toBe(false);
  expect(versionAtLeast('1.2.0-beta', '1.2.0')).toBe(false);
  expect(versionAtLeast(' 1.2.0 ', '1.2.0')).toBe(true);
});
