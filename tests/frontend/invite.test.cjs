const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScreen } = require('./harness.cjs');

const APP_STORE = 'https://apps.apple.com/app/id6829561855';
const ALICE_MESSAGE = `Add me on Peekaboo 👀 My username is @alice\n${APP_STORE}`;
const inviteCode = loadScreen('src/lib/inviteCode.ts').exports;

// Loads lib/invite.ts as if it ran on a phone (`os`) with an update channel (`channel`, null = Expo Go).
// `session` is who is logged in (null = nobody); `rpc(name, args, state)` answers the database calls.
// Timers are only recorded: a test runs the 3-second one by hand to make "the server is slow" happen.
function loadInvite({ os, channel, session = null, rpc, stored = [] } = {}) {
  const state = { shared: [], rpcCalls: [], session, signOutSteps: [], store: new Map(stored) };
  const screen = loadScreen('src/lib/invite.ts', {
    'expo-updates': { channel },
    'react-native': { Platform: { OS: os }, Share: { share: async content => { state.shared.push(content); } } },
    '@react-native-async-storage/async-storage': {
      __esModule: true,
      default: {
        getItem: async key => state.store.get(key) ?? null,
        setItem: async (key, value) => { state.store.set(key, value); },
        removeItem: async key => { state.store.delete(key); },
      },
    },
    './auth': { runAfterSignOut: step => { state.signOutSteps.push(step); return () => {}; } },
    './inviteCode': inviteCode,
    './supabase': {
      supabase: {
        rpc: async (name, args) => {
          state.rpcCalls.push([name, args]);
          return rpc ? rpc(name, args, state) : { data: null, error: { message: 'Could not find the function public.my_invite_code' } };
        },
        auth: { getSession: async () => ({ data: { session: state.session ? { user: { id: state.session } } : null }, error: null }) },
      },
    },
  });
  return { invite: screen.exports, state, calls: screen.calls, screen };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
// Moves the loaded file's clock (Date.now) to `ms` – the file has its own Date, so the test's clock is untouched.
const setClock = (screen, ms) => { screen.getBinding('Date').now = () => ms; };
const MINUTE = 60 * 1000;

// Every invite is just your username and the App Store link (owner, 22 Nov). The link is the last line, alone.
test('every phone and every channel sends the same invite: your username, then the App Store link last', async () => {
  for (const os of ['ios', 'android']) {
    for (const channel of ['production', 'testing', 'preview', null]) {
      const { invite, state } = loadInvite({ os, channel, session: 'alice', rpc: () => ({ data: 'BCDFGHJKLM', error: null }) });
      await invite.inviteFriends('alice');
      assert.equal(state.shared.length, 1);
      const { message } = state.shared[0];
      assert.equal(message, ALICE_MESSAGE, `${os} ${channel}`);
      assert.equal(message.split('\n').at(-1), APP_STORE, 'the App Store link is the last line, with nothing after it');
      assert.doesNotMatch(message, /testflight|\.apk|expo\.dev|pages\.dev|invite\?c=|Android|iPhone:/i);
      assert.equal(state.shared[0].url, undefined, 'only a message, so every app (Messages, WhatsApp, Instagram) keeps the link');
      assert.deepEqual(state.rpcCalls, [], 'nothing to load: the share sheet opens straight away');
    }
  }
});

test('the invite works without a username, and an @ or spaces in the username are tidied', async () => {
  const { invite } = loadInvite({ os: 'ios', channel: 'production' });
  assert.equal(invite.inviteMessage(null), `Come hang out with me on Peekaboo 👀\n${APP_STORE}`);
  assert.equal(invite.inviteMessage(''), `Come hang out with me on Peekaboo 👀\n${APP_STORE}`);
  assert.equal(invite.inviteMessage('  @alice '), ALICE_MESSAGE);
  assert.equal(invite.withAppLink('Hello  \n'), `Hello\n${APP_STORE}`);
  assert.equal(invite.TESTFLIGHT_LINK, undefined, 'the TestFlight link is gone from the app');
  assert.equal(invite.IPHONE_LINK, undefined);
});

test('a second tap while the share sheet is open does nothing', async () => {
  let close;
  const shared = [];
  // The share sheet stays open until `close` is called.
  const loaded = loadScreen('src/lib/invite.ts', {
    'react-native': { Platform: { OS: 'ios' }, Share: { share: content => { shared.push(content); return new Promise(resolve => { close = resolve; }); } } },
    '@react-native-async-storage/async-storage': { __esModule: true, default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } },
    './auth': { runAfterSignOut: () => () => {} },
    './inviteCode': inviteCode,
    './supabase': { supabase: { rpc: async () => ({ data: null, error: null }), auth: { getSession: async () => ({ data: { session: null } }) } } },
  }).exports;
  const first = loaded.inviteFriends('alice');
  await loaded.inviteFriends('alice');
  assert.equal(shared.length, 1);
  close();
  await first;
  const third = loaded.inviteFriends('alice');
  assert.equal(shared.length, 2, 'once it is closed, the button works again');
  close();
  await third;
});

