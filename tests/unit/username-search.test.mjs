import { expect, it } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

// A pretend Supabase client that writes down every filter the search sends.
function recordingClient(rows = []) {
  const calls = [];
  const chain = {};
  for (const method of ['select', 'ilike', 'neq', 'order', 'limit']) {
    chain[method] = (...args) => { calls.push([method, ...args]); return chain; };
  }
  chain.then = (resolve, reject) => Promise.resolve({ data: rows, error: null }).then(resolve, reject);
  return { calls, supabase: { from: (table) => { calls.push(['from', table]); return chain; } } };
}

async function patternFor(typed) {
  const client = recordingClient();
  const lib = loadLibrary('friends', { supabase: client.supabase });
  await lib.searchUsers(typed, 'me');
  return client.calls.find((call) => call[0] === 'ilike');
}

it('an underscore in the search is sent as a real underscore, not "any one letter"', async () => {
  expect(await patternFor('ab_c')).toEqual(['ilike', 'username', 'ab\\_c%']);
  expect(await patternFor('__')).toEqual(['ilike', 'username', '\\_\\_%']);
});

it('search wildcards the person types are dropped, so the search stays a plain "starts with"', async () => {
  // "%", "*" and "\" are removed before searching; only the final "%" (= "anything after") is ours.
  expect(await patternFor('A%b*c\\d')).toEqual(['ilike', 'username', 'abcd%']);
  expect(await patternFor('@Cool.Name')).toEqual(['ilike', 'username', 'cool.name%']);
});

it('an empty search after cleaning asks the server nothing', async () => {
  const client = recordingClient();
  const lib = loadLibrary('friends', { supabase: client.supabase });
  expect(await lib.searchUsers('%*\\', 'me')).toEqual([]);
  expect(client.calls).toEqual([]);
});

it('likePrefix puts a backslash before every search wildcard', () => {
  const lib = loadLibrary('friends', { supabase: {} });
  expect(lib.likePrefix('a_b%c\\d')).toBe('a\\_b\\%c\\\\d');
  expect(lib.likePrefix('plain.name1')).toBe('plain.name1');
});
