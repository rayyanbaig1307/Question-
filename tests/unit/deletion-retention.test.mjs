import { expect, it, vi } from 'vitest';
import { query } from '../api/edgeHarness.mjs';
import { loadLibrary } from './libHarness.mjs';

for (const [moduleName, method] of [['posts', 'deletePost'], ['stories', 'deleteStory'], ['keeps', 'deleteKeep'], ['guess', 'deleteMystery']]) {
  it(`${method}: report-evidence retention does not misreport an already removed item as a failed deletion`, async () => {
    const cleanup = vi.fn(async () => { throw new Error('Cleanup cancelled because media is still in use or reported'); });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const lib = loadLibrary(moduleName, {
        supabase: { from: () => query({ error: null }) },
        mocks: { './media': { deleteMedia: cleanup, mediaFiles: (row) => [row.media_path] } },
      });
      await expect(lib[method]({ id: 'removed-item', media_path: 'test/file.jpg' })).resolves.toBeUndefined();
      expect(cleanup).toHaveBeenCalledExactlyOnceWith(['test/file.jpg']);
      expect(warning).toHaveBeenCalled();
    } finally { warning.mockRestore(); }
  });

  it(`${method}: a failed row deletion still fails without attempting file removal`, async () => {
    const cleanup = vi.fn();
    const lib = loadLibrary(moduleName, {
      supabase: { from: () => query({ error: { message: 'Database unavailable' } }) },
      mocks: { './media': { deleteMedia: cleanup, mediaFiles: (row) => [row.media_path] } },
    });
    await expect(lib[method]({ id: 'unchanged-item', media_path: 'test/file.jpg' })).rejects.toMatchObject({ message: 'Database unavailable' });
    expect(cleanup).not.toHaveBeenCalled();
  });
}