test('a share sheet that fails to open never throws', async () => {
  const loaded = loadScreen('src/lib/invite.ts', {
    'react-native': { Platform: { OS: 'ios' }, Share: { share: async () => { throw new Error('no share sheet'); } } },
    '@react-native-async-storage/async-storage': { __esModule: true, default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } },
    './auth': { runAfterSignOut: () => () => {} },
    './inviteCode': inviteCode,
    './supabase': { supabase: { rpc: async () => ({ data: null, error: null }), auth: { getSession: async () => ({ data: { session: null } }) } } },
  });
  await loaded.exports.inviteFriends('alice');
  await loaded.exports.inviteFriends('alice');
});

test('logging out forgets your code and any invite waiting on this phone', async () => {
  const saved = JSON.stringify({ code: 'NPQRSTVWXZ', savedAt: Date.now() });
  const { invite, state } = loadInvite({
    os: 'ios', channel: 'production', session: 'alice',
    rpc: () => ({ data: 'BCDFGHJKLM', error: null }),
    stored: [['peekaboo-pending-invite', saved]],
  });
  await invite.fetchMyInviteCode('alice');
  assert.equal(state.signOutSteps.length, 1, 'it tidies up after logging out');
  state.signOutSteps[0]('alice');
  await flush();
  assert.equal(state.store.has('peekaboo-pending-invite'), false);
  await invite.fetchMyInviteCode('alice');
  assert.equal(state.rpcCalls.length, 2, 'the code is loaded again after logging back in');
});

test('"Get a new link" replaces the remembered code, and a late answer with the old code cannot bring it back', async () => {
  let oldAnswer;
  const { invite, state } = loadInvite({
    os: 'ios', channel: 'production', session: 'alice',
    rpc: name => (name === 'reset_invite_code' ? { data: 'NPQRSTVWXZ', error: null } : new Promise(resolve => { oldAnswer = resolve; })),
  });
  const loading = invite.fetchMyInviteCode('alice');
  await flush();
  assert.equal(await invite.resetInviteCode('alice'), 'NPQRSTVWXZ');
  oldAnswer({ data: 'BCDFGHJKLM', error: null });
  await loading;
  assert.equal(await invite.fetchMyInviteCode('alice'), 'NPQRSTVWXZ');
  assert.deepEqual(state.rpcCalls.map(([name]) => name), ['my_invite_code', 'reset_invite_code']);
});

