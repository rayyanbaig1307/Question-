const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScreen, renderScreen, act, button, textOf, unmount } = require('./harness.cjs');

// A stand-in for React Native's AppState: `foreground()` acts like the person coming back to the app.
function appState() {
  const listeners = new Set();
  return {
    currentState: 'active',
    addEventListener: (_type, callback) => { listeners.add(callback); return { remove: () => listeners.delete(callback) }; },
    foreground() { for (const callback of [...listeners]) callback('active'); },
    get listening() { return listeners.size; },
  };
}

function termsScreen(hasAccepted, acceptLegal = async () => {}, signOut = async () => {}) {
  const screen = loadScreen('src/components/TermsGate.tsx', {
    '@/lib/auth': { useAuth: () => ({ userId: 'alice', session: { user: { user_metadata: {} } }, signOut }) },
    '@/lib/legal': { hasAccepted, acceptLegal, TERMS_VERSION: 'qa-terms', LEGAL_PAGES: {} },
    '@/lib/legalDocs': { LEGAL_DOCS: {} },
  });
  screen.appState = appState();
  screen.modules['react-native'].AppState = screen.appState;
  screen.Component = screen.exports.TermsGate;
  return screen;
}
const allText = tree => tree.root.findAllByType('Text').map(textOf).join(' ');

test('terms gate stays closed while acceptance is loading', async () => {
  let resolve;
  const screen = termsScreen(() => new Promise(done => { resolve = done; }));
  const tree = await renderScreen(screen);
  try {
    assert.equal(tree.root.findAllByType('Modal').length, 1, 'the app must wait for the acceptance check');
    await act(() => resolve(true));
    assert.equal(tree.root.findAllByType('Modal').length, 0);
  } finally { resolve(true); await unmount(tree); }
});

test('terms database failure cannot silently dismiss the required agreement', async () => {
  const screen = termsScreen(async () => { throw new Error('Simulated database outage'); });
  const tree = await renderScreen(screen);
  try {
    assert.equal(tree.root.findAllByType('Modal').length, 1);
    assert.ok(button(tree, 'Log out'));
  } finally { await unmount(tree); }
});

test('terms gate remains open if saving agreement fails', async () => {
  const screen = termsScreen(async () => false, async () => { throw new Error('Simulated network timeout'); });
  const tree = await renderScreen(screen);
  try {
    await act(() => button(tree, 'I agree').props.onPress());
    assert.equal(tree.root.findAllByType('Modal').length, 1);
    assert.equal(screen.calls.alerts[0][0], 'Could not save');
  } finally { await unmount(tree); }
});

test('a failed logout from the Terms screen is explained without an unhandled rejection', async () => {
  const screen = termsScreen(async () => false, async () => {}, async () => { throw new Error('Simulated logout timeout'); });
  const tree = await renderScreen(screen);
  try {
    await act(() => button(tree, 'Log out').props.onPress());
    assert.equal(screen.calls.alerts[0][0], 'Could not log out');
    assert.equal(tree.root.findAllByType('Modal').length, 1);
  } finally { await unmount(tree); }
});

test('a queued Terms logout cannot affect the next account after unmount', async () => {
  let loggedOut = 0;
  const screen = termsScreen(async () => false, async () => {}, async () => { loggedOut++; });
  const tree = await renderScreen(screen);
  const logOut = button(tree, 'Log out').props.onPress;
  await unmount(tree); await act(() => logOut());
  assert.equal(loggedOut, 0);
});

test('an already-agreed user sees only a plain cover (not the Terms page) while the check runs', async () => {
  let resolve;
  const screen = termsScreen(() => new Promise(done => { resolve = done; }));
  const tree = await renderScreen(screen);
  try {
    const [cover] = tree.root.findAllByType('Modal');
    assert.ok(cover, 'the app must stay covered until the check is done');
    assert.notEqual(cover.props.animationType, 'slide', 'nothing should slide up on every launch');
    assert.doesNotMatch(allText(tree), /Our Terms/);
    assert.equal(!!button(tree, 'I agree'), false, 'no "I agree" button yet');
    await act(() => resolve(true));
    assert.equal(tree.root.findAllByType('Modal').length, 0);
  } finally { resolve(true); await unmount(tree); }
});

test('the Terms page appears only when the check says agreeing is needed', async () => {
  const screen = termsScreen(async () => false);
  const tree = await renderScreen(screen);
  try {
    assert.match(allText(tree), /Our Terms/);
    assert.ok(button(tree, 'I agree'));
    assert.equal(button(tree, 'I agree').props.loading, false);
  } finally { await unmount(tree); }
});

