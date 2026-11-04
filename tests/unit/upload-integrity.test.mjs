import { expect, it, vi } from 'vitest';
import { query } from '../api/edgeHarness.mjs';
import { loadLibrary } from './libHarness.mjs';

function captureService(failAt, cleanupFails = false) {
  let count = 0;
  const failure = { message: 'Synthetic upload failure' };
  const upload = vi.fn(async () => ({ error: ++count === failAt ? failure : null }));
  const remove = vi.fn(async () => ({ error: cleanupFails ? { message: 'Synthetic cleanup failure' } : null }));
  const media = loadLibrary('media', {
    supabase: {
      auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
      storage: { from: () => ({ upload, remove }) },
    },
    mocks: {
      expo: { requireOptionalNativeModule: () => ({}) },
      'expo-video-thumbnails': { getThumbnailAsync: async () => ({ uri: 'file:///poster.jpg' }) },
      'expo-image-manipulator': {
        SaveFormat: { JPEG: 'jpeg' },
        ImageManipulator: { manipulate: () => ({ resize() { return this; }, renderAsync: async () => ({ saveAsync: async () => ({ uri: 'file:///poster.jpg' }) }) }) },
      },
    },
  });
  return { media, upload, remove, failure };
}

for (const folder of ['posts', 'stories', 'snaps', 'mystery', 'keeps', 'group']) {
  for (const failAt of [2, 3]) {
    it(`cleans up already-uploaded ${folder} video files when upload ${failAt} fails`, async () => {
      const { media, upload, remove, failure } = captureService(failAt);
      await expect(media.uploadCapture('A', folder, { kind: 'video', uri: 'file:///video.mp4', overlayUri: 'file:///overlay.png' })).rejects.toMatchObject(failure);
      const prefix = folder === 'mystery' ? 'mystery' : `A/${folder}`;
      expect(remove).toHaveBeenCalledExactlyOnceWith(failAt === 2 ? [`${prefix}/test-file.mp4`] : [`${prefix}/test-file.mp4`, `${prefix}/test-file.jpg`]);
      expect(upload).toHaveBeenCalledTimes(failAt);
    });
  }
}

it('does not replace the original upload error if cleanup also fails', async () => {
  const { media, remove, failure } = captureService(2, true);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await expect(media.uploadCapture('A', 'posts', { kind: 'video', uri: 'file:///video.mp4' })).rejects.toMatchObject(failure);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalled();
  } finally { warning.mockRestore(); }
});

it('does not delete an object when no upload was known to have succeeded', async () => {
  const { media, remove, failure } = captureService(1);
  await expect(media.uploadCapture('A', 'posts', { kind: 'video', uri: 'file:///video.mp4' })).rejects.toMatchObject(failure);
  expect(remove).not.toHaveBeenCalled();
});

