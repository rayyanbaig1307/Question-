const test = require('node:test');
const assert = require('node:assert/strict');
const { React, loadScreen, renderScreen, act, textOf, button, unmount, host } = require('./harness.cjs');

// Personal invite links in the app: "Your invite link" (/invite), opening someone's invite (/invite/<code>),
// the invite saved before logging in (PendingInvite), the start-up link handler (+native-intent) and the
// friendly "page doesn't exist" screen (+not-found).

const inviteCode = loadScreen('src/lib/inviteCode.ts').exports;
// The real helpers that don't talk to anything (birthday rule, error check).
const realInvite = loadScreen('src/lib/invite.ts', {
  'expo-updates': { channel: 'production' },
  '@react-native-async-storage/async-storage': { __esModule: true, default: {} },
  './auth': { runAfterSignOut: () => () => {} },
  './inviteCode': inviteCode,
  './supabase': { supabase: {} },
}).exports;
// The real lib/invite.ts with a stand-in phone storage (`store`) and server (`rpc`).
function realInviteWithStore({ rpc = () => ({ data: null, error: { message: 'unexpected' } }), session = 'alice' } = {}) {
  const store = new Map();
  const shared = [];
  const rpcCalls = [];
  const invite = loadScreen('src/lib/invite.ts', {
    'expo-updates': { channel: 'production' },
    'react-native': { Platform: { OS: 'ios' }, Share: { share: async content => { shared.push(content); } } },
    '@react-native-async-storage/async-storage': {
      __esModule: true,
      default: {
        getItem: async key => store.get(key) ?? null,
        setItem: async (key, value) => { store.set(key, value); },
        removeItem: async key => { store.delete(key); },
      },
    },
    './auth': { runAfterSignOut: () => () => {} },
    './inviteCode': inviteCode,
    './supabase': {
      supabase: {
        rpc: async (name, args) => { rpcCalls.push(name); return rpc(name, args); },
        auth: { getSession: async () => ({ data: { session: { user: { id: session } } }, error: null }) },
      },
    },
  }).exports;
  return { invite, store, shared, rpcCalls };
}
const BOB = { id: 'bob', username: 'bob', display_name: 'Bob', avatar_path: 'bob/face.jpg' };
const GONE = "This invite link doesn't work any more";
const flush = () => new Promise(resolve => setImmediate(resolve));
const allText = tree => tree.root.findAllByType('Text').map(textOf).join('\n');

function routerMock(calls, { canGoBack = true } = {}) {
  return Object.assign(
    Object.fromEntries(['back', 'push', 'replace', 'dismissTo'].map(name => [name, (...args) => calls.routes.push([name, ...args])])),
    { canGoBack: () => canGoBack },
  );
}

// ---------------------------------------------------------------------------
// /invite/<code>: someone's invite
// ---------------------------------------------------------------------------

function openInvite({ code = 'BCDFGHJKLM', preview = async () => BOB, accept = async () => 'friends', canGoBack = true, clearPendingInvite = async () => {} } = {}) {
  const state = { previews: [], accepts: [], cleared: [], options: [], toasts: [], reports: [], blocks: [] };
  const calls = { routes: [] };
  const screen = loadScreen('src/app/(app)/invite/[code].tsx', {
    'expo-router': { router: routerMock(calls, { canGoBack }), useLocalSearchParams: () => ({ code }) },
    '@/components/Overlays': { useOverlays: () => ({ showToast: message => state.toasts.push(message), showOptions: menu => state.options.push(menu) }) },
    '@/components/ScreenHeader': { ScreenHeader: host('ScreenHeader'), RoundIconButton: host('RoundIconButton') },
    '@/lib/invite': {
      INVITE_GONE: GONE,
      isInviteGone: realInvite.isInviteGone,
      isInviteBusy: realInvite.isInviteBusy,
      normalizeInviteCode: inviteCode.normalizeInviteCode,
      previewInvite: async (...args) => { state.previews.push(args); return preview(...args); },
      acceptInvite: async (...args) => { state.accepts.push(args); return accept(...args); },
      clearPendingInvite: async (...args) => { state.cleared.push(args); return clearPendingInvite(...args); },
    },
    '@/lib/useSafetyActions': {
      useSafetyActions: () => ({
        report: params => state.reports.push(params),
        confirmBlock: (user, onBlocked) => state.blocks.push([user, onBlocked]),
      }),
    },
  });
  return { screen, state, calls };
}

