import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PostgrestClient } from '@supabase/postgrest-js';
import { StorageClient } from '@supabase/storage-js';
import { loadLibrary } from './libHarness.mjs';

// The time limit on every request (src/lib/timedFetch.ts) now covers the WHOLE answer, and a request that was given
// up always fails with an "AbortError".
//
// Why: the phone's fetch (expo/fetch, which Expo puts in place of the usual one) hands back an answer as soon as its
// headers arrive; the body (the rows, the JSON) is read after that. The clock used to stop at the headers, so on
// 1 bar a body that stalled kept a send on "Sending…" for good (review BODY-READ-UNTIMED). And when the clock ran
// out, expo/fetch failed with a plain Error, "fetch failed: Fetch request has been canceled", not an AbortError:
// Supabase then tried a lost read 3 more times (about 87 s instead of 20), uploads didn't see that their time had
// run out, and that raw text was shown to people (review ABORT-NOT-RECOGNISED).

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const NO_INTERNET = "Can't reach the internet. Check your connection and try again.";

// The same shape as expo/fetch's own error (node_modules/expo/src/winter/fetch/FetchErrors.ts): a plain Error.
class FetchError extends Error {
  constructor(message) {
    super(`fetch failed: ${message}`);
  }
}

// A pretend answer like expo/fetch's FetchResponse: the headers are there at once, and the body is read later.
// `body` is either the whole body as text (it arrives in full), or { arrived, then } for a body that stalls after
// `arrived` has come in. `then` says what a cancel does to that stalled read:
//   'never'   – nothing: the read never finishes, not even after a cancel
//   'partial' – the read ends with only the part that had arrived (what Android does after a cancel)
//   'fail'    – the read fails with expo's "Fetch request has been canceled" (what iOS does)
function phoneAnswer({ status = 200, headers = { 'content-type': 'application/json' }, body = '', signal }) {
  const read = () =>
    new Promise((resolve, reject) => {
      if (typeof body === 'string') return resolve(body);
      if (body.then === 'never') return;
      signal.addEventListener('abort', () => {
        if (body.then === 'partial') resolve(body.arrived);
        else reject(new FetchError('Fetch request has been canceled'));
      });
    });
  let used = false;
  const answer = {
    status,
    statusText: status === 200 ? 'OK' : '',
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    async text() {
      if (used) throw new TypeError("Failed to execute 'text' on 'Response': Response body is already used.");
      used = true;
      return read();
    },
    // Like FetchResponse: json() and blob() read through text() and arrayBuffer().
    async json() {
      return JSON.parse(await this.text());
    },
    async arrayBuffer() {
      if (used) throw new TypeError('Response body is already used.');
      used = true;
      return new TextEncoder().encode(await read()).buffer;
    },
    async blob() {
      return new Blob([await this.arrayBuffer()]);
    },
  };
  return answer;
}

// A fetch like the phone's. `answer(call)` decides each request: return { after, ...phoneAnswer options } to send
// the headers after `after` ms, or nothing for no answer at all. With no answer, a cancel makes the request fail
// the way expo/fetch does (fetch.ts: FetchError.createFromError of the native "Fetch request has been canceled").
function phoneFetch(answer = () => null) {
  const calls = [];
  const fetch = (url, init) => {
    const signal = init.signal;
    if (signal.aborted) return Promise.reject(new FetchError('The operation was aborted.'));
    const call = { url: String(url), method: init.method ?? 'GET', at: Date.now() };
    calls.push(call);
    return new Promise((resolve, reject) => {
      let answered = false;
      signal.addEventListener('abort', () => {
        if (!answered) reject(new FetchError('Fetch request has been canceled'));
      });
      const plan = answer(call);
      if (!plan) return;
      setTimeout(() => {
        if (signal.aborted) return;
        answered = true;
        resolve(plan.response ?? phoneAnswer({ ...plan, signal }));
      }, plan.after ?? 0);
    });
  };
  return { fetch, calls };
}

function load(fetch) {
  return loadLibrary('timedFetch', {
    globals: { fetch, AbortController, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, ArrayBuffer },
  });
}

const errors = () => loadLibrary('errors');

