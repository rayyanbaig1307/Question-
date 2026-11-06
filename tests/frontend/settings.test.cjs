const test = require('node:test');
const assert = require('node:assert/strict');
const { React, loadScreen, renderScreen, act, option, unmount } = require('./harness.cjs');

function settingsHarness({ delayWrite = false, delayLocation = false, signOut = async () => {}, deleteAccount, refreshProfile, storePlus = false, plus = storePlus } = {}) {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  // `signedIn` is who the phone is logged in as right now (it can change while a request is still running).
  const state = { profile: { id: 'alice', username: 'alice', display_name: 'Alice', is_private: true, location_sharing: false, hit_ups_from: 'everyone' }, options: [], writes: 0, deleted: [], signedIn: 'alice', refreshes: 0 };
  const saved = { ...state.profile };
  const screen = loadScreen('src/app/(app)/settings.tsx', {
    expo: { reloadAppAsync: async () => {} }, 'expo-constants': { expoConfig: {} },
    'expo-router': { router: { push() {} }, useFocusEffect: callback => React.useEffect(callback, [callback]) },
    '@/components/BirthdayForm': { formatBirthday: value => value },
    '@/components/Overlays': { useOverlays: () => ({ showToast() {}, showOptions: value => state.options.push(value) }) },
    '@/lib/auth': { useMe: () => { const [profile, set] = React.useState(state.profile); return { userId: 'alice', profile, setProfile: value => { state.profile = value; set(value); }, signOut, currentUserId: () => state.signedIn, refreshProfile: refreshProfile ? () => refreshProfile(state, saved) : async () => { state.refreshes++; return { ...saved }; } }; } },
    '@/lib/birthday': { fetchMyBirthday: async () => null },
    '@/lib/invite': { inviteFriends() {} },
    '@/lib/legal': { contactEmail: () => null }, '@/lib/legalDocs': { LEGAL_DOCS: { terms: '' } },
    '@/lib/location': { setLocationSharing: async (_id, share) => { if (share && delayLocation) await pending; return { ...saved, location_sharing: share }; } },
    '@/lib/notificationPrefs': { ALL_ON: {}, fetchNotificationPrefs: async () => ({ messages: true, drops: true }), saveNotificationPrefs: async () => {} },
    '@/lib/notifications': { scheduleDropNotifications: async () => {} },
    '@/lib/preferences': { useScratchToReveal: () => [true, () => {}] },
    '@/lib/profiles': { deleteMyAccount: async (...args) => { state.deleted.push(args); if (deleteAccount) await deleteAccount(); }, updateMyProfile: async (_id, changes) => { if (++state.writes === 1 && delayWrite) await pending; Object.assign(saved, changes); return { ...saved }; } },
    // Peekaboo+: `storePlus` = the App Store says you're paying; `plus` = you have Plus (the App Store or the
    // server). Delete account then warns about Apple billing.
    '@/lib/plus': {
      usePlus: () => plus, useStorePlus: () => storePlus,
      MANAGE_SUBSCRIPTION_URL: 'https://apps.apple.com/account/subscriptions',
      openManageSubscription: async () => { state.managed++; },
    },
  });
  // Links the screen opens, and how often Apple's subscriptions sheet was opened.
  state.opened = [];
  state.managed = 0;
  screen.modules['react-native'].Linking = { openURL: async url => { state.opened.push(url); } };
  return { screen, state, saved, release };
}

test('the last private-account choice wins even if the first save is delayed', async () => {
  const fixture = settingsHarness({ delayWrite: true });
  const tree = await renderScreen(fixture.screen);
  try {
    const toggle = tree.root.findAllByType('Switch')[0].props.onValueChange;
    let a, b;
    await act(async () => { a = toggle(false); b = toggle(true); await Promise.resolve(); });
    fixture.release();
    await act(() => Promise.all([a, b]));
    assert.equal(fixture.saved.is_private, true, 'an older make-public response must not undo the later private choice');
    assert.equal(fixture.state.profile.is_private, true);
  } finally { fixture.release(); await unmount(tree); }
});

