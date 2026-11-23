const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScreen, renderScreen, act, unmount, host, textOf, outboxStore } = require('./harness.cjs');

// Comments post in the background now (lib/outbox.ts): yours shows at once with "Sending…" and the box empties.
const plain = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const store = outboxStore();
  const options = [];
  const animated = { setValue() {}, interpolate: () => 1 };
  const screen = loadScreen('src/app/(app)/comments/[postId].tsx', {
    'expo-router': { router: { back() {}, push() {} }, useLocalSearchParams: () => ({ postId: 'post-1' }) },
    'react-native': {
      ...loadScreen('src/lib/lensLooks.ts').modules['react-native'],
      Animated: { Value: function Value() { return animated; }, View: host('AnimatedView'), spring: () => ({ start() {} }), timing: () => ({ start() {} }) },
      PanResponder: { create: () => ({ panHandlers: {} }) },
      Keyboard: { dismiss() {} },
    },
    '@/components/Bouncy': { Bouncy: host('Bouncy') },
    '@/components/IconButton': { IconButton: host('IconButton') },
    '@/components/Overlays': { useOverlays: () => ({ showToast() {}, showOptions: value => options.push(value) }) },
    '@/lib/feed': {
      // The old way would wait on this forever.
      addComment: () => new Promise(() => {}),
      fetchComments: async () => [],
      deleteComment: async () => {},
      setCommentLiked: async () => {},
    },
    '@/lib/posts': { fetchPost: async () => ({ user_id: 'bob' }) },
    '@/lib/time': { timeAgo: () => 'now' },
    '@/lib/useSafetyActions': { useSafetyActions: () => ({ report() {} }) },
    '@/lib/outbox': store,
  });
  return { screen, store, options };
}

// F13
test('a comment shows at once with "Sending…" and the box empties', async () => {
  const { screen, store } = fixture();
  const tree = await renderScreen(screen);
  try {
    await act(() => tree.root.findByType('TextInput').props.onChangeText('love this'));
    const post = tree.root.findAllByType('IconButton').find(node => node.props.label === 'Post comment');
    await act(async () => { post.props.onPress(); post.props.onPress(); });
    assert.equal(tree.root.findByType('TextInput').props.value, '');
    const words = tree.root.findAllByType('Text').map(textOf);
    assert.ok(words.some(text => text.includes('love this')), JSON.stringify(words));
    assert.ok(words.includes('Sending…'), JSON.stringify(words));
    assert.equal(tree.root.findAllByType('EmptyState').length, 0);
    assert.equal(store.calls.sendLater.length, 1);
    assert.deepEqual(plain(store.calls.sendLater[0].slice(0, 3)), ['alice', 'post:post-1', { kind: 'comment', postId: 'post-1', body: 'love this', parentId: null }]);
  } finally { await unmount(tree); }
});

test("a comment that couldn't be posted says so, and a tap offers Try again", async () => {
  const { screen, store, options } = fixture();
  const tree = await renderScreen(screen);
  try {
    await act(() => tree.root.findByType('TextInput').props.onChangeText('hello'));
    await act(() => tree.root.findAllByType('IconButton').find(node => node.props.label === 'Post comment').props.onPress());
    const [job] = store.jobs();
    await act(() => store.set(job.key, { state: 'failed', error: 'No connection – tap to try again', noAnswer: true }));
    const failed = tree.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel === "Couldn't post · tap to try again");
    assert.ok(failed);
    await act(() => failed.props.onPress());
    await act(() => options.at(-1).options.find(choice => choice.label === 'Try again').onPress());
    assert.deepEqual(plain(store.calls.retry), [job.key]);
  } finally { await unmount(tree); }
});
