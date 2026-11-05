// The story ring on profile pictures (src/components/StoryAvatar.tsx).
const test = require('node:test');
const assert = require('node:assert/strict');
const { React, renderer, act, host, loadScreen } = require('./harness.cjs');

const bob = { id: 'bob', username: 'bob', display_name: 'Bob', avatar_path: 'bob/a.jpg' };

function load(badges = new Map()) {
  const asked = [];
  const screen = loadScreen('src/components/StoryAvatar.tsx', {
    'expo-linear-gradient': { LinearGradient: host('LinearGradient') },
    'react-native-reanimated': {
      __esModule: true,
      default: { View: host('AnimatedView') },
      cancelAnimation: () => {}, Easing: { inOut: f => f, ease: 'ease' },
      useAnimatedStyle: () => ({}), useReducedMotion: () => false,
      useSharedValue: value => ({ get: () => value, set: () => {} }),
      withRepeat: value => value, withTiming: value => value,
    },
    '@/lib/storyRings': { useStoryBadge: (me, id) => { asked.push([me, id]); return id ? badges.get(id) ?? null : null; } },
    '@/theme': { colors: { border: 'grey', green: 'green', bg: 'bg' }, gradients: { brand: ['pink', 'purple'] } },
  });
  return { StoryAvatar: screen.exports.StoryAvatar, routes: screen.calls.routes, asked };
}
async function render(StoryAvatar, props) {
  let tree;
  await renderer.act(async () => { tree = renderer.create(React.createElement(StoryAvatar, props)); });
  return tree;
}
const ringColors = tree => tree.root.findAllByType('LinearGradient').map(node => node.props.colors.join('+'));

test('no story: just the picture – a tap goes to whatever it sits in, or to the fallback when one is given', async () => {
  const { StoryAvatar, routes } = load();
  let tree = await render(StoryAvatar, { person: bob, size: 52 });
  assert.equal(tree.root.findAllByType('Pressable').length, 0);
  assert.equal(tree.root.findAllByType('LinearGradient').length, 0);
  assert.equal(tree.root.findByType('Avatar').props.size, 52);
  await act(() => tree.unmount());
  let opened = 0;
  tree = await render(StoryAvatar, { person: bob, size: 36, onPress: () => opened++, label: 'Open Bob\'s profile' });
  const press = tree.root.findByType('Pressable');
  assert.equal(press.props.accessibilityLabel, 'Open Bob\'s profile');
  await act(() => press.props.onPress());
  assert.equal(opened, 1);
  assert.equal(routes.length, 0);
  await act(() => tree.unmount());
});

test('a new story: a glowing pink-purple ring, the same size as the plain picture, and a tap opens the story', async () => {
  const { StoryAvatar, routes, asked } = load(new Map([['bob', { allSeen: false, closeFriends: false }]]));
  let fallback = 0;
  const tree = await render(StoryAvatar, { person: bob, size: 52, onPress: () => fallback++ });
  try {
    assert.deepEqual(asked.at(-1), ['alice', 'bob']);
    const press = tree.root.findByType('Pressable');
    assert.equal(press.props.accessibilityLabel, 'Watch Bob\'s story');
    assert.equal(tree.root.findAllByType('AnimatedView').length, 1, 'the glow');
    assert.deepEqual(ringColors(tree), ['pink+purple', 'pink+purple']);
    const box = tree.root.findAllByType('View')[0];
    assert.deepEqual([box.props.style.width, box.props.style.height], [52, 52]);
    assert.equal(tree.root.findByType('Avatar').props.size, 52 - 2 * (2 + 2));
    await act(() => press.props.onPress());
    assert.deepEqual(JSON.parse(JSON.stringify(routes.at(-1))), ['push', { pathname: '/stories/[user]', params: { user: 'bob' } }]);
    assert.equal(fallback, 0, 'with a story, the picture opens the story instead of the fallback');
  } finally { await act(() => tree.unmount()); }
});

