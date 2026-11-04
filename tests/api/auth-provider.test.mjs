import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const { React, renderer, loadScreen, act, unmount } = require('../frontend/harness.cjs');

function harness(getSession, signOut = async () => ({ error: null }), unregisterPush = async () => {}) {
  let listener, current;
  const supabase = { auth: {
    getSession, signOut,
    onAuthStateChange: (callback) => { listener = callback; return { data: { subscription: { unsubscribe() {} } } }; },
  } };
  const screen = loadScreen('src/lib/auth.tsx', {
    './supabase': { supabase },
    './profiles': { fetchProfile: async (id) => ({ id, username: id }) },
    './notifications': { unregisterPush },
  });
  function Consumer() { current = screen.exports.useAuth(); return null; }
  return {
    screen, supabase,
    get current() { return current; },
    event(event, session) { listener(event, session); },
    async render() {
      let tree;
      await act(() => { tree = renderer.create(React.createElement(screen.exports.AuthProvider, null, React.createElement(Consumer))); });
      return tree;
    },
  };
}

it('a delayed initial session cannot undo a newer logout', async () => {
  let finish;
  const h = harness(() => new Promise((resolve) => { finish = resolve; }));
  const tree = await h.render();
  try {
    await act(() => h.event('SIGNED_OUT', null));
    await act(() => finish({ data: { session: { user: { id: 'old-account' } } } }));
    expect(h.current.session).toBeNull();
    expect(h.current.userId).toBeNull();
    expect(h.current.initializing).toBe(false);
  } finally { await unmount(tree); }
});

it('does not report a successful logout when auth rejected it', async () => {
  const failure = new Error('Simulated auth outage');
  const h = harness(async () => ({ data: { session: { user: { id: 'A' } } } }), async () => ({ error: failure }));
  const tree = await h.render();
  try {
    await expect(h.current.signOut()).rejects.toThrow('Simulated auth outage');
    expect(h.current.userId).toBe('A');
  } finally { await unmount(tree); }
});

// How @supabase/auth-js 2.118 really behaves when the logout request fails with a network error or a 5xx:
// it still removes the saved login from the phone (and sends SIGNED_OUT), then returns the error.
// (node_modules/@supabase/auth-js/dist/main/GoTrueClient.js, _signOut)
it('a logout whose server request fails still counts as logged out when the login is gone from the phone', async () => {
  let saved = { user: { id: 'A' } }, h;
  h = harness(async () => ({ data: { session: saved }, error: null }), async () => {
    saved = null;
    h.event('SIGNED_OUT', null);
    return { error: new Error('Failed to fetch') };
  });
  const tree = await h.render();
  try {
    await act(async () => { await expect(h.current.signOut('A')).resolves.toBeUndefined(); });
    expect(h.current.userId).toBeNull();
    expect(h.current.profile).toBeNull();
  } finally { await unmount(tree); }
});

it('a logout that leaves the login on the phone is still reported as failed', async () => {
  const failure = new Error('Simulated storage failure');
  const h = harness(async () => ({ data: { session: { user: { id: 'A' } } }, error: null }), async () => ({ error: failure }));
  const tree = await h.render();
  try {
    await expect(h.current.signOut('A')).rejects.toThrow('Simulated storage failure');
    expect(h.current.userId).toBe('A');
  } finally { await unmount(tree); }
});

it('reloading the profile never puts an old account in place of a newer login', async () => {
  let h, finish, holdNext = false;
  h = harness(async () => ({ data: { session: { user: { id: 'A' } } }, error: null }));
  // Only the reload started below is held back (a slow connection); every other profile load answers at once.
  h.screen.modules['./profiles'].fetchProfile = async (id) => {
    if (!holdNext) return { id, username: id };
    holdNext = false;
    return new Promise((resolve) => { finish = () => resolve({ id, username: id }); });
  };
  const tree = await h.render();
  try {
    expect(h.current.profile).toMatchObject({ id: 'A' });
    let reload;
    const oldRefresh = h.current.refreshProfile;
    holdNext = true;
    await act(async () => { reload = oldRefresh(); await Promise.resolve(); });
    await act(() => h.event('SIGNED_IN', { user: { id: 'B' } }));
    let result;
    await act(async () => { finish(); result = await reload; });
    expect(h.current.userId).toBe('B');
    expect(h.current.profile).toMatchObject({ id: 'B' }); // B's own profile is still there
    expect(result).toMatchObject({ id: 'A' }); // the caller still learns what was loaded
  } finally { await unmount(tree); }
});

it('a successful logout clears the local session even before its auth event arrives', async () => {
  const h = harness(async () => ({ data: { session: { user: { id: 'A' } } } }));
  const tree = await h.render();
  try {
    await act(() => h.current.signOut());
    expect(h.current.session).toBeNull();
    expect(h.current.profile).toBeNull();
  } finally { await unmount(tree); }
});

it('handles failure while reading the saved login without an unhandled rejection', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const h = harness(async () => { throw new Error('Saved login could not be read'); });
  const tree = await h.render();
  try {
    expect(h.current.initializing).toBe(false);
    expect(h.current.session).toBeNull();
    expect(warning).toHaveBeenCalled();
  } finally { await unmount(tree); warning.mockRestore(); }
});

it('an old account’s logout callback cannot sign out the new account', async () => {
  const signOut = vi.fn(async () => ({ error: null }));
  const unregister = vi.fn(async () => {});
  const h = harness(async () => ({ data: { session: { user: { id: 'B' } } } }), signOut, unregister);
  const tree = await h.render();
  try {
    await expect(h.current.signOut('A')).rejects.toThrow('signed-in account changed');
    expect(signOut).not.toHaveBeenCalled();
    expect(unregister).not.toHaveBeenCalled();
    expect(h.current.userId).toBe('B');
  } finally { await unmount(tree); }
});

it('changing account while push unregister waits cannot sign out the new user', async () => {
  let current = 'A', h;
  const signOut = vi.fn(async () => ({ error: null }));
  h = harness(async () => ({ data: { session: { user: { id: current } } } }), signOut,
    async () => { current = 'B'; h.event('SIGNED_IN', { user: { id: 'B' } }); });
  const tree = await h.render();
  try {
    await act(async () => { await expect(h.current.signOut('A')).rejects.toThrow('signed-in account changed'); });
    expect(signOut).not.toHaveBeenCalled();
    expect(h.current.userId).toBe('B');
  } finally { await unmount(tree); }
});

it('a newer login event is not overwritten by an old logout response', async () => {
  let h;
  h = harness(async () => ({ data: { session: { user: { id: 'A' } } } }),
    async () => { h.event('SIGNED_IN', { user: { id: 'B' } }); return { error: null }; });
  const tree = await h.render();
  try {
    await act(() => h.current.signOut('A'));
    expect(h.current.userId).toBe('B');
  } finally { await unmount(tree); }
});