// Runs a promise and says how it ended once the fake clock has moved on.
function watch(promise) {
  const state = { done: false, error: null, value: null };
  promise.then((value) => { state.done = true; state.value = value; }, (error) => { state.done = true; state.error = error; });
  return state;
}

const ROWS = 'https://x.supabase.co/rest/v1/messages?select=*';

it('BODY-READ-UNTIMED: headers that arrive but a body that never does is given up at the same 20 seconds', async () => {
  const { fetch } = phoneFetch(() => ({ after: 1_000, body: { arrived: '', then: 'never' } }));
  const { timedFetch } = load(fetch);
  const asked = watch(timedFetch(ROWS));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(asked.value?.status).toBe(200);
  const body = watch(asked.value.text());
  await vi.advanceTimersByTimeAsync(18_999);
  expect(body.done).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(body.done).toBe(true);
  expect(body.error?.name).toBe('AbortError');
  expect(vi.getTimerCount()).toBe(0);
  expect(errors().friendlyError(body.error)).toBe(NO_INTERNET);
});

it('BODY-READ-UNTIMED: a body that stalls and is then cut short (Android) is never handed back half-read', async () => {
  const { fetch } = phoneFetch(() => ({ body: { arrived: '[{"id":"m1","text":"hel', then: 'partial' } }));
  const { timedFetch } = load(fetch);
  const one = watch(timedFetch(ROWS));
  const two = watch(timedFetch(ROWS));
  await vi.advanceTimersByTimeAsync(0);
  const json = watch(one.value.json());
  const text = watch(two.value.text());
  await vi.advanceTimersByTimeAsync(20_000);
  expect(json.error?.name).toBe('AbortError');
  expect(text.error?.name).toBe('AbortError');
  expect(text.value).toBe(null);
  expect(vi.getTimerCount()).toBe(0);
});

it('BODY-READ-UNTIMED: a body read that fails after a cancel (iOS) also says AbortError', async () => {
  const { fetch } = phoneFetch(() => ({ body: { arrived: '', then: 'fail' } }));
  const { timedFetch } = load(fetch);
  const asked = watch(timedFetch(ROWS));
  await vi.advanceTimersByTimeAsync(0);
  const blob = watch(asked.value.blob());
  await vi.advanceTimersByTimeAsync(20_000);
  expect(blob.error?.name).toBe('AbortError');
  expect(blob.error?.message).toMatch(/aborted/);
});

it('BODY-READ-UNTIMED: a chat text whose saved row never fully comes back stops "Sending…" at 20 seconds', async () => {
  // The outbox saves with insert(...).select('*').single(): the row comes back in the body.
  const { fetch, calls } = phoneFetch(() => ({ status: 201, body: { arrived: '{"id":"m1"', then: 'never' } }));
  const { timedFetch } = load(fetch);
  const db = new PostgrestClient('https://x.supabase.co/rest/v1', { fetch: timedFetch });
  const save = watch(db.from('messages').insert({ id: 'm1', body: 'hi' }).select('*').single().then((result) => result));
  await vi.advanceTimersByTimeAsync(19_999);
  expect(save.done).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(save.done).toBe(true);
  // A lost answer, as the outbox expects it (status 0, no database code), not a crash and not a hang.
  expect(save.value).toMatchObject({ data: null, status: 0, error: { code: '' } });
  expect(save.value.error.message).toMatch(/^AbortError/);
  expect(errors().friendlyError(save.value.error)).toBe(NO_INTERNET);
  expect(calls).toHaveLength(1);
});

it('a normal JSON answer comes through whole (emoji too) and leaves no timer once it is read', async () => {
  const rows = [{ id: 'm1', body: 'hi 👋 café' }];
  const { fetch } = phoneFetch(() => ({ after: 300, body: JSON.stringify(rows) }));
  const { timedFetch } = load(fetch);
  const asked = watch(timedFetch(ROWS));
  await vi.advanceTimersByTimeAsync(300);
  // The clock is still running while the body hasn't been read yet.
  expect(vi.getTimerCount()).toBe(1);
  await expect(asked.value.json()).resolves.toEqual(rows);
  expect(vi.getTimerCount()).toBe(0);
  // With a real Response (as on the web), every way of reading still works.
  const real = load(() => Promise.resolve(new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } }))).timedFetch;
  await expect((await real(ROWS)).json()).resolves.toEqual(rows);
  await expect((await real(ROWS)).text()).resolves.toBe(JSON.stringify(rows));
  expect(new TextDecoder().decode(await (await real(ROWS)).arrayBuffer())).toBe(JSON.stringify(rows));
  expect(await (await (await real(ROWS)).blob()).text()).toBe(JSON.stringify(rows));
  expect(vi.getTimerCount()).toBe(0);
});

