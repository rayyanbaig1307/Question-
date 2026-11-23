import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { backend } from './outboxHarness.mjs';

// Early uploads (src/lib/preupload.ts): "Send to…" starts uploading the photo the moment it opens, so Send only has
// to save the row (the drop's On time / Late is stamped when the row is saved).

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const photo = { kind: 'photo', uri: 'file:///photo.jpg' };
const settle = () => vi.advanceTimersByTimeAsync(0);
const removed = (b) => b.log.filter((entry) => entry[0] === 'remove').flatMap((entry) => entry.slice(1));
const ledger = (b) => JSON.parse(b.store.get('preupload.v1.A') ?? '[]').map((entry) => entry.path);

async function setup() {
  const b = backend();
  const pre = b.load('preupload');
  await settle();
  return { b, pre };
}

it('the photo uploads straight away (shrunk), and its names are written down before the upload starts', async () => {
  const { b, pre } = await setup();
  const prepared = pre.prepareUpload('A', photo, 'posts', { blur: true });
  expect(prepared.state).toBe('uploading');
  const fields = await prepared.done;
  expect(fields).toMatchObject({ media_type: 'photo', media_path: prepared.paths.media });
  expect(fields.media_path).toMatch(/^A\/posts\//);
  expect(await prepared.blur).toMatch(/^A\/blurs\//);
  expect(prepared.state).toBe('ready');
  expect(b.files.has(fields.media_path)).toBe(true);
  // Both names are on the leftovers list until a saved row uses them.
  expect(ledger(b).sort()).toEqual([fields.media_path, prepared.blurPath].sort());
});

it('throwing it away deletes its files once the upload is done', async () => {
  const { b, pre } = await setup();
  const prepared = pre.prepareUpload('A', photo, 'snaps');
  pre.discardUpload(prepared);
  await prepared.done;
  await settle();
  expect(removed(b)).toEqual([prepared.paths.media]);
  expect(b.files.size).toBe(0);
  expect(ledger(b)).toEqual([]);
});

it('an upload a send is using is never deleted', async () => {
  const { b, pre } = await setup();
  const prepared = pre.prepareUpload('A', photo, 'snaps');
  pre.markUsed(prepared);
  pre.discardUpload(prepared);
  await prepared.done;
  await settle();
  expect(removed(b)).toEqual([]);
  expect(b.files.has(prepared.paths.media)).toBe(true);
});

it('leftovers older than 15 minutes are deleted at sign-in, except ones a waiting send uses', async () => {
  const { b, pre } = await setup();
  const now = Date.now();
  b.store.set('preupload.v1.A', JSON.stringify([
    { bucket: 'media', path: 'A/posts/old-unused.jpg', at: now - 20 * 60 * 1000 },
    { bucket: 'media', path: 'A/posts/old-waiting.jpg', at: now - 20 * 60 * 1000 },
    { bucket: 'media', path: 'A/posts/new.jpg', at: now - 60 * 1000 },
    { bucket: 'avatars', path: 'A/old-avatar.jpg', at: now - 30 * 60 * 1000 },
  ]));
  b.store.set('outbox.v1.A', JSON.stringify({
    k1: { key: 'k1', owner: 'A', state: 'failed', paths: { media: 'A/posts/old-waiting.jpg', poster: null, overlay: null } },
  }));
  for (const path of ['A/posts/old-unused.jpg', 'A/posts/old-waiting.jpg', 'A/posts/new.jpg', 'A/old-avatar.jpg']) b.files.set(path, true);
  await pre.cleanLeftoverUploads('A');
  expect(removed(b).sort()).toEqual(['A/old-avatar.jpg', 'A/posts/old-unused.jpg']);
  expect(ledger(b).sort()).toEqual(['A/posts/new.jpg', 'A/posts/old-waiting.jpg']);
});

it('another folder gets a server copy (to the names the send chose), not a new upload', async () => {
  const { b, pre } = await setup();
  const prepared = pre.prepareUpload('A', photo, 'posts');
  await prepared.done;
  const uploads = b.uploads().length;
  const targets = { media: 'A/snaps/copy.jpg', poster: null, overlay: null };
  const fields = await pre.fieldsFor(prepared, 'snaps', targets);
  expect(fields).toMatchObject({ media_path: 'A/snaps/copy.jpg', media_type: 'photo' });
  expect(b.log.filter((entry) => entry[0] === 'copy')).toEqual([['copy', prepared.paths.media, 'A/snaps/copy.jpg']]);
  expect(b.uploads()).toHaveLength(uploads);
  // A second try copies to the same name: "already exists" counts as done.
  await expect(pre.fieldsFor(prepared, 'snaps', targets)).resolves.toMatchObject({ media_path: 'A/snaps/copy.jpg' });
});

it('Guess Who files are never copied: to or from the mystery folder it uploads its own file', async () => {
  const { b, pre } = await setup();
  const guess = pre.prepareUpload('A', photo, 'mystery');
  await guess.done;
  expect(guess.paths.media).toMatch(/^mystery\//);
  const story = await pre.fieldsFor(guess, 'stories');
  expect(story.media_path).toMatch(/^A\/stories\//);
  const normal = pre.prepareUpload('A', photo, 'posts');
  await normal.done;
  const mystery = await pre.fieldsFor(normal, 'mystery');
  expect(mystery.media_path).toMatch(/^mystery\//);
  expect(b.log.filter((entry) => entry[0] === 'copy')).toEqual([]);
  // The same folder: the early upload itself.
  expect(await pre.fieldsFor(guess, 'mystery')).toEqual(await guess.done);
});

it('a different login throws early uploads away', async () => {
  const { b, pre } = await setup();
  const prepared = pre.prepareUpload('A', photo, 'snaps');
  await prepared.done;
  b.signIn('C');
  await settle();
  expect(prepared.state).toBe('discarded');
  expect(removed(b)).toEqual([prepared.paths.media]);
  await expect(pre.fieldsFor(prepared, 'snaps')).rejects.toThrow();
});

it('a profile picture uploads when it is picked; one that is not saved is deleted', async () => {
  const { b, pre } = await setup();
  const kept = pre.prepareAvatar('A', 'file:///me.jpg');
  const path = await kept.done;
  expect(path).toMatch(/^A\/[^/]+\.jpg$/);
  pre.markAvatarUsed(kept);
  pre.discardAvatar(kept);
  const dropped = pre.prepareAvatar('A', 'file:///other.jpg');
  pre.discardAvatar(dropped);
  await dropped.done;
  await settle();
  expect(removed(b)).toEqual([dropped.path]);
  expect(ledger(b)).toEqual([]);
});

it('an early upload that failed after a send took it over is tried once more by that send', async () => {
  const { b, pre } = await setup();
  let fail = true;
  b.rules.upload = () => (fail ? { error: { name: 'StorageApiError', message: 'Bad gateway', status: 400 } } : 'ok');
  const prepared = pre.prepareUpload('A', photo, 'snaps');
  pre.markUsed(prepared);
  await expect(prepared.done).rejects.toBeTruthy();
  fail = false;
  const fields = await pre.fieldsFor(prepared, 'snaps');
  expect(fields.media_path).toBe(prepared.paths.media);
  expect(b.files.has(prepared.paths.media)).toBe(true);
});

// ---------------------------------------------------------------------------
// Review fixes.
// ---------------------------------------------------------------------------

// R3: a picture picked in a dead spot failed to upload, and every Save after that failed at once.
it('a profile picture whose early upload failed is uploaded again (same name) when Save asks for it', async () => {
  const { b, pre } = await setup();
  let offline = true;
  b.rules.upload = () => (offline ? { error: { name: 'StorageApiError', message: 'Bad gateway', status: 400 } } : 'ok');
  const avatar = pre.prepareAvatar('A', 'file:///me.jpg');
  await expect(avatar.done).rejects.toBeTruthy();
  await settle();
  expect(avatar.failed).toBe(true);
  offline = false;
  await expect(pre.avatarReady(avatar)).resolves.toBe(avatar.path);
  expect(b.files.has(avatar.path)).toBe(true);
  // Already uploaded: Save doesn't upload it again.
  const uploads = b.uploads().length;
  await pre.avatarReady(avatar);
  expect(b.uploads()).toHaveLength(uploads);
});

// F2: profile pictures have no "in use" guard on the server. Saving the profile could go through while its answer
// got lost; leaving the screen then deleted the picture the profile now shows.
it('an unsaved profile picture that the profile does use after all is never deleted', async () => {
  const { b, pre } = await setup();
  const avatar = pre.prepareAvatar('A', 'file:///me.jpg');
  const path = await avatar.done;
  // The save reached the server, but its answer was lost: the phone still thinks it's unsaved.
  b.db.profiles.push({ id: 'A', avatar_path: path });
  pre.discardAvatar(avatar);
  await settle();
  expect(removed(b)).toEqual([]);
  expect(b.files.has(path)).toBe(true);
  expect(ledger(b)).toEqual([]);
  // The leftovers clean-up checks it too.
  b.store.set('preupload.v1.A', JSON.stringify([
    { bucket: 'avatars', path, at: Date.now() - 30 * 60 * 1000 },
    { bucket: 'avatars', path: 'A/really-unused.jpg', at: Date.now() - 30 * 60 * 1000 },
  ]));
  b.files.set('A/really-unused.jpg', true);
  await pre.cleanLeftoverUploads('A');
  expect(removed(b)).toEqual(['A/really-unused.jpg']);
  expect(b.files.has(path)).toBe(true);
  expect(ledger(b)).toEqual([]);
});

it("profile pictures aren't deleted at all while the profile can't be checked", async () => {
  const { b, pre } = await setup();
  b.rules.select = (table) => (table === 'profiles' ? 'noanswer' : null);
  b.store.set('preupload.v1.A', JSON.stringify([{ bucket: 'avatars', path: 'A/maybe.jpg', at: Date.now() - 30 * 60 * 1000 }]));
  b.files.set('A/maybe.jpg', true);
  await pre.cleanLeftoverUploads('A');
  expect(removed(b)).toEqual([]);
  expect(ledger(b)).toEqual(['A/maybe.jpg']);
});

// F4: leftovers were deleted in ONE request; one file a saved row uses made the server refuse the whole request,
// so the unused ones were either crossed off without being deleted, or never deleted at all.
it('leftovers are deleted one at a time: one file still in use never stops the others', async () => {
  const { b, pre } = await setup();
  const old = Date.now() - 20 * 60 * 1000;
  b.store.set('preupload.v1.A', JSON.stringify([
    { bucket: 'media', path: 'A/posts/in-use.jpg', at: old },
    { bucket: 'media', path: 'A/snaps/unused.jpg', at: old },
  ]));
  b.files.set('A/posts/in-use.jpg', true);
  b.files.set('A/snaps/unused.jpg', true);
  b.rules.remove = (paths) =>
    paths.includes('A/posts/in-use.jpg') ? { error: { name: 'StorageApiError', message: 'Cleanup cancelled because media is still in use', status: 400 } } : null;
  await pre.cleanLeftoverUploads('A');
  expect(b.files.has('A/posts/in-use.jpg')).toBe(true);
  expect(b.files.has('A/snaps/unused.jpg')).toBe(false);
  expect(ledger(b)).toEqual([]);
});

// R4: an early upload that failed while "Send to…" was open was only tried again at Send – so on 1 bar the whole
// upload came before the drop was saved (On time could turn into Late).
it('a failed early upload is tried again by itself while Send to… is still open', async () => {
  const { b, pre } = await setup();
  let offline = true;
  b.rules.upload = () => (offline ? 'noanswer' : 'ok');
  const prepared = pre.prepareUpload('A', photo, 'posts', { blur: true });
  // Three quick tries in about 2.5 seconds, all in a dead spot.
  await vi.advanceTimersByTimeAsync(3000);
  expect(prepared.state).toBe('failed');
  offline = false;
  await vi.advanceTimersByTimeAsync(1000);
  expect(prepared.state).toBe('ready');
  expect(b.files.has(prepared.paths.media)).toBe(true);
  expect(await prepared.blur).toBe(prepared.blurPath);
});

it('a failed early upload starts again when you come back to the app', async () => {
  const { b, pre } = await setup();
  let offline = true;
  b.rules.upload = () => (offline ? 'noanswer' : 'ok');
  const prepared = pre.prepareUpload('A', photo, 'snaps');
  // Every quick try fails (about 15 seconds of a dead spot).
  await vi.advanceTimersByTimeAsync(30_000);
  expect(prepared.state).toBe('failed');
  offline = false;
  b.becomeActive();
  await vi.advanceTimersByTimeAsync(10);
  expect(prepared.state).toBe('ready');
});

// R5: a video drop's blurry preview used to wait until the whole video was up, and the drop waited for both.
it("a video drop's blurry preview is made from its still picture while the video is still uploading", async () => {
  const b = backend();
  const pre = b.load('preupload', {
    expo: { requireOptionalNativeModule: (name) => (name === 'ExpoVideoThumbnails' ? {} : null) },
    'expo-video-thumbnails': { getThumbnailAsync: async () => ({ uri: 'file:///poster.jpg' }) },
  });
  await settle();
  let release;
  b.rules.upload = (path) => (path.endsWith('.mp4') ? new Promise((resolve) => { release = () => resolve('ok'); }) : 'ok');
  const prepared = pre.prepareUpload('A', { kind: 'video', uri: 'file:///clip.mp4' }, 'posts', { blur: true });
  await expect(prepared.blur).resolves.toBe(prepared.blurPath);
  expect(b.files.has(prepared.paths.media)).toBe(false);
  release();
  const fields = await prepared.done;
  expect(fields).toMatchObject({ media_type: 'video', media_path: prepared.paths.media, poster_path: prepared.paths.poster });
});