test('the last hit-up audience choice wins when saves complete out of order', async () => {
  const fixture = settingsHarness({ delayWrite: true });
  const tree = await renderScreen(fixture.screen);
  try {
    await act(() => option(tree, 'Who can hit me up').props.onPress());
    let a, b;
    await act(async () => {
      a = fixture.state.options[0].options.find(item => item.label.startsWith('Friends of friends')).onPress();
      b = fixture.state.options[0].options.find(item => item.label.startsWith('Nobody')).onPress();
      await Promise.resolve();
    });
    fixture.release();
    await act(() => Promise.all([a, b]));
    assert.equal(fixture.saved.hit_ups_from, 'nobody');
    assert.equal(fixture.state.profile.hit_ups_from, 'nobody');
  } finally { fixture.release(); await unmount(tree); }
});

test('Settings ignores an old show-location response after the user chooses Hide', async () => {
  const fixture = settingsHarness({ delayLocation: true });
  const tree = await renderScreen(fixture.screen);
  try {
    const toggle = tree.root.findAllByType('Switch')[1].props.onValueChange;
    let a;
    await act(async () => { a = toggle(false); await Promise.resolve(); });
    await act(() => toggle(true));
    fixture.release();
    await act(() => a);
    assert.equal(fixture.state.profile.location_sharing, false);
  } finally { fixture.release(); await unmount(tree); }
});

test('a failed confirmed logout in Settings is explained without an unhandled rejection', async () => {
  const fixture = settingsHarness({ signOut: async () => { throw new Error('Simulated logout timeout'); } });
  const tree = await renderScreen(fixture.screen);
  try {
    await act(() => option(tree, 'Log out').props.onPress());
    const confirm = fixture.screen.calls.alerts[0][2].find(item => item.text === 'Log out');
    await act(() => confirm.onPress());
    assert.equal(fixture.screen.calls.alerts[1][0], 'Could not log out');
  } finally { await unmount(tree); }
});

async function deleteCallback(tree, screen) {
  await act(() => option(tree, 'Delete account').props.onPress());
  await act(() => screen.calls.alerts[0][2].find(item => item.text === 'Delete').onPress());
  return screen.calls.alerts[1][2].find(item => item.text === 'Delete forever').onPress;
}

test('an old native delete confirmation cannot delete a later signed-in account', async () => {
  const fixture = settingsHarness();
  const tree = await renderScreen(fixture.screen);
  const confirmed = await deleteCallback(tree, fixture.screen);
  await unmount(tree);
  await act(() => confirmed());
  assert.equal(fixture.state.deleted.length, 0, 'a native Alert can outlive Settings, so its callback must be cancelled');
});

// Like the real signOut(expectedUserId) in src/lib/auth.tsx: it refuses to log out anyone but the named account.
function boundSignOut(fixture, log) {
  return async (expected) => {
    log.push(expected);
    if (!expected || expected !== fixture.state.signedIn) throw new Error('The signed-in account changed. Open Settings and try again.');
    fixture.state.signedIn = null;
  };
}

test('an old deletion response cannot log out a later account', async () => {
  let release;
  const calls = [];
  const pending = new Promise(resolve => { release = resolve; });
  const fixture = settingsHarness({ deleteAccount: () => pending, signOut: (...args) => fixture.signOut(...args) });
  fixture.signOut = boundSignOut(fixture, calls);
  const tree = await renderScreen(fixture.screen);
  const confirmed = await deleteCallback(tree, fixture.screen);
  let deleting;
  await act(async () => { deleting = confirmed(); await Promise.resolve(); });
  await unmount(tree);
  // Alice's account is being deleted; meanwhile Bob logs in on this phone.
  fixture.state.signedIn = 'bob';
  release(); await act(() => deleting);
  assert.equal(fixture.state.signedIn, 'bob', 'Bob must stay logged in');
  assert.ok(calls.every(account => account === 'alice'), 'any logout after the deletion must name the deleted account only');
  assert.deepEqual(fixture.state.deleted[0], ['alice'], 'the deletion request must explicitly name the account that approved it');
});

