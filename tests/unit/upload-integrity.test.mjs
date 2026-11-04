import { expect, it, vi } from 'vitest';
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
