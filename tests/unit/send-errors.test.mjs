import { expect, it } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

// A request that ran out of time (lib/timedFetch.ts) says the same kind thing as no internet at all.
const errors = () => loadLibrary('errors', { mocks: { './cleanWords': { NAME_NOT_ALLOWED: 'That name is not allowed.', WORD_NOT_ALLOWED: 'That word is not allowed.' } } });
const NO_INTERNET = "Can't reach the internet. Check your connection and try again.";

it('a request that was given up reads as "Can\'t reach the internet"', () => {
  const { friendlyError } = errors();
  expect(friendlyError({ message: 'AbortError: Aborted' })).toBe(NO_INTERNET);
  expect(friendlyError(Object.assign(new Error('Aborted'), { name: 'AbortError' }))).toBe(NO_INTERNET);
  expect(friendlyError({ message: 'The request timed out.' })).toBe(NO_INTERNET);
  // Other messages are unchanged.
  expect(friendlyError({ message: 'Network request failed' })).toBe(NO_INTERNET);
  expect(friendlyError({ message: 'posts_one_drop_per_day' })).toMatch(/already posted today's Peekaboo drop/);
});

it('isClearRefusal: a database code or a 4xx is a clear "no"; no answer, an abort or a bare 5xx is not', () => {
  const { isClearRefusal } = errors();
  expect(isClearRefusal({ code: '42501' }, 403)).toBe(true);
  expect(isClearRefusal({ code: 'P0001' }, 400)).toBe(true);
  expect(isClearRefusal({ code: '' }, 404)).toBe(true);
  expect(isClearRefusal({ code: '', message: 'AbortError: Aborted' }, 0)).toBe(false);
  expect(isClearRefusal({ code: '' }, 502)).toBe(false);
  expect(isClearRefusal({ code: null }, undefined)).toBe(false);
  // The status can also travel on the error itself.
  expect(isClearRefusal({ status: 409 })).toBe(true);
  expect(isClearRefusal({ status: 0 })).toBe(false);
  expect(isClearRefusal(null)).toBe(false);
});
