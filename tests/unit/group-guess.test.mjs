import { expect, it, vi } from 'vitest';
import { query } from '../api/edgeHarness.mjs';
import { loadLibrary } from './libHarness.mjs';

// 🕵️ Guess Who in a group chat (src/lib/groupGuess.ts): the list comes from one server function, the photo is cut
// to one fixed size and saved in the shared Guess Who folder, and the live listener never shares a channel name.

const post = (changes = {}) => ({
  id: 'g1', media_path: 'mystery/g1.jpg', media_type: 'photo', poster_path: null, overlay_path: null, caption: '',
  created_at: '2026-11-04T12:00:00Z', expires_at: '2026-11-05T12:00:00Z', mine: false, options: ['B', 'C'], my_guess: null,
  poster: null, guess_count: null, right_count: null, others_count: 3, ...changes,
});

function feedLibrary(rpcAnswer, profiles = []) {
  const rpc = vi.fn(async () => rpcAnswer);
  const from = vi.fn(() => query({ data: profiles, error: null }));
  const lib = loadLibrary('groupGuess', { supabase: { rpc, from }, mocks: { './media': {} } });
  return { lib, rpc, from };
}

it('loads one group\'s Guess Whos with group_mystery_feed and the profiles of the people to pick from', async () => {
  const posts = [post(), post({ id: 'g2', options: ['C', 'D'], my_guess: 'C', poster: 'D', guess_count: 1, right_count: 0 })];
  const { lib, rpc, from } = feedLibrary({ data: posts, error: null }, [{ id: 'B' }, { id: 'C' }, { id: 'D' }]);
  const feed = await lib.fetchGroupGuesses('group-1');
  expect(rpc).toHaveBeenCalledExactlyOnceWith('group_mystery_feed', { grp: 'group-1' });
  expect(from).toHaveBeenCalledWith('profiles');
  expect(feed.posts).toEqual(posts);
  expect([...feed.people.keys()].sort()).toEqual(['B', 'C', 'D']);
});

it('no Guess Whos: no profile lookup at all', async () => {
  const { lib, from } = feedLibrary({ data: [], error: null });
  const feed = await lib.fetchGroupGuesses('group-1');
  expect(feed.posts).toEqual([]);
  expect(feed.people.size).toBe(0);
  expect(from).not.toHaveBeenCalled();
});

it.each([
  ['PostgREST cannot find the function', { code: 'PGRST202', message: 'Could not find the function public.group_mystery_feed(grp) in the schema cache' }],
  ['the database has no such function', { code: '42883', message: 'function public.group_mystery_feed(uuid) does not exist' }],
])('a server without group Guess Who yet (%s) gives null, so the chat works as before', async (_why, error) => {
  const { lib } = feedLibrary({ data: null, error });
  await expect(lib.fetchGroupGuesses('group-1')).resolves.toBeNull();
});

it('any other error is a real problem and is passed on (the chat keeps what it shows)', async () => {
  const error = { code: '', message: 'TypeError: fetch failed' };
  const { lib } = feedLibrary({ data: null, error });
  await expect(lib.fetchGroupGuesses('group-1')).rejects.toBe(error);
  const refused = { code: 'P0001', message: 'Please log in again' };
  await expect(feedLibrary({ data: null, error: refused }).lib.fetchGroupGuesses('group-1')).rejects.toBe(refused);
});

function postLibrary(insertResult = { error: null }, { upload } = {}) {
  const inserted = [];
  const removed = [];
  const fixed = [];
  const uploaded = [];
  const chain = query(insertResult);
  chain.insert = (row) => { inserted.push(row); return chain; };
  const from = vi.fn(() => chain);
  const lib = loadLibrary('groupGuess', {
    supabase: { from },
    mocks: {
      './media': {
        fixedSizePhoto: async (uri, width, height) => { fixed.push([uri, width, height]); return 'file:///fixed.jpg'; },
        uploadCapture: upload ?? (async (userId, folder, capture) => {
          uploaded.push([userId, folder, capture]);
          return { fields: { media_path: 'mystery/abc.jpg', media_type: 'photo', poster_path: null, overlay_path: null }, stillUri: capture.uri };
        }),
        deleteMedia: async (paths) => { removed.push(paths); },
        mediaFiles: (fields) => [fields.media_path, fields.poster_path, fields.overlay_path].filter(Boolean),
      },
    },
  });
  return { lib, from, inserted, removed, fixed, uploaded };
}

