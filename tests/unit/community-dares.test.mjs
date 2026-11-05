import { expect, it } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

// The Community dares list. If an idea's writer blocked you, their profile is hidden from you, so the
// database sends that idea with no author. The screen reads the author's name, so the idea must be left out.
it('leaves out an idea whose writer is hidden from you (they blocked you)', async () => {
  const rows = [
    { id: 'a', user_id: 'u1', text: 'Sing the chorus of a song you love', votes: 0, hidden: false, used_on: null, created_at: '2026-11-04', author: null },
    { id: 'b', user_id: 'u2', text: 'Hop on one foot for a minute', votes: 1, hidden: false, used_on: null, created_at: '2026-11-04', author: { id: 'u2', username: 'bob', display_name: null } },
  ];
  const chain = (data) => {
    const query = {};
    for (const method of ['select', 'is', 'order', 'limit', 'eq']) query[method] = () => query;
    query.then = (ok, bad) => Promise.resolve({ data, error: null }).then(ok, bad);
    return query;
  };
  const supabase = { from: (table) => chain(table === 'dare_ideas' ? rows : [{ idea_id: 'b' }]) };
  const AsyncStorage = { getItem: async () => null, setItem: async () => {} };
  const { fetchIdeas } = loadLibrary('communityDares', { supabase, mocks: { '@react-native-async-storage/async-storage': { __esModule: true, default: AsyncStorage } } });
  const ideas = await fetchIdeas('me', 'top');
  expect(ideas.map((idea) => idea.id)).toEqual(['b']);
  expect(ideas[0].mine).toBe(true);
});