test('a watched story: a grey ring without the glow (it still opens); a close-friends story: green', async () => {
  const { StoryAvatar, routes } = load(new Map([['bob', { allSeen: true, closeFriends: false }], ['cara', { allSeen: false, closeFriends: true }]]));
  let tree = await render(StoryAvatar, { person: bob, size: 40 });
  assert.equal(tree.root.findAllByType('AnimatedView').length, 0);
  assert.deepEqual(ringColors(tree), ['grey+grey']);
  await act(() => tree.root.findByType('Pressable').props.onPress());
  assert.equal(routes.length, 1);
  await act(() => tree.unmount());
  tree = await render(StoryAvatar, { person: { id: 'cara', username: 'cara' }, size: 92 });
  assert.deepEqual(ringColors(tree), ['green+green', 'green+green']);
  assert.equal(tree.root.findByType('Avatar').props.size, 92 - 2 * (3 + 3), 'a big picture gets a slightly thicker ring');
  await act(() => tree.unmount());
});

test('your own story says "Watch my story"; a screen that already knows (the profile page) passes the ring itself', async () => {
  const { StoryAvatar, asked } = load(new Map([['alice', { allSeen: false, closeFriends: false }]]));
  let tree = await render(StoryAvatar, { person: { id: 'alice', username: 'alice' }, size: 92 });
  assert.equal(tree.root.findByType('Pressable').props.accessibilityLabel, 'Watch my story');
  await act(() => tree.unmount());
  const before = asked.length;
  tree = await render(StoryAvatar, { person: bob, size: 92, badge: { allSeen: true, closeFriends: false } });
  assert.deepEqual(ringColors(tree), ['grey+grey']);
  assert.ok(asked.slice(before).every(([, id]) => id === null), 'the shared list is not used for this picture');
  await act(() => tree.unmount());
  tree = await render(StoryAvatar, { person: bob, size: 92, badge: null });
  assert.equal(tree.root.findAllByType('Pressable').length, 0, 'the profile page says: no story');
  await act(() => tree.unmount());
});

test('holding the picture still does what holding the row does (menus), with or without a story', async () => {
  const { StoryAvatar } = load(new Map([['bob', { allSeen: false, closeFriends: false }]]));
  let held = 0;
  for (const person of [bob, { id: 'dan', username: 'dan' }]) {
    const tree = await render(StoryAvatar, { person, size: 52, onPress: () => {}, onLongPress: () => held++ });
    await act(() => tree.root.findByType('Pressable').props.onLongPress());
    await act(() => tree.unmount());
  }
  assert.equal(held, 2);
});

test('no person yet (still loading): a plain picture, nothing to tap', async () => {
  const { StoryAvatar } = load();
  const tree = await render(StoryAvatar, { person: null, size: 32 });
  assert.equal(tree.root.findAllByType('Pressable').length, 0);
  assert.equal(tree.root.findByType('Avatar').props.size, 32);
  await act(() => tree.unmount());
});

test('a person row shows the story picture, but a plain one inside a sheet (the story viewer\'s "Seen by" list)', async () => {
  const screen = loadScreen('src/components/PersonRow.tsx', {});
  for (const [plain, type] of [[false, 'StoryAvatar'], [true, 'Avatar']]) {
    let tree;
    await renderer.act(async () => { tree = renderer.create(React.createElement(screen.exports.PersonRow, { person: bob, plain })); });
    assert.equal(tree.root.findAllByType(type).length, 1, type);
    assert.equal(tree.root.findAllByType(plain ? 'StoryAvatar' : 'Avatar').length, 0);
    await act(() => tree.unmount());
  }
  const { readSource } = require('./harness.cjs');
  assert.match(readSource('src/app/(app)/stories/[user].tsx'), /<PersonRow person=\{item\} plain \/>/);
});

test('where the picture sits in a row that opens something, it does the same without a story (members, comments, chat list)', () => {
  const { readSource } = require('./harness.cjs');
  assert.match(readSource('src/app/(app)/groups/[id].tsx'), /<StoryAvatar\s+person=\{member\.profile\}\s+size=\{40\}\s+onPress=\{\(\) => router\.push\(`\/profile\/\$\{member\.userId\}`\)\}\s+onLongPress=\{\(\) => memberMenu\(member\)\}/);
  assert.match(readSource('src/app/(app)/comments/[postId].tsx'), /<StoryAvatar[\s\S]{0,120}onPress=\{\(\) => item\.author && openProfile\(item\.author\.id\)\}/);
});