test('a finished deletion still logs this phone out if you left Settings while it ran', async () => {
  let release;
  const calls = [];
  const pending = new Promise(resolve => { release = resolve; });
  const fixture = settingsHarness({ deleteAccount: () => pending, signOut: (...args) => fixture.signOut(...args) });
  fixture.signOut = boundSignOut(fixture, calls);
  const tree = await renderScreen(fixture.screen);
  const confirmed = await deleteCallback(tree, fixture.screen);
  let deleting;
  await act(async () => { deleting = confirmed(); await Promise.resolve(); });
  await unmount(tree); // the user goes back while the deletion is still running
  release(); await act(() => deleting);
  assert.deepEqual(calls, ['alice']);
  assert.equal(fixture.state.signedIn, null, 'the deleted account must not stay logged in on the phone');
});

test('a queued private-account choice is still saved after you leave Settings', async () => {
  const fixture = settingsHarness({ delayWrite: true });
  const tree = await renderScreen(fixture.screen);
  const toggle = tree.root.findAllByType('Switch')[0].props.onValueChange;
  let a, b;
  await act(async () => { a = toggle(false); b = toggle(true); await Promise.resolve(); });
  await unmount(tree); // Back pressed before the first save finished
  fixture.release();
  await act(() => Promise.allSettled([a, b]));
  assert.equal(fixture.state.writes, 2, 'both choices must be sent, in order');
  assert.equal(fixture.saved.is_private, true, 'the last choice (Private) must win');
  assert.equal(fixture.screen.calls.alerts.length, 0);
});

test('a queued hit-up choice is still saved after you leave Settings', async () => {
  const fixture = settingsHarness({ delayWrite: true });
  const tree = await renderScreen(fixture.screen);
  await act(() => option(tree, 'Who can hit me up').props.onPress());
  let a, b;
  await act(async () => {
    a = fixture.state.options[0].options.find(item => item.label.startsWith('Friends of friends')).onPress();
    b = fixture.state.options[0].options.find(item => item.label.startsWith('Nobody')).onPress();
    await Promise.resolve();
  });
  await unmount(tree);
  fixture.release();
  await act(() => Promise.allSettled([a, b]));
  assert.equal(fixture.saved.hit_ups_from, 'nobody');
});

test('a queued privacy choice is not sent once another account is logged in', async () => {
  const fixture = settingsHarness({ delayWrite: true });
  const tree = await renderScreen(fixture.screen);
  const toggle = tree.root.findAllByType('Switch')[0].props.onValueChange;
  let a, b;
  await act(async () => { a = toggle(false); b = toggle(true); await Promise.resolve(); });
  await unmount(tree);
  fixture.state.signedIn = 'bob';
  fixture.release();
  await act(() => Promise.allSettled([a, b]));
  assert.equal(fixture.state.writes, 1, 'the second choice belongs to Alice, so it must not be sent while Bob is logged in');
});

test('an old native logout confirmation cannot log out a later account', async () => {
  let loggedOut = 0;
  const fixture = settingsHarness({ signOut: async () => { loggedOut++; } });
  const tree = await renderScreen(fixture.screen);
  await act(() => option(tree, 'Log out').props.onPress());
  const confirmed = fixture.screen.calls.alerts[0][2].find(item => item.text === 'Log out').onPress;
  await unmount(tree); await act(() => confirmed());
  assert.equal(loggedOut, 0);
});

// Like the real refreshProfile in src/lib/auth.tsx: it reads the saved profile, and puts what it read into the
// app's copy of your profile (`state.appCopy`) when the answer arrives. The first read is slow (bad signal).
function slowFirstRefresh() {
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  const refreshProfile = async (state, saved) => {
    const number = ++state.refreshes;
    const read = { ...saved };
    if (number === 1) await slow;
    state.appCopy = read;
    return read;
  };
  return { refreshProfile, release: () => release() };
}

