import { expect, it, vi } from 'vitest';
import { query } from '../api/edgeHarness.mjs';
import { loadLibrary } from './libHarness.mjs';

function service() {
  let next = 0, failInsert = false;
  const active = new Set(), tombstones = new Set(), copies = [];
  const remove = async (paths) => { for (const path of paths) { active.delete(path); tombstones.add(path); } };
  const lib = loadLibrary('posts', {
    supabase: {
      storage: { from: () => ({ copy: async (source, target) => {
        copies.push([source, target]);
        if (tombstones.has(target) || active.has(target)) return { error: { message: 'Path already used' } };
        active.add(target); return { error: null };
      } }) },
      from: () => query(() => ({ data: failInsert ? null : { id: 'new-post' }, error: failInsert ? { message: 'Post insert failed' } : null })),
    },
    mocks: { './media': { deleteMedia: remove }, 'expo-crypto': { randomUUID: () => `fresh-${++next}` } },
  });
  return { lib, active, copies, remove, fail(value) { failInsert = value; } };
}
const story = { media_path: 'A/stories/original.mp4', poster_path: 'A/stories/poster.jpg', overlay_path: 'A/stories/overlay.png', media_type: 'video' };

it('retrying a failed story-to-profile post uses fresh paths after rollback tombstones', async () => {
  const s = service();
  s.fail(true);
  await expect(s.lib.postFromStory('A', story, 'Caption', 'everyone')).rejects.toMatchObject({ message: 'Post insert failed' });
  expect(s.active.size).toBe(0);
  const previous = s.copies.map(([, target]) => target);
  s.fail(false);
  await expect(s.lib.postFromStory('A', story, 'Caption', 'everyone')).resolves.toMatchObject({ id: 'new-post' });
  const later = s.copies.slice(3).map(([, target]) => target);
  expect(later.every((target) => !previous.includes(target))).toBe(true);
  expect(later.map((target) => target.slice(target.lastIndexOf('.')))).toEqual(['.mp4', '.jpg', '.png']);
});

it('the same story can be posted again after its earlier profile copy was deleted', async () => {
  const s = service();
  await s.lib.postFromStory('A', story, '', 'everyone');
  await s.remove([...s.active]);
  await expect(s.lib.postFromStory('A', story, '', 'everyone')).resolves.toMatchObject({ id: 'new-post' });
  expect(new Set(s.copies.map(([, target]) => target)).size).toBe(6);
});
