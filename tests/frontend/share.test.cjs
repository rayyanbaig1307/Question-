const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScreen, renderScreen, act, button, option, unmount, textOf } = require('./harness.cjs');

// "Send to…" (src/app/(app)/share.tsx) starts uploading the photo when it opens (lib/preupload.ts) and hands the sends
// to the outbox (lib/outbox.ts) when you tap Send, then closes at once. The outbox's own rules (never twice, the
// drop first, trying again) are tested in tests/unit/outbox.test.mjs.
// Values made inside the screen come from its own little world: compare them as plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));
const router = (routes) => ({ dismissTo: (...args) => routes.push(['dismissTo', ...args]), push: (...args) => routes.push(['push', ...args]), back: () => routes.push(['back']) });

// F1: the owner's 22 Nov screenshot – tick Ray, tap Send, and the button spun forever on 1 bar.
test('Send to a friend closes Send to… at once while the network hangs', async () => {
  const routes = [];
  const screen = loadScreen('src/app/(app)/share.tsx', {
    'expo-router': { router: router(routes), useLocalSearchParams: () => ({ uri: 'file:///qa-photo.jpg', to: 'ray' }) },
    // The old way would wait on this forever.
    '@/lib/chat': { sendSnap: () => new Promise(() => {}) },
  });
  const tree = await renderScreen(screen);
  try {
    await act(() => { button(tree, /^Send to/).props.onPress(); });
    assert.deepEqual(plain(routes), [['dismissTo', '/chat/ray']]);
    assert.equal(button(tree, /^Send to/).props.loading, false);
    const shares = screen.calls.outbox.queueShare;
    assert.equal(shares.length, 1);
    assert.deepEqual(plain(shares[0][1].friendIds), ['ray']);
    assert.equal(shares[0][1].post, null);
    // It's the early upload from when the screen opened that's handed over.
    assert.equal(screen.calls.preupload.prepareUpload.length, 1);
    assert.equal(shares[0][2].key, 'early-1');
  } finally { await unmount(tree); }
});

// F2: the drop's photo starts uploading the moment Send to… opens (with its blurry preview).
test('drop: the photo starts uploading when Send to… opens', async () => {
  const screen = loadScreen('src/app/(app)/share.tsx', {
    'expo-router': { router: router([]), useLocalSearchParams: () => ({ uri: 'file:///qa-photo.jpg', drop: '1' }) },
  });
  const tree = await renderScreen(screen);
  try {
    const early = screen.calls.preupload.prepareUpload;
    assert.equal(early.length, 1);
    assert.equal(early[0][0], 'alice');
    assert.deepEqual(plain(early[0][1]), { kind: 'photo', uri: 'file:///qa-photo.jpg' });
    assert.equal(early[0][2], 'posts');
    assert.deepEqual(plain(early[0][3]), { blur: true });
  } finally { await unmount(tree); }
});

test('each way in uploads early into the folder it most likely needs', async () => {
  const folders = {};
  for (const [name, params] of [['story', {}], ['chat', { to: 'bob' }], ['pick', { pick: 'friends' }], ['dare', { dare: '1' }], ['forfeit', { forfeit: 'f1' }], ['guess', { guess: '1' }], ['video', { video: '1', overlay: 'file:///layer.png' }]]) {
    const screen = loadScreen('src/app/(app)/share.tsx', {
      'expo-router': { router: router([]), useLocalSearchParams: () => ({ uri: 'file:///qa-photo.jpg', ...params }) },
    });
    const tree = await renderScreen(screen);
    try {
      const [[, capture, folder, options]] = screen.calls.preupload.prepareUpload;
      folders[name] = folder;
      assert.deepEqual(plain(options), { blur: false }, name);
      if (name === 'video') assert.deepEqual(plain(capture), { kind: 'video', uri: 'file:///qa-photo.jpg', overlayUri: 'file:///layer.png' });
    } finally { await unmount(tree); }
  }
  assert.deepEqual(folders, { story: 'stories', chat: 'snaps', pick: 'snaps', dare: 'posts', forfeit: 'posts', guess: 'mystery', video: 'stories' });
});