test('preview and accept call the database with the agreed names', async () => {
  const answers = {
    invite_preview: { data: [{ id: 'bob', username: 'bob', display_name: 'Bob', avatar_path: null }], error: null },
    accept_invite: { data: 'friends', error: null },
  };
  const { invite, state } = loadInvite({ os: 'ios', channel: 'production', session: 'alice', rpc: name => answers[name] });
  assert.equal(await invite.previewInvite('BCDFGHJKLM'), answers.invite_preview.data[0]);
  assert.equal(await invite.acceptInvite('BCDFGHJKLM', 'alice'), 'friends');
  // (The arguments are made inside the loaded file, so compare them as plain JSON.)
  assert.deepEqual(JSON.parse(JSON.stringify(state.rpcCalls)), [
    ['invite_preview', { invite_code: 'BCDFGHJKLM' }],
    ['accept_invite', { invite_code: 'BCDFGHJKLM', expected_user_id: 'alice' }],
  ]);
  // No rows = the invite doesn't work.
  answers.invite_preview = { data: [], error: null };
  assert.equal(await invite.previewInvite('BCDFGHJKLM'), null);
  // Every answer the app knows, and anything else counts as a request (never "friends").
  for (const result of ['friends', 'requested', 'already', 'self', 'busy']) {
    answers.accept_invite = { data: result, error: null };
    assert.equal(await invite.acceptInvite('BCDFGHJKLM', 'alice'), result);
  }
  answers.accept_invite = { data: 'accepted', error: null };
  assert.equal(await invite.acceptInvite('BCDFGHJKLM', 'alice'), 'requested');
  answers.accept_invite = { data: null, error: { message: "This invite link doesn't work any more" } };
  await assert.rejects(invite.acceptInvite('BCDFGHJKLM', 'alice'), error => invite.isInviteGone(error));
});

test('isAdultBirthday matches the server: 18 or over on the UTC date, no birthday = not an adult', () => {
  const { invite } = loadInvite({ os: 'ios', channel: 'production' });
  const now = new Date('2026-11-09T12:00:00Z');
  assert.equal(invite.isAdultBirthday('2008-11-09', now), true);
  assert.equal(invite.isAdultBirthday('2008-11-10', now), false);
  assert.equal(invite.isAdultBirthday('1990-01-01', now), true);
  assert.equal(invite.isAdultBirthday(null, now), false);
  assert.equal(invite.isAdultBirthday('not a date', now), false);
});

test('a saved invite is read back for 7 days, and only the matching code is forgotten', async () => {
  const now = Date.now();
  const save = (code, savedAt) => [['peekaboo-pending-invite', JSON.stringify({ code, savedAt })]];
  let loaded = loadInvite({ os: 'ios', channel: 'production', stored: save('BCDFGHJKLM', now - 60_000) });
  assert.equal(await loaded.invite.readPendingInvite(now), 'BCDFGHJKLM');
  await loaded.invite.clearPendingInvite('NPQRSTVWXZ');
  assert.equal(loaded.state.store.has('peekaboo-pending-invite'), true, 'a different invite stays');
  await loaded.invite.clearPendingInvite('BCDFGHJKLM');
  assert.equal(loaded.state.store.has('peekaboo-pending-invite'), false);

  loaded = loadInvite({ os: 'ios', channel: 'production', stored: save('BCDFGHJKLM', now - 8 * 24 * 60 * 60 * 1000) });
  assert.equal(await loaded.invite.readPendingInvite(now), null, 'older than 7 days');
  assert.equal(loaded.state.store.has('peekaboo-pending-invite'), false, 'an old one is tidied away');
});

test('"busy" (the link was used a lot today) comes back as busy – never as friends or a request', async () => {
  const { invite } = loadInvite({ os: 'ios', channel: 'production', session: 'alice', rpc: () => ({ data: 'busy', error: null }) });
  assert.equal(await invite.acceptInvite('BCDFGHJKLM', 'alice'), 'busy');
  // Other words the app doesn't know still count as a request.
  const other = loadInvite({ os: 'ios', channel: 'production', session: 'alice', rpc: () => ({ data: 'something new', error: null }) });
  assert.equal(await other.invite.acceptInvite('BCDFGHJKLM', 'alice'), 'requested');
});