it('an empty 204 answer and a HEAD answer pass through, and their clock stops at once', async () => {
  const { timedFetch } = load(() => Promise.resolve(new Response(null, { status: 204 })));
  const empty = await timedFetch('https://x.supabase.co/rest/v1/messages?id=eq.m1', { method: 'DELETE' });
  expect(vi.getTimerCount()).toBe(0);
  expect(empty.status).toBe(204);
  await expect(empty.text()).resolves.toBe('');
  // A count (head: true) is only headers: nobody reads a body, so nothing is left waiting.
  const { fetch } = phoneFetch(() => ({ headers: { 'content-range': '*/3' } }));
  const db = new PostgrestClient('https://x.supabase.co/rest/v1', { fetch: load(fetch).timedFetch });
  const check = watch(db.from('legal_acceptances').select('version', { count: 'exact', head: true }).then((result) => result));
  await vi.advanceTimersByTimeAsync(0);
  expect(check.value).toMatchObject({ error: null, count: 3, status: 200 });
  expect(vi.getTimerCount()).toBe(0);
});

it('ABORT-NOT-RECOGNISED: a request the phone cancels at the limit fails with an AbortError, not "fetch failed"', async () => {
  const { fetch, calls } = phoneFetch();
  const { timedFetch } = load(fetch);
  const state = watch(timedFetch(ROWS, { method: 'POST', body: '{}' }));
  await vi.advanceTimersByTimeAsync(20_000);
  expect(calls).toHaveLength(1);
  expect(state.error?.name).toBe('AbortError');
  expect(state.error?.message).toMatch(/aborted/);
  expect(errors().friendlyError(state.error)).toBe(NO_INTERNET);
  expect(vi.getTimerCount()).toBe(0);
});

it('ABORT-NOT-RECOGNISED: a HEAD check that gets no answer is tried once and gives up at 20 seconds (not about 87)', async () => {
  // dareRules.ensure() in share.tsx: the Send spinner waits on this count of legal_acceptances.
  const { fetch, calls } = phoneFetch();
  const db = new PostgrestClient('https://x.supabase.co/rest/v1', { fetch: load(fetch).timedFetch });
  const check = watch(db.from('legal_acceptances').select('version', { count: 'exact', head: true }).eq('user_id', 'A').then((result) => result));
  await vi.advanceTimersByTimeAsync(20_000);
  expect(check.done).toBe(true);
  expect(calls.map((call) => call.method)).toEqual(['HEAD']);
  expect(check.value).toMatchObject({ status: 0, error: { code: '' } });
  expect(check.value.error.message).toMatch(/^AbortError/);
  expect(errors().friendlyError(check.value.error)).toBe(NO_INTERNET);
  // Nothing else is tried later either.
  await vi.advanceTimersByTimeAsync(120_000);
  expect(calls).toHaveLength(1);
});

it("ABORT-NOT-RECOGNISED: the caller's own cancel also says AbortError, before the headers and while the body is read", async () => {
  const { fetch } = phoneFetch((call) => (call.url.includes('body') ? { body: { arrived: '', then: 'fail' } } : null));
  const { timedFetch } = load(fetch);
  const early = new AbortController();
  const before = watch(timedFetch(ROWS, { signal: early.signal }));
  await vi.advanceTimersByTimeAsync(5);
  early.abort();
  await vi.advanceTimersByTimeAsync(0);
  expect(before.error?.name).toBe('AbortError');
  // A signal that was already cancelled.
  const already = watch(timedFetch(ROWS, { signal: early.signal }));
  await vi.advanceTimersByTimeAsync(0);
  expect(already.error?.name).toBe('AbortError');
  const late = new AbortController();
  const asked = watch(timedFetch('https://x.supabase.co/rest/v1/body', { signal: late.signal }));
  await vi.advanceTimersByTimeAsync(0);
  const body = watch(asked.value.text());
  await vi.advanceTimersByTimeAsync(5);
  expect(body.done).toBe(false);
  late.abort();
  await vi.advanceTimersByTimeAsync(0);
  expect(body.error?.name).toBe('AbortError');
  expect(vi.getTimerCount()).toBe(0);
});