it('posting cuts the photo to exactly 1080 × 1440, saves it in the shared Guess Who folder and adds it to the group', async () => {
  const { lib, from, inserted, removed, fixed, uploaded } = postLibrary();
  await lib.postGroupGuess('A', 'group-1', { kind: 'photo', uri: 'file:///edited.jpg' });
  expect(fixed).toEqual([['file:///edited.jpg', 1080, 1440]]);
  expect(uploaded).toEqual([['A', 'mystery', { kind: 'photo', uri: 'file:///fixed.jpg' }]]);
  expect(from).toHaveBeenCalledWith('mystery_posts');
  expect(inserted).toEqual([{ user_id: 'A', group_id: 'group-1', media_path: 'mystery/abc.jpg', media_type: 'photo', poster_path: null, overlay_path: null, caption: '' }]);
  expect(removed).toEqual([]);
});

it('a post the server refuses removes the uploaded file and shows the server\'s own reason', async () => {
  const refusal = { code: 'P0001', message: 'Guess Who needs at least 3 people in the group' };
  const { lib, removed } = postLibrary({ data: null, error: refusal });
  await expect(lib.postGroupGuess('A', 'group-1', { kind: 'photo', uri: 'file:///edited.jpg' })).rejects.toBe(refusal);
  expect(removed).toEqual([['mystery/abc.jpg']]);
});

it('if removing the file fails too, the real reason is still shown', async () => {
  const refusal = { code: 'P0001', message: 'You can post 3 Guess Whos in this group a day' };
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const lib = loadLibrary('groupGuess', {
      supabase: { from: () => { const chain = query({ data: null, error: refusal }); chain.insert = () => chain; return chain; } },
      mocks: { './media': {
        fixedSizePhoto: async () => 'file:///fixed.jpg',
        uploadCapture: async () => ({ fields: { media_path: 'mystery/abc.jpg', media_type: 'photo', poster_path: null, overlay_path: null } }),
        deleteMedia: async () => { throw new Error('Synthetic cleanup failure'); },
        mediaFiles: (fields) => [fields.media_path],
      } },
    });
    await expect(lib.postGroupGuess('A', 'group-1', { kind: 'photo', uri: 'file:///edited.jpg' })).rejects.toBe(refusal);
    expect(warn).toHaveBeenCalled();
  } finally { warn.mockRestore(); }
});

it('a video is never posted: Guess Who in groups is photos only (nothing is uploaded)', async () => {
  const { lib, from, uploaded, fixed } = postLibrary();
  await expect(lib.postGroupGuess('A', 'group-1', { kind: 'video', uri: 'file:///clip.mp4', overlayUri: null }))
    .rejects.toMatchObject({ message: 'Guess Who in groups is photos only for now' });
  expect(fixed).toEqual([]);
  expect(uploaded).toEqual([]);
  expect(from).not.toHaveBeenCalled();
});

function realtime() {
  const names = new Set();
  const listeners = [];
  const removed = [];
  const supabase = {
    channel: (name) => {
      if (names.has(name)) return { on() { throw new Error('Tried to add a listener to an already subscribed channel'); } };
      const channel = { name, on(type, filter, callback) { listeners.push({ name, type, filter, callback }); return channel; }, subscribe() { names.add(name); return channel; } };
      return channel;
    },
    removeChannel: (channel) => { removed.push(channel.name); },
  };
  return { supabase, names, listeners, removed };
}

it('two listeners on the same group get different channel names (the 4 Nov launch crash), and both are removed', () => {
  const r = realtime();
  const lib = loadLibrary('groupGuess', { supabase: r.supabase, mocks: { './media': {} } });
  const changes = [];
  const first = lib.subscribeToGroupGuesses('group-1', () => changes.push('first'));
  let second;
  expect(() => { second = lib.subscribeToGroupGuesses('group-1', () => changes.push('second')); }).not.toThrow();
  const all = lib.subscribeToGroupGuesses(null, () => changes.push('all'));
  expect(r.names.size).toBe(3);
  expect(r.listeners.map((l) => l.filter)).toEqual([
    { event: '*', schema: 'public', table: 'group_guess_pings', filter: 'group_id=eq.group-1' },
    { event: '*', schema: 'public', table: 'group_guess_pings', filter: 'group_id=eq.group-1' },
    { event: '*', schema: 'public', table: 'group_guess_pings' },
  ]);
  // A change only says which group changed: the callback gets nothing from it.
  r.listeners[0].callback({ eventType: 'UPDATE', new: { group_id: 'group-1', changed_at: 'now' } });
  expect(changes).toEqual(['first']);
  first(); second(); all();
  expect(r.removed).toHaveLength(3);
});

