// Peekaboo+ extras in the app: the ⏰ drop rewind choice on Send to, the 🙈 Peek-a-Save card and the late-drop
// choice itself. The server parts are tested in tests/database/plus-extras.test.mjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScreen, renderScreen, renderer, act, button, textOf, unmount } = require('./harness.cjs');

const ALLOWANCES = { plus: true, savesLeft: 1, saveResetsAt: '2026-12-01T00:00:00Z', rewindsLeft: 1, rewindResetsAt: '2026-11-09T00:00:00Z' };
const dropParams = { 'expo-router': { router: { dismissTo() {}, push() {}, back() {} }, useLocalSearchParams: () => ({ uri: 'file:///qa-photo.jpg', drop: '1' }) } };

test('Send to: the drop rewind choice is hidden when the server does not have it', async () => {
  const tree = await renderScreen(loadScreen('src/app/(app)/share.tsx', dropParams));
  try {
    assert.equal(tree.root.findAllByType('DropRewindOption').length, 0);
  } finally { await unmount(tree); }
});

test('Send to: a rewound late drop asks the server for it and says so', async () => {
  const posts = [];
  const screen = loadScreen('src/app/(app)/share.tsx', {
    ...dropParams,
    '@/lib/plusExtras': { fetchPlusAllowances: async () => ALLOWANCES },
    '@/lib/posts': { createPost: async (...args) => { posts.push(args); return { id: 'qa-post', drop_late_seconds: 0, drop_rewound: true }; } },
  });
  const tree = await renderScreen(screen);
  try {
    const choice = tree.root.findByType('DropRewindOption');
    assert.equal(choice.props.selected, false);
    await act(() => choice.props.onChange(true));
    await act(() => button(tree, /^Send to/).props.onPress());
    assert.equal(posts.length, 1);
    assert.equal(posts[0][3].drop, true);
    assert.equal(posts[0][3].rewind, true);
    assert.match(screen.calls.toasts[0][0], /No 'late' label/);
  } finally { await unmount(tree); }
});