it('keeps all files after a complete successful capture upload', async () => {
  const { media, remove } = captureService(-1);
  const result = await media.uploadCapture('A', 'posts', { kind: 'video', uri: 'file:///video.mp4', overlayUri: 'file:///overlay.png' });
  expect(result).toEqual({ fields: { media_path: 'A/posts/test-file.mp4', media_type: 'video', poster_path: 'A/posts/test-file.jpg', overlay_path: 'A/posts/test-file.png' }, stillUri: 'file:///poster.jpg' });
  expect(remove).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Rolling back after a failed save (R2-API-16, second review): the files already uploaded are removed, and the
// person always sees the REAL reason, even if removing the files fails too.
// ---------------------------------------------------------------------------
const imageManipulator = (fail = false) => ({
  SaveFormat: { JPEG: 'jpeg' },
  ImageManipulator: { manipulate: () => ({ resize() { return this; }, renderAsync: async () => {
    if (fail) throw new Error('Synthetic blur render failure');
    return { saveAsync: async () => ({ uri: 'file:///blur.jpg' }) };
  } }) },
});

function backend({ failUploadAt = -1, insertError = null, cleanupFails = false, blurFails = false } = {}) {
  let uploads = 0;
  const stored = new Set();
  const removed = [];
  const bucket = {
    upload: async (path) => {
      if (++uploads === failUploadAt) return { error: { message: 'Synthetic blur upload failure' } };
      stored.add(path); return { error: null };
    },
    copy: async (_source, target) => { stored.add(target); return { error: null }; },
    remove: async (paths) => {
      removed.push(...paths);
      if (cleanupFails) return { error: { message: 'Synthetic cleanup failure' } };
      paths.forEach((path) => stored.delete(path)); return { error: null };
    },
  };
  const supabase = {
    auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
    storage: { from: () => bucket },
    from: () => query(insertError ? { data: null, error: insertError } : { data: { id: 'new-row' }, error: null }),
  };
  const load = (name) => loadLibrary(name, { supabase, mocks: { 'expo-image-manipulator': imageManipulator(blurFails) } });
  return { load, stored, removed };
}

it('a drop whose blurry preview fails to upload removes the photo it already uploaded', async () => {
  const b = backend({ failUploadAt: 2 });
  await expect(b.load('posts').createPost('A', { kind: 'photo', uri: 'file:///photo.jpg' }, 'hi', { drop: true }))
    .rejects.toMatchObject({ message: 'Synthetic blur upload failure' });
  expect(b.removed).toEqual(['A/posts/test-file.jpg']);
  expect([...b.stored]).toEqual([]);
});

it('a drop whose blurry preview cannot be made removes the photo it already uploaded', async () => {
  const b = backend({ blurFails: true });
  await expect(b.load('posts').createPost('A', { kind: 'photo', uri: 'file:///photo.jpg' }, '', { drop: true }))
    .rejects.toThrow('Synthetic blur render failure');
  expect(b.removed).toEqual(['A/posts/test-file.jpg']);
  expect([...b.stored]).toEqual([]);
});

const story = { media_path: 'A/stories/s.mp4', poster_path: null, overlay_path: null, media_type: 'video' };
const photo = { kind: 'photo', uri: 'file:///photo.jpg' };
const savers = {
  'a post': (b) => b.load('posts').createPost('A', photo, 'hi', { forfeit: 'forfeit-1' }),
  'a drop': (b) => b.load('posts').createPost('A', photo, 'hi', { drop: true }),
  'a story copied to your profile': (b) => b.load('posts').postFromStory('A', story, 'hi', 'everyone'),
  'a story': (b) => b.load('stories').createStory('A', photo),
  'a keep': (b) => b.load('keeps').addKeep('A', photo),
  'a peek in chat': (b) => b.load('chat').sendSnap('A', ['B'], photo),
  'a group chat photo': (b) => b.load('groupChat').sendGroupCapture('A', 'group-1', photo),
  'a voice note': (b) => b.load('voice').sendVoice('A', 'B', 'file:///voice.m4a', 1200, [10, 20]),
  'a group voice note': (b) => b.load('groupChat').sendGroupVoice('A', 'group-1', 'file:///voice.m4a', 1200, [10, 20]),
  'a Guess Who post': (b) => b.load('guess').postMystery('A', photo, 'hi'),
};

for (const [what, save] of Object.entries(savers)) {
  it(`keeps the real reason when saving ${what} fails and removing its files fails too`, async () => {
    const real = { message: 'You already did this today', code: 'P0001' };
    const b = backend({ insertError: real, cleanupFails: true });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(save(b)).rejects.toMatchObject(real);
      expect(b.removed.length).toBeGreaterThan(0);
      expect(warning).toHaveBeenCalled();
    } finally { warning.mockRestore(); }
  });

  it(`removes the uploaded files when saving ${what} fails`, async () => {
    const b = backend({ insertError: { message: 'Not allowed', code: '42501' } });
    await expect(save(b)).rejects.toMatchObject({ message: 'Not allowed' });
    expect([...b.stored]).toEqual([]);
  });
}
