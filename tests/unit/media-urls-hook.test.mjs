import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { loadLibrary } from './libHarness.mjs';
const require = createRequire(import.meta.url);
const { React, renderer, act, unmount } = require('../frontend/harness.cjs');

// When a new photo arrives in a chat or feed, the photos already on screen must stay on screen.
// Only a change of login may hide them (see tests/api/media-hook.test.mjs for that side).
function setup() {
  let authListener;
  let fail = false;
  let hold = null;
  let onlyPrefix = null;
  const createSignedUrls = vi.fn(async (paths) => {
    if (hold) await hold;
    if (fail) return { data: null, error: { message: 'Network request failed' } };
    // A partly successful answer: the file store signs only the files this login may open.
    if (onlyPrefix) paths = paths.filter((path) => path.startsWith(onlyPrefix));
    return { data: paths.map((path) => ({ path, signedUrl: `test-only://${path}` })), error: null };
  });
  const media = loadLibrary('media', {
    mocks: { react: React },
    supabase: {
      auth: { onAuthStateChange: (fn) => { authListener = fn; return { data: { subscription: { unsubscribe() {} } } }; } },
      storage: { from: () => ({ createSignedUrls }) },
    },
  });
  authListener?.('SIGNED_IN', { user: { id: 'A' } });
  const seen = [];
  function Probe({ paths }) {
    seen.push(media.useMediaUrls(paths));
    return null;
  }
  return {
    createSignedUrls, seen, Probe,
    setFail(value) { fail = value; },
    signOnly(prefix) { onlyPrefix = prefix; },
    holdNext() { let release; hold = new Promise((r) => { release = r; }); return () => { hold = null; release(); }; },
    switchTo(id) { authListener?.('SIGNED_IN', { user: { id } }); },
  };
}

describe('photo links while the list of photos changes', () => {
  it('keeps showing the photos already loaded while a new photo is fetched', async () => {
    const s = setup();
    let tree;
    await act(() => { tree = renderer.create(React.createElement(s.Probe, { paths: ['a.jpg', 'b.jpg'] })); });
    try {
      expect(s.seen.at(-1)).toEqual({ 'a.jpg': 'test-only://a.jpg', 'b.jpg': 'test-only://b.jpg' });
      s.seen.length = 0;
      const release = s.holdNext();
      await act(() => { tree.update(React.createElement(s.Probe, { paths: ['a.jpg', 'b.jpg', 'c.jpg'] })); });
      // While the new link is on its way, a and b must not blink out.
      for (const urls of s.seen) {
        expect(urls['a.jpg']).toBe('test-only://a.jpg');
        expect(urls['b.jpg']).toBe('test-only://b.jpg');
      }
      await act(async () => { release(); });
      expect(s.seen.at(-1)).toEqual({
        'a.jpg': 'test-only://a.jpg', 'b.jpg': 'test-only://b.jpg', 'c.jpg': 'test-only://c.jpg',
      });
    } finally { await unmount(tree); }
  });

  it('keeps the old photos when the link for one new photo cannot be fetched', async () => {
    const s = setup();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let tree;
    await act(() => { tree = renderer.create(React.createElement(s.Probe, { paths: ['a.jpg', 'b.jpg'] })); });
    try {
      s.seen.length = 0;
      s.setFail(true);
      await act(() => { tree.update(React.createElement(s.Probe, { paths: ['a.jpg', 'b.jpg', 'c.jpg'] })); });
      expect(s.seen.length).toBeGreaterThan(0);
      for (const urls of s.seen) {
        expect(urls['a.jpg']).toBe('test-only://a.jpg');
        expect(urls['b.jpg']).toBe('test-only://b.jpg');
        expect(urls['c.jpg']).toBeUndefined();
      }
      // Once the signal is back and the list changes again, the missing photo loads too.
      s.setFail(false);
      await act(() => { tree.update(React.createElement(s.Probe, { paths: ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'] })); });
      expect(Object.keys(s.seen.at(-1)).sort()).toEqual(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']);
    } finally { await unmount(tree); warning.mockRestore(); }
  });

  it('gives a stable photo the same link, so videos are not restarted', async () => {
    const s = setup();
    let tree;
    await act(() => { tree = renderer.create(React.createElement(s.Probe, { paths: ['clip.mp4'] })); });
    try {
      s.seen.length = 0;
      await act(() => { tree.update(React.createElement(s.Probe, { paths: ['clip.mp4', 'new.jpg'] })); });
      expect(new Set(s.seen.map((urls) => urls['clip.mp4']))).toEqual(new Set(['test-only://clip.mp4']));
    } finally { await unmount(tree); }
  });

  it('forgets photos that left the list instead of piling up old links', async () => {
    const s = setup();
    let tree;
    await act(() => { tree = renderer.create(React.createElement(s.Probe, { paths: ['a.jpg', 'b.jpg'] })); });
    try {
      await act(() => { tree.update(React.createElement(s.Probe, { paths: ['b.jpg', 'c.jpg'] })); });
      expect(s.seen.at(-1)).toEqual({ 'b.jpg': 'test-only://b.jpg', 'c.jpg': 'test-only://c.jpg' });
    } finally { await unmount(tree); }
  });

  it('still hides every photo at once when the login changes, even if the list changes too', async () => {
    const s = setup();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let tree;
    await act(() => { tree = renderer.create(React.createElement(s.Probe, { paths: ['A/a.jpg'] })); });
    try {
      expect(s.seen.at(-1)).toHaveProperty('A/a.jpg');
      s.seen.length = 0;
      s.setFail(true);
      await act(() => {
        s.switchTo('B');
        tree.update(React.createElement(s.Probe, { paths: ['A/a.jpg', 'B/b.jpg'] }));
      });
      for (const urls of s.seen) expect(urls).toEqual({});
    } finally { await unmount(tree); warning.mockRestore(); }
  });

  it('never carries a link from the old login into the new login, even when the new fetch only partly succeeds', async () => {
    const s = setup();
    let tree;
    await act(() => { tree = renderer.create(React.createElement(s.Probe, { paths: ['A/a.jpg'] })); });
    try {
      expect(s.seen.at(-1)).toEqual({ 'A/a.jpg': 'test-only://A/a.jpg' });
      s.signOnly('B/');
      await act(async () => {
        s.switchTo('B');
        tree.update(React.createElement(s.Probe, { paths: ['A/a.jpg', 'B/b.jpg'] }));
      });
      await act(async () => {});
      expect(s.seen.at(-1)).toEqual({ 'B/b.jpg': 'test-only://B/b.jpg' });
    } finally { await unmount(tree); }
  });
});
