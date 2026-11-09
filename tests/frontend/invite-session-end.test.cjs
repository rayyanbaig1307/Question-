const test = require('node:test');
const assert = require('node:assert/strict');
const { React, renderer, loadScreen, act, unmount } = require('./harness.cjs');

// A login can end without anyone tapping "Log out" (it ran out, or the account was banned or deleted on another
// phone: Supabase then just sends SIGNED_OUT). The invite waiting on the phone, and the remembered invite code,
// must not be handed to the next person who logs in. These tests wire the real parts together: the real
// AuthProvider (src/lib/auth.tsx), the real lib/invite.ts and the real PendingInvite.

const KEY = 'peekaboo-pending-invite';
const flush = () => new Promise(resolve => setImmediate(resolve));
const inviteCode = loadScreen('src/lib/inviteCode.ts').exports;

function phone({ loggedIn = 'alice' } = {}) {
  const store = new Map();
  let listener;
  let saved = loggedIn ? { user: { id: loggedIn } } : null;
  const supabase = {
    rpc: async () => ({ data: 'BCDFGHJKLM', error: null }),
    auth: {
      getSession: async () => ({ data: { session: saved }, error: null }),
      signOut: async () => { saved = null; listener('SIGNED_OUT', null); return { error: null }; },
      onAuthStateChange: callback => { listener = callback; return { data: { subscription: { unsubscribe() {} } } }; },
    },
  };
  const auth = loadScreen('src/lib/auth.tsx', {
    './supabase': { supabase },
    './profiles': { fetchProfile: async id => ({ id, username: id }) },
    './notifications': { unregisterPush: async () => {} },
  }).exports;
  const invite = loadScreen('src/lib/invite.ts', {
    'expo-updates': { channel: 'production' },
    'react-native': { Platform: { OS: 'ios' }, Share: { share: async () => {} } },
    '@react-native-async-storage/async-storage': {
      __esModule: true,
      default: {
        getItem: async key => store.get(key) ?? null,
        setItem: async (key, value) => { store.set(key, value); },
        removeItem: async key => { store.delete(key); },
      },
    },
    // The real runAfterSignOut from the real auth.tsx above.
    './auth': auth,
    './inviteCode': inviteCode,
    './supabase': { supabase },
  }).exports;
  return {
    store, auth, invite,
    saveInvite: code => store.set(KEY, JSON.stringify({ code, savedAt: Date.now() - 60_000 })),
    // Supabase tells the app about a login change (nobody called signOut()).
    async authEvent(event, userId) {
      saved = userId ? { user: { id: userId } } : null;
      await act(() => listener(event, saved));
      await act(flush);
    },
  };
}

async function renderAuth(world) {
  let current;
  let tree;
  function Consumer() { current = world.auth.useAuth(); return null; }
  await act(() => { tree = renderer.create(React.createElement(world.auth.AuthProvider, null, React.createElement(Consumer))); });
  await act(flush);
  return { tree, get current() { return current; } };
}

// (app)/_layout shows PendingInvite once someone is in the app. Gives back where it sent them.
async function openApp(world) {
  const routes = [];
  const screen = loadScreen('src/components/PendingInvite.tsx', {
    'expo-router': { router: { push: (...args) => routes.push(['push', ...args]) }, usePathname: () => '/' },
    '@/lib/invite': world.invite,
  });
  let tree;
  await act(() => { tree = renderer.create(React.createElement(screen.exports.PendingInvite)); });
  await act(flush);
  await unmount(tree);
  return routes;
}

test("Alice's login ends without Log out, then Bob logs in: Alice's saved invite is not opened for Bob", async () => {
  const world = phone();
  world.saveInvite('NPQRSTVWXZ');
  const app = await renderAuth(world);
  try {
    assert.equal(app.current.userId, 'alice');
    await world.invite.fetchMyInviteCode('alice');
    assert.equal(world.invite.rememberedInviteCode('alice'), 'BCDFGHJKLM');
    // Alice's login is turned down by the server: Supabase removes it and sends SIGNED_OUT.
    await world.authEvent('SIGNED_OUT', null);
    assert.equal(app.current.userId, null);
    assert.equal(world.store.has(KEY), false, 'the saved invite is forgotten');
    assert.equal(world.invite.rememberedInviteCode('alice'), null, "Alice's code is forgotten too");
    await world.authEvent('SIGNED_IN', 'bob');
    assert.equal(app.current.userId, 'bob');
    assert.deepEqual(await openApp(world), [], 'Bob is not sent to the invite Alice opened');
  } finally { await unmount(app.tree); }
});

test('another account taking over straight away (no SIGNED_OUT in between) also forgets the saved invite', async () => {
  const world = phone();
  world.saveInvite('NPQRSTVWXZ');
  const app = await renderAuth(world);
  try {
    await world.authEvent('SIGNED_IN', 'bob');
    assert.equal(app.current.userId, 'bob');
    assert.equal(world.store.has(KEY), false);
    assert.deepEqual(await openApp(world), []);
  } finally { await unmount(app.tree); }
});

test('logged out, open an invite, then log in: the invite still opens (and a token refresh changes nothing)', async () => {
  const world = phone({ loggedIn: null });
  const app = await renderAuth(world);
  try {
    assert.equal(app.current.userId, null);
    world.saveInvite('NPQRSTVWXZ');
    await world.authEvent('SIGNED_IN', 'bob');
    await world.authEvent('TOKEN_REFRESHED', 'bob');
    assert.equal(world.store.has(KEY), true, 'nobody → Bob keeps the invite');
    assert.deepEqual(await openApp(world), [['push', '/invite/NPQRSTVWXZ']]);
  } finally { await unmount(app.tree); }
});

test('"Log out" still forgets the saved invite (once)', async () => {
  const world = phone();
  let steps = 0;
  world.auth.runAfterSignOut(() => { steps++; });
  world.saveInvite('NPQRSTVWXZ');
  const app = await renderAuth(world);
  try {
    // signOut() makes Supabase send SIGNED_OUT while it runs: the tidy-up still happens only once.
    await act(() => app.current.signOut('alice'));
    await act(flush);
    assert.equal(app.current.userId, null);
    assert.equal(world.store.has(KEY), false);
    assert.equal(steps, 1);
  } finally { await unmount(app.tree); }
});