test('a failed Terms check offers Try again instead of asking an agreed user to agree again', async () => {
  let checks = 0;
  const screen = termsScreen(async () => { if (++checks === 1) throw new Error('Simulated database outage'); return true; });
  const tree = await renderScreen(screen);
  try {
    assert.equal(tree.root.findAllByType('Modal').length, 1, 'the app must stay blocked after a failed check');
    assert.equal(!!button(tree, 'I agree'), false, 'no "I agree" button yet');
    assert.doesNotMatch(allText(tree), /Our Terms/);
    assert.equal(!!button(tree, 'Try again'), true, 'a Try again button is shown');
    assert.ok(button(tree, 'Log out'));
    await act(() => button(tree, 'Try again').props.onPress());
    assert.equal(checks, 2);
    assert.equal(tree.root.findAllByType('Modal').length, 0);
  } finally { await unmount(tree); }
});

test('a failed Terms check is tried again when the app comes back to the front', async () => {
  let checks = 0;
  const screen = termsScreen(async () => { if (++checks === 1) throw new Error('Simulated database outage'); return true; });
  const tree = await renderScreen(screen);
  try {
    assert.equal(!!button(tree, 'Try again'), true, 'a Try again button is shown');
    await act(() => screen.appState.foreground());
    assert.equal(checks, 2);
    assert.equal(tree.root.findAllByType('Modal').length, 0);
  } finally { await unmount(tree); }
  assert.equal(screen.appState.listening, 0, 'the listener must be removed when the gate goes away');
});

// Review of the fixes: on Android a request can hang forever (no time limit), so a check that never answers
// must not leave a spinner with no way out.
test('a Terms check that never answers turns into "Try again" / "Log out" after a short wait', async () => {
  let checks = 0;
  const screen = termsScreen(() => { checks++; return checks === 1 ? new Promise(() => {}) : Promise.resolve(true); });
  const tree = await renderScreen(screen);
  try {
    assert.equal(!!button(tree, 'Try again'), false, 'just a spinner while the check is still running');
    assert.ok(screen.calls.timers.length > 0, 'the check must have a time limit');
    for (const timer of screen.calls.timers.splice(0)) await act(() => timer());
    assert.equal(tree.root.findAllByType('Modal').length, 1, 'still blocked: nothing was confirmed');
    assert.ok(button(tree, 'Try again'), 'a stalled check offers Try again');
    assert.ok(button(tree, 'Log out'), 'a stalled check offers Log out');
    assert.equal(!!button(tree, 'I agree'), false, 'an agreed user is not asked to agree again');
    await act(() => button(tree, 'Try again').props.onPress());
    assert.equal(checks, 2);
    assert.equal(tree.root.findAllByType('Modal').length, 0);
  } finally { await unmount(tree); }
});

test('a check that answers in time is not turned into "Could not check" by its timer', async () => {
  const screen = termsScreen(async () => true);
  const tree = await renderScreen(screen);
  try {
    assert.equal(tree.root.findAllByType('Modal').length, 0);
    for (const timer of screen.calls.timers.splice(0)) await act(() => timer());
    assert.equal(tree.root.findAllByType('Modal').length, 0, 'a late timer must not cover the app again');
  } finally { await unmount(tree); }
});

test('a slow Terms check that answers after the time limit still counts', async () => {
  let resolve;
  const screen = termsScreen(() => new Promise(done => { resolve = done; }));
  const tree = await renderScreen(screen);
  try {
    for (const timer of screen.calls.timers.splice(0)) await act(() => timer());
    assert.ok(button(tree, 'Try again'));
    await act(() => resolve(true));
    assert.equal(tree.root.findAllByType('Modal').length, 0, 'a confirmed "agreed" lets you in');
  } finally { resolve(true); await unmount(tree); }
});

// A stand-in for React Native's Modal that writes down how each copy of it is shown, hidden and removed.
// On a phone, a Modal that turns invisible plays its `animationType` on the way out. Closing one pop-up and
// opening another in the same moment can fail on an iPhone (the new one is never shown), so the gate must
// keep using the one pop-up it started with.
function recordModals(screen) {
  const { React } = require('./harness.cjs');
  const log = [];
  let made = 0;
  screen.modules['react-native'].Modal = function Modal(props) {
    const id = React.useRef(0);
    if (!id.current) id.current = ++made;
    log.push({ id: id.current, visible: !!props.visible, animationType: props.animationType });
    React.useEffect(() => () => { log.push({ id: id.current, removed: true }); }, []);
    return props.visible ? React.createElement('Modal', props, props.children) : null;
  };
  return log;
}

