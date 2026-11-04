const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScreen, renderScreen, act, button, textOf, unmount } = require('./harness.cjs');

function loginHarness(fail = false) {
  const requests = [];
  return {
    requests,
    screen: loadScreen('src/app/sign-in.tsx', {
      '@/lib/supabase': { supabase: { auth: { signInWithPassword: async input => { requests.push(['email', input]); return { error: fail ? new Error('Wrong password') : null }; } } } },
      '@/lib/usernameAuth': { logInWithUsername: async (...input) => { requests.push(['username', ...input]); if (fail) throw new Error('Wrong password'); } },
    }),
  };
}
async function fill(tree, label, value) { await act(() => tree.root.findAllByType('TextField').find(node => node.props.label === label).props.onChangeText(value)); }

test('login rejects empty credentials without making a request', async () => {
  const { screen, requests } = loginHarness();
  const tree = await renderScreen(screen);
  try {
    await act(() => button(tree, 'Log in').props.onPress());
    assert.equal(requests.length, 0);
    assert.match(textOf(tree.root), /Type your email or username/);
  } finally { await unmount(tree); }
});

for (const login of ['alice@example.test', 'alice', '@alice']) test(`login routes ${login.includes('@example') ? 'email' : 'username'} credentials correctly: ${login}`, async () => {
  const { screen, requests } = loginHarness();
  const tree = await renderScreen(screen);
  try {
    await fill(tree, 'Email or username', `  ${login}  `);
    await fill(tree, 'Password', 'Example123');
    await act(() => button(tree, 'Log in').props.onPress());
    assert.equal(requests.length, 1);
    assert.equal(requests[0][0], login.includes('@example') ? 'email' : 'username');
    assert.equal(login.includes('@example') ? requests[0][1].email : requests[0][1], login);
    assert.equal(tree.root.findAllByType('TextField').find(node => node.props.label === 'Password').props.secureTextEntry, true);
  } finally { await unmount(tree); }
});

test('wrong credentials show an error and allow retry', async () => {
  const { screen, requests } = loginHarness(true);
  const tree = await renderScreen(screen);
  try {
    await fill(tree, 'Email or username', 'alice');
    await fill(tree, 'Password', 'wrong123');
    await act(() => button(tree, 'Log in').props.onPress());
    assert.match(textOf(tree.root), /Wrong password/);
    assert.equal(button(tree, 'Log in').props.loading, false);
    await act(() => button(tree, 'Log in').props.onPress());
    assert.equal(requests.length, 2);
  } finally { await unmount(tree); }
});

const validators = {
  ...loadScreen('src/lib/profiles.ts', { './supabase': { supabase: {} }, './socialAuth': {} }).exports,
  ...loadScreen('src/lib/password.ts').exports,
  ...loadScreen('src/lib/cleanWords.ts').exports,
};

function signupHarness() {
  const requests = [];
  return { requests, screen: loadScreen('src/app/sign-up.tsx', {
    '@/lib/profiles': { ...validators, isUsernameAvailable: async () => true },
    '@/lib/password': validators,
    '@/lib/cleanWords': validators,
    '@/lib/legal': { TERMS_VERSION: 'qa-terms' },
    '@/lib/supabase': { supabase: { auth: { signUp: async input => { requests.push(['email', input]); return { data: { session: null }, error: null }; } } } },
    '@/lib/usernameAuth': { signUpWithUsername: async (...input) => { requests.push(['username', ...input]); } },
  }) };
}

test('signup rejects an empty form without calling authentication', async () => {
  const { screen, requests } = signupHarness();
  const tree = await renderScreen(screen);
  try {
    await act(() => button(tree, "Let's go!").props.onPress());
    assert.equal(requests.length, 0);
    assert.equal(tree.root.findAllByType('TextField').find(node => node.props.label === 'Username').props.error, 'Pick a username.');
    assert.match(textOf(tree.root), /13 or older/);
    assert.match(textOf(tree.root), /agree to the Terms/);
  } finally { await unmount(tree); }
});

test('signup requires both age confirmation and terms before using email authentication', async () => {
  const { screen, requests } = signupHarness();
  const tree = await renderScreen(screen);
  try {
    await fill(tree, 'Your name', 'Alice 👋');
    await fill(tree, 'Username', 'AL ICE!!');
    await fill(tree, 'Email', 'alice@example.test');
    await fill(tree, 'Password', 'Example123');
    await act(() => button(tree, "Let's go!").props.onPress());
    assert.equal(requests.length, 0);
    await act(() => tree.root.findAllByType('Pressable').filter(node => node.props.accessibilityRole === 'checkbox')[0].props.onPress());
    await act(() => button(tree, "Let's go!").props.onPress());
    assert.equal(requests.length, 0);
    await act(() => tree.root.findAllByType('Pressable').filter(node => node.props.accessibilityRole === 'checkbox')[1].props.onPress());
    await act(() => button(tree, "Let's go!").props.onPress());
    assert.equal(requests.length, 1);
    assert.equal(requests[0][1].options.data.username, 'alice');
    assert.equal(requests[0][1].options.data.terms_version, 'qa-terms');
    assert.equal(tree.root.findByType('FormScreen').props.title, 'Check your email 📬');
  } finally { await unmount(tree); }
});

for (const invalid of ['short', '12345678', 'abcdefgh', '😀'.repeat(4)]) test(`signup rejects a password missing its required parts (${JSON.stringify(invalid)})`, async () => {
  const { screen, requests } = signupHarness();
  const tree = await renderScreen(screen);
  try {
    await fill(tree, 'Username', 'alice');
    await fill(tree, 'Email', 'alice@example.test');
    await fill(tree, 'Password', invalid);
    for (const row of tree.root.findAllByType('Pressable').filter(node => node.props.accessibilityRole === 'checkbox')) await act(() => row.props.onPress());
    await act(() => button(tree, "Let's go!").props.onPress());
    assert.equal(requests.length, 0);
  } finally { await unmount(tree); }
});

const birthday = loadScreen('src/components/BirthdayForm.tsx', { '@/lib/birthday': { setBirthday() {} } }).exports.checkBirthday;
const today = new Date(2026, 10, 4);
for (const [label, day, month, year, valid] of [
  ['empty', '', '', '', false], ['zero', '0', '1', '2000', false], ['negative', '-1', '1', '2000', false],
  ['huge', '999999999', '1', '2000', false], ['emoji', '👀', '1', '2000', false],
  ['invalid month', '1', '13', '2000', false], ['invalid day', '31', '4', '2000', false],
  ['non-leap February', '29', '2', '2001', false], ['leap February', '29', '2', '2000', true],
  ['future', '5', '11', '2026', false], ['under 13', '5', '11', '2013', false],
  ['exactly 13', '4', '11', '2013', true], ['over 100', '3', '11', '1926', false], ['exactly 100', '4', '11', '1926', true],
]) test(`birthday validates ${label}`, () => assert.equal(birthday(day, month, year, today) === null, valid));
