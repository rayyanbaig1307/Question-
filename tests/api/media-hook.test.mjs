import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';
import { loadLibrary } from '../unit/libHarness.mjs';
const require = createRequire(import.meta.url);
const { React, renderer, act, unmount } = require('../frontend/harness.cjs');

it('a mounted media hook immediately hides the previous account’s picture after account switching', async () => {
  let listener, currentUrl;
  const sign = vi.fn(async () => ({ data: [{ path: 'A/keeps/private.jpg', signedUrl: 'test-only://private-A' }], error: null }));
  const media = loadLibrary('media', {
    mocks: { react: React },
    supabase: {
      auth: { onAuthStateChange: (fn) => { listener = fn; return { data: { subscription: { unsubscribe() {} } } }; } },
      storage: { from: () => ({ createSignedUrls: sign }) },
    },
  });
  listener?.('SIGNED_IN', { user: { id: 'A' } });
  function Picture() { currentUrl = media.useMediaUrl('A/keeps/private.jpg'); return null; }
  let tree;
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await act(() => { tree = renderer.create(React.createElement(Picture)); });
  try {
    expect(currentUrl).toBe('test-only://private-A');
    sign.mockResolvedValue({ data: [], error: { message: 'B is not allowed' } });
    await act(() => listener?.('SIGNED_IN', { user: { id: 'B' } }));
    expect(currentUrl).toBeNull();
    expect(sign).toHaveBeenCalledTimes(2);
  } finally { await unmount(tree); warning.mockRestore(); }
});
