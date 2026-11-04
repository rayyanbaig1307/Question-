import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

// Loads actual library code without starting Expo or contacting a service.
export function loadLibrary(name, { supabase = {}, mocks = {}, globals = {} } = {}) {
  const loaded = new Map();
  function load(path) {
    if (loaded.has(path)) return loaded.get(path);
    const source = process.env.QA_ORIGINAL === '1'
      ? execFileSync('git', ['show', `a9e5ddf88e785bd8378b2b7d9dcd7e341df439b1:${relative(process.cwd(), path).split('\\').join('/')}`], { encoding: 'utf8' })
      : readFileSync(path, 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    const output = {};
    loaded.set(path, output);
    vm.runInNewContext(compiled, {
      exports: output,
      require: (id) => {
        if (Object.hasOwn(mocks, id)) return mocks[id];
        if (id === './supabase') return { supabase };
        if (id === 'react') return { useEffect() {}, useState() {}, useCallback() {}, useSyncExternalStore() {} };
        if (id === 'expo') return { requireOptionalNativeModule: () => null };
        if (id === 'expo-crypto') return { randomUUID: () => 'test-file' };
        if (id === 'expo-constants') return { __esModule: true, default: { executionEnvironment: 'store-client' }, ExecutionEnvironment: { StoreClient: 'store-client' } };
        if (id === 'expo-file-system') return { File: class { async arrayBuffer() { return new ArrayBuffer(0); } } };
        if (id === 'expo-image-manipulator') return {};
        if (id === 'react-native') return { TurboModuleRegistry: { get: () => null }, Platform: { OS: 'android' } };
        if (id.startsWith('.')) {
          const base = resolve(dirname(path), id);
          return load(['.ts', '.tsx', '.js'].map((ext) => base + ext).find(existsSync));
        }
        throw new Error(`Unexpected native or external import: ${id}`);
      },
      console, Date, Map, Set, Promise, Math, Number, String, Array, Object, Uint8Array, DataView,
      crypto: webcrypto, setTimeout, clearTimeout, setInterval, clearInterval,
      process: { env: {} },
      fetch: () => { throw new Error('Network access forbidden in unit tests'); },
      ...globals,
    }, { filename: path });
    return output;
  }
  return load(resolve('src/lib', name + '.ts'));
}
