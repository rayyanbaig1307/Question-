import { expect, it } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

// Uploads try again by themselves after a hiccup (the owner's one-off "server error" on a second photo in a row:
// a 520 from the storage server's front door). Up to 2 more tries, a short wait apart; never after a clear "no".

const serverError = (status) => ({ name: 'StorageApiError', message: `HTTP ${status} error`, status, statusCode: String(status) });
const noSignal = () => ({ name: 'StorageUnknownError', message: 'Network request failed', originalError: new TypeError('Network request failed') });
const alreadyExists = () => ({ name: 'StorageApiError', message: 'The resource already exists', status: 400, statusCode: '409' });

// `answers` is what the store says to each try, in order (null = saved). `inserts` counts chat messages saved.
function service(answers) {
  const tries = [];
  const waits = [];
  let inserts = 0;
  const bucket = {
    upload: async (path, _bytes, options) => {
      tries.push({ path, options });
      return { data: null, error: answers[tries.length - 1] ?? null };
    },
    remove: async () => ({ error: null }),
  };
  const supabase = {
    auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
    storage: { from: () => bucket },
    from: () => ({
      insert: () => {
        inserts += 1;
        return Promise.resolve({ error: null });
      },
    }),
  };
  // No real waiting in tests: note each wait and carry on at once.
  const globals = { setTimeout: (run, ms) => { waits.push(ms); run(); return 0; } };
  const load = (name) => loadLibrary(name, { supabase, globals });
  return { load, tries, waits, inserts: () => inserts };
}

const photo = { kind: 'photo', uri: 'file:///photo.jpg' };

it('a 520 from the store is tried again, and the group photo is sent once', async () => {
  const s = service([serverError(520)]);
  await s.load('groupChat').sendGroupCapture('A', 'group-1', photo);
  expect(s.tries).toHaveLength(2);
  // The same file name both times (so a try that did get through can't leave a second copy).
  expect(new Set(s.tries.map((t) => t.path))).toEqual(new Set(['A/group/test-file.jpg']));
  expect(s.waits).toHaveLength(1);
  expect(s.inserts()).toBe(1);
});

for (const [what, first] of [
  ['no signal', noSignal()],
  ['a 502', serverError(502)],
  ['a 503', serverError(503)],
  ['a 504', serverError(504)],
  ['a 500', serverError(500)],
]) {
  it(`${what} is tried again`, async () => {
    const s = service([first]);
    await expect(s.load('media').uploadMedia('A', 'snaps', 'file:///photo.jpg')).resolves.toBe('A/snaps/test-file.jpg');
    expect(s.tries).toHaveLength(2);
  });
}

it('gives up after 2 more tries (3 in all), with a short wait before each new try, and keeps the real reason', async () => {
  const last = serverError(503);
  const s = service([serverError(520), noSignal(), last]);
  const media = s.load('media');
  await expect(media.uploadMedia('A', 'group', 'file:///photo.jpg')).rejects.toBe(last);
  expect(s.tries).toHaveLength(3);
  expect(s.waits).toEqual([...media.UPLOAD_RETRY_WAITS_MS]);
  expect(s.waits.every((ms) => ms > 0 && ms <= 2000)).toBe(true);
});

it('the chat message is never saved when the upload finally fails', async () => {
  const s = service([serverError(520), serverError(520), serverError(520)]);
  await expect(s.load('groupChat').sendGroupCapture('A', 'group-1', photo)).rejects.toMatchObject({ status: 520 });
  expect(s.inserts()).toBe(0);
});

for (const status of [400, 401, 403, 404, 409, 413, 429]) {
  it(`a clear "no" (${status}) is never tried again`, async () => {
    const no = serverError(status);
    const s = service([no]);
    await expect(s.load('media').uploadMedia('A', 'snaps', 'file:///photo.jpg')).rejects.toBe(no);
    expect(s.tries).toHaveLength(1);
    expect(s.waits).toEqual([]);
  });
}

it('an error with no answer number that is not a dropped connection is not tried again', async () => {
  const odd = { message: 'Something else' };
  const s = service([odd]);
  await expect(s.load('media').uploadMedia('A', 'snaps', 'file:///photo.jpg')).rejects.toBe(odd);
  expect(s.tries).toHaveLength(1);
});

it('"already exists" on a new try means the earlier try did save it: done, no error', async () => {
  const s = service([serverError(520), alreadyExists()]);
  await expect(s.load('media').uploadMedia('A', 'group', 'file:///photo.jpg')).resolves.toBe('A/group/test-file.jpg');
  expect(s.tries).toHaveLength(2);
});

it('"already exists" on the FIRST try is a real refusal (not ours)', async () => {
  const s = service([alreadyExists()]);
  await expect(s.load('media').uploadMedia('A', 'group', 'file:///photo.jpg')).rejects.toMatchObject({ statusCode: '409' });
  expect(s.tries).toHaveLength(1);
});

it('profile and group pictures are tried again too', async () => {
  const s = service([noSignal()]);
  await expect(s.load('media').uploadAvatar('A', 'file:///me.jpg')).resolves.toBe('A/test-file.jpg');
  expect(s.tries).toHaveLength(2);
  expect(s.tries[0].options).toEqual({ contentType: 'image/jpeg' });
});

it('a video and its text layer each get their own tries', async () => {
  // The video goes through on its 2nd try, the text layer on its 3rd. (No still-picture maker in tests.)
  const s = service([serverError(520), null, noSignal(), serverError(502), null]);
  const { fields } = await s.load('media').uploadCapture('A', 'group', { kind: 'video', uri: 'file:///clip.mp4', overlayUri: 'file:///layer.png' });
  expect(fields).toMatchObject({ media_path: 'A/group/test-file.mp4', overlay_path: 'A/group/test-file.png' });
  expect(s.tries.map((t) => t.path)).toEqual([
    'A/group/test-file.mp4',
    'A/group/test-file.mp4',
    'A/group/test-file.png',
    'A/group/test-file.png',
    'A/group/test-file.png',
  ]);
});

it('worthTryingAgain: only no-answer and 5xx', async () => {
  const { worthTryingAgain } = service([]).load('media');
  expect(worthTryingAgain(noSignal())).toBe(true);
  expect(worthTryingAgain(serverError(520))).toBe(true);
  expect(worthTryingAgain(serverError(500))).toBe(true);
  expect(worthTryingAgain(serverError(499))).toBe(false);
  expect(worthTryingAgain(serverError(400))).toBe(false);
  expect(worthTryingAgain(null)).toBe(false);
  expect(worthTryingAgain('boom')).toBe(false);
});