// F3: the logs showed the "Before your first dare" sheet coming up at drop time for people who had agreed: the check
// hadn't answered yet (null counted as "no").
test('a drop sent while the rules check is still loading waits for it instead of showing the sheet', async () => {
  let asked = 0;
  const screen = loadScreen('src/app/(app)/share.tsx', {
    'expo-router': { router: router([]), useLocalSearchParams: () => ({ uri: 'file:///qa-photo.jpg', drop: '1' }) },
    '@/lib/legal': { useDareRulesAccepted: () => ({ accepted: null, accept: async () => {}, ensure: async () => { asked++; return true; } }) },
  });
  const tree = await renderScreen(screen);
  try {
    await act(() => button(tree, /^Send to/).props.onPress());
    assert.equal(asked, 1);
    assert.equal(tree.root.findByType('DareRulesSheet').props.visible, false);
    const shares = screen.calls.outbox.queueShare;
    assert.equal(shares.length, 1);
    assert.equal(shares[0][1].post.drop, true);
  } finally { await unmount(tree); }
});

// F4: agreeing used to only close the sheet, so the drop needed a second tap.
test("after 'I understand' the drop goes out without a second tap", async () => {
  let accepted = 0;
  const screen = loadScreen('src/app/(app)/share.tsx', {
    'expo-router': { router: router([]), useLocalSearchParams: () => ({ uri: 'file:///qa-photo.jpg', drop: '1' }) },
    '@/lib/legal': { useDareRulesAccepted: () => ({ accepted: null, accept: async () => { accepted++; }, ensure: async () => false }) },
  });
  const tree = await renderScreen(screen);
  try {
    await act(() => button(tree, /^Send to/).props.onPress());
    const sheet = () => tree.root.findByType('DareRulesSheet');
    assert.equal(sheet().props.visible, true);
    assert.equal(screen.calls.outbox.queueShare.length, 0);
    await act(() => sheet().props.onAccept());
    assert.equal(accepted, 1);
    assert.equal(sheet().props.visible, false);
    // Review R6: it waits for the rules sheet to slide away first (iPhones can't open the story preview or close
    // the screen while a sheet is still closing).
    assert.equal(screen.calls.outbox.queueShare.length, 0);
    await act(() => screen.calls.timers.at(-1)());
    assert.equal(screen.calls.outbox.queueShare.length, 1);
    assert.equal(screen.calls.outbox.queueShare[0][1].post.drop, true);
  } finally { await unmount(tree); }
});

test('someone this phone knows has agreed is never asked again (no check, no sheet)', async () => {
  let asked = 0;
  const screen = loadScreen('src/app/(app)/share.tsx', {
    'expo-router': { router: router([]), useLocalSearchParams: () => ({ uri: 'file:///qa-photo.jpg', dare: '1' }) },
    '@/lib/legal': { useDareRulesAccepted: () => ({ accepted: true, accept: async () => {}, ensure: async () => { asked++; return true; } }) },
  });
  const tree = await renderScreen(screen);
  try {
    await act(() => button(tree, /^Send to/).props.onPress());
    assert.equal(asked, 0);
    assert.equal(screen.calls.outbox.queueShare[0][1].post.dare, true);
  } finally { await unmount(tree); }
});

// F5: leaving without sending throws the early upload away; sending hands it over (and never deletes it).
test('leaving without sending throws the early upload away; sending keeps it', async () => {
  const left = loadScreen('src/app/(app)/share.tsx', {
    'expo-router': { router: router([]), useLocalSearchParams: () => ({ uri: 'file:///qa-photo.jpg', to: 'bob' }) },
  });
  const tree = await renderScreen(left);
  await unmount(tree);
  assert.equal(left.calls.preupload.discardUpload.length, 1);
  assert.equal(left.calls.preupload.discardUpload[0][0].key, 'early-1');

  const sent = loadScreen('src/app/(app)/share.tsx', {
    'expo-router': { router: router([]), useLocalSearchParams: () => ({ uri: 'file:///qa-photo.jpg', to: 'bob' }) },
  });
  const tree2 = await renderScreen(sent);
  await act(() => button(tree2, /^Send to/).props.onPress());
  await unmount(tree2);
  assert.equal(sent.calls.preupload.discardUpload.length, 0);
  const handed = sent.calls.outbox.queueShare[0][2];
  assert.equal(handed.key, 'early-1');
  assert.equal(sent.calls.preupload.markUsed[0][0], handed);
});

