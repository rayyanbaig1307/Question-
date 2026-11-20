const test = require('node:test');
const assert = require('node:assert/strict');
const { React, renderer, loadScreen, act, unmount, host, textOf } = require('./harness.cjs');

// "How did you hear about Peekaboo?" – pick one and Continue, or Skip. Either way the app opens.
const OPTIONS = [
  { source: 'friend', emoji: '👯', label: 'A friend' },
  { source: 'tiktok', emoji: '🎵', label: 'TikTok' },
  { source: 'other', emoji: '✨', label: 'Something else' },
];

async function render() {
  const saved = [];
  let done = 0;
  const { HeardAbout } = loadScreen('src/components/HeardAbout.tsx', {
    '@/components/FormScreen': { FormScreen: host('FormScreen') },
    '@/components/TextField': { TextField: host('TextField') },
    '@/lib/heardAbout': { HEARD_ABOUT_OPTIONS: OPTIONS, saveHeardAbout: async (...args) => saved.push(args) },
  }).exports;
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(HeardAbout, { userId: 'alice', onDone: () => { done++; } })); });
  const option = (label) => tree.root.findAll((n) => n.props.accessibilityRole === 'radio' && n.props.accessibilityLabel === label)[0];
  const button = (title) => tree.root.findAllByType('Button').find((n) => n.props.title === title);
  return { tree, saved, done: () => done, option, button };
}

test('Continue does nothing until you pick one; then it saves your pick and opens the app', async () => {
  const s = await render();
  assert.equal(s.button('Continue').props.disabled, true);
  await act(async () => s.option('TikTok').props.onPress());
  assert.equal(s.button('Continue').props.disabled, false);
  await act(async () => s.button('Continue').props.onPress());
  assert.deepEqual(s.saved.map((a) => a.slice(0, 2)), [['alice', 'tiktok']]);
  assert.equal(s.done(), 1);
  await unmount(s.tree);
});

test('"Something else" asks where, and sends those words', async () => {
  const s = await render();
  assert.equal(s.tree.root.findAllByType('TextField').length, 0);
  await act(async () => s.option('Something else').props.onPress());
  await act(async () => s.tree.root.findByType('TextField').props.onChangeText('a poster at school'));
  await act(async () => s.button('Continue').props.onPress());
  assert.deepEqual(s.saved, [['alice', 'other', 'a poster at school']]);
  await unmount(s.tree);
});

test('Skip is always there, saves "skipped" and opens the app; there is no back button', async () => {
  const s = await render();
  assert.equal(s.tree.root.findByType('FormScreen').props.showBack, false);
  await act(async () => s.button('Skip').props.onPress());
  assert.deepEqual(s.saved.map((a) => a[1]), ['skipped']);
  assert.equal(s.done(), 1);
  await unmount(s.tree);
});
