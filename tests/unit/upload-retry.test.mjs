import { expect, it } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

// Uploads try again by themselves after a hiccup (the owner's one-off "server error" on a second photo in a row:
// a 520 from the storage server's front door). Up to 2 more tries, a short wait apart; never after a clear "no".

const serverError = (status) => ({ name: 'StorageApiError', message: `HTTP ${status} error`, status, statusCode: String(status) });
const noSignal = () => ({ name: 'StorageUnknownError', message: 'Network request failed', originalError: new TypeError('Network request failed') });
const alreadyExists = () => ({ name: 'StorageApiError', message: 'The resource already exists', status: 400, statusCode: '409' });

// `answers` is what the store says to each try, in order (null = saved). It can also be a map from a file ending
// ('mp4', 'png', …) to that file's own answers, for files that upload at the same time.
// `inserts` counts chat messages saved.
function service(answers) {
  const tries = [];
  const waits = [];
  let inserts = 0;
  const perFile = new Map();
  const removed = [];
  const bucket = {
    upload: async (path, _bytes, options) => {
      tries.push({ path, options });
      if (Array.isArray(answers)) return { data: null, error: answers[tries.length - 1] ?? null };
      const ending = path.split('.').pop();
      const count = perFile.get(ending) ?? 0;
      perFile.set(ending, count + 1);
      return { data: null, error: answers[ending]?.[count] ?? null };
    },
    remove: async (paths) => {
      removed.push(...paths);
      return { error: null };
    },
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
  return { load, tries, waits, removed, inserts: () => inserts };
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

// A try that ran out of its time limit (src/lib/timedFetch.ts gave it 30 s + 1 s per 16 KB) already waited long on
// a slow signal: it isn't tried again straight away (the outbox tries again a little later).
it('an upload that ran out of time is not tried again at once', async () => {
  const timedOut = { name: 'StorageUnknownError', message: 'Aborted', originalError: { name: 'AbortError', message: 'Aborted' } };
  const s = service([timedOut]);
  await expect(s.load('media').uploadMedia('A', 'snaps', 'file:///photo.jpg', 'jpg', { path: 'A/snaps/chosen.jpg' })).rejects.toBe(timedOut);
  expect(s.tries).toHaveLength(1);
  expect(s.waits).toEqual([]);
});

it('gives up after 2 more tries (3 in all), with a short wait before each new try, and keeps the real reason', async () => {
  const last = serverError(503);
  const s = service([serverError(520), noSignal(), last]);
  const media = s.load('media');
  await expect(media.uploadMedia('A', 'group', 'file:///photo.jpg')).rejects.toBe(last);
  expect(s.tries).toHaveLength(3);
  expect(s.waits).toEqual([...media.UPLOAD_RETRY_WAITS_MS]);
  expect(s.waits.every((ms) => ms > 0 && ms <= 2000)).toBe(true);
});

it('the group message is not saved when the upload finally fails (saving rows is the outbox\'s job, with ids chosen once)', async () => {
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

// The outbox and early uploads choose the file name before the first try and write it down. "Already exists" on
// such a name means an earlier try of ours (maybe before the app was closed) did save it.
it('a chosen path that answers "already exists" on the FIRST try counts as done', async () => {
  const s = service([alreadyExists()]);
  await expect(s.load('media').uploadMedia('A', 'snaps', 'file:///photo.jpg', 'jpg', { path: 'A/snaps/chosen.jpg' })).resolves.toBe('A/snaps/chosen.jpg');
  expect(s.tries).toHaveLength(1);
  expect(s.tries[0].path).toBe('A/snaps/chosen.jpg');
});

it('a video with chosen paths keeps the files it already saved when another file fails (the next try reuses the names)', async () => {
  const s = service({ png: [serverError(400)] });
  const media = s.load('media');
  const paths = { media: 'A/snaps/v.mp4', poster: 'A/snaps/v.jpg', overlay: 'A/snaps/v.png' };
  await expect(media.uploadCapture('A', 'snaps', { kind: 'video', uri: 'file:///clip.mp4', overlayUri: 'file:///layer.png' }, { paths })).rejects.toMatchObject({ status: 400 });
  expect(s.removed).toEqual([]);
  expect(s.tries.map((t) => t.path).sort()).toEqual(['A/snaps/v.mp4', 'A/snaps/v.png']);
});

it('profile and group pictures are tried again too', async () => {
  const s = service([noSignal()]);
  await expect(s.load('media').uploadAvatar('A', 'file:///me.jpg')).resolves.toBe('A/test-file.jpg');
  expect(s.tries).toHaveLength(2);
  expect(s.tries[0].options).toEqual({ contentType: 'image/jpeg' });
});

// The video and its text layer now upload at the same time (they used to go one after another), so each file has
// its own answers here.
it('without chosen paths, a video still undoes the files it saved when another file fails (as before)', async () => {
  const s = service({ png: [serverError(400)] });
  await expect(s.load('media').uploadCapture('A', 'group', { kind: 'video', uri: 'file:///clip.mp4', overlayUri: 'file:///layer.png' })).rejects.toMatchObject({ status: 400 });
  expect(s.removed).toEqual(['A/group/test-file.mp4']);
});

it('a video and its text layer each get their own tries', async () => {
  // The video goes through on its 2nd try, the text layer on its 3rd. (No still-picture maker in tests.)
  const s = service({ mp4: [serverError(520), null], png: [noSignal(), serverError(502), null] });
  const { fields } = await s.load('media').uploadCapture('A', 'group', { kind: 'video', uri: 'file:///clip.mp4', overlayUri: 'file:///layer.png' });
  expect(fields).toMatchObject({ media_path: 'A/group/test-file.mp4', overlay_path: 'A/group/test-file.png' });
  expect(s.tries.filter((t) => t.path.endsWith('.mp4'))).toHaveLength(2);
  expect(s.tries.filter((t) => t.path.endsWith('.png'))).toHaveLength(3);
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
