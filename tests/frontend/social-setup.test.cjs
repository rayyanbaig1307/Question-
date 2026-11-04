const test = require('node:test');
const assert = require('node:assert/strict');
const { React, loadScreen, renderScreen, act, button, unmount, host } = require('./harness.cjs');
const validators = {
  ...loadScreen('src/lib/profiles.ts', { './supabase': { supabase: {} }, './socialAuth': {} }).exports,
  ...loadScreen('src/lib/cleanWords.ts').exports,
};

// A stand-in for React Native's AppState: `foreground()` acts like the person coming back to the app.
function appState() {
  const listeners = new Set();
  return {
    currentState: 'active',
    addEventListener: (_type, callback) => { listeners.add(callback); return { remove: () => listeners.delete(callback) }; },
    foreground() { for (const callback of [...listeners]) callback('active'); },
  };
}

const STAND_IN_PROFILE = { id: 'alice', username: 'userabcdef', display_name: 'userabcdef' };

function setupHarness({ hasAccepted = async () => false, update = async () => ({}), signOut = async () => {}, profile = STAND_IN_PROFILE, refreshProfile } = {}) {
  const calls = { saved: [], accepted: 0, done: 0, profile: null, refreshes: 0 };
  const screen = loadScreen('src/components/ProfileSetup.tsx', {
    '@/lib/auth': { useAuth: () => ({ userId: 'alice', profile, session: { user: { app_metadata: { provider: 'apple' } } }, setProfile: value => { calls.profile = value; }, signOut,
      refreshProfile: async () => { calls.refreshes++; return refreshProfile ? refreshProfile() : profile; } }) },
    '@/lib/legal': { hasAcceptedAnyTerms: hasAccepted, acceptLegal: async () => { calls.accepted++; }, TERMS_VERSION: 'qa-terms' },
    '@/lib/profiles': { ...validators, isUsernameAvailable: async () => true, updateMyProfile: async (...args) => { calls.saved.push(args); return update(...args); } },
    '@/lib/cleanWords': validators,
    '@/lib/socialAuth': { sharedName: null, madeWithAppleOrGoogle: provider => ['apple', 'google'].includes(provider) },
  });
  screen.appState = appState();
  screen.modules['react-native'].AppState = screen.appState;
  screen.Component = () => React.createElement(screen.exports.ProfileSetup, { onDone: () => { calls.done++; } });
  return { screen, calls };
}

// Renders just the "does this account still need setup?" check, and shows its answer.
function checkOnly(screen) {
  let latest;
  screen.Component = () => {
    const [needed, , check] = screen.exports.useNeedsSetup();
    latest = check;
    return React.createElement('SetupState', { needed, failed: check?.failed ?? false });
  };
  return { get check() { return latest; } };
}
const setupState = tree => tree.root.findByType('SetupState').props;
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

test('a failed setup check offers Try again, and an existing user who agreed long ago gets straight in', async () => {
  let checks = 0;
  const { screen } = setupHarness({ hasAccepted: async () => { if (++checks === 1) throw new Error('Network request failed'); return true; } });
  const view = checkOnly(screen);
  const tree = await renderScreen(screen);
  try {
    assert.deepEqual(setupState(tree), { needed: true, failed: true }, 'never skip setup on an error, but say the check failed');
    await act(() => view.check.retry());
    assert.equal(checks, 2);
    assert.deepEqual(setupState(tree), { needed: false, failed: false });
  } finally { await unmount(tree); }
});

test('a failed setup check is tried again when the app comes back to the front', async () => {
  let checks = 0;
  const { screen } = setupHarness({ hasAccepted: async () => { if (++checks === 1) throw new Error('Network request failed'); return true; } });
  checkOnly(screen);
  const tree = await renderScreen(screen);
  try {
    assert.equal(setupState(tree).failed, true);
    await act(() => screen.appState.foreground());
    assert.equal(checks, 2);
    assert.deepEqual(setupState(tree), { needed: false, failed: false });
  } finally { await unmount(tree); }
});

test('setup loads a missing profile first, so your own username counts as yours', async () => {
  const { screen, calls } = setupHarness({ profile: null, refreshProfile: async () => ({ id: 'alice', username: 'alice', display_name: 'Alice' }) });
  checkOnly(screen);
  const tree = await renderScreen(screen);
  try {
    assert.equal(calls.refreshes, 1, 'the profile must be loaded again before the form is shown');
    assert.deepEqual(setupState(tree), { needed: true, failed: false });
  } finally { await unmount(tree); }
});

