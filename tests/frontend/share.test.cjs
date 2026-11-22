const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScreen, renderScreen, act, button, option, unmount } = require('./harness.cjs');

test('close-friends choice also protects a dare, drop, or forfeit posted with a story', async t => {
  for (const mode of ['dare', 'drop', 'forfeit']) await t.test(mode, async () => {
    const posts = [], stories = [];
    const screen = loadScreen('src/app/(app)/share.tsx', {
      'expo-router': { router: { dismissTo() {}, push() {}, back() {} }, useLocalSearchParams: () => ({ uri: 'file:///qa-photo.jpg', [mode]: mode === 'forfeit' ? 'qa-forfeit' : '1' }) },
      '@/lib/posts': { createPost: async (...args) => { posts.push(args); return { id: 'qa-post', drop_late_seconds: 0 }; } },
      '@/lib/stories': { createStory: async (...args) => { stories.push(args); } },
    });
    const tree = await renderScreen(screen);
    try {
      await act(() => option(tree, 'My Story').props.onPress());
      await act(() => tree.root.findByType('Switch').props.onValueChange(true));
      await act(() => button(tree, /^Send to/).props.onPress());
      await act(() => tree.root.findByType('StoryPreview').props.onShare());
      await act(() => screen.calls.timers.shift()());
      assert.equal(stories.length, 1);
      assert.equal(stories[0][2], 'close_friends');
      assert.equal(posts.length, 1);
      assert.equal(posts[0][3].audience, 'close_friends', 'every copy of the photo must keep the audience selected on screen');
    } finally { await unmount(tree); }
  });
});

test('rapid repeated send presses do not send the same peek twice', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const sent = [];
  const screen = loadScreen('src/app/(app)/share.tsx', {
    'expo-router': { router: { dismissTo() {}, push() {} }, useLocalSearchParams: () => ({ uri: 'file:///qa-photo.jpg', to: 'bob' }) },
    '@/lib/chat': { sendSnap: async (...args) => { sent.push(args); await pending; } },
  });
  const tree = await renderScreen(screen);
  try {
    const press = button(tree, /^Send to/).props.onPress;
    let a, b;
    await act(async () => { a = press(); b = press(); await Promise.resolve(); });
    release();
    await act(async () => { await Promise.all([a, b]); });
    assert.equal(sent.length, 1, 'one rapid action must create one peek');
  } finally { await unmount(tree); }
});

test('a failed upload preserves the selected recipients and can be retried', async () => {
  let attempts = 0;
  const screen = loadScreen('src/app/(app)/share.tsx', {
    'expo-router': { router: { dismissTo() {}, push() {} }, useLocalSearchParams: () => ({ uri: 'file:///qa-photo.jpg', to: 'bob' }) },
    '@/lib/chat': { sendSnap: async () => { if (++attempts === 1) throw new Error('Simulated network timeout'); } },
  });
  const tree = await renderScreen(screen);
  try {
    await act(() => button(tree, /^Send to/).props.onPress());
    assert.equal(screen.calls.alerts[0][0], 'Could not send');
    assert.equal(button(tree, /^Send to/).props.loading, false);
    await act(() => button(tree, /^Send to/).props.onPress());
    assert.equal(attempts, 2);
  } finally { await unmount(tree); }
});

test('retry after a partial send does not repeat a successful peek', async () => {
  let snaps = 0, stories = 0;
  const screen = loadScreen('src/app/(app)/share.tsx', {
    'expo-router': { router: { dismissTo() {}, push() {} }, useLocalSearchParams: () => ({ uri: 'file:///qa-photo.jpg', to: 'bob' }) },
    '@/lib/chat': { sendSnap: async () => { snaps++; } },
    '@/lib/stories': { createStory: async () => { if (++stories === 1) throw new Error('Simulated database failure'); } },
  });
  const tree = await renderScreen(screen);
  try {
    await act(() => option(tree, 'My Story').props.onPress());
    await act(() => button(tree, /^Send to/).props.onPress());
    await act(() => tree.root.findByType('StoryPreview').props.onShare());
    await act(() => screen.calls.timers.shift()());
    await act(() => button(tree, /^Send to/).props.onPress());
    assert.equal(snaps, 1);
    assert.equal(stories, 2);
  } finally { await unmount(tree); }
});

test('editing the caption inside the final profile preview cannot bypass the content check', async () => {
  const checkClean = loadScreen('src/lib/cleanWords.ts').exports.checkClean;
  let posts = 0;
  const screen = loadScreen('src/app/(app)/share.tsx', {
    '@/lib/cleanWords': { checkClean },
    '@/lib/posts': { createPost: async () => { posts++; return { id: 'qa-post' }; } },
  });
  const tree = await renderScreen(screen);
  try {
    await act(() => option(tree, 'My Story').props.onPress());
    await act(() => option(tree, 'My Profile').props.onPress());
    await act(() => button(tree, /^Send to/).props.onPress());
    const fields = tree.root.findAllByType('TextField').filter(node => node.props.label === 'Caption');
    await act(() => fields.at(-1).props.onChangeText('n1gg3r'));
    await act(() => button(tree, 'Post').props.onPress());
    assert.equal(posts, 0, 'the editable preview must check its final caption before posting');
    assert.equal(screen.calls.alerts[0][0], 'Caption not allowed');
  } finally { await unmount(tree); }
});

// 🌆 Main Character Mode's "Send" opens Send to… to pick friends: My Story starts unticked there. Its "My story"
// (no `pick`) and every other way in stay as they were.
test('pick=friends starts with My Story not ticked; without it My Story is ticked as before', async () => {
  const states = {};
  for (const [name, params] of [['friends', { uri: 'file:///qa-poster.jpg', pick: 'friends' }], ['story', { uri: 'file:///qa-poster.jpg' }], ['other', { uri: 'file:///qa-poster.jpg', pick: 'something-else' }]]) {
    const sent = { stories: 0, snaps: [] };
    const screen = loadScreen('src/app/(app)/share.tsx', {
      'expo-router': { router: { dismissTo() {}, push() {}, back() {} }, useLocalSearchParams: () => params },
      '@/lib/friends': { fetchFriends: async () => [{ id: 'bob', username: 'bob', display_name: 'Bob' }] },
      '@/lib/stories': { createStory: async () => { sent.stories++; } },
      '@/lib/chat': { sendSnap: async (...args) => { sent.snaps.push(args); } },
    });
    const tree = await renderScreen(screen);
    try {
      states[name] = option(tree, 'My Story').props.accessibilityState.checked;
      if (name === 'friends') {
        assert.equal(button(tree, /^Send to|^Pick where/).props.title, 'Pick where it goes');
        // Pick a friend and send: a peek to Bob, nothing on the story.
        await act(() => option(tree, 'Bob').props.onPress());
        await act(() => button(tree, /^Send to/).props.onPress());
        assert.equal(sent.snaps.length, 1);
        assert.equal(sent.stories, 0);
      }
    } finally { await unmount(tree); }
  }
  assert.deepEqual(states, { friends: false, story: true, other: true });
});