test('a new link made on another phone: asking fresh shows it', async () => {
  // The server's code for Alice. "Get a new link" on her tablet changes it.
  const server = { code: 'BCDFGHJKLM' };
  const { invite, state } = loadInvite({
    os: 'ios', channel: 'production', session: 'alice',
    rpc: name => (name === 'my_invite_code' ? { data: server.code, error: null } : { data: null, error: { message: 'unexpected' } }),
  });
  invite.prefetchInviteCode('alice');
  await flush();
  assert.equal(await invite.fetchMyInviteCode('alice'), 'BCDFGHJKLM');
  server.code = 'NPQRSTVWXZ';
  // "Your invite link" asks the server again (fresh), even though a code is remembered.
  assert.equal(await invite.fetchMyInviteCode('alice', { fresh: true }), 'NPQRSTVWXZ');
  assert.equal(invite.rememberedInviteCode('alice'), 'NPQRSTVWXZ');
  assert.equal(state.rpcCalls.length, 2);
});

test('a remembered code is only used for 10 minutes, so a new link made on another phone is picked up', async () => {
  const server = { code: 'BCDFGHJKLM' };
  const { invite, state, screen } = loadInvite({
    os: 'ios', channel: 'production', session: 'alice',
    rpc: () => ({ data: server.code, error: null }),
  });
  const start = Date.now();
  setClock(screen, start);
  invite.prefetchInviteCode('alice');
  await flush();
  server.code = 'NPQRSTVWXZ';
  // 9 minutes later: the remembered code is still used (no extra question to the server).
  setClock(screen, start + 9 * MINUTE);
  invite.prefetchInviteCode('alice');
  await flush();
  assert.equal(state.rpcCalls.length, 1);
  assert.equal(invite.rememberedInviteCode('alice'), 'BCDFGHJKLM');
  // 11 minutes later: Home loads it again.
  setClock(screen, start + 11 * MINUTE);
  assert.equal(invite.rememberedInviteCode('alice'), null, 'too old to use');
  invite.prefetchInviteCode('alice');
  await flush();
  assert.equal(state.rpcCalls.length, 2);
  assert.equal(invite.rememberedInviteCode('alice'), 'NPQRSTVWXZ');
  // A clock that jumped back doesn't keep an old code either.
  setClock(screen, start);
  assert.equal(invite.rememberedInviteCode('alice'), null);
  // Never another account's code.
  setClock(screen, start + 11 * MINUTE);
  assert.equal(invite.rememberedInviteCode('bob'), null);
});

test('asking fresh: a late answer can never undo "Get a new link", or replace a newer answer', async () => {
  // 1. A fresh question is still on its way when you get a new link: the old code must not come back.
  let lateAnswer;
  let loaded = loadInvite({
    os: 'ios', channel: 'production', session: 'alice',
    rpc: name => (name === 'reset_invite_code' ? { data: 'NPQRSTVWXZ', error: null } : new Promise(resolve => { lateAnswer = resolve; })),
  });
  const asking = loaded.invite.fetchMyInviteCode('alice', { fresh: true });
  await flush();
  assert.equal(await loaded.invite.resetInviteCode('alice'), 'NPQRSTVWXZ');
  lateAnswer({ data: 'BCDFGHJKLM', error: null });
  await asking;
  assert.equal(loaded.invite.rememberedInviteCode('alice'), 'NPQRSTVWXZ');
  assert.equal(await loaded.invite.fetchMyInviteCode('alice'), 'NPQRSTVWXZ');

  // 2. An older question (Home loading it early) answers after a fresh one: the fresh answer stays.
  const answers = [];
  loaded = loadInvite({
    os: 'ios', channel: 'production', session: 'alice',
    rpc: () => new Promise(resolve => { answers.push(resolve); }),
  });
  loaded.invite.prefetchInviteCode('alice');
  await flush();
  const fresh = loaded.invite.fetchMyInviteCode('alice', { fresh: true });
  await flush();
  assert.equal(answers.length, 2, 'fresh asks the server itself, even while another question is on its way');
  answers[1]({ data: 'NPQRSTVWXZ', error: null });
  assert.equal(await fresh, 'NPQRSTVWXZ');
  answers[0]({ data: 'BCDFGHJKLM', error: null });
  await flush();
  assert.equal(loaded.invite.rememberedInviteCode('alice'), 'NPQRSTVWXZ');
});