test('after leaving Settings, an old profile refresh cannot put back an older privacy choice', async () => {
  const refresh = slowFirstRefresh();
  const fixture = settingsHarness({ delayWrite: true, refreshProfile: refresh.refreshProfile });
  const tree = await renderScreen(fixture.screen);
  const toggle = tree.root.findAllByType('Switch')[0].props.onValueChange;
  let a, b;
  await act(async () => { a = toggle(false); b = toggle(true); await Promise.resolve(); });
  await unmount(tree); // Back pressed before the first save finished
  fixture.release(); // the first save (Public) arrives…
  await act(async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); });
  refresh.release(); // …and only now the slow refresh that read "Public" comes back
  await act(() => Promise.allSettled([a, b]));
  assert.equal(fixture.saved.is_private, true, 'the last choice (Private) is saved');
  assert.equal(fixture.state.appCopy?.is_private, true, "the app's copy of the profile must show the last choice too");
  assert.equal(fixture.screen.calls.alerts.length, 0);
});

test('Settings rows that only hold a switch are not marked as disabled (screen readers would say so)', async () => {
  const fixture = settingsHarness();
  const tree = await renderScreen(fixture.screen);
  try {
    const switches = tree.root.findAllByType('Switch');
    assert.ok(switches.length >= 7, 'every switch row is on the page');
    for (const row of tree.root.findAllByType('Pressable')) {
      assert.notEqual(row.props.disabled, true, `a disabled row: ${row.findAllByType('Text').map(text => text.props.children).join(' / ')}`);
    }
    // Every switch still works on its own.
    for (const item of switches) assert.equal(typeof item.props.onValueChange, 'function');
  } finally { await unmount(tree); }
});

const BILLING = 'If you pay for Peekaboo+, Apple keeps billing you until you cancel it. Please cancel it first.';

test('Delete account warns a Peekaboo+ subscriber that Apple keeps billing, and opens Apple\'s subscriptions', async () => {
  const fixture = settingsHarness({ storePlus: true });
  const tree = await renderScreen(fixture.screen);
  try {
    await act(() => option(tree, 'Delete account').props.onPress());
    const [title, message, buttons] = fixture.screen.calls.alerts[0];
    assert.equal(title, 'Delete your account?');
    assert.ok(message.endsWith(`\n\n${BILLING}`), message);
    assert.deepEqual(Array.from(buttons, item => item.text), ['Manage subscription', 'Cancel', 'Delete']);
    await act(() => buttons.find(item => item.text === 'Manage subscription').onPress());
    assert.equal(fixture.state.managed, 1, 'Manage subscription opens Apple\'s subscriptions');
    assert.equal(fixture.state.deleted.length, 0, 'opening Apple\'s subscriptions never deletes anything');
    assert.equal(fixture.screen.calls.alerts.length, 1, 'no second warning until Delete is tapped');
    // Delete still works after the warning.
    await act(() => buttons.find(item => item.text === 'Delete').onPress());
    await act(() => fixture.screen.calls.alerts[1][2].find(item => item.text === 'Delete forever').onPress());
    assert.deepEqual(fixture.state.deleted, [['alice']]);
  } finally { await unmount(tree); }
});

test('Delete account also warns when only the server knows about your Peekaboo+ (bought on another phone)', async () => {
  const fixture = settingsHarness({ storePlus: false, plus: true });
  const tree = await renderScreen(fixture.screen);
  try {
    await act(() => option(tree, 'Delete account').props.onPress());
    const [, message, buttons] = fixture.screen.calls.alerts[0];
    assert.ok(message.endsWith(`\n\n${BILLING}`), message);
    assert.deepEqual(Array.from(buttons, item => item.text), ['Manage subscription', 'Cancel', 'Delete']);
  } finally { await unmount(tree); }
});

test('Delete account says nothing about billing without Peekaboo+', async () => {
  const fixture = settingsHarness({ storePlus: false });
  const tree = await renderScreen(fixture.screen);
  try {
    await act(() => option(tree, 'Delete account').props.onPress());
    const [, message, buttons] = fixture.screen.calls.alerts[0];
    assert.doesNotMatch(message, /billing/);
    assert.deepEqual(Array.from(buttons, item => item.text), ['Cancel', 'Delete']);
  } finally { await unmount(tree); }
});
