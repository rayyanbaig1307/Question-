const test = require('node:test');
const assert = require('node:assert/strict');
const { React, loadScreen, renderScreen, act, button, unmount, host } = require('./harness.cjs');
const validators = {
  ...loadScreen('src/lib/profiles.ts', { './supabase': { supabase: {} }, './socialAuth': {} }).exports,
  ...loadScreen('src/lib/cleanWords.ts').exports,
};

function setupHarness({ hasAccepted = async () => false, update = async () => ({}), signOut = async () => {} } = {}) {
  const calls = { saved: [], accepted: 0, done: 0, profile: null };
  const screen = loadScreen('src/components/ProfileSetup.tsx', {
    '@/lib/auth': { useAuth: () => ({ userId: 'alice', profile: { id: 'alice', username: 'userabcdef', display_name: 'userabcdef' }, session: { user: { app_metadata: { provider: 'apple' } } }, setProfile: value => { calls.profile = value; }, signOut }) },
    '@/lib/legal': { hasAcceptedAnyTerms: hasAccepted, acceptLegal: async () => { calls.accepted++; }, TERMS_VERSION: 'qa-terms' },
    '@/lib/profiles': { ...validators, isUsernameAvailable: async () => true, updateMyProfile: async (...args) => { calls.saved.push(args); return update(...args); } },
    '@/lib/cleanWords': validators,
    '@/lib/socialAuth': { sharedName: null, madeWithAppleOrGoogle: provider => ['apple', 'google'].includes(provider) },
  });
  screen.Component = () => React.createElement(screen.exports.ProfileSetup, { onDone: () => { calls.done++; } });
  return { screen, calls };
}
async function fillSetup(tree) {
  for (const [label, value] of [['Your name', 'Alice'], ['Username', 'alice']]) await act(() => tree.root.findAllByType('TextField').find(node => node.props.label === label).props.onChangeText(value));
  for (const box of tree.root.findAllByType('Pressable').filter(node => node.props.accessibilityRole === 'checkbox')) await act(() => box.props.onPress());
}

test('social account setup remains required when its Terms check fails', async () => {
  const { screen } = setupHarness({ hasAccepted: async () => { throw new Error('Simulated database outage'); } });
  screen.Component = () => { const [needed] = screen.exports.useNeedsSetup(); return React.createElement('SetupState', { needed }); };
  const tree = await renderScreen(screen);
  try { assert.equal(tree.root.findByType('SetupState').props.needed, true); }
  finally { await unmount(tree); }
});

test('setup does not accept Terms for another login when an old profile save finishes after unmount', async () => {
  let release;
  const saved = new Promise(resolve => { release = resolve; });
  const { screen, calls } = setupHarness({ update: () => saved });
  const tree = await renderScreen(screen);
  await fillSetup(tree);
  let finishing;
  await act(async () => { finishing = button(tree, "Let's go!").props.onPress(); await Promise.resolve(); });
  await unmount(tree);
  await act(async () => { release({ id: 'alice', username: 'alice' }); await finishing; });
  assert.equal(calls.accepted, 0, 'an old setup must not call the current-session accept_legal RPC');
  assert.equal(calls.done, 0);
});

test('social setup validates empty fields and both confirmations before saving', async () => {
  const { screen, calls } = setupHarness();
  const tree = await renderScreen(screen);
  try {
    await act(() => button(tree, "Let's go!").props.onPress());
    assert.equal(calls.saved.length, 0);
    await fillSetup(tree);
    await act(() => button(tree, "Let's go!").props.onPress());
    assert.equal(calls.saved.length, 1);
    assert.equal(calls.accepted, 1);
    assert.equal(calls.done, 1);
  } finally { await unmount(tree); }
});

test('social setup treats a failed logout as a visible, recoverable error', async () => {
  const { screen } = setupHarness({ signOut: async () => { throw new Error('Simulated logout failure'); } });
  const tree = await renderScreen(screen);
  try {
    await act(() => button(tree, 'Cancel and log out').props.onPress());
    assert.match(tree.root.findAllByType('Text').map(node => node.children.join('')).join(''), /Simulated logout failure/);
  } finally { await unmount(tree); }
});

test('repeated native social sign-in presses start only one account-selection flow', async () => {
  let release, attempts = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const screen = loadScreen('src/components/SocialSignIn.tsx', {
    '@/lib/socialAuth': { Apple: null, APPLE_SIGN_IN_AVAILABLE: false, GOOGLE_SIGN_IN_AVAILABLE: true, signInWithGoogle: async () => { attempts++; await pending; }, SignInCancelled: class extends Error {} },
  });
  screen.Component = screen.exports.SocialSignInButtons;
  const tree = await renderScreen(screen);
  try {
    const press = button(tree, 'Continue with Google').props.onPress;
    await act(async () => { press(); press(); await Promise.resolve(); });
    release();
    await act(async () => { await pending; });
    assert.equal(attempts, 1);
  } finally { release(); await unmount(tree); }
});