test('an invite shows who it is from and waits for your tap – nothing is added by itself', async () => {
  const { screen, state } = openInvite({ code: 'bcdfg-hjklm' });
  const tree = await renderScreen(screen);
  try {
    assert.deepEqual(state.previews, [['BCDFGHJKLM']], 'the code is cleaned up before asking the server');
    const text = allText(tree);
    assert.match(text, /Bob/);
    assert.match(text, /@bob/);
    assert.match(text, /Only add people you know in real life\./);
    assert.equal(tree.root.findByType('Avatar').props.path, 'bob/face.jpg');
    assert.ok(button(tree, 'Add Bob'));
    assert.ok(button(tree, 'Not now'));
    assert.equal(state.accepts.length, 0, 'never accepted without a tap');
    assert.deepEqual(state.cleared, [['BCDFGHJKLM']], 'the saved copy is forgotten as soon as the invite opens');
  } finally { await unmount(tree); }
});

test('tapping Add shows the right message for every result and goes back', async () => {
  const expected = {
    friends: 'You and @bob are friends! 🎉',
    requested: 'Friend request sent 💌',
    already: "You're already friends 🙌",
    self: "That's your own invite 😄",
    // The link was used a lot today: nothing was added (the server's own words).
    busy: 'This invite link is busy – try again tomorrow',
  };
  for (const [result, message] of Object.entries(expected)) {
    const { screen, state, calls } = openInvite({ accept: async () => result });
    const tree = await renderScreen(screen);
    try {
      await act(() => button(tree, 'Add Bob').props.onPress());
      assert.deepEqual(state.accepts, [['BCDFGHJKLM', 'alice']], 'it says who is logged in (expected_user_id)');
      assert.deepEqual(state.toasts, [message]);
      assert.deepEqual(calls.routes, [['back']]);
      // Forgotten when it opened, and again after Add (the same link may have been tapped again meanwhile).
      assert.deepEqual(state.cleared, [['BCDFGHJKLM'], ['BCDFGHJKLM']], 'the saved invite is forgotten');
    } finally { await unmount(tree); }
  }
});

test('opened straight from a link (nothing to go back to), leaving goes to Home', async () => {
  const { screen, calls } = openInvite({ canGoBack: false });
  const tree = await renderScreen(screen);
  try {
    await act(() => button(tree, 'Add Bob').props.onPress());
    assert.deepEqual(calls.routes, [['replace', '/']]);
  } finally { await unmount(tree); }
});

test('Not now forgets the saved invite and leaves without adding anyone', async () => {
  const { screen, state, calls } = openInvite();
  const tree = await renderScreen(screen);
  try {
    await act(() => button(tree, 'Not now').props.onPress());
    assert.equal(state.accepts.length, 0);
    assert.deepEqual(state.cleared, [['BCDFGHJKLM'], ['BCDFGHJKLM']]);
    assert.deepEqual(calls.routes, [['back']]);
  } finally { await unmount(tree); }
});

test('an invite that does not work says so (no rows, or the server says so) – the same words every time', async () => {
  for (const preview of [async () => null, async () => { throw new Error(GONE); }, async () => { throw { message: GONE, code: 'P0001' }; }]) {
    const { screen, state } = openInvite({ preview });
    const tree = await renderScreen(screen);
    try {
      assert.equal(tree.root.findByType('EmptyState').props.title, GONE);
      assert.equal(button(tree, /^Add/), undefined);
      assert.deepEqual(state.cleared, [['BCDFGHJKLM'], ['BCDFGHJKLM']]);
    } finally { await unmount(tree); }
  }
});

test('a link with a broken code says it does not work without asking the server', async () => {
  const { screen, state } = openInvite({ code: 'hello' });
  const tree = await renderScreen(screen);
  try {
    assert.equal(tree.root.findByType('EmptyState').props.title, GONE);
    assert.equal(state.previews.length, 0);
  } finally { await unmount(tree); }
});

test('your own invite says so and offers no Add button', async () => {
  const { screen, state } = openInvite({ preview: async () => ({ ...BOB, id: 'alice', username: 'alice' }) });
  const tree = await renderScreen(screen);
  try {
    assert.equal(tree.root.findByType('EmptyState').props.title, "That's your own invite 😄");
    assert.equal(button(tree, /^Add/), undefined);
    assert.deepEqual(state.cleared, [['BCDFGHJKLM'], ['BCDFGHJKLM']]);
  } finally { await unmount(tree); }
});

