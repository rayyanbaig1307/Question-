// Launch safety in the app (supabase/migrations/20261220000000_launch_safety.sql):
// - Adding someone under 18 gives 'pending' from the server: the app says "Friend request sent" and shows
//   "Requested", never "Friends".
// - Community dare ideas only run after the Peekaboo team checked them: the Dare ideas screen says so.
const test = require('node:test');
const assert = require('node:assert/strict');
const { React, loadScreen, renderScreen, act, button, textOf, unmount, host } = require('./harness.cjs');

// ---------------------------------------------------------------------------
// Adding a friend
// ---------------------------------------------------------------------------

function friendsLib(answer) {
  const calls = [];
  const screen = loadScreen('src/lib/friends.ts', {
    './supabase': { supabase: { rpc: async (name, args) => { calls.push([name, args]); return answer(); } } },
  });
  return { lib: screen.exports, calls };
}

test('sendFriendRequest passes on the server answer, and anything but "accepted" counts as a request', async () => {
  let reply = { data: 'pending', error: null };
  const { lib, calls } = friendsLib(() => reply);
  assert.equal(await lib.sendFriendRequest('teen'), 'pending');
  // (The library runs in its own sandbox, so compare the plain values.)
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['send_friend_request', { target: 'teen' }]]);
  reply = { data: 'accepted', error: null };
  assert.equal(await lib.sendFriendRequest('adult'), 'accepted');
  reply = { data: null, error: null };
  assert.equal(await lib.sendFriendRequest('odd'), 'pending');
  reply = { data: null, error: new Error('You cannot add this user') };
  await assert.rejects(lib.sendFriendRequest('blocked'), /cannot add/);
});

function friendButton({ answer }) {
  const calls = { sent: [], toasts: [], reloads: 0 };
  const screen = loadScreen('src/components/FriendButton.tsx', {
    '@/components/Overlays': { useOverlays: () => ({ showToast: (text) => calls.toasts.push(text), showOptions: () => {} }) },
    '@/lib/friends': {
      sendFriendRequest: async (id) => { calls.sent.push(id); return answer; },
      respondToRequest: async () => {},
      removeFriendLink: async () => {},
    },
  });
  const { FriendButton } = screen.exports;
  // Like the profile screen: after a tap it loads the friendship again from the server. The server saved a
  // request ('sent') when it answered 'pending', and a friendship when it answered 'accepted'.
  screen.Component = function Profile() {
    const [relation, setRelation] = React.useState({ kind: 'none' });
    const onChanged = () => {
      calls.reloads++;
      setRelation(answer === 'accepted' ? { kind: 'friends', linkId: 'f1' } : { kind: 'sent', linkId: 'f1' });
    };
    return React.createElement(FriendButton, { person: { id: 'teen', username: 'teen' }, relation, onChanged });
  };
  return { screen, calls };
}

test('Adding someone under 18 (server says "pending") shows "Friend request sent" and then "Requested", not "Friends"', async () => {
  const { screen, calls } = friendButton({ answer: 'pending' });
  const tree = await renderScreen(screen);
  try {
    await act(() => button(tree, 'Add friend').props.onPress());
    assert.deepEqual(calls.sent, ['teen']);
    assert.deepEqual(calls.toasts, ['Friend request sent 💌']);
    assert.equal(calls.reloads, 1);
    assert.ok(button(tree, 'Requested'), 'the button says Requested');
    assert.equal(button(tree, 'Friends'), undefined);
    assert.equal(button(tree, 'Add friend'), undefined);
  } finally { await unmount(tree); }
});

test('Adding an adult with a public account (server says "accepted") still makes you friends at once', async () => {
  const { screen, calls } = friendButton({ answer: 'accepted' });
  const tree = await renderScreen(screen);
  try {
    await act(() => button(tree, 'Add friend').props.onPress());
    assert.deepEqual(calls.toasts, ['You and @teen are friends! 🎉']);
    assert.ok(button(tree, 'Friends'));
    assert.equal(button(tree, 'Requested'), undefined);
  } finally { await unmount(tree); }
});

// ---------------------------------------------------------------------------
// Community dare ideas
// ---------------------------------------------------------------------------

const author = (name) => ({ id: name, username: name, display_name: '', avatar_path: null });
const IDEAS = [
  { id: 'i1', user_id: 'bob', text: 'Wear a silly hat all day', votes: 4, hidden: false, used_on: null, approved_at: '2026-11-04T09:00:00Z', created_at: '2026-11-03', author: author('bob'), mine: false },
  { id: 'i2', user_id: 'cara', text: 'Sing in the shower loudly', votes: 7, hidden: false, used_on: null, approved_at: null, created_at: '2026-11-03', author: author('cara'), mine: true },
  { id: 'i3', user_id: 'dan', text: 'Talk like a pirate all day', votes: 1, hidden: false, used_on: null, approved_at: '2026-11-04T09:00:00Z', created_at: '2026-11-03', author: author('dan'), mine: false },
  // A server without the approval column yet: no approved_at at all.
  { id: 'i4', user_id: 'eve', text: 'Dance in the kitchen for a minute', votes: 3, hidden: false, used_on: null, created_at: '2026-11-03', author: author('eve'), mine: false },
];

function dareIdeas() {
  return loadScreen('src/app/(app)/dare-ideas.tsx', {
    '@/components/Bouncy': { Bouncy: host('Bouncy') },
    '@/components/Overlays': { useOverlays: () => ({ showToast: () => {}, showOptions: () => {} }) },
    '@/lib/communityDares': {
      deleteIdea: async () => {}, fetchIdeas: async () => IDEAS, IDEA_MAX: 120, IDEA_MIN: 10, MIN_VOTES: 3,
      reportIdea: async () => {}, submitIdea: async () => {}, voteIdea: async () => {},
    },
    '@/lib/safety': { REPORT_REASONS: [] },
  });
}

test('Dare ideas: only checked ideas say "ready to run"; the rest with enough votes wait for the check', async () => {
  const tree = await renderScreen(dareIdeas());
  try {
    await act(async () => {});
    const texts = tree.root.findAllByType('Text').map(textOf);
    const line = (name) => texts.find((t) => t.startsWith(`@${name}`));
    assert.equal(line('bob'), '@bob · 🔥 ready to run');
    assert.equal(line('cara'), '@cara · 👀 waiting for our check');
    assert.equal(line('dan'), '@dan');
    assert.equal(line('eve'), '@eve · 👀 waiting for our check');
    const card = texts.find((t) => t.startsWith('Suggest one.'));
    assert.match(card, /checked by the Peekaboo team/);
    assert.doesNotMatch(texts.join('\n'), /becomes the next day's dare/);
  } finally { await unmount(tree); }
});
