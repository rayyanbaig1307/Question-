const test = require('node:test');
const assert = require('node:assert/strict');
const { React, loadScreen, renderScreen, act, unmount, host } = require('./harness.cjs');

// Live friend updates on the Inbox and Friends screens, with the app's real src/lib/friends.ts. Loads of your
// friends that are on their way at the same moment are shared (one request instead of six on a weak signal). But a
// live update says something changed on the server – they sent you a request, or accepted yours – and a load that
// started before that may not have it. The reload must ask the server again, and an older answer that comes in late
// must not replace the newer one on screen.

const ALICE = 'alice'; // the person logged in (tests/frontend/harness.cjs)
const person = (id) => ({ id, username: id, display_name: id.toUpperCase(), avatar_path: null });
const link = (id, requester, addressee, status) => ({
  id, requester_id: requester, addressee_id: addressee, status, created_at: '2026-11-23T10:00:00Z',
  requester: person(requester), addressee: person(addressee),
});

// A pretend Supabase: every friendships load waits until the test answers it, and `fire(table)` sends a live
// update to the screens listening.
function fakeSupabase() {
  const loads = [];
  const channels = [];
  const supabase = {
    from(table) {
      assert.equal(table, 'friendships');
      const chain = {};
      for (const method of ['select', 'or', 'order', 'eq']) chain[method] = () => chain;
      let answer;
      const done = new Promise((resolve) => { answer = resolve; });
      loads.push({ answer: (data) => answer({ data, error: null }) });
      chain.then = (resolve, reject) => done.then(resolve, reject);
      return chain;
    },
    channel(name) {
      const channel = { name, listeners: [], on(_kind, filter, callback) { this.listeners.push({ table: filter.table, callback }); return this; }, subscribe() { return this; } };
      channels.push(channel);
      return channel;
    },
    removeChannel(channel) { channels.splice(channels.indexOf(channel), 1); },
  };
  const fire = (table) => channels.forEach((channel) => channel.listeners.filter((l) => l.table === table).forEach((l) => l.callback({ eventType: 'INSERT' })));
  return { supabase, loads, fire };
}

const realFriends = (supabase) => loadScreen('src/lib/friends.ts', { './supabase': { supabase } }).exports;

function inbox() {
  const server = fakeSupabase();
  const noop = () => {};
  const screen = loadScreen('src/app/(app)/inbox.tsx', {
    'expo-router': { router: { push: noop }, useFocusEffect: (callback) => React.useEffect(callback, [callback]) },
    '@/components/FriendButton': { FriendButton: host('FriendButton') },
    '@/components/PersonRow': { PersonRow: host('PersonRow') },
    '@/components/Overlays': { useOverlays: () => ({ showToast: noop, showOptions: noop }) },
    '@/lib/activity': { useActivity: () => ({ items: [], seenAt: null, markSeen: noop, clear: noop, reload: noop }), describeActivity: () => '' },
    '@/lib/friends': realFriends(server.supabase),
    '@/lib/hitups': { useHitUps: () => ({ hitUps: [], reload: noop }), respondToHitUp: async () => {} },
    '@/lib/notifications': { clearDeliveredNotifications: noop },
    '@/lib/supabase': { supabase: server.supabase },
    '@/lib/time': { timeAgo: () => 'now' },
    '@/lib/useSafetyActions': { useSafetyActions: () => ({ report: noop, confirmBlock: noop }) },
  });
  return { screen, server };
}

const requestsShown = (tree) => tree.root.findAllByType('PersonRow').map((row) => row.props.person.id);
const caughtUp = (tree) => tree.root.findAllByType('EmptyState').some((node) => node.props.title === 'All caught up!');

test('Inbox: a friend request that arrives while the Inbox is still loading shows up (the reload asks again)', async () => {
  const { screen, server } = inbox();
  const tree = await renderScreen(screen);
  try {
    assert.equal(server.loads.length, 1, 'the Inbox loads your friend requests');
    // Bob sends you a request while that load is still on its way (the server already read your requests).
    await act(async () => server.fire('friendships'));
    await act(async () => screen.calls.timers.shift()());
    assert.equal(server.loads.length, 2, 'the live update makes a fresh load, not the one from before');
    await act(async () => server.loads[0].answer([]));
    await act(async () => server.loads[1].answer([link('l1', 'bob', ALICE, 'pending')]));
    assert.deepEqual(requestsShown(tree), ['bob']);
    assert.equal(caughtUp(tree), false);
  } finally { await unmount(tree); }
});

test('Inbox: the older load answering last never hides the new friend request', async () => {
  const { screen, server } = inbox();
  const tree = await renderScreen(screen);
  try {
    await act(async () => server.fire('friendships'));
    await act(async () => screen.calls.timers.shift()());
    await act(async () => server.loads[1].answer([link('l1', 'bob', ALICE, 'pending')]));
    await act(async () => server.loads[0].answer([]));
    assert.deepEqual(requestsShown(tree), ['bob']);
  } finally { await unmount(tree); }
});

function friendsScreen() {
  const server = fakeSupabase();
  const screen = loadScreen('src/app/(app)/friends.tsx', {
    'expo-router': { router: { push() {} }, useFocusEffect: (callback) => React.useEffect(callback, [callback]) },
    '@/components/FriendButton': { FriendButton: host('FriendButton') },
    '@/components/PersonRow': { PersonRow: host('PersonRow') },
    '@/lib/friends': realFriends(server.supabase),
    '@/lib/invite': { inviteFriends() {} },
    '@/lib/supabase': { supabase: server.supabase },
  });
  return { screen, server };
}

// Each row's button (a PersonRow's `right`) and the friendship it shows: 'friends', 'sent' ("Requested")…
const relations = (tree) => tree.root.findAllByType('PersonRow').map((row) => `${row.props.person.id}:${row.props.right.props.relation.kind}`);

test('Friends: when they accept your request while the screen is loading, you see "friends", not "Requested"', async () => {
  const { screen, server } = friendsScreen();
  const tree = await renderScreen(screen);
  try {
    assert.equal(server.loads.length, 1);
    // Bob accepts while that first load is still on its way (it was read before he accepted).
    await act(async () => server.fire('friendships'));
    assert.equal(server.loads.length, 2, 'the live update makes a fresh load, not the one from before');
    await act(async () => server.loads[0].answer([link('l1', ALICE, 'bob', 'pending')]));
    await act(async () => server.loads[1].answer([link('l1', ALICE, 'bob', 'accepted')]));
    assert.deepEqual(relations(tree), ['bob:friends']);
  } finally { await unmount(tree); }
});

test('Friends: the older load answering last never puts "Requested" back', async () => {
  const { screen, server } = friendsScreen();
  const tree = await renderScreen(screen);
  try {
    await act(async () => server.fire('friendships'));
    await act(async () => server.loads[1].answer([link('l1', ALICE, 'bob', 'accepted')]));
    await act(async () => server.loads[0].answer([link('l1', ALICE, 'bob', 'pending')]));
    assert.deepEqual(relations(tree), ['bob:friends']);
  } finally { await unmount(tree); }
});