test('any other loading problem offers Try again', async () => {
  let fail = true;
  const { screen, state } = openInvite({ preview: async () => { if (fail) throw new Error('Network request failed'); return BOB; } });
  const tree = await renderScreen(screen);
  try {
    assert.equal(tree.root.findByType('EmptyState').props.title, "Couldn't load the invite – check your internet and try again");
    assert.notEqual(tree.root.findByType('EmptyState').props.title, GONE);
    fail = false;
    await act(() => button(tree, 'Try again').props.onPress());
    assert.ok(button(tree, 'Add Bob'));
    assert.equal(state.previews.length, 2);
  } finally { await unmount(tree); }
  // Forgotten when it opened; leaving after it loaded = you saw it: forgotten again.
  assert.deepEqual(state.cleared, [['BCDFGHJKLM'], ['BCDFGHJKLM']]);
});

test('the saved invite is forgotten as soon as the invite screen opens – even if it then fails to load', async () => {
  const { screen, state } = openInvite({ preview: async () => { throw new Error('Network request failed'); } });
  const tree = await renderScreen(screen);
  assert.deepEqual(state.cleared, [['BCDFGHJKLM']]);
  await unmount(tree);
  assert.deepEqual(state.cleared, [['BCDFGHJKLM']]);
});

test('opening an invite clears the matching saved code on the phone, and never a different one', async () => {
  const lib = realInviteWithStore();
  for (const [saved, opened, kept] of [['BCDFGHJKLM', 'bcdfg-hjklm', false], ['NPQRSTVWXZ', 'BCDFGHJKLM', true]]) {
    lib.store.set('peekaboo-pending-invite', JSON.stringify({ code: saved, savedAt: Date.now() - 60_000 }));
    // Loading never finishes here: the saved copy is forgotten anyway, straight away.
    const { screen } = openInvite({ code: opened, preview: () => new Promise(() => {}), clearPendingInvite: lib.invite.clearPendingInvite });
    const tree = await renderScreen(screen);
    try {
      await act(flush);
      assert.equal(lib.store.has('peekaboo-pending-invite'), kept, `saved ${saved}, opened ${opened}`);
    } finally { await unmount(tree); }
  }
});

test('Add errors: a dead link turns into the "doesn\'t work" message; the server\'s other words are shown as they are', async () => {
  let fixture = openInvite({ accept: async () => { throw new Error(GONE); } });
  let tree = await renderScreen(fixture.screen);
  try {
    await act(() => button(tree, 'Add Bob').props.onPress());
    assert.equal(tree.root.findByType('EmptyState').props.title, GONE);
    assert.deepEqual(fixture.calls.routes, []);
  } finally { await unmount(tree); }

  for (const message of ["You've used a lot of invites today – try again tomorrow", 'Your login has changed - please try again']) {
    fixture = openInvite({ accept: async () => { throw new Error(message); } });
    tree = await renderScreen(fixture.screen);
    try {
      await act(() => button(tree, 'Add Bob').props.onPress());
      assert.deepEqual(fixture.screen.calls.alerts.at(-1).slice(0, 2), ['Oops', message]);
      assert.ok(button(tree, 'Add Bob'), 'still on the invite');
      assert.deepEqual(fixture.state.toasts, []);
    } finally { await unmount(tree); }
  }
});

test('a "busy" error looks exactly like a "busy" answer: the same toast, the saved invite cleared, and back out', async () => {
  const outcome = async accept => {
    const fixture = openInvite({ accept });
    const tree = await renderScreen(fixture.screen);
    try {
      await act(() => button(tree, 'Add Bob').props.onPress());
      return { toasts: fixture.state.toasts, cleared: fixture.state.cleared.length > 0, routes: fixture.calls.routes, alerts: fixture.screen.calls.alerts.length };
    } finally { await unmount(tree); }
  };
  const answer = await outcome(async () => 'busy');
  const thrown = await outcome(async () => { throw new Error('This invite link is busy – try again tomorrow'); });
  assert.deepEqual(answer.toasts, ['This invite link is busy – try again tomorrow']);
  assert.deepEqual(thrown, answer);
  assert.equal(thrown.alerts, 0, 'no "Oops" alert');
});