it.each([
  // A wide photo (4032 × 3024): the middle 2268 × 3024 is kept.
  [4032, 3024, { originX: 882, originY: 0, width: 2268, height: 3024 }],
  // A tall phone screenshot (1170 × 2532): the middle 1170 × 1560 is kept.
  [1170, 2532, { originX: 0, originY: 486, width: 1170, height: 1560 }],
  // Already 3:4: all of it is kept.
  [3024, 4032, { originX: 0, originY: 0, width: 3024, height: 4032 }],
  // What the editor sends in group Guess Who mode (its 3:4 box, made 1080 wide): nothing is cut off at all.
  [1080, 1440, { originX: 0, originY: 0, width: 1080, height: 1440 }],
])('the photo helper cuts the middle of a %i × %i photo to 3:4 and saves it at exactly 1080 × 1440', async (width, height, crop) => {
  const steps = [];
  const image = (w, h) => ({ width: w, height: h, saveAsync: async (options) => { steps.push(['save', options]); return { uri: 'file:///out.jpg', width: w, height: h }; } });
  const context = (source) => {
    const ctx = {
      crop: (rect) => { steps.push(['crop', rect]); return ctx; },
      resize: (size) => { steps.push(['resize', size]); return ctx; },
      renderAsync: async () => (typeof source === 'string' ? image(width, height) : image(1080, 1440)),
    };
    steps.push(['open', typeof source === 'string' ? source : 'image']);
    return ctx;
  };
  const media = loadLibrary('media', {
    supabase: { auth: { onAuthStateChange: () => {} } },
    mocks: { 'expo-image-manipulator': { ImageManipulator: { manipulate: context }, SaveFormat: { JPEG: 'jpeg' } } },
  });
  await expect(media.fixedSizePhoto('file:///photo.jpg', 1080, 1440)).resolves.toBe('file:///out.jpg');
  expect(steps).toEqual([
    ['open', 'file:///photo.jpg'],
    ['open', 'image'],
    ['crop', crop],
    ['resize', { width: 1080, height: 1440 }],
    ['save', { compress: 0.8, format: 'jpeg' }],
  ]);
});

// ---------------------------------------------------------------------------
// The posted file: always a 1080 × 1440 JPEG. On app downloads with Skia it is saved again by Skia (the same JPEG
// maker on iPhone and Android, quality 80, no extra details in the file). Without Skia, or if Skia fails, the
// phone's own JPEG is used (best effort) – posting never fails because of this.
// ---------------------------------------------------------------------------
const PHONE_JPEG = [0xff, 0xd8, 0x01, 0x02]; // made by the phone's own JPEG maker
const SKIA_JPEG = [0xff, 0xd8, 0x5a, 0x5a, 0x5a]; // made by Skia

function postWithRealMedia({ skiaHere, skia: skiaChanges = {} }) {
  const files = new Map([['file:///edited.jpg', new Uint8Array([0xff, 0xd8, 0x00])]]);
  const steps = { resized: [], saved: [], uploads: [], inserted: [], skiaLoads: 0, skia: [] };
  // A tiny pretend file store, so the test can see which bytes are uploaded.
  class File {
    constructor(...parts) { this.uri = parts.map((part) => (typeof part === 'string' ? part : part.uri)).join('/'); }
    async arrayBuffer() { return new Uint8Array(files.get(this.uri)).buffer; }
    async write(bytes) { files.set(this.uri, new Uint8Array(bytes)); }
  }
  const manipulate = (source) => {
    const ctx = {
      crop: () => ctx,
      resize: (size) => { steps.resized.push(size); return ctx; },
      renderAsync: async () => ({
        width: typeof source === 'string' ? 1170 : 1080,
        height: typeof source === 'string' ? 1560 : 1440,
        saveAsync: async (options) => {
          steps.saved.push(options);
          files.set('file:///phone.jpg', new Uint8Array(PHONE_JPEG));
          return { uri: 'file:///phone.jpg' };
        },
      }),
    };
    return ctx;
  };
  const surface = {
    getCanvas: () => ({ drawImageRect: (image, src, dest) => steps.skia.push(['draw', image.from, src, dest]) }),
    flush: () => steps.skia.push(['flush']),
    makeImageSnapshot: () => ({
      encodeToBytes: (format, quality) => { steps.skia.push(['encode', format, quality]); return new Uint8Array(SKIA_JPEG); },
    }),
  };
  const fakeSkia = {
    ImageFormat: { JPEG: 3, PNG: 4 },
    Skia: {
      Data: { fromURI: async (uri) => { steps.skia.push(['read', uri]); return { uri }; } },
      Image: { MakeImageFromEncoded: (data) => ({ from: data.uri, width: () => 1080, height: () => 1440 }) },
      Surface: { Make: (width, height) => { steps.skia.push(['surface', width, height]); return surface; } },
      XYWHRect: (x, y, width, height) => ({ x, y, width, height }),
      Paint: () => ({}),
      ...skiaChanges,
    },
  };
  const chain = query({ error: null });
  chain.insert = (row) => { steps.inserted.push(row); return chain; };
  const mocks = {
    'expo-image-manipulator': { ImageManipulator: { manipulate }, SaveFormat: { JPEG: 'jpeg' } },
    'expo-file-system': { File, Paths: { cache: { uri: 'file:///cache' } } },
    'react-native': { TurboModuleRegistry: { get: (name) => (skiaHere && name === 'RNSkiaModule' ? {} : null) } },
  };
  // Counts every time the app loads the Skia library (it must not, when the app download doesn't have Skia).
  Object.defineProperty(mocks, '@shopify/react-native-skia', { enumerable: true, get: () => { steps.skiaLoads++; return fakeSkia; } });
  const lib = loadLibrary('groupGuess', {
    supabase: {
      auth: { onAuthStateChange: () => {} },
      storage: { from: (bucket) => ({ upload: async (path, body, options) => { steps.uploads.push({ bucket, path, bytes: [...new Uint8Array(body)], options }); return { error: null }; } }) },
      from: () => chain,
    },
    mocks,
  });
  return { lib, steps, files };
}