test('close-friends choice also protects a dare, drop, or forfeit posted with a story', async t => {
  for (const mode of ['dare', 'drop', 'forfeit']) await t.test(mode, async () => {
    const screen = loadScreen('src/app/(app)/share.tsx', {
      'expo-router': { router: router([]), useLocalSearchParams: () => ({ uri: 'file:///qa-photo.jpg', [mode]: mode === 'forfeit' ? 'qa-forfeit' : '1' }) },
    });
    const tree = await renderScreen(screen);
    try {
      await act(() => option(tree, 'My Story').props.onPress());
      await act(() => tree.root.findByType('Switch').props.onValueChange(true));
      await act(() => button(tree, /^Send to/).props.onPress());
      await act(() => tree.root.findByType('StoryPreview').props.onShare());
      await act(() => screen.calls.timers.shift()());
      const shares = screen.calls.outbox.queueShare;
      assert.equal(shares.length, 1);
      const plan = shares[0][1];
      assert.equal(plan.story, true);
      assert.equal(plan.audience, 'close_friends', 'every copy of the photo must keep the audience selected on screen');
      assert.ok(plan.post);
      if (mode === 'forfeit') assert.equal(plan.post.forfeit, 'qa-forfeit');
    } finally { await unmount(tree); }
  });
});

test('rapid repeated send presses do not send the same peek twice', async () => {
  const screen = loadScreen('src/app/(app)/share.tsx', {
    'expo-router': { router: router([]), useLocalSearchParams: () => ({ uri: 'file:///qa-photo.jpg', to: 'bob' }) },
  });
  const tree = await renderScreen(screen);
  try {
    const press = button(tree, /^Send to/).props.onPress;
    await act(async () => { press(); press(); press(); });
    assert.equal(screen.calls.outbox.queueShare.length, 1, 'one rapid action must create one send');
  } finally { await unmount(tree); }
});

test('a drop goes home, a dare goes to the Dare page and then "dare your friends" (which waits for the post)', async () => {
  for (const [params, expected] of [
    [{ drop: '1' }, [['dismissTo', { pathname: '/', params: { page: 'home' } }]]],
    [{ forfeit: 'f1' }, [['dismissTo', '/dare']]],
    [{ guess: '1' }, [['dismissTo', '/guess']]],
    [{ dare: '1' }, [['dismissTo', '/dare'], ['push', { pathname: '/dare-chain', params: { post: 'post-1', job: 'job-post' } }]]],
    [{}, [['dismissTo', '/']]],
  ]) {
    const routes = [];
    const screen = loadScreen('src/app/(app)/share.tsx', {
      'expo-router': { router: router(routes), useLocalSearchParams: () => ({ uri: 'file:///qa-photo.jpg', ...params }) },
    });
    const tree = await renderScreen(screen);
    try {
      await act(() => button(tree, /^Send to|^Post my Guess Who/).props.onPress());
      // My Story is ticked by default with no mode: its preview comes first.
      const preview = tree.root.findAllByType('StoryPreview')[0];
      if (preview?.props.visible) {
        await act(() => preview.props.onShare());
        await act(() => screen.calls.timers.shift()());
        // The preview slides away before leaving.
        await act(() => screen.calls.timers.shift()());
      }
      assert.deepEqual(plain(routes), expected, JSON.stringify(params));
    } finally { await unmount(tree); }
  }
});

test('editing the caption inside the final profile preview cannot bypass the content check', async () => {
  const checkClean = loadScreen('src/lib/cleanWords.ts').exports.checkClean;
  const screen = loadScreen('src/app/(app)/share.tsx', {
    '@/lib/cleanWords': { checkClean },
  });
  const tree = await renderScreen(screen);
  try {
    await act(() => option(tree, 'My Story').props.onPress());
    await act(() => option(tree, 'My Profile').props.onPress());
    await act(() => button(tree, /^Send to/).props.onPress());
    const fields = tree.root.findAllByType('TextField').filter(node => node.props.label === 'Caption');
    await act(() => fields.at(-1).props.onChangeText('n1gg3r'));
    await act(() => button(tree, 'Post').props.onPress());
    assert.equal(screen.calls.outbox.queueShare.length, 0, 'the editable preview must check its final caption before posting');
    assert.equal(screen.calls.alerts[0][0], 'Caption not allowed');
  } finally { await unmount(tree); }
});