test('Send to: when the server says no, the drop is posted late and the toast says the rewind was not used', async () => {
  const screen = loadScreen('src/app/(app)/share.tsx', {
    ...dropParams,
    '@/lib/plusExtras': { fetchPlusAllowances: async () => ALLOWANCES },
    '@/lib/drop': { lateLabel: (s) => (s <= 120 ? { onTime: true, text: 'On time' } : { onTime: false, text: 'Late by 3h' }) },
    '@/lib/posts': { createPost: async () => ({ id: 'qa-post', drop_late_seconds: 11000, drop_rewound: false }) },
  });
  const tree = await renderScreen(screen);
  try {
    await act(() => tree.root.findByType('DropRewindOption').props.onChange(true));
    await act(() => button(tree, /^Send to/).props.onPress());
    assert.match(screen.calls.toasts[0][0], /Late by 3h \(the rewind wasn't available\)/);
  } finally { await unmount(tree); }
});

function rewindOption({ plus, late = true, left = 1 }) {
  const screen = loadScreen('src/components/DropRewindOption.tsx', {
    '@/lib/drop': { useDropStatus: () => ({ kind: late ? 'late' : 'live', now: 0 }) },
    '@/lib/plus': { usePlus: () => plus },
    '@/lib/plusExtras': { shortDate: () => '9 Nov' },
  });
  const element = (props) => require('react').createElement(screen.exports.DropRewindOption, props);
  return { screen, element };
}

test('Drop rewind choice: shows the weekly count for Plus, and Peekaboo+ for everyone else', async () => {
  const render = async (element) => { let tree; await act(async () => { tree = renderer.create(element); }); return tree; };
  const changes = [];
  const plus = rewindOption({ plus: true });
  let tree = await render(plus.element({ allowances: ALLOWANCES, selected: false, onChange: (on) => changes.push(on) }));
  assert.equal(textOf(tree.root.findAllByType('Text')[0]), "⏰ Post without 'late' (1 left this week)");
  await act(() => tree.root.findByType('Pressable').props.onPress());
  assert.deepEqual(changes, [true]);
  await unmount(tree);

  const usedUp = rewindOption({ plus: true });
  tree = await render(usedUp.element({ allowances: { ...ALLOWANCES, rewindsLeft: 0 }, selected: false, onChange: (on) => changes.push(on) }));
  assert.equal(textOf(tree.root.findAllByType('Text')[0]), "⏰ Post without 'late' (0 left this week)");
  assert.equal(tree.root.findByType('Pressable').props.disabled, true);
  await unmount(tree);

  const free = rewindOption({ plus: false });
  tree = await render(free.element({ allowances: { ...ALLOWANCES, plus: false }, selected: false, onChange: (on) => changes.push(on) }));
  await act(() => tree.root.findByType('Pressable').props.onPress());
  assert.deepEqual(free.screen.calls.routes, [['push', '/plus']]);
  assert.deepEqual(changes, [true]);
  await unmount(tree);

  const notLate = rewindOption({ plus: true, late: false });
  tree = await render(notLate.element({ allowances: ALLOWANCES, selected: false, onChange: () => {} }));
  assert.equal(tree.toJSON(), null, 'only shown once the drop is late');
  await unmount(tree);
});

function saveCard({ plus, peekASave = async () => 12 }) {
  const saved = [];
  const screen = loadScreen('src/components/PeekASaveCard.tsx', {
    '@/lib/plus': { usePlus: () => plus },
    '@/lib/plusExtras': {
      peekASave: async (...args) => { saved.push(args); return peekASave(); },
      brokenStreakText: (s, name) => `Your ${s.streak}-day streak with ${name} broke 😱`,
      hoursLeft: () => '5h left',
      shortDate: () => '1 Dec',
    },
  });
  return { screen, saved };
}

test('Peek-a-Save card: a Plus member saves the streak after saying yes; others are sent to Peekaboo+', async () => {
  const React = require('react');
  const streak = { kind: 'daily_dare', friend_id: 'ayaan', streak: 12, broke_at: '', save_until: '' };
  const friend = { id: 'ayaan', username: 'ayaan', display_name: 'Ayaan' };
  const restored = [];

  const plus = saveCard({ plus: true });
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(plus.screen.exports.PeekASaveCard, { streak, friend, allowances: ALLOWANCES, onSaved: (n) => restored.push(n) })); });
  assert.ok(tree.root.findAllByType('Text').some((t) => textOf(t) === 'Your 12-day streak with Ayaan broke 😱'));
  await act(() => button(tree, '🙈 Peek-a-Save').props.onPress());
  const [title, , choices] = plus.screen.calls.alerts[0];
  assert.match(title, /Peek-a-Save/);
  await act(() => choices.find((c) => c.text === '🙈 Peek-a-Save').onPress());
  assert.deepEqual(plus.saved, [['daily_dare', 'ayaan']]);
  assert.deepEqual(restored, [12]);
  assert.match(plus.screen.calls.toasts[0][0], /Saved! Your 12 day streak with Ayaan is back/);
  await unmount(tree);

  // Used this month: the button is there but can't be pressed.
  const usedUp = saveCard({ plus: true });
  await act(async () => { tree = renderer.create(React.createElement(usedUp.screen.exports.PeekASaveCard, { streak, friend, allowances: { ...ALLOWANCES, savesLeft: 0 }, onSaved: () => {} })); });
  assert.equal(button(tree, '🙈 Peek-a-Save').props.disabled, true);
  await unmount(tree);

  // A refusal from the server is shown, and nothing is marked as saved.
  const refused = saveCard({ plus: true, peekASave: async () => { throw new Error('Peek-a-Save only works for 24 hours after it breaks'); } });
  await act(async () => { tree = renderer.create(React.createElement(refused.screen.exports.PeekASaveCard, { streak, friend, allowances: ALLOWANCES, onSaved: (n) => restored.push(n) })); });
  await act(() => button(tree, '🙈 Peek-a-Save').props.onPress());
  await act(() => refused.screen.calls.alerts[0][2].find((c) => c.text === '🙈 Peek-a-Save').onPress());
  assert.equal(refused.screen.calls.alerts[1][0], 'Could not save it');
  assert.deepEqual(restored, [12]);
  await unmount(tree);

  const free = saveCard({ plus: false });
  await act(async () => { tree = renderer.create(React.createElement(free.screen.exports.PeekASaveCard, { streak, friend, allowances: { ...ALLOWANCES, plus: false }, onSaved: () => {} })); });
  assert.equal(button(tree, '🙈 Peek-a-Save'), undefined);
  await act(() => button(tree, 'Save it with Peekaboo+ ⭐').props.onPress());
  assert.deepEqual(free.screen.calls.routes, [['push', '/plus']]);
  assert.deepEqual(free.saved, []);
  await unmount(tree);
});

