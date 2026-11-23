import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

// Every request to the server has a time limit (src/lib/timedFetch.ts). Before this, the phone's fetch waited
// forever: on 1 bar of signal a lost answer kept the Send button spinning for good (the owner's drop, 22 Nov).

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// A fetch that never answers by itself: it only fails when it's cancelled (like the phone's fetch on a lost answer).
function hangingFetch() {
  const calls = [];
  const fetch = (url, init) =>
    new Promise((resolve, reject) => {
      const call = { url, init, settled: false };
      calls.push(call);
      call.answer = (value) => { call.settled = true; resolve(value); };
      init.signal.addEventListener('abort', () => {
        call.settled = true;
        reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      });
    });
  return { fetch, calls };
}

function load(fetch) {
  return loadLibrary('timedFetch', {
    globals: { fetch, AbortController, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, ArrayBuffer },
  });
}

// Runs the request and says how it ended once the fake clock has moved on.
function watch(promise) {
  const state = { done: false, error: null, value: null };
  promise.then((value) => { state.done = true; state.value = value; }, (error) => { state.done = true; state.error = error; });
  return state;
}

it('supabase.ts gives Supabase the timed fetch (rows, storage, login and functions all use it)', () => {
  let options = null;
  const supabaseJs = { createClient: (_url, _key, given) => { options = given; return { auth: { startAutoRefresh() {}, stopAutoRefresh() {} } }; } };
  loadLibrary('supabase', {
    mocks: {
      '@supabase/supabase-js': supabaseJs,
      '@react-native-async-storage/async-storage': { default: {} },
      'react-native': { AppState: { addEventListener() { return { remove() {} }; } } },
    },
  });
  expect(typeof options?.global?.fetch).toBe('function');
  // The login settings are the same as before.
  expect(options.auth).toMatchObject({ autoRefreshToken: true, persistSession: true, detectSessionInUrl: false });
});

it('a request that never answers is given up after 20 seconds', async () => {
  const { fetch, calls } = hangingFetch();
  const { timedFetch } = load(fetch);
  const state = watch(timedFetch('https://x.supabase.co/rest/v1/messages?select=*', { method: 'POST', body: '{}' }));
  await vi.advanceTimersByTimeAsync(19_999);
  expect(state.done).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(state.done).toBe(true);
  expect(state.error?.name).toBe('AbortError');
  expect(calls).toHaveLength(1);
});

it('a 500 KB photo upload is still going at 60 seconds and is given up at about 61 seconds', async () => {
  const { fetch } = hangingFetch();
  const { timedFetch, deadlineFor } = load(fetch);
  const body = new ArrayBuffer(500 * 1024);
  expect(deadlineFor('https://x.supabase.co/storage/v1/object/media/x.jpg', { method: 'POST', body })).toBe(61_250);
  const state = watch(timedFetch('https://x.supabase.co/storage/v1/object/media/x.jpg', { method: 'POST', body }));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(state.done).toBe(false);
  await vi.advanceTimersByTimeAsync(1_300);
  expect(state.error?.name).toBe('AbortError');
});

