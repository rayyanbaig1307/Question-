import { loadLibrary } from './libHarness.mjs';

// A pretend Supabase, phone storage and file system for the outbox and early-upload tests. Nothing leaves the
// machine. `rules.insert(table, rows)` and `rules.upload(path)` decide how each request goes:
// 'ok' (default) · 'lost' (saved, but the answer never arrives) · 'noanswer' (not saved, no answer) ·
// { error, status } (a clear answer) · a Promise (the request hangs until it settles, then goes on as 'ok').
export function backend({ user = 'A' } = {}) {
  const db = { messages: [], group_messages: [], posts: [], stories: [], mystery_posts: [], comments: [], public_photos: [], profiles: [] };
  const files = new Map();
  const log = [];
  const rules = { insert: null, upload: null, select: null, remove: null, rpc: {} };
  const auth = { session: user ? { user: { id: user } } : null, listeners: new Set() };
  // Steps that run when someone logs out on purpose (lib/auth.tsx runBeforeLogOut).
  const beforeLogOut = new Set();
  const appState = new Set();
  const store = new Map();
  const disk = new Set(['file:///photo.jpg', 'file:///clip.mp4', 'file:///voice.m4a', 'file:///layer.png']);
  let ids = 0;

  const lostAnswer = { data: null, error: { message: 'AbortError: Aborted', code: '', details: '', hint: '' }, status: 0 };

  function query(table) {
    let op = null;
    let rows = null;
    let one = false;
    const filters = [];
    const builder = {
      insert(value) { op = 'insert'; rows = Array.isArray(value) ? value : [value]; return builder; },
      select() { if (!op) op = 'select'; return builder; },
      eq(column, value) { filters.push((row) => row[column] === value); return builder; },
      in(column, values) { filters.push((row) => values.includes(row[column])); return builder; },
      order() { return builder; },
      limit() { return builder; },
      single() { one = true; return builder; },
      maybeSingle() { one = true; return builder; },
      then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject); },
    };
    async function run() {
      if (op === 'insert') {
        log.push(['insert', table, rows.map((row) => row.id ?? row.media_path)]);
        let rule = rules.insert?.(table, rows) ?? 'ok';
        if (rule && typeof rule.then === 'function') rule = (await rule) ?? 'ok';
        if (rule === 'noanswer') return lostAnswer;
        if (rule && typeof rule === 'object' && rule.error) return { data: null, error: rule.error, status: rule.status ?? 400 };
        for (const row of rows) {
          const twice = table === 'public_photos' ? db[table].some((r) => r.media_path === row.media_path) : db[table].some((r) => r.id === row.id);
          if (twice) return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint "${table}_pkey"` }, status: 409 };
        }
        const saved = rows.map((row) => ({
          saved_at: null,
          created_at: '2026-11-22T22:01:00Z',
          ...row,
          ...(table === 'posts' && row.drop_offset_minutes !== undefined ? { drop_late_seconds: 30, drop_day: '2026-11-22' } : {}),
        }));
        db[table].push(...saved);
        if (rule === 'lost') return lostAnswer;
        return { data: one ? saved[0] : saved, error: null, status: 201 };
      }
      log.push(['select', table]);
      // `rules.select(table)` = 'empty': the row isn't there yet when it's looked up (it's saved a moment later).
      // 'noanswer': the look-up gets no answer.
      const selectRule = rules.select?.(table);
      if (selectRule === 'empty') return { data: one ? null : [], error: null, status: 200 };
      if (selectRule === 'noanswer') return lostAnswer;
      const found = db[table].filter((row) => filters.every((keep) => keep(row)));
      return { data: one ? (found[0] ?? null) : found, error: null, status: 200 };
    }
    return builder;
  }

  const bucket = () => ({
    async upload(path) {
      log.push(['upload', path]);
      let rule = rules.upload?.(path) ?? 'ok';
      if (rule && typeof rule.then === 'function') rule = (await rule) ?? 'ok';
      if (rule === 'noanswer') return { data: null, error: { name: 'StorageUnknownError', message: 'Network request failed' } };
      if (rule && typeof rule === 'object' && rule.error) return { data: null, error: rule.error };
      if (files.has(path)) return { data: null, error: { name: 'StorageApiError', message: 'The resource already exists', status: 400, statusCode: '409' } };
      files.set(path, true);
      return { data: { path }, error: null };
    },
    async copy(from, to) {
      log.push(['copy', from, to]);
      if (!files.has(from)) return { data: null, error: { name: 'StorageApiError', message: 'Object not found', status: 400, statusCode: '404' } };
      if (files.has(to)) return { data: null, error: { name: 'StorageApiError', message: 'The resource already exists', status: 400, statusCode: '409' } };
      files.set(to, true);
      return { data: { path: to }, error: null };
    },
    async remove(paths) {
      log.push(['remove', ...paths]);
      // `rules.remove(paths)`: an answer of its own (like the server refusing to delete a file a saved row uses).
      const rule = rules.remove?.(paths);
      if (rule && typeof rule === 'object' && rule.error) return { data: null, error: rule.error };
      for (const path of paths) files.delete(path);
      return { data: [], error: null };
    },
    getPublicUrl: (path) => ({ data: { publicUrl: `https://cdn.invalid/${path}` } }),
  });

  const supabase = {
    auth: {
      getSession: async () => ({ data: { session: auth.session }, error: null }),
      onAuthStateChange(listener) {
        auth.listeners.add(listener);
        Promise.resolve().then(() => listener('INITIAL_SESSION', auth.session));
        return { data: { subscription: { unsubscribe() { auth.listeners.delete(listener); } } } };
      },
    },
    from: (table) => query(table),
    storage: { from: bucket },
    rpc: async (name, args) => {
      log.push(['rpc', name, args]);
      const rule = rules.rpc[name];
      if (rule) return rule(args);
      return { data: true, error: null };
    },
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel() {},
  };

  // Logging in or out (or someone else logging in).
  function signIn(id, event = 'SIGNED_IN') {
    auth.session = id ? { user: { id } } : null;
    auth.listeners.forEach((listener) => listener(event, auth.session));
  }
  // "Log out" tapped (the steps for logging out on purpose run first, like lib/auth.tsx does).
  function logOut(id) {
    beforeLogOut.forEach((step) => step(id));
    signIn(null, 'SIGNED_OUT');
  }

  class File {
    constructor(where, name) {
      const base = typeof where === 'string' ? where : where.uri;
      this.uri = name ? `${base}/${name}` : base;
    }
    get exists() { return disk.has(this.uri); }
    get name() { return this.uri.split('/').pop(); }
    get size() { return 1000; }
    async copy(target) { disk.add(target.uri); }
    delete() { disk.delete(this.uri); }
    async arrayBuffer() { return new ArrayBuffer(1000); }
  }
  class Directory {
    constructor(where, name) { this.uri = `${typeof where === 'string' ? where : where.uri}/${name}`; }
    get exists() { return true; }
    create() {}
    list() { return [...disk].filter((uri) => uri.startsWith(`${this.uri}/`) && !uri.slice(this.uri.length + 1).includes('/')).map((uri) => new File(uri)); }
  }
  let rendered = 0;
  const manipulate = (source) => {
    const uri = typeof source === 'string' ? source : source.uri;
    const chain = {
      resize: () => chain,
      crop: () => chain,
      renderAsync: async () => ({ uri, width: 1080, height: 1440, saveAsync: async () => ({ uri: `${uri.split('#')[0]}#small${++rendered}` }) }),
    };
    return chain;
  };

  const mocks = {
    '@react-native-async-storage/async-storage': {
      __esModule: true,
      default: {
        getItem: async (key) => (store.has(key) ? store.get(key) : null),
        setItem: async (key, value) => { store.set(key, value); },
        removeItem: async (key) => { store.delete(key); },
        getAllKeys: async () => [...store.keys()],
      },
    },
    'expo-crypto': { randomUUID: () => `id-${++ids}` },
    'expo-file-system': { File, Directory, Paths: { document: { uri: 'file:///doc' }, cache: { uri: 'file:///cache' } } },
    'expo-image-manipulator': { ImageManipulator: { manipulate }, SaveFormat: { JPEG: 'jpeg', PNG: 'png' } },
    './auth': { runBeforeLogOut: (step) => { beforeLogOut.add(step); return () => beforeLogOut.delete(step); } },
    'react-native': {
      AppState: { currentState: 'active', addEventListener: (_type, listener) => { appState.add(listener); return { remove() { appState.delete(listener); } }; } },
      TurboModuleRegistry: { get: () => null },
      Platform: { OS: 'ios' },
    },
  };

  const load = (name, extraMocks = {}) =>
    loadLibrary(name, {
      supabase,
      mocks: { ...mocks, ...extraMocks },
      globals: { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, Date, AbortController },
    });

  return {
    db, files, log, rules, store, disk, supabase, load, signIn, logOut, auth,
    becomeActive: () => appState.forEach((listener) => listener('active')),
    goAway: () => appState.forEach((listener) => listener('background')),
    inserts: (table) => log.filter((entry) => entry[0] === 'insert' && (!table || entry[1] === table)),
    uploads: () => log.filter((entry) => entry[0] === 'upload'),
  };
}