// 🌆 Main Character Mode's "Send" opens Send to… to pick friends: My Story starts unticked there. Its "My story"
// (no `pick`) and every other way in stay as they were.
test('pick=friends starts with My Story not ticked; without it My Story is ticked as before', async () => {
  const states = {};
  for (const [name, params] of [['friends', { uri: 'file:///qa-poster.jpg', pick: 'friends' }], ['story', { uri: 'file:///qa-poster.jpg' }], ['other', { uri: 'file:///qa-poster.jpg', pick: 'something-else' }]]) {
    const screen = loadScreen('src/app/(app)/share.tsx', {
      'expo-router': { router: router([]), useLocalSearchParams: () => params },
      '@/lib/friends': { fetchFriends: async () => [{ id: 'bob', username: 'bob', display_name: 'Bob' }], cachedFriends: () => null },
    });
    const tree = await renderScreen(screen);
    try {
      states[name] = option(tree, 'My Story').props.accessibilityState.checked;
      if (name === 'friends') {
        assert.equal(button(tree, /^Send to|^Pick where/).props.title, 'Pick where it goes');
        // Pick a friend and send: a peek to Bob, nothing on the story.
        await act(() => option(tree, 'Bob').props.onPress());
        await act(() => button(tree, /^Send to/).props.onPress());
        const plan = screen.calls.outbox.queueShare[0][1];
        assert.deepEqual(plain(plan.friendIds), ['bob']);
        assert.deepEqual(plain(plan.names), { bob: 'Bob' });
        assert.equal(plan.story, false);
      }
    } finally { await unmount(tree); }
  }
  assert.deepEqual(states, { friends: false, story: true, other: true });
});

test('your friends show at once from the last list while a fresh one loads', async () => {
  const screen = loadScreen('src/app/(app)/share.tsx', {
    'expo-router': { router: router([]), useLocalSearchParams: () => ({ uri: 'file:///qa-photo.jpg' }) },
    '@/lib/friends': { fetchFriends: () => new Promise(() => {}), cachedFriends: () => [{ id: 'ray', username: 'ray', display_name: 'Ray' }] },
  });
  const tree = await renderScreen(screen);
  try {
    assert.ok(option(tree, 'Ray'), 'Ray shows before the fresh list arrives');
  } finally { await unmount(tree); }
});

// SPEED-3: Send to… closes at once now, so another photo can reach Send to… while your drop is still on its way
// (the server only knows about it once it's saved). It started with "Today's drop" ticked, and that second drop
// post could even be saved before the real one.
test("while your drop is still on its way, Send to… doesn't start as a second drop, and won't send one", async () => {
  const outbox = { sending: 'job-drop', shares: [] };
  const ray = { id: 'ray', username: 'ray', display_name: 'Ray' };
  const screen = loadScreen('src/app/(app)/share.tsx', {
    'expo-router': { router: router([]), useLocalSearchParams: () => ({ uri: 'file:///qa-photo.jpg', drop: '1' }) },
    '@/lib/friends': { fetchFriends: async () => [ray], cachedFriends: () => [ray] },
    '@/lib/outbox': {
      queueShare: (...args) => { outbox.shares.push(args); return { group: 'group-1', postId: null, postJob: null }; },
      useDropSending: () => outbox.sending,
      dropSendingKey: () => outbox.sending,
    },
  });
  const tree = await renderScreen(screen);
  try {
    const dropOption = () => option(tree, "Today's drop");
    assert.equal(dropOption().props.accessibilityState.checked, false);
    assert.match(textOf(dropOption()), /Your drop is still on its way/);
    // Ticked anyway: Send says why, and nothing is sent.
    await act(() => dropOption().props.onPress());
    await act(() => option(tree, 'Ray').props.onPress());
    await act(() => button(tree, /^Send to/).props.onPress());
    assert.equal(outbox.shares.length, 0);
    assert.equal(screen.calls.alerts[0][0], 'Your drop is still on its way');
    // Unticked: the photo goes to Ray as a peek, and no drop.
    await act(() => dropOption().props.onPress());
    await act(() => button(tree, /^Send to/).props.onPress());
    assert.equal(outbox.shares.length, 1);
    assert.equal(outbox.shares[0][1].post, null);
    assert.deepEqual(plain(outbox.shares[0][1].friendIds), ['ray']);
  } finally { await unmount(tree); }
});