it('the limits: login 30 s, login refresh 90 s, functions 60 s, small storage calls 20 s, a 6 MB video about 7 minutes, never more than 10', () => {
  const { deadlineFor } = load(hangingFetch().fetch);
  expect(deadlineFor('https://x.supabase.co/auth/v1/token?grant_type=password', { method: 'POST', body: '{}' })).toBe(30_000);
  expect(deadlineFor('https://x.supabase.co/auth/v1/user', { method: 'GET' })).toBe(30_000);
  expect(deadlineFor('https://x.supabase.co/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: '{}' })).toBe(90_000);
  expect(deadlineFor('https://x.supabase.co/functions/v1/delete-account', { method: 'POST', body: '{}' })).toBe(60_000);
  expect(deadlineFor('https://x.supabase.co/storage/v1/object/sign/media', { method: 'POST', body: '{"paths":[]}' })).toBe(20_000);
  expect(deadlineFor('https://x.supabase.co/storage/v1/object/copy', { method: 'POST', body: '{}' })).toBe(20_000);
  expect(deadlineFor('https://x.supabase.co/storage/v1/object/media', { method: 'DELETE', body: '{}' })).toBe(20_000);
  expect(deadlineFor('https://x.supabase.co/rest/v1/rpc/accept_legal', { method: 'POST', body: '{}' })).toBe(20_000);
  const video = deadlineFor('https://x.supabase.co/storage/v1/object/media/a.mp4', { method: 'POST', body: new Uint8Array(6 * 1024 * 1024) });
  expect(video).toBeGreaterThan(6.5 * 60_000);
  expect(video).toBeLessThan(7.5 * 60_000);
  expect(deadlineFor('https://x.supabase.co/storage/v1/object/media/b.mp4', { method: 'PUT', body: new ArrayBuffer(200 * 1024 * 1024) })).toBe(600_000);
});

// Review F1: the server swaps your login for a new one as soon as it gets a refresh. Giving up at 30 s (while the
// answer was still on its way) meant the phone later sent the old login again, got "already used" and was logged
// out. A slow answer (38 s was seen on 1 bar) is now waited for; only a refresh with no answer at all is given up.
it('a login refresh answered after 38 seconds is still taken; one with no answer is given up at 90 seconds', async () => {
  const { fetch, calls } = hangingFetch();
  const { timedFetch } = load(fetch);
  const slow = watch(timedFetch('https://x.supabase.co/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: '{}' }));
  await vi.advanceTimersByTimeAsync(38_000);
  expect(slow.done).toBe(false);
  calls[0].answer({ ok: true, status: 200 });
  await vi.advanceTimersByTimeAsync(0);
  expect(slow.error).toBe(null);
  expect(slow.value).toMatchObject({ status: 200 });
  const lost = watch(timedFetch('https://x.supabase.co/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: '{}' }));
  await vi.advanceTimersByTimeAsync(89_999);
  expect(lost.done).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(lost.error?.name).toBe('AbortError');
});

// Review R2: every try of an upload used to get the same time limit, so an upload slower than its limit failed on
// every try and could never get there. Now the next try of the same file gets 3 times as long (then 9 times…).
it('an upload that ran out of time gets three times as long on its next try, and the normal limit again after an answer', async () => {
  const { fetch, calls } = hangingFetch();
  const { timedFetch, deadlineFor, UPLOAD_MAX_MS } = load(fetch);
  const url = 'https://x.supabase.co/storage/v1/object/media/A/snaps/video.mp4';
  // A 60-second Peekaboo+ video (about 18.75 MB): on 1 bar at 200 kbit/s it needs about 12.5 minutes.
  const body = new ArrayBuffer(Math.round(18.75 * 1024 * 1024));
  const other = 'https://x.supabase.co/storage/v1/object/media/A/snaps/other.mp4';
  expect(deadlineFor(url, { method: 'POST', body })).toBe(UPLOAD_MAX_MS);
  const first = watch(timedFetch(url, { method: 'POST', body }));
  await vi.advanceTimersByTimeAsync(UPLOAD_MAX_MS);
  expect(first.error?.name).toBe('AbortError');
  // The next try of the same file: up to 30 minutes, so 12.5 minutes is enough this time.
  expect(deadlineFor(url, { method: 'POST', body })).toBe(3 * UPLOAD_MAX_MS);
  expect(deadlineFor(other, { method: 'POST', body })).toBe(UPLOAD_MAX_MS);
  const second = watch(timedFetch(url, { method: 'POST', body }));
  await vi.advanceTimersByTimeAsync(12.5 * 60_000);
  expect(second.done).toBe(false);
  calls[1].answer({ ok: true, status: 200 });
  await vi.advanceTimersByTimeAsync(0);
  expect(second.value).toMatchObject({ status: 200 });
  expect(deadlineFor(url, { method: 'POST', body })).toBe(UPLOAD_MAX_MS);
  // A small photo on a very weak signal: 61 s, then about 3 minutes.
  const photo = 'https://x.supabase.co/storage/v1/object/media/A/snaps/photo.jpg';
  const small = new ArrayBuffer(500 * 1024);
  watch(timedFetch(photo, { method: 'POST', body: small }));
  await vi.advanceTimersByTimeAsync(61_250);
  expect(deadlineFor(photo, { method: 'POST', body: small })).toBe(30_000 + 3 * 31_250);
});

it("the caller's own cancel still works", async () => {
  const { fetch } = hangingFetch();
  const { timedFetch } = load(fetch);
  const own = new AbortController();
  const state = watch(timedFetch('https://x.supabase.co/rest/v1/posts', { signal: own.signal }));
  await vi.advanceTimersByTimeAsync(10);
  expect(state.done).toBe(false);
  own.abort();
  await vi.advanceTimersByTimeAsync(0);
  expect(state.error?.name).toBe('AbortError');
  expect(vi.getTimerCount()).toBe(0);
});

it('a request that answered leaves no timer behind', async () => {
  const { fetch, calls } = hangingFetch();
  const { timedFetch } = load(fetch);
  const request = timedFetch('https://x.supabase.co/rest/v1/posts');
  expect(vi.getTimerCount()).toBe(1);
  calls[0].answer({ ok: true, status: 200 });
  await expect(request).resolves.toMatchObject({ status: 200 });
  expect(vi.getTimerCount()).toBe(0);
});