test('a second tap on Add while it is working does nothing', async () => {
  let finish;
  const { screen, state } = openInvite({ accept: () => new Promise(resolve => { finish = resolve; }) });
  const tree = await renderScreen(screen);
  try {
    const add = button(tree, 'Add Bob').props.onPress;
    await act(async () => { add(); await flush(); });
    await act(async () => { button(tree, 'Add Bob').props.onPress(); await flush(); });
    assert.equal(state.accepts.length, 1);
    await act(async () => { finish('friends'); await flush(); });
  } finally { await unmount(tree); }
});

test('the ⋯ menu reports or blocks the person, and a block ends the invite', async () => {
  const { screen, state, calls } = openInvite();
  const tree = await renderScreen(screen);
  try {
    const more = tree.root.findByType('ScreenHeader').props.right;
    assert.equal(more.props.label, 'More');
    await act(() => more.props.onPress());
    const menu = state.options[0];
    assert.deepEqual([...menu.options.map(option => option.label)], ['Report profile', 'Block']);
    await act(() => menu.options[0].onPress());
    assert.equal(state.reports[0].user, BOB);
    assert.equal(state.reports[0].contentType, 'user');
    assert.equal(state.reports[0].contentId, 'bob');
    await act(() => menu.options[1].onPress());
    assert.equal(state.blocks[0][0], BOB);
    await act(() => state.blocks[0][1]());
    assert.deepEqual(state.cleared, [['BCDFGHJKLM'], ['BCDFGHJKLM']]);
    assert.deepEqual(calls.routes, [['back']]);
    assert.equal(state.accepts.length, 0);
  } finally { await unmount(tree); }
});

// ---------------------------------------------------------------------------
// /invite: your invite link
// ---------------------------------------------------------------------------

function yourLink({ profile = { id: 'alice', username: 'alice', display_name: 'Alice', is_private: false }, birthday = async () => '1990-05-01', code = async () => 'BCDFGHJKLM', reset = async () => 'NPQRSTVWXZ', canGoBack = true, remembered = () => null, lib = null } = {}) {
  const state = { shares: [], resets: [], toasts: [], loads: 0 };
  const calls = { routes: [] };
  const screen = loadScreen('src/app/(app)/invite/index.tsx', {
    'expo-router': { router: routerMock(calls, { canGoBack }) },
    '@/components/Overlays': { useOverlays: () => ({ showToast: message => state.toasts.push(message), showOptions() {} }) },
    '@/lib/auth': { useMe: () => ({ userId: 'alice', profile }) },
    '@/lib/birthday': { fetchMyBirthday: birthday },
    // `lib`: the real lib/invite.ts (realInviteWithStore). Otherwise stand-ins.
    '@/lib/invite': lib ?? {
      fetchMyInviteCode: async (me, options) => {
        state.loads++;
        assert.equal(me, 'alice');
        assert.equal(options?.fresh, true, 'this screen always asks the server');
        return code();
      },
      rememberedInviteCode: me => (me === 'alice' ? remembered() : null),
      formatInviteCode: inviteCode.formatInviteCode,
      inviteLink: inviteCode.inviteLink,
      isAdultBirthday: realInvite.isAdultBirthday,
      normalizeInviteCode: inviteCode.normalizeInviteCode,
      resetInviteCode: async me => { state.resets.push(me); return reset(); },
      shareInviteLink: async value => { state.shares.push(value); },
    },
  });
  return { screen, state, calls };
}

test('"Your invite link" shows your link and code, and Share my link shares it', async () => {
  const { screen, state } = yourLink();
  const tree = await renderScreen(screen);
  try {
    const text = allText(tree);
    assert.match(text, /https:\/\/peekaboo-4gz\.pages\.dev\/invite\?c=BCDFGHJKLM/);
    assert.match(text, /BCDFG-HJKLM/);
    await act(() => button(tree, 'Share my link').props.onPress());
    assert.deepEqual(state.shares, ['BCDFGHJKLM']);
  } finally { await unmount(tree); }
});

