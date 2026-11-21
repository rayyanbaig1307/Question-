const test = require('node:test');
const assert = require('node:assert/strict');
const { React, renderer, loadScreen, act, unmount, host, textOf } = require('./harness.cjs');

// "How did you hear about Peekaboo?" – pick one and Continue, or Skip. Either way the app opens.
const OPTIONS = [
  { source: 'friend', emoji: '👯', label: 'A friend' },
  { source: 'tiktok', emoji: '🎵', label: 'TikTok' },
  { source: 'other', emoji: '✨', label: 'Something else' },
];

async function render() {
  const saved = [];
  let done = 0;
  const { HeardAbout } = loadScreen('src/components/HeardAbout.tsx', {
    '@/components/FormScreen': { FormScreen: host('FormScreen') },
    '@/components/TextField': { TextField: host('TextField') },
    '@/lib/heardAbout': { HEARD_ABOUT_OPTIONS: OPTIONS, saveHeardAbout: async (...args) => saved.push(args) },
  }).exports;
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(HeardAbout, { userId: 'alice', onDone: () => { done++; } })); });
  const option = (label) => tree.root.findAll((n) => n.props.accessibilityRole === 'radio' && n.props.accessibilityLabel === label)[0];
  const button = (title) => tree.root.findAllByType('Button').find((n) => n.props.title === title);
  return { tree, saved, done: () => done, option, button };
}

test('Continue does nothing until you pick one; then it saves your pick and opens the app', async () => {
  const s = await render();
  assert.equal(s.button('Continue').props.disabled, true);
  await act(async () => s.option('TikTok').props.onPress());
  assert.equal(s.button('Continue').props.disabled, false);
  await act(async () => s.button('Continue').props.onPress());
  assert.deepEqual(s.saved.map((a) => a.slice(0, 2)), [['alice', 'tiktok']]);
  assert.equal(s.done(), 1);
  await unmount(s.tree);
});

test('"Something else" asks where, and sends those words', async () => {
  const s = await render();
  assert.equal(s.tree.root.findAllByType('TextField').length, 0);
  await act(async () => s.option('Something else').props.onPress());
  await act(async () => s.tree.root.findByType('TextField').props.onChangeText('a poster at school'));
  await act(async () => s.button('Continue').props.onPress());
  assert.deepEqual(s.saved, [['alice', 'other', 'a poster at school']]);
  await unmount(s.tree);
});

test('Skip is always there, saves "skipped" and opens the app; there is no back button', async () => {
  const s = await render();
  assert.equal(s.tree.root.findByType('FormScreen').props.showBack, false);
  await act(async () => s.button('Skip').props.onPress());
  assert.deepEqual(s.saved.map((a) => a[1]), ['skipped']);
  assert.equal(s.done(), 1);
  await unmount(s.tree);
});

// ---------------------------------------------------------------------------
// Who is asked (useNeedsHeardAbout): the app shows nothing while it checks, so an existing account must never
// wait for the server on every app start (App Store users after the update).
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

function hookWith({ stored = {}, server = { data: false, error: null } } = {}) {
  const store = { ...stored };
  const log = [];
  const AsyncStorage = {
    getItem: async (key) => { log.push(['get', key]); return store[key] ?? null; },
    setItem: async (key, value) => { log.push(['set', key, value]); store[key] = value; },
  };
  const supabase = { rpc: async (name) => { log.push(['rpc', name]); return server; } };
  const { exports } = loadScreen('src/lib/heardAbout.ts', {
    '@react-native-async-storage/async-storage': { __esModule: true, default: AsyncStorage },
    './supabase': { supabase },
  }, { timers: 'real' });
  const seen = [];
  function Probe({ userId, createdAt }) {
    const [needed] = exports.useNeedsHeardAbout(userId, createdAt);
    seen.push(needed);
    return null;
  }
  return { exports, store, log, seen, Probe };
}

async function mount(Probe, props) {
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(Probe, props)); });
  // Let the storage read and the server call finish.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return tree;
}

test('an account older than 3 days is never checked: no server call, no blank wait', async () => {
  const h = hookWith({ server: { data: true, error: null } });
  const tree = await mount(h.Probe, { userId: 'alice', createdAt: ago(10 * DAY) });
  // Never null (null = the app shows nothing while it checks).
  assert.ok(h.seen.length > 0);
  assert.ok(h.seen.every((needed) => needed === false));
  assert.deepEqual(h.log, []);
  await unmount(tree);
  assert.equal(h.exports.accountIsOld(ago(3 * DAY + 60_000)), true);
  assert.equal(h.exports.accountIsOld(ago(2 * DAY)), false);
  assert.equal(h.exports.accountIsOld(undefined), false);
  assert.equal(h.exports.accountIsOld('not a date'), false);
});

test("the server's \"no\" is remembered, so the next app start doesn't wait for it", async () => {
  const h = hookWith({ server: { data: false, error: null } });
  const first = await mount(h.Probe, { userId: 'alice', createdAt: ago(DAY) });
  assert.equal(h.seen[0], null);
  assert.equal(h.seen.at(-1), false);
  assert.deepEqual(h.log.filter(([kind]) => kind === 'rpc'), [['rpc', 'needs_heard_about']]);
  assert.equal(h.store['peekaboo-heard-about:alice'], 'no');
  await unmount(first);
  h.log.length = 0;
  const second = await mount(h.Probe, { userId: 'alice', createdAt: ago(DAY) });
  assert.equal(h.seen.at(-1), false);
  assert.deepEqual(h.log.filter(([kind]) => kind === 'rpc'), []);
  await unmount(second);
});

test('a new account the server wants to ask is asked; nothing is remembered until they answer', async () => {
  const h = hookWith({ server: { data: true, error: null } });
  const tree = await mount(h.Probe, { userId: 'alice', createdAt: ago(DAY) });
  assert.equal(h.seen.at(-1), true);
  assert.equal(h.store['peekaboo-heard-about:alice'], undefined);
  await unmount(tree);
});

test('a server error skips the question this time but is not remembered', async () => {
  const h = hookWith({ server: { data: null, error: { message: 'offline' } } });
  const tree = await mount(h.Probe, { userId: 'alice', createdAt: ago(DAY) });
  assert.equal(h.seen.at(-1), false);
  assert.equal(h.store['peekaboo-heard-about:alice'], undefined);
  await unmount(tree);
});

test('while the profile loads it checks; once the profile shows an old account, the app opens at once', async () => {
  let tree;
  // The server never answers in this test.
  const never = new Promise(() => {});
  const { exports } = loadScreen('src/lib/heardAbout.ts', {
    '@react-native-async-storage/async-storage': { __esModule: true, default: { getItem: async () => null, setItem: async () => {} } },
    './supabase': { supabase: { rpc: () => never } },
  }, { timers: 'real' });
  const seen = [];
  function Probe({ createdAt }) {
    const [needed] = exports.useNeedsHeardAbout('alice', createdAt);
    seen.push(needed);
    return null;
  }
  await act(async () => { tree = renderer.create(React.createElement(Probe, { createdAt: undefined })); });
  assert.equal(seen.at(-1), null);
  await act(async () => { tree.update(React.createElement(Probe, { createdAt: ago(30 * DAY) })); });
  assert.equal(seen.at(-1), false);
  await unmount(tree);
});
