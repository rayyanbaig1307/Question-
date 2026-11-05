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

// The word filter on the sign-up and edit-profile screens, with the app's real filter. The owner's choice: a display
// name may swear (like a bio); only the @username can't. Slurs are refused everywhere, however they are written.
const NAME_NOT_ALLOWED = "Let's keep it clean – that word can't be in a username or name.";
const WORD_NOT_ALLOWED = "That word isn't allowed on Peekaboo.";
const SWEARY_NAMES = ['Fuck Off', 'Big Shit', 'ｆｕｃｋ', 'Total Bitch'];
// Numbers for letters, dots, spaces, fancy letters, an invisible character, a Cyrillic look-alike letter, accents.
const DISGUISED_SLURS = ['n1gg3r', 'F.A.G.G.O.T', 'K I K E', 'ｒｅｔａｒｄ', 'ki​ke', 'сhink', 'Wétbáck'];
const SWEARY_USERNAMES = ['f.u.c.k', 'sh1t_head', 'fuckboy'];
const field = (tree, label) => tree.root.findAllByType('TextField').find(node => node.props.label === label);

async function trySignup({ name, username, withEmail = true }) {
  const { screen, requests } = signupHarness();
  const tree = await renderScreen(screen);
  try {
    await fill(tree, 'Your name', name);
    await fill(tree, 'Username', username);
    if (withEmail) await fill(tree, 'Email', 'alice@example.test');
    else await act(() => tree.root.findAllByType('Pressable').find(node => node.props.accessibilityRole === 'radio' && textOf(node).includes('Just a username')).props.onPress());
    await fill(tree, 'Password', 'Example123');
    for (const row of tree.root.findAllByType('Pressable').filter(node => node.props.accessibilityRole === 'checkbox')) await act(() => row.props.onPress());
    await act(() => button(tree, "Let's go!").props.onPress());
    // After an email sign-up the form is replaced by "Check your email", so the fields can be gone.
    return { requests, nameError: field(tree, 'Your name')?.props.error ?? null, usernameError: field(tree, 'Username')?.props.error ?? null };
  } finally { await unmount(tree); }
}

test('signup: a display name with swearing is fine, with email or with just a username', async () => {
  for (const name of SWEARY_NAMES) {
    const email = await trySignup({ name, username: 'alice' });
    assert.deepEqual([name, email.nameError, email.usernameError, email.requests.length], [name, null, null, 1]);
    assert.equal(email.requests[0][1].options.data.display_name, name);
    const usernameOnly = await trySignup({ name, username: 'alice', withEmail: false });
    assert.deepEqual(usernameOnly.requests, [['username', 'alice', 'Example123', name, 'qa-terms']]);
  }
});

test('signup: a slur in the display name is refused under the name, however it is written', async () => {
  for (const name of DISGUISED_SLURS) {
    const result = await trySignup({ name, username: 'alice' });
    assert.deepEqual([name, result.nameError, result.usernameError, result.requests.length], [name, WORD_NOT_ALLOWED, null, 0]);
  }
});

test('signup: swearing in the username is still refused, even with a display name that swears', async () => {
  for (const username of SWEARY_USERNAMES) {
    const result = await trySignup({ name: 'Fuck Off', username });
    assert.deepEqual([username, result.nameError, result.usernameError, result.requests.length], [username, null, NAME_NOT_ALLOWED, 0]);
  }
});

function editProfileHarness() {
  const saved = [];
  const screen = loadScreen('src/app/(app)/edit-profile.tsx', {
    'expo-image-picker': {},
    '@/lib/auth': { useMe: () => ({ userId: 'alice', profile: { id: 'alice', username: 'alice', display_name: 'Alice', bio: '', is_private: false, avatar_path: null }, setProfile() {} }) },
    '@/lib/media': { deleteAvatar: async () => {}, resizePhoto: async uri => uri, uploadAvatar: async () => 'alice/avatar.jpg' },
    '@/lib/profiles': { ...validators, isUsernameAvailable: async () => true, updateMyProfile: async (_id, fields) => { saved.push(fields); return { id: 'alice', ...fields }; } },
    '@/lib/cleanWords': validators,
  });
  return { screen, saved };
}
async function tryEditProfile(changes) {
  const { screen, saved } = editProfileHarness();
  const tree = await renderScreen(screen);
  try {
    for (const [label, value] of Object.entries(changes)) await fill(tree, label, value);
    await act(() => button(tree, 'Save').props.onPress());
    return { saved, alerts: screen.calls.alerts };
  } finally { await unmount(tree); }
}

test('edit profile: a display name with swearing saves', async () => {
  for (const name of SWEARY_NAMES) {
    const { saved, alerts } = await tryEditProfile({ Name: name });
    assert.deepEqual(alerts, [], name);
    assert.equal(saved.length, 1, name);
    assert.equal(saved[0].display_name, name);
    assert.equal(saved[0].username, 'alice');
  }
});

test('edit profile: a slur in the display name or bio, or swearing in the username, is refused and nothing is saved', async () => {
  const cases = [
    ...DISGUISED_SLURS.map(value => [{ Name: value }, WORD_NOT_ALLOWED]),
    ...DISGUISED_SLURS.map(value => [{ Name: 'Fuck Off', Bio: value }, WORD_NOT_ALLOWED]),
    ...SWEARY_USERNAMES.map(value => [{ Name: 'Fuck Off', Username: value }, NAME_NOT_ALLOWED]),
  ];
  for (const [changes, message] of cases) {
    const { saved, alerts } = await tryEditProfile(changes);
    assert.deepEqual(alerts, [['Pick something else', message]], JSON.stringify(changes));
    assert.equal(saved.length, 0, JSON.stringify(changes));
  }
});

// Only the app checks this, not the database: a slur split across the @username and the name is refused too.
test('signup and edit profile: a slur split across the username and the name is refused', async () => {
  for (const [username, name] of [['the_nig', 'Ger Bob'], ['ret', 'Ard'], ['tow', 'Elhead'], ['n_i_g', 'G E R']]) {
    const result = await trySignup({ name, username });
    assert.deepEqual([username, name, result.nameError, result.usernameError, result.requests.length], [username, name, null, WORD_NOT_ALLOWED, 0]);
    const { saved, alerts } = await tryEditProfile({ Username: username, Name: name });
    assert.deepEqual(alerts, [['Pick something else', WORD_NOT_ALLOWED]], `${username} + ${name}`);
    assert.equal(saved.length, 0, `${username} + ${name}`);
  }
  // The name is still checked on its own too: joined to "al_x", the spaced-out slur "K I K E" would slip through.
  const spaced = await trySignup({ name: 'K I K E', username: 'al_x' });
  assert.deepEqual([spaced.nameError, spaced.usernameError, spaced.requests.length], [WORD_NOT_ALLOWED, null, 0]);
  const edited = await tryEditProfile({ Username: 'al_x', Name: 'K I K E' });
  assert.deepEqual([edited.alerts, edited.saved.length], [[['Pick something else', WORD_NOT_ALLOWED]], 0]);
  // Swearing split across them is fine: the name may swear anyway.
  const signup = await trySignup({ name: 'Ck Off', username: 'big_fu' });
  assert.deepEqual([signup.nameError, signup.usernameError, signup.requests.length], [null, null, 1]);
  const { saved, alerts } = await tryEditProfile({ Username: 'big_fu', Name: 'Ck Off' });
  assert.deepEqual([alerts, saved.length], [[], 1]);
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
