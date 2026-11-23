const test = require('node:test');
const assert = require('node:assert/strict');
const { React, renderer, loadScreen, act, textOf } = require('./harness.cjs');

// How your sends are doing, wherever you are in the app (src/components/OutboxBanner.tsx): the "Sending…" pill and
// the toasts when a send is in or couldn't go.

function banner({ jobs = [], size = 2 } = {}) {
  const listeners = [];
  const options = [];
  const retried = [];
  const screen = loadScreen('src/components/OutboxBanner.tsx', {
    '@/lib/outbox': {
      onOutboxDone: (listener) => { listeners.push(listener); return () => {}; },
      groupSize: () => size,
      getVisibleScope: () => null,
      inScope: () => false,
      useOutbox: () => jobs,
      retry: (key) => retried.push(key), discard: async () => {},
    },
    '@/components/Overlays': { useOverlays: () => ({ showToast: (...args) => screen.calls.toasts.push(args), showOptions: (value) => options.push(value) }) },
  });
  return { screen, listeners, options, retried, done: (job) => listeners.forEach((listener) => listener(job)) };
}

async function render(Component, props) {
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(Component, props)); });
  return tree;
}

const story = { key: 's', owner: 'alice', group: 'g', state: 'sent', what: { kind: 'story', audience: 'everyone' } };
const peek = (state, extra = {}) => ({ key: 'p', owner: 'alice', group: 'g', state, what: { kind: 'peek', friendIds: ['ray'], names: { ray: 'Ray' } }, ...extra });

// Review TOAST-GROUP-FAILURE: a failed send never counted as finished, so the toast for the rest of a "Send to…"
// never showed (you didn't know your story went).
test('Send to… with a refused peek and a story that went: both toasts show', async () => {
  const { screen, done } = banner();
  const tree = await render(screen.exports.OutboxToasts, { userId: 'alice' });
  try {
    await act(() => done(peek('failed', { final: true, error: 'You need to be friends to chat' })));
    await act(() => done(story));
    const toasts = screen.calls.toasts.map(([words]) => words);
    assert.deepEqual(toasts, ["Couldn't send your peek to Ray: You need to be friends to chat", 'Shared to your story! 🎉']);
  } finally { await act(() => tree.unmount()); }
});

test('Send to… with a drop that was refused and a peek that went: the peek still gets its toast', async () => {
  const { screen, done } = banner();
  const tree = await render(screen.exports.OutboxToasts, { userId: 'alice' });
  try {
    const dropJob = { key: 'd', owner: 'alice', group: 'g', state: 'failed', final: true, error: "You've already posted today's Peekaboo drop", what: { kind: 'post', caption: '', audience: 'everyone', drop: true } };
    await act(() => done(dropJob));
    await act(() => done(peek('sent')));
    const toasts = screen.calls.toasts.map(([words]) => words);
    assert.deepEqual(toasts, ["Your drop didn't post: You've already posted today's Peekaboo drop", 'Peek sent to Ray! 💌']);
  } finally { await act(() => tree.unmount()); }
});