it('ABORT-NOT-RECOGNISED: an upload that ran out of time is seen as that (one try), and gets longer next time', async () => {
  const { fetch, calls } = phoneFetch();
  const { timedFetch, deadlineFor } = load(fetch);
  const storage = new StorageClient('https://x.supabase.co/storage/v1', {}, timedFetch);
  // A 16 KB photo: 31 seconds to upload.
  const photo = { File: class { async arrayBuffer() { return new ArrayBuffer(16 * 1024); } }, Paths: {} };
  const auth = { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) };
  const media = loadLibrary('media', { supabase: { auth, storage }, mocks: { 'expo-file-system': photo } });
  const path = 'A/snaps/chosen.jpg';
  const url = `https://x.supabase.co/storage/v1/object/media/${path}`;
  const upload = watch(media.uploadMedia('A', 'snaps', 'file:///photo.jpg', 'jpg', { path }));
  await vi.advanceTimersByTimeAsync(31_000);
  expect(upload.done).toBe(true);
  // The storage library keeps the AbortError, so media.ts doesn't try again at once (the outbox does, later).
  expect(upload.error?.name).toBe('StorageUnknownError');
  expect(upload.error?.originalError?.name).toBe('AbortError');
  expect(calls).toHaveLength(1);
  expect(errors().friendlyError(upload.error)).toBe(NO_INTERNET);
  // Its next try gets three times as long.
  expect(deadlineFor(url, { method: 'POST', body: new ArrayBuffer(16 * 1024) })).toBe(33_000);
});

it('an upload that got its answer starts from the normal limit again, even if reading that answer then stalls', async () => {
  let plan = null;
  const { fetch } = phoneFetch(() => plan);
  const { timedFetch, deadlineFor } = load(fetch);
  const url = 'https://x.supabase.co/storage/v1/object/media/A/snaps/v.mp4';
  const body = new ArrayBuffer(16 * 1024);
  const first = watch(timedFetch(url, { method: 'POST', body }));
  await vi.advanceTimersByTimeAsync(31_000);
  expect(first.error?.name).toBe('AbortError');
  expect(deadlineFor(url, { method: 'POST', body })).toBe(33_000);
  // The next try gets there: the file is saved, the answer's headers come back, then its small JSON stalls.
  plan = { after: 20_000, body: { arrived: '{"Key":', then: 'never' } };
  const second = watch(timedFetch(url, { method: 'POST', body }));
  await vi.advanceTimersByTimeAsync(20_000);
  expect(second.value?.status).toBe(200);
  expect(deadlineFor(url, { method: 'POST', body })).toBe(31_000);
  const json = watch(second.value.json());
  await vi.advanceTimersByTimeAsync(13_000);
  expect(json.error?.name).toBe('AbortError');
  // The file did get there, so the limit doesn't grow because of the stalled answer.
  expect(deadlineFor(url, { method: 'POST', body })).toBe(31_000);
  // And a later answer that comes back whole is taken.
  plan = { body: '{"Key":"media/A/snaps/v.mp4"}' };
  const third = watch(timedFetch(url, { method: 'POST', body }));
  await vi.advanceTimersByTimeAsync(0);
  await expect(third.value.json()).resolves.toEqual({ Key: 'media/A/snaps/v.mp4' });
  expect(vi.getTimerCount()).toBe(0);
});

it('the phone\'s own "fetch failed: …" text reads as "Can\'t reach the internet"', () => {
  const { friendlyError } = errors();
  expect(friendlyError({ message: 'Error: fetch failed: Fetch request has been canceled' })).toBe(NO_INTERNET);
  expect(friendlyError(new FetchError('The Internet connection appears to be offline.'))).toBe(NO_INTERNET);
  expect(friendlyError({ message: 'AbortError: The request was aborted: no answer in time.' })).toBe(NO_INTERNET);
});
