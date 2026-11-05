const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScreen, renderScreen, act, option, textOf, unmount } = require('./harness.cjs');

// The App icon screen (Settings → App icon): Classic is free, the others are Peekaboo+.
function iconScreen({ plus = false, canChange = true, current = 'classic', fail = null } = {}) {
  const state = { set: [] };
  const screen = loadScreen('src/app/(app)/app-icon.tsx', {
    '@/lib/plus': { usePlus: () => plus },
    '@/lib/appIcons': {
      CAN_CHANGE_APP_ICON: canChange,
      APP_ICONS: [
        { key: 'classic', name: null, label: 'Classic', plus: false, preview: 1 },
        { key: 'midnight', name: 'Midnight', label: 'Midnight', plus: true, preview: 2 },
      ],
      currentAppIcon: () => current,
      setAppIcon: async key => { if (fail) throw new Error(fail); state.set.push(key); },
    },
  });
  return { screen, state };
}

test('without Plus a ⭐ icon opens the Peekaboo+ screen and does not change the icon', async () => {
  const { screen, state } = iconScreen({ plus: false });
  const tree = await renderScreen(screen);
  try {
    assert.match(textOf(option(tree, 'Midnight')), /⭐/);
    await act(() => option(tree, 'Midnight').props.onPress());
    assert.deepEqual(screen.calls.routes, [['push', '/plus']]);
    assert.deepEqual(state.set, []);
  } finally { await unmount(tree); }
});

test('the current icon is ticked, and a member can switch', async () => {
  const { screen, state } = iconScreen({ plus: true });
  const tree = await renderScreen(screen);
  try {
    assert.equal(option(tree, 'Classic').props.accessibilityState.selected, true);
    assert.equal(option(tree, 'Midnight').props.accessibilityState.selected, false);
    await act(() => option(tree, 'Midnight').props.onPress());
    assert.deepEqual(state.set, ['midnight']);
    assert.equal(option(tree, 'Midnight').props.accessibilityState.selected, true);
    assert.equal(screen.calls.toasts.length, 1);
    // Tapping the one you already have does nothing.
    await act(() => option(tree, 'Midnight').props.onPress());
    assert.deepEqual(state.set, ['midnight']);
  } finally { await unmount(tree); }
});

test('Classic is free for everyone', async () => {
  const { screen, state } = iconScreen({ plus: false, current: 'midnight' });
  const tree = await renderScreen(screen);
  try {
    await act(() => option(tree, 'Classic').props.onPress());
    assert.deepEqual(state.set, ['classic']);
    assert.deepEqual(screen.calls.routes, []);
  } finally { await unmount(tree); }
});

test('a phone that cannot change icons says so and changes nothing', async () => {
  const { screen, state } = iconScreen({ plus: true, canChange: false });
  const tree = await renderScreen(screen);
  try {
    assert.ok(tree.root.findAllByType('Text').some(node => /works on iPhone/.test(textOf(node))));
    await act(() => option(tree, 'Midnight').props.onPress());
    assert.deepEqual(state.set, []);
  } finally { await unmount(tree); }
});

test('a refused change shows a friendly alert and keeps the old tick', async () => {
  const { screen } = iconScreen({ plus: true, fail: 'Not now' });
  const tree = await renderScreen(screen);
  try {
    await act(() => option(tree, 'Midnight').props.onPress());
    assert.equal(screen.calls.alerts[0][0], 'Could not change the icon');
    assert.equal(option(tree, 'Classic').props.accessibilityState.selected, true);
  } finally { await unmount(tree); }
});