test('setup shows Try again (not an empty form) when the profile cannot be loaded', async () => {
  const { screen } = setupHarness({ profile: null, refreshProfile: async () => null });
  checkOnly(screen);
  const tree = await renderScreen(screen);
  try {
    assert.deepEqual(setupState(tree), { needed: true, failed: true });
  } finally { await unmount(tree); }
});

function appLayout(setup, profile = { id: 'alice', username: 'alice' }) {
  const screen = loadScreen('src/app/(app)/_layout.tsx', {
    'expo-router': { Stack: Object.assign(host('Stack'), { Screen: host('StackScreen') }) },
    '@/components/ProfileSetup': { useNeedsSetup: () => setup, ProfileSetup: host('ProfileSetup') },
    '@/components/TermsGate': { TermsGate: host('TermsGate'), CouldNotCheck: host('CouldNotCheck') },
    '@/lib/auth': { useAuth: () => ({ userId: 'alice', profile }) },
    '@/lib/communityDares': { syncCommunityDares: async () => {} },
    '@/lib/location': { useShareLocationWhileOpen() {} },
    '@/lib/notificationPrefs': { fetchNotificationPrefs: async () => ({ drops: true }) },
    '@/lib/notifications': { registerForPush() {}, scheduleDropNotifications: async () => {}, useNotificationTaps() {} },
  });
  return screen;
}
const shown = tree => ['CouldNotCheck', 'ProfileSetup', 'Stack', 'TermsGate'].filter(name => tree.root.findAllByType(name).length > 0);

test('the app shows "Could not check" (not the setup form or the app) after a failed setup check', async () => {
  const retry = () => {};
  const tree = await renderScreen(appLayout([true, () => {}, { failed: true, checking: false, retry }]));
  try {
    assert.deepEqual(shown(tree), ['CouldNotCheck']);
    assert.equal(tree.root.findByType('CouldNotCheck').props.onRetry, retry);
  } finally { await unmount(tree); }
});

test('the app never shows the setup form without your profile', async () => {
  const tree = await renderScreen(appLayout([true, () => {}, { failed: false, checking: false, retry() {} }], null));
  try { assert.deepEqual(shown(tree), ['CouldNotCheck']); } finally { await unmount(tree); }
});

test('the app shows the setup form when setup is needed, and the app itself when it is not', async () => {
  const setupTree = await renderScreen(appLayout([true, () => {}, { failed: false, checking: false, retry() {} }]));
  try { assert.deepEqual(shown(setupTree), ['ProfileSetup']); } finally { await unmount(setupTree); }
  const appTree = await renderScreen(appLayout([false, () => {}, { failed: false, checking: false, retry() {} }]));
  try { assert.deepEqual(shown(appTree), ['Stack', 'TermsGate']); } finally { await unmount(appTree); }
});

// Review of the fixes: a check that never answers (a stalled request) must not leave a blank screen forever.
test('a setup check that never answers turns into "Could not check" after a short wait', async () => {
  let checks = 0;
  const { screen } = setupHarness({ hasAccepted: () => { checks++; return checks === 1 ? new Promise(() => {}) : Promise.resolve(true); } });
  const view = checkOnly(screen);
  const tree = await renderScreen(screen);
  try {
    assert.deepEqual(setupState(tree), { needed: null, failed: false }, 'still checking');
    assert.ok(screen.calls.timers.length > 0, 'the check must have a time limit');
    for (const timer of screen.calls.timers.splice(0)) await act(() => timer());
    assert.deepEqual(setupState(tree), { needed: true, failed: true }, 'never skip setup, but offer Try again');
    await act(() => view.check.retry());
    assert.equal(checks, 2);
    assert.deepEqual(setupState(tree), { needed: false, failed: false });
  } finally { await unmount(tree); }
});

test('a setup check that answers in time is not turned into "Could not check" by its timer', async () => {
  const { screen } = setupHarness({ hasAccepted: async () => true });
  checkOnly(screen);
  const tree = await renderScreen(screen);
  try {
    assert.deepEqual(setupState(tree), { needed: false, failed: false });
    for (const timer of screen.calls.timers.splice(0)) await act(() => timer());
    assert.deepEqual(setupState(tree), { needed: false, failed: false });
  } finally { await unmount(tree); }
});
