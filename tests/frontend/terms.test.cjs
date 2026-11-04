const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScreen, renderScreen, act, button, unmount } = require('./harness.cjs');

function termsScreen(hasAccepted, acceptLegal = async () => {}, signOut = async () => {}) {
  const screen = loadScreen('src/components/TermsGate.tsx', {
    '@/lib/auth': { useAuth: () => ({ userId: 'alice', session: { user: { user_metadata: {} } }, signOut }) },
    '@/lib/legal': { hasAccepted, acceptLegal, TERMS_VERSION: 'qa-terms', LEGAL_PAGES: {} },
    '@/lib/legalDocs': { LEGAL_DOCS: {} },
  });
  screen.Component = screen.exports.TermsGate;
  return screen;
}

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
