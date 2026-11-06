// The steps other parts of the app run after a logout (src/lib/auth.tsx runAfterSignOut). Peekaboo+ uses one
// to log RevenueCat out, so the next person on the phone can never buy Plus for the previous account.
import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const { React, renderer, loadScreen, act, unmount } = require('../frontend/harness.cjs');

function harness(getSession, signOut = async () => ({ error: null })) {
  let listener, current;
  const supabase = { auth: {
    getSession, signOut,
    onAuthStateChange: (callback) => { listener = callback; return { data: { subscription: { unsubscribe() {} } } }; },
  } };
  const screen = loadScreen('src/lib/auth.tsx', {
    './supabase': { supabase },
    './profiles': { fetchProfile: async (id) => ({ id, username: id }) },
    './notifications': { unregisterPush: async () => {} },
  });
  function Consumer() { current = screen.exports.useAuth(); return null; }
  return {
    screen,
    get current() { return current; },
    event(event, session) { listener(event, session); },
    async render() {
      let tree;
      await act(() => { tree = renderer.create(React.createElement(screen.exports.AuthProvider, null, React.createElement(Consumer))); });
      return tree;
    },
  };
}

it('after a logout, each step runs once with the account that logged out', async () => {
  const h = harness(async () => ({ data: { session: { user: { id: 'A' } } } }));
  const step = vi.fn();
  h.screen.exports.runAfterSignOut(step);
  const tree = await h.render();
  try {
    await act(() => h.current.signOut('A'));
    expect(step).toHaveBeenCalledExactlyOnceWith('A');
  } finally { await unmount(tree); }
});

it('no step runs when the logout failed and the account is still logged in', async () => {
  const h = harness(async () => ({ data: { session: { user: { id: 'A' } } }, error: null }), async () => ({ error: new Error('Simulated storage failure') }));
  const step = vi.fn();
  h.screen.exports.runAfterSignOut(step);
  const tree = await h.render();
  try {
    await expect(h.current.signOut('A')).rejects.toThrow('Simulated storage failure');
    expect(step).not.toHaveBeenCalled();
  } finally { await unmount(tree); }
});

it('no step runs when someone else logged in while the old logout was finishing', async () => {
  let h;
  h = harness(async () => ({ data: { session: { user: { id: 'A' } } } }),
    async () => { h.event('SIGNED_IN', { user: { id: 'B' } }); return { error: null }; });
  const step = vi.fn();
  h.screen.exports.runAfterSignOut(step);
  const tree = await h.render();
  try {
    await act(() => h.current.signOut('A'));
    expect(h.current.userId).toBe('B');
    expect(step).not.toHaveBeenCalled();
  } finally { await unmount(tree); }
});

it('a step that breaks never stops the logout, and later steps still run', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const h = harness(async () => ({ data: { session: { user: { id: 'A' } } } }));
  const later = vi.fn();
  h.screen.exports.runAfterSignOut(() => { throw new Error('RevenueCat is not there'); });
  h.screen.exports.runAfterSignOut(later);
  const tree = await h.render();
  try {
    await act(async () => { await expect(h.current.signOut('A')).resolves.toBeUndefined(); });
    expect(h.current.userId).toBeNull();
    expect(later).toHaveBeenCalledExactlyOnceWith('A');
  } finally { await unmount(tree); warning.mockRestore(); }
});

it('a step can be taken off again', async () => {
  const h = harness(async () => ({ data: { session: { user: { id: 'A' } } } }));
  const step = vi.fn();
  const stop = h.screen.exports.runAfterSignOut(step);
  stop();
  const tree = await h.render();
  try {
    await act(() => h.current.signOut('A'));
    expect(step).not.toHaveBeenCalled();
  } finally { await unmount(tree); }
});
