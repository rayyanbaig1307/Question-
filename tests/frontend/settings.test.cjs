const test = require('node:test');
const assert = require('node:assert/strict');
const { React, loadScreen, renderScreen, act, option, unmount } = require('./harness.cjs');

function settingsHarness({ delayWrite = false, delayLocation = false, signOut = async () => {}, deleteAccount } = {}) {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const state = { profile: { id: 'alice', username: 'alice', display_name: 'Alice', is_private: true, location_sharing: false, hit_ups_from: 'everyone' }, options: [], writes: 0, deleted: [] };
  const saved = { ...state.profile };
  const screen = loadScreen('src/app/(app)/settings.tsx', {
    expo: { reloadAppAsync: async () => {} }, 'expo-constants': { expoConfig: {} },
    'expo-router': { router: { push() {} }, useFocusEffect: callback => React.useEffect(callback, [callback]) },
    '@/components/BirthdayForm': { formatBirthday: value => value },
    '@/components/Overlays': { useOverlays: () => ({ showToast() {}, showOptions: value => state.options.push(value) }) },
    '@/lib/auth': { useMe: () => { const [profile, set] = React.useState(state.profile); return { userId: 'alice', profile, setProfile: value => { state.profile = value; set(value); }, signOut }; } },
    '@/lib/birthday': { fetchMyBirthday: async () => null },
    '@/lib/invite': { inviteFriends() {} },
    '@/lib/legal': { contactEmail: () => null }, '@/lib/legalDocs': { LEGAL_DOCS: { terms: '' } },
    '@/lib/location': { setLocationSharing: async (_id, share) => { if (share && delayLocation) await pending; return { ...saved, location_sharing: share }; } },
    '@/lib/notificationPrefs': { ALL_ON: {}, fetchNotificationPrefs: async () => ({ messages: true, drops: true }), saveNotificationPrefs: async () => {} },
    '@/lib/notifications': { scheduleDropNotifications: async () => {} },
    '@/lib/preferences': { useScratchToReveal: () => [true, () => {}] },
    '@/lib/profiles': { deleteMyAccount: async (...args) => { state.deleted.push(args); if (deleteAccount) await deleteAccount(); }, updateMyProfile: async (_id, changes) => { if (++state.writes === 1 && delayWrite) await pending; Object.assign(saved, changes); return { ...saved }; } },
  });
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

test('an old deletion response cannot log out a later account', async () => {
  let release, loggedOut = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const fixture = settingsHarness({ deleteAccount: () => pending, signOut: async () => { loggedOut++; } });
  const tree = await renderScreen(fixture.screen);
  const confirmed = await deleteCallback(tree, fixture.screen);
  let deleting;
  await act(async () => { deleting = confirmed(); await Promise.resolve(); });
  await unmount(tree);
  release(); await act(() => deleting);
  assert.equal(loggedOut, 0);
  assert.deepEqual(fixture.state.deleted[0], ['alice'], 'the deletion request must explicitly name the account that approved it');
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