test('for someone who already agreed, the checking cover goes away without sliding down', async () => {
  let resolve;
  const screen = termsScreen(() => new Promise(done => { resolve = done; }));
  const log = recordModals(screen);
  const tree = await renderScreen(screen);
  try {
    const cover = log.find(entry => entry.visible);
    assert.ok(cover, 'the app is covered while the check runs');
    assert.equal(cover.animationType, 'none');
    await act(() => resolve(true));
    assert.equal(tree.root.findAllByType('Modal').length, 0, 'the app is open once the check says "agreed"');
    // The cover must go away as it is (no animation), never hidden with a slide.
    const hiddenWithAnimation = log.filter(entry => !entry.removed && !entry.visible && entry.animationType !== 'none');
    assert.deepEqual(hiddenWithAnimation, [], 'the cover must not slide down on every launch');
    assert.deepEqual(log.filter(entry => !entry.removed).at(-1), { id: cover.id, visible: false, animationType: 'none' }, 'the cover is hidden without animation');
    assert.equal(log.some(entry => entry.id !== cover.id), false, 'no other pop-up is ever made');
  } finally { resolve(true); await unmount(tree); }
});

test('when agreeing is needed, the Terms page shows on the same pop-up (never a new one) and slides away after "I agree"', async () => {
  let resolve;
  const screen = termsScreen(() => new Promise(done => { resolve = done; }));
  const log = recordModals(screen);
  const tree = await renderScreen(screen);
  try {
    const cover = log.find(entry => entry.visible);
    await act(() => resolve(false));
    assert.match(allText(tree), /Our Terms/);
    assert.equal(log.some(entry => entry.id !== cover.id), false, 'the Terms page uses the cover pop-up, never a new one');
    assert.equal(log.some(entry => entry.removed), false, 'the pop-up is never closed and opened again');
    assert.equal(log.some(entry => entry.id === cover.id && !entry.visible), false, 'the app is never uncovered before "I agree"');
    assert.equal(log.at(-1).animationType, 'slide', 'the Terms page can slide away after "I agree"');
    await act(() => button(tree, 'I agree').props.onPress());
    assert.equal(tree.root.findAllByType('Modal').length, 0);
    assert.deepEqual(log.at(-1), { id: cover.id, visible: false, animationType: 'slide' });
  } finally { resolve(false); await unmount(tree); }
});

// Start-up: someone this phone already knows has agreed goes straight in (no cover flashing after the logo),
// but the server still decides – if the Terms changed, the Terms page shows.
function rememberedScreen(hasAccepted) {
  const saved = { alice: 'qa-terms' };
  const screen = loadScreen('src/components/TermsGate.tsx', {
    '@/lib/auth': { useAuth: () => ({ userId: 'alice', session: { user: { user_metadata: {} } }, signOut: async () => {} }) },
    '@/lib/legal': { hasAccepted, acceptLegal: async () => {}, TERMS_VERSION: 'qa-terms', LEGAL_PAGES: {} },
    '@/lib/legalDocs': { LEGAL_DOCS: {} },
    '@/lib/termsCache': {
      knownAgreed: (user, version) => saved[user] === version,
      knownAgreedAny: user => user in saved,
      rememberAgreed: (user, version) => { saved[user] = version; },
      forgetAgreed: user => { delete saved[user]; },
    },
  });
  screen.modules['react-native'].AppState = appState();
  screen.Component = screen.exports.TermsGate;
  screen.saved = saved;
  return screen;
}

test('already agreed on this phone: no cover at start-up, even while the server check is still running', async () => {
  let resolve;
  const screen = rememberedScreen(() => new Promise(done => { resolve = done; }));
  const tree = await renderScreen(screen);
  try {
    assert.equal(tree.root.findAllByType('Modal').length, 0, 'straight into the app');
    await act(() => resolve(true));
    assert.equal(tree.root.findAllByType('Modal').length, 0);
  } finally { resolve(true); await unmount(tree); }
});

test('already agreed on this phone, but the Terms changed on the server: the Terms page still shows', async () => {
  const screen = rememberedScreen(async () => false);
  const tree = await renderScreen(screen);
  try {
    await act(async () => {});
    assert.equal(tree.root.findAllByType('Modal').length, 1);
    assert.match(allText(tree), /Our Terms/);
    assert.equal('alice' in screen.saved, false, 'the phone forgets the old agreement');
  } finally { await unmount(tree); }
});

test('already agreed on this phone and the server check fails (no internet): carries on, no "Couldn\'t check"', async () => {
  const screen = rememberedScreen(async () => { throw new Error('offline'); });
  const tree = await renderScreen(screen);
  try {
    await act(async () => {});
    assert.equal(tree.root.findAllByType('Modal').length, 0);
  } finally { await unmount(tree); }
});