it('with Skia, the uploaded file is the one Skia saved: 1080 × 1440, JPEG, quality 80', async () => {
  const { lib, steps, files } = postWithRealMedia({ skiaHere: true });
  await lib.postGroupGuess('A', 'group-1', { kind: 'photo', uri: 'file:///edited.jpg' });
  // First the phone cuts and sizes it to 1080 × 1440 …
  expect(steps.resized).toEqual([{ width: 1080, height: 1440 }]);
  expect(steps.saved).toEqual([{ compress: 0.8, format: 'jpeg' }]);
  // … then Skia draws that onto a fresh 1080 × 1440 picture in memory and saves it as a JPEG at quality 80.
  expect(steps.skia).toEqual([
    ['read', 'file:///phone.jpg'],
    ['surface', 1080, 1440],
    ['draw', 'file:///phone.jpg', { x: 0, y: 0, width: 1080, height: 1440 }, { x: 0, y: 0, width: 1080, height: 1440 }],
    ['flush'],
    ['encode', 3, 80],
  ]);
  // The bytes that go up are Skia's, never the phone's own file.
  expect(steps.uploads).toEqual([{ bucket: 'media', path: 'mystery/test-file.jpg', bytes: SKIA_JPEG, options: { contentType: 'image/jpeg' } }]);
  expect([...files.get('file:///cache/same-jpeg-test-file.jpg')]).toEqual(SKIA_JPEG);
  expect(steps.inserted).toEqual([{ user_id: 'A', group_id: 'group-1', media_path: 'mystery/test-file.jpg', media_type: 'photo', poster_path: null, overlay_path: null, caption: '' }]);
});

it('without Skia (Expo Go, older downloads) the phone\'s own 1080 × 1440 JPEG is posted, and Skia is never loaded', async () => {
  const { lib, steps } = postWithRealMedia({ skiaHere: false });
  await lib.postGroupGuess('A', 'group-1', { kind: 'photo', uri: 'file:///edited.jpg' });
  expect(steps.skiaLoads).toBe(0);
  expect(steps.resized).toEqual([{ width: 1080, height: 1440 }]);
  expect(steps.saved).toEqual([{ compress: 0.8, format: 'jpeg' }]);
  expect(steps.uploads).toEqual([{ bucket: 'media', path: 'mystery/test-file.jpg', bytes: PHONE_JPEG, options: { contentType: 'image/jpeg' } }]);
  expect(steps.inserted).toHaveLength(1);
});

it.each([
  ['Skia cannot read the photo', { Image: { MakeImageFromEncoded: () => null } }],
  ['Skia cannot make a picture', { Surface: { Make: () => null } }],
  ['Skia throws', { Data: { fromURI: async () => { throw new Error('Synthetic Skia failure'); } } }],
])('if %s, the phone\'s own JPEG is posted instead (posting still works)', async (_why, skia) => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const { lib, steps } = postWithRealMedia({ skiaHere: true, skia });
    await lib.postGroupGuess('A', 'group-1', { kind: 'photo', uri: 'file:///edited.jpg' });
    expect(steps.uploads.map((upload) => upload.bytes)).toEqual([PHONE_JPEG]);
    expect(steps.inserted).toHaveLength(1);
  } finally { warn.mockRestore(); }
});
