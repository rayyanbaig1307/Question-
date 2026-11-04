import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';
import { loadLibrary } from '../unit/libHarness.mjs';
const require = createRequire(import.meta.url);
const { React, renderer, act, unmount } = require('../frontend/harness.cjs');
const epoch = new Date(0).toISOString();
const item = (actor, at = '2026-11-04T10:00:00Z') => ({ kind: 'like', at, actor_id: actor, actor_username: actor, actor_name: actor, actor_avatar: null, post_id: 'test-post', snippet: null });

function harness() {
  let current, me = 'A';
  const rpc = vi.fn(async () => ({ data: [item('actor-A')], error: null }));
  const multiGet = vi.fn(async (keys) => keys.map((key) => [key, epoch]));
  const lib = loadLibrary('activity', {
    supabase: { rpc },
    mocks: {
      react: React,
      '@react-native-async-storage/async-storage': { __esModule: true, default: { multiGet, setItem: async () => {}, multiSet: async () => {} } },
      'react-native': { AppState: { addEventListener: () => ({ remove() {} }) } },
      './notifications': { onNotificationArrived: () => () => {} },
    },
  });
  function Consumer() { current = lib.useActivity(me, true); return null; }
  return {
    rpc, multiGet, get current() { return current; },
    async render() { let tree; await act(() => { tree = renderer.create(React.createElement(Consumer)); }); return tree; },
    async switchUser(tree, user) { me = user; await act(() => tree.update(React.createElement(Consumer))); },
  };
}

it('a delayed preference read cannot undo a completed Clear Inbox action', async () => {
  const h = harness();
  const tree = await h.render();
  try {
    let finish;
    h.multiGet.mockImplementationOnce((keys) => new Promise((resolve) => { finish = () => resolve(keys.map((key) => [key, epoch])); }));
    await act(() => h.current.reload());
    await act(() => h.current.clear());
    expect(h.current.items).toHaveLength(0);
    await act(() => finish());
    expect(h.current.items).toHaveLength(0);
    expect(h.current.unseen).toBe(0);
  } finally { await unmount(tree); }
});

it('an older refresh cannot replace newer activity after a later refresh finishes', async () => {
  const h = harness();
  const tree = await h.render();
  try {
    let finish;
    h.rpc.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(() => h.current.reload());
    h.rpc.mockResolvedValueOnce({ data: [item('latest', '2026-11-04T11:00:00Z')], error: null });
    await act(() => h.current.reload());
    expect(h.current.items[0].actor_id).toBe('latest');
    await act(() => finish({ data: [item('stale')], error: null }));
    expect(h.current.items[0].actor_id).toBe('latest');
  } finally { await unmount(tree); }
});

it('activity from account A never arrives in account B after a delayed reply', async () => {
  const h = harness();
  const tree = await h.render();
  try {
    let finish;
    h.rpc.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(() => h.current.reload());
    h.rpc.mockResolvedValueOnce({ data: [item('private-B')], error: null });
    await h.switchUser(tree, 'B');
    expect(h.current.items[0].actor_id).toBe('private-B');
    await act(() => finish({ data: [item('private-A')], error: null }));
    expect(h.current.items[0].actor_id).toBe('private-B');
  } finally { await unmount(tree); }
});