// Review PILL-COVERS-CONTROLS: the pill sat on the camera's flip and flash buttons and took their taps.
test('the pill sits below the top bars, lets taps through while sending, and stays short when something failed', async () => {
  const sending = banner({ jobs: [peek('sending')] });
  const tree = await render(sending.screen.exports.SendingPill, { userId: 'alice' });
  try {
    const wrap = tree.root.findAllByType('View')[0];
    assert.equal(wrap.props.pointerEvents, 'none');
    assert.equal(wrap.props.style[1].top, sending.screen.exports.PILL_TOP);
    assert.ok(sending.screen.exports.PILL_TOP >= 56, 'below a 56-point top bar');
    assert.equal(textOf(tree.root.findByType('Text')), '📤 Sending to Ray…');
  } finally { await act(() => tree.unmount()); }

  const failed = banner({ jobs: [{ ...peek('failed'), error: 'No connection – tap to try again', final: false }] });
  const failedTree = await render(failed.screen.exports.SendingPill, { userId: 'alice' });
  try {
    const wrap = failedTree.root.findAllByType('View')[0];
    assert.equal(wrap.props.pointerEvents, 'box-none');
    assert.equal(textOf(failedTree.root.findByType('Text')), '⚠️ Not sent · tap');
    await act(() => failedTree.root.findByType('Pressable').props.onPress());
    assert.equal(failed.options.length, 1);
    assert.match(failed.options[0].title, /^Couldn't send your peek to Ray/);
  } finally { await act(() => failedTree.unmount()); }
});

// PILL-NO-RETRY: an old send that can't go any more (its picture was gone after a restart) came first in the list,
// and the sheet only looked at that one: no "Try again" at all, so a drop that failed later could only be deleted
// (together with the old one).
test('the pill offers Try again when any failed send can still go, and talks about your drop first', async () => {
  const gone = { key: 'old', owner: 'alice', state: 'failed', restored: true, final: true, error: 'Not sent – tap to remove', what: { kind: 'story', audience: 'everyone' } };
  const dropJob = { key: 'd', owner: 'alice', group: 'g', state: 'failed', final: false, noAnswer: true, error: 'No connection – tap to try again', what: { kind: 'post', caption: '', audience: 'everyone', drop: true } };
  const failedPeek = { ...peek('failed'), error: 'No connection – tap to try again', final: false };
  const open = async (jobs) => {
    const setup = banner({ jobs });
    const tree = await render(setup.screen.exports.SendingPill, { userId: 'alice' });
    try {
      await act(() => tree.root.findByType('Pressable').props.onPress());
      // (The screen's own arrays come from its little world: copied into plain ones to compare.)
      return { setup, label: textOf(tree.root.findByType('Text')), sheet: setup.options[0], labels: [...setup.options[0].options].map((option) => option.label) };
    } finally { await act(() => tree.unmount()); }
  };

  const withDrop = await open([gone, dropJob]);
  assert.equal(withDrop.label, '⚠️ Drop not posted · tap');
  assert.equal(withDrop.sheet.title, "Your drop didn't post – tap the banner to try again");
  assert.deepEqual(withDrop.labels, ['Try again', 'Delete (2)']);
  await act(() => withDrop.sheet.options[0].onPress());
  assert.deepEqual(withDrop.setup.retried, ['d'], 'only the drop is tried again (the old one can only be deleted)');

  // No drop: the sheet talks about the one that can still go.
  const withPeek = await open([gone, failedPeek]);
  assert.match(withPeek.sheet.title, /^Couldn't send your peek to Ray/);
  assert.equal(withPeek.sheet.options[0].label, 'Try again');
  await act(() => withPeek.sheet.options[0].onPress());
  assert.deepEqual(withPeek.setup.retried, ['p']);

  // Nothing can go any more: only Delete.
  const onlyGone = await open([gone]);
  assert.deepEqual(onlyGone.labels, ['Delete']);

  // Yesterday's drop (its day is over, so it can only be deleted) is still on the list when today's drop fails:
  // the sheet talks about today's drop, which can still go – not "it can't be posted now", which would make you
  // delete both.
  const deadDrop = { key: 'yesterday', owner: 'alice', state: 'failed', restored: true, final: true, error: "This drop was for an earlier day – it can't be posted now", what: { kind: 'post', caption: '', audience: 'everyone', drop: true } };
  const twoDrops = await open([deadDrop, dropJob]);
  assert.equal(twoDrops.label, '⚠️ Drop not posted · tap');
  assert.equal(twoDrops.sheet.title, "Your drop didn't post – tap the banner to try again");
  assert.deepEqual(twoDrops.labels, ['Try again', 'Delete (2)']);
  await act(() => twoDrops.sheet.options[0].onPress());
  assert.deepEqual(twoDrops.setup.retried, ['d'], "only today's drop is tried again");

  // Only yesterday's drop is left: the sheet says why it can't go, and only offers Delete.
  const onlyDeadDrop = await open([deadDrop]);
  assert.match(onlyDeadDrop.sheet.title, /earlier day – it can't be posted now/);
  assert.deepEqual(onlyDeadDrop.labels, ['Delete']);
});