test('the plain line about who can use your link follows your own privacy and birthday', async () => {
  const OPEN = 'Anyone with this link can add you as a friend – only share it with people you know.';
  const REQUEST = 'People who use your link send you a friend request.';
  const cases = [
    [{ is_private: false }, async () => '1990-05-01', OPEN],
    [{ is_private: true }, async () => '1990-05-01', REQUEST],
    [{ is_private: false }, async () => `${new Date().getUTCFullYear() - 15}-01-01`, REQUEST],
    [{ is_private: false }, async () => null, REQUEST],
  ];
  for (const [privacy, birthday, line] of cases) {
    const { screen } = yourLink({ profile: { id: 'alice', username: 'alice', display_name: 'Alice', ...privacy }, birthday });
    const tree = await renderScreen(screen);
    try {
      const text = allText(tree);
      assert.ok(text.includes(line), `${JSON.stringify(privacy)} → ${line}`);
      assert.ok(!text.includes(line === OPEN ? REQUEST : OPEN));
    } finally { await unmount(tree); }
  }
  // Birthday couldn't be loaded: say nothing rather than guess.
  const { screen } = yourLink({ birthday: async () => { throw new Error('offline'); } });
  const tree = await renderScreen(screen);
  try {
    const text = allText(tree);
    assert.ok(!text.includes(OPEN) && !text.includes(REQUEST));
  } finally { await unmount(tree); }
});

test('Get a new link asks first, then shows the new link', async () => {
  const { screen, state } = yourLink();
  const tree = await renderScreen(screen);
  try {
    await act(() => button(tree, 'Get a new link').props.onPress());
    assert.equal(state.resets.length, 0, 'nothing changes before you confirm');
    const [title, , choices] = screen.calls.alerts[0];
    assert.equal(title, 'Get a new link?');
    assert.deepEqual([...choices.map(choice => choice.text)], ['Cancel', 'Get a new link']);
    await act(() => choices[1].onPress());
    assert.deepEqual(state.resets, ['alice']);
    assert.match(allText(tree), /invite\?c=NPQRSTVWXZ/);
    assert.equal(state.toasts.length, 1);
  } finally { await unmount(tree); }
});

test('a failed "Get a new link" keeps the old link and explains', async () => {
  const { screen } = yourLink({ reset: async () => { throw new Error('Network request failed'); } });
  const tree = await renderScreen(screen);
  try {
    await act(() => button(tree, 'Get a new link').props.onPress());
    await act(() => screen.calls.alerts[0][2][1].onPress());
    assert.equal(screen.calls.alerts[1][0], 'Could not get a new link');
    assert.match(allText(tree), /invite\?c=BCDFGHJKLM/);
  } finally { await unmount(tree); }
});

