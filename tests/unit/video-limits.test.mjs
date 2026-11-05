import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

// Videos: 30 seconds for everyone, 60 with Peekaboo+, and never more than the 30 MB the store takes.
const limits = loadLibrary('videoLimits');
const MB = 1024 * 1024;

it('the camera records 30 seconds without Peekaboo+ and 60 with it', () => {
  expect(limits.maxVideoSeconds(false)).toBe(30);
  expect(limits.maxVideoSeconds(true)).toBe(60);
});

it('a camera-roll video is checked by length (with Plus) and size', () => {
  const check = limits.checkPickedVideo;
  expect(check(30_400, 5 * MB, false)).toBe('ok');
  expect(check(31_000, 5 * MB, false)).toBe('needs-plus');
  expect(check(59_000, 5 * MB, false)).toBe('needs-plus');
  expect(check(59_000, 19 * MB, true)).toBe('ok');
  expect(check(60_400, 19 * MB, true)).toBe('ok');
  expect(check(61_000, 19 * MB, true)).toBe('too-long');
  expect(check(61_000, 19 * MB, false)).toBe('too-long');
  expect(check(20_000, 31 * MB, false)).toBe('too-big');
  expect(check(50_000, 31 * MB, true)).toBe('too-big');
  // Some phones don't say how long or big a video is: let it through, the upload checks the size again.
  expect(check(undefined, undefined, false)).toBe('ok');
});

it('the size limit matches the storage bucket limit in the videos migration', () => {
  const migration = readFileSync('supabase/migrations/20261103000000_videos.sql', 'utf8');
  expect(migration).toMatch(new RegExp(`file_size_limit = ${limits.MAX_VIDEO_BYTES}\\b`));
});

function mediaWithFile(bytes) {
  const upload = vi.fn(async () => ({ error: null }));
  const media = loadLibrary('media', {
    supabase: {
      auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
      storage: { from: () => ({ upload }) },
    },
    mocks: { 'expo-file-system': { File: class { async arrayBuffer() { return new ArrayBuffer(bytes); } } } },
  });
  return { media, upload };
}

it('a video over 30 MB is stopped before uploading, with a friendly message', async () => {
  const { media, upload } = mediaWithFile(30 * MB + 1);
  await expect(media.uploadMedia('A', 'snaps', 'file:///long.mp4', 'video')).rejects.toThrow(limits.TOO_BIG_VIDEO);
  expect(upload).not.toHaveBeenCalled();
});

it('a 60-second Peekaboo video (about 19 MB) uploads', async () => {
  const { media, upload } = mediaWithFile(19 * MB);
  await expect(media.uploadMedia('A', 'stories', 'file:///minute.mp4', 'video')).resolves.toMatch(/^A\/stories\/.+\.mp4$/);
  expect(upload).toHaveBeenCalledTimes(1);
});

it('the players allow a 60-second video', () => {
  expect(readFileSync('src/app/(app)/snap/[id].tsx', 'utf8')).toMatch(/const MAX_VIDEO_SECONDS = 60;/);
  expect(readFileSync('src/app/(app)/stories/[user].tsx', 'utf8')).toMatch(/Math\.min\(60, Math\.max\(1, videoLength\.seconds\)\)/);
});

it('the store size error reads kindly', () => {
  const { friendlyError } = loadLibrary('errors', { mocks: { './cleanWords': { NAME_NOT_ALLOWED: 'That name is not allowed.', WORD_NOT_ALLOWED: 'That word is not allowed.' } } });
  expect(friendlyError({ message: 'The object exceeded the maximum allowed size' })).toMatch(/too big/);
});
