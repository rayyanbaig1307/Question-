const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScreen, renderScreen, act, button, option, unmount } = require('./harness.cjs');

// "Dare your friends" opens straight after Send to… now, while your dare post may still be on its way (lib/outbox.ts).
// The dares point at your post (dare_nominations.post_id), so "Dare them" waits for it to be saved.
const plain = value => JSON.parse(JSON.stringify(value));

function fixture({ whenSent, params = { post: 'post-9', job: 'job-post' } } = {}) {
  const calls = { dared: [], retried: [], back: 0 };
  const screen = loadScreen('src/app/(app)/dare-chain.tsx', {
    'expo-router': { router: { back: () => { calls.back++; }, push() {} }, useLocalSearchParams: () => params },
    '@/lib/dareChain': {
      dareFriends: async (...args) => { calls.dared.push(args); return args[0].length; },
      fetchDareChain: async () => ({ sent: [] }),
      inviteToDare() {},
      MAX_DARES_PER_DAY: 3,
    },
    '@/lib/friends': { fetchFriends: async () => [{ id: 'bob', username: 'bob', display_name: 'Bob' }], cachedFriends: () => null },
    '@/lib/outbox': { whenSent, retry: key => { calls.retried.push(key); }, SEND_NOT_FOUND: "We couldn't find this send any more" },
  });
  return { screen, calls };
}

// F12
test('"Dare them" waits for your dare post to be saved, then dares with its id', async () => {
  let release;
  const posted = new Promise(resolve => { release = resolve; });
  const { screen, calls } = fixture({ whenSent: () => posted });
  const tree = await renderScreen(screen);
  try {
    await act(() => option(tree, 'Bob').props.onPress());
    await act(() => { button(tree, /^Dare 1 friend/).props.onPress(); });
    assert.equal(calls.dared.length, 0, 'not before the post is in');
    assert.equal(button(tree, 'Posting your dare…').props.loading, true);
    await act(async () => { release({ key: 'job-post', state: 'sent' }); });
    assert.deepEqual(plain(calls.dared), [[['bob'], 'post-9']]);
    assert.equal(calls.back, 1);
  } finally { await unmount(tree); }
});

test("if your dare post didn't go: try again, or dare them anyway without it", async () => {
  const { screen, calls } = fixture({ whenSent: async () => ({ key: 'job-post', state: 'failed', error: 'No connection – tap to try again' }) });
  const tree = await renderScreen(screen);
  try {
    await act(() => option(tree, 'Bob').props.onPress());
    await act(() => button(tree, /^Dare 1 friend/).props.onPress());
    assert.equal(calls.dared.length, 0);
    const [title, words, choices] = screen.calls.alerts.at(-1);
    assert.equal(title, "Your dare post didn't go");
    assert.equal(words, 'No connection – tap to try again');
    assert.deepEqual(plain(choices.map(choice => choice.text)), ['Try again', 'Dare them anyway', 'Cancel']);
    await act(() => choices.find(choice => choice.text === 'Dare them anyway').onPress());
    assert.deepEqual(plain(calls.dared), [[['bob'], null]]);
  } finally { await unmount(tree); }
});

test('opened without a send to wait for (as before), it dares straight away', async () => {
  const { screen, calls } = fixture({ whenSent: () => new Promise(() => {}), params: { post: 'post-1' } });
  const tree = await renderScreen(screen);
  try {
    await act(() => option(tree, 'Bob').props.onPress());
    await act(() => button(tree, /^Dare 1 friend/).props.onPress());
    assert.deepEqual(plain(calls.dared), [[['bob'], 'post-1']]);
  } finally { await unmount(tree); }
});

// Review DARECHAIN-LEAVE: on 1 bar "Posting your dare…" can take a while, and you could go back meanwhile. When the
// post was saved later, your friends still got dared and the screen you'd moved on to was closed.
test('leaving while your dare post is on its way: nobody is dared, no message, no screen closed', async () => {
  let release;
  const posted = new Promise(resolve => { release = resolve; });
  const { screen, calls } = fixture({ whenSent: () => posted });
  const tree = await renderScreen(screen);
  await act(() => option(tree, 'Bob').props.onPress());
  await act(() => { button(tree, /^Dare 1 friend/).props.onPress(); });
  await unmount(tree);
  await act(async () => { release({ key: 'job-post', state: 'sent' }); });
  assert.deepEqual(calls.dared, []);
  assert.equal(calls.back, 0);
  assert.deepEqual(screen.calls.alerts, []);
});

test('leaving while it is on its way, and it fails: no message pops up on another screen', async () => {
  let release;
  const posted = new Promise(resolve => { release = resolve; });
  const { screen, calls } = fixture({ whenSent: () => posted });
  const tree = await renderScreen(screen);
  await act(() => option(tree, 'Bob').props.onPress());
  await act(() => { button(tree, /^Dare 1 friend/).props.onPress(); });
  await unmount(tree);
  await act(async () => { release({ key: 'job-post', state: 'failed', error: 'No connection – tap to try again' }); });
  assert.deepEqual(screen.calls.alerts, []);
  assert.deepEqual(calls.dared, []);
});

test("a dare post this phone doesn't know any more is said in plain words (no Try again)", async () => {
  const { screen, calls } = fixture({ whenSent: async () => ({ key: 'job-post', state: 'failed', final: true, error: "We couldn't find this send any more" }) });
  const tree = await renderScreen(screen);
  try {
    await act(() => option(tree, 'Bob').props.onPress());
    await act(() => button(tree, /^Dare 1 friend/).props.onPress());
    const [title, words, choices] = screen.calls.alerts.at(-1);
    assert.equal(title, "We couldn't find your dare post");
    assert.equal(words, 'Try again from the Dare page, or dare them without it.');
    assert.deepEqual(plain(choices.map(choice => choice.text)), ['Dare them anyway', 'Cancel']);
    assert.equal(calls.dared.length, 0);
  } finally { await unmount(tree); }
});