test('a code from a friend opens their invite; a wrong one is explained', async () => {
  const { screen, calls } = yourLink();
  const tree = await renderScreen(screen);
  try {
    const field = () => tree.root.findByType('TextField');
    assert.equal(field().props.label, 'Got a code from a friend?');
    await act(() => field().props.onChangeText('hello'));
    await act(() => button(tree, 'Open invite').props.onPress());
    assert.match(field().props.error, /doesn't look like an invite code/);
    assert.deepEqual(calls.routes, []);
    await act(() => field().props.onChangeText(' npqrs-tvwxz '));
    await act(() => button(tree, 'Open invite').props.onPress());
    assert.deepEqual(calls.routes, [['push', '/invite/NPQRSTVWXZ']]);
  } finally { await unmount(tree); }
});

test('if your link cannot be loaded, Try again loads it again (the friend code box still works)', async () => {
  let fail = true;
  const { screen, state } = yourLink({ code: async () => { if (fail) throw new Error('offline'); return 'BCDFGHJKLM'; } });
  const tree = await renderScreen(screen);
  try {
    assert.match(allText(tree), /Couldn't load your link/);
    assert.equal(button(tree, 'Share my link').props.disabled, true);
    assert.ok(tree.root.findByType('TextField'));
    fail = false;
    await act(() => button(tree, 'Try again').props.onPress());
    assert.equal(state.loads, 2);
    assert.match(allText(tree), /BCDFG-HJKLM/);
  } finally { await unmount(tree); }
});

test('if the server cannot be reached, the code loaded in the last few minutes is shown', async () => {
  const { screen, state } = yourLink({ code: async () => { throw new Error('Network request failed'); }, remembered: () => 'NPQRSTVWXZ' });
  const tree = await renderScreen(screen);
  try {
    assert.match(allText(tree), /invite\?c=NPQRSTVWXZ/);
    assert.doesNotMatch(allText(tree), /Couldn't load your link/);
    await act(() => button(tree, 'Share my link').props.onPress());
    assert.deepEqual(state.shares, ['NPQRSTVWXZ']);
  } finally { await unmount(tree); }
});

test('a new link made on another phone: "Your invite link" shows it, and the next share sends it', async () => {
  // The real lib/invite.ts. The server's code for Alice changes when she gets a new link on her tablet.
  const server = { code: 'BCDFGHJKLM' };
  const lib = realInviteWithStore({ rpc: name => (name === 'my_invite_code' ? { data: server.code, error: null } : { data: null, error: { message: 'unexpected' } }) });
  lib.invite.prefetchInviteCode('alice');
  await flush();
  assert.equal(lib.invite.rememberedInviteCode('alice'), 'BCDFGHJKLM');
  server.code = 'NPQRSTVWXZ';
  const { screen } = yourLink({ lib: lib.invite });
  const tree = await renderScreen(screen);
  try {
    await act(flush);
    assert.match(allText(tree), /invite\?c=NPQRSTVWXZ/);
    assert.match(allText(tree), /NPQRS-TVWXZ/);
    assert.doesNotMatch(allText(tree), /BCDFGHJKLM|BCDFG-HJKLM/);
  } finally { await unmount(tree); }
  // An "Invite friends" share somewhere else afterwards sends the new link too.
  await lib.invite.inviteFriends('alice');
  assert.match(lib.shared[0].message, /invite\?c=NPQRSTVWXZ/);
  assert.doesNotMatch(lib.shared[0].message, /BCDFGHJKLM/);
  assert.deepEqual(lib.rpcCalls, ['my_invite_code', 'my_invite_code']);
});

test('the back button goes Home when there is nothing to go back to', async () => {
  const { screen, calls } = yourLink({ canGoBack: false });
  const tree = await renderScreen(screen);
  try {
    await act(() => tree.root.findByType('ScreenHeader').props.onBack());
    assert.deepEqual(calls.routes, [['replace', '/']]);
  } finally { await unmount(tree); }
});

// ---------------------------------------------------------------------------
// The invite saved on the phone, and the start-up link handler
// ---------------------------------------------------------------------------

function pending({ saved = 'BCDFGHJKLM', path = '/' } = {}) {
  const calls = { routes: [] };
  const screen = loadScreen('src/components/PendingInvite.tsx', {
    'expo-router': { router: routerMock(calls), usePathname: () => path },
    '@/lib/invite': { readPendingInvite: async () => saved },
  });
  screen.Component = screen.exports.PendingInvite;
  return { screen, calls };
}

test('a saved invite opens once you are in the app', async () => {
  const { screen, calls } = pending();
  const tree = await renderScreen(screen);
  try {
    await act(flush);
    assert.deepEqual(calls.routes, [['push', '/invite/BCDFGHJKLM']]);
    await act(() => tree.update(React.createElement(screen.Component)));
    assert.equal(calls.routes.length, 1, 'only once');
  } finally { await unmount(tree); }
});

test('no saved invite, or already looking at one: nothing is opened', async () => {
  for (const fixture of [pending({ saved: null }), pending({ path: '/invite/BCDFGHJKLM' })]) {
    const tree = await renderScreen(fixture.screen);
    try {
      await act(flush);
      assert.deepEqual(fixture.calls.routes, []);
    } finally { await unmount(tree); }
  }
});

function nativeIntent({ setItem = async () => {} } = {}) {
  const saved = [];
  const screen = loadScreen('src/app/+native-intent.tsx', {
    '@react-native-async-storage/async-storage': { __esModule: true, default: { setItem: async (key, value) => { saved.push([key, value]); return setItem(); } } },
    '@/lib/inviteCode': inviteCode,
  });
  return { redirect: screen.exports.redirectSystemPath, saved, calls: screen.calls };
}

test('the start-up link handler passes every other link on unchanged, straight away', () => {
  const { redirect, saved } = nativeIntent();
  for (const path of ['peekaboo://settings', 'peekaboo://chat/123?x=1', 'exp://192.168.1.2:8081/--/friends', '/invite', 'peekaboo://invite/nope']) {
    assert.equal(redirect({ path, initial: true }), path);
  }
  assert.deepEqual(saved, []);
});

test('an invite link is saved on the phone and opens /invite/<code>', async () => {
  const { redirect, saved } = nativeIntent();
  const before = Date.now();
  for (const path of ['peekaboo://invite/bcdfg-hjklm?utm=1', 'exp://192.168.1.2:8081/--/invite/BCDFGHJKLM#x']) {
    assert.equal(await redirect({ path, initial: false }), '/invite/BCDFGHJKLM');
  }
  assert.equal(saved.length, 2);
  const [key, value] = saved[0];
  assert.equal(key, 'peekaboo-pending-invite');
  const parsed = JSON.parse(value);
  assert.equal(parsed.code, 'BCDFGHJKLM');
  assert.ok(parsed.savedAt >= before && parsed.savedAt <= Date.now());
});

test('the link handler never fails: a broken phone storage still opens the invite, and odd input is passed on', async () => {
  let { redirect } = nativeIntent({ setItem: async () => { throw new Error('disk full'); } });
  assert.equal(await redirect({ path: 'peekaboo://invite/BCDFGHJKLM', initial: true }), '/invite/BCDFGHJKLM');
  // Storage that never answers: the time limit lets the app open anyway.
  const stuck = nativeIntent({ setItem: () => new Promise(() => {}) });
  const opening = stuck.redirect({ path: 'peekaboo://invite/BCDFGHJKLM', initial: true });
  assert.equal(stuck.calls.timers.length, 1);
  stuck.calls.timers[0]();
  assert.equal(await opening, '/invite/BCDFGHJKLM');
  ({ redirect } = nativeIntent());
  assert.equal(redirect({ path: undefined, initial: true }), undefined);
});

// ---------------------------------------------------------------------------
// A link to a page that doesn't exist
// ---------------------------------------------------------------------------

test('a page that does not exist says so, with a Go home button', async () => {
  const calls = { routes: [] };
  const screen = loadScreen('src/app/+not-found.tsx', { 'expo-router': { router: routerMock(calls) } });
  const tree = await renderScreen(screen);
  try {
    assert.equal(tree.root.findByType('EmptyState').props.title, "That page doesn't exist");
    await act(() => button(tree, 'Go home').props.onPress());
    assert.deepEqual(calls.routes, [['replace', '/']]);
  } finally { await unmount(tree); }
});

// ---------------------------------------------------------------------------
// Friends: the top "Invite friends" button opens your invite link; empty screens still share straight away
// ---------------------------------------------------------------------------

function friendsScreen(links) {
  const state = { shared: [], prefetched: [] };
  const calls = { routes: [] };
  const screen = loadScreen('src/app/(app)/friends.tsx', {
    'expo-router': { router: routerMock(calls), useFocusEffect: callback => React.useEffect(callback, [callback]) },
    '@/components/FriendButton': { FriendButton: host('FriendButton') },
    '@/components/PersonRow': { PersonRow: host('PersonRow') },
    '@/lib/friends': {
      fetchMyFriendLinks: async () => links,
      otherPerson: link => (link.requester_id === 'alice' ? link.addressee : link.requester),
      relationFrom: () => ({ kind: 'friends' }),
      searchUsers: async () => [],
    },
    '@/lib/invite': { inviteFriends: username => state.shared.push(username), prefetchInviteCode: me => state.prefetched.push(me) },
    '@/lib/supabase': { supabase: { channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {} } },
  });
  return { screen, state, calls };
}

test('Friends: the top "Invite friends" button opens your invite link, and the link is loaded early', async () => {
  const link = { id: 'l1', status: 'accepted', requester_id: 'alice', addressee_id: 'bob', addressee: BOB, requester: { id: 'alice' } };
  const { screen, state, calls } = friendsScreen([link]);
  const tree = await renderScreen(screen);
  try {
    assert.deepEqual(state.prefetched, ['alice']);
    await act(() => button(tree, 'Invite friends').props.onPress());
    assert.deepEqual(calls.routes, [['push', '/invite']]);
    assert.deepEqual(state.shared, []);
  } finally { await unmount(tree); }
});

test('Friends with nobody yet: "Invite friends" still opens the share sheet straight away', async () => {
  const { screen, state, calls } = friendsScreen([]);
  const tree = await renderScreen(screen);
  try {
    await act(() => button(tree, 'Invite friends').props.onPress());
    assert.deepEqual(state.shared, ['alice']);
    assert.deepEqual(calls.routes, []);
  } finally { await unmount(tree); }
});
