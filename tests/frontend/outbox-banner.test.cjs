const test = require('node:test');
const assert = require('node:assert/strict');
const { React, renderer, loadScreen, act, textOf } = require('./harness.cjs');

// How your sends are doing, wherever you are in the app (src/components/OutboxBanner.tsx): the "Sending…" pill and
// the toasts when a send is in or couldn't go.

function banner({ jobs = [], size = 2 } = {}) {
  const listeners = [];
  const options = [];
  const screen = loadScreen('src/components/OutboxBanner.tsx', {
    '@/lib/outbox': {
      onOutboxDone: (listener) => { listeners.push(listener); return () => {}; },
      groupSize: () => size,
      getVisibleScope: () => null,
      inScope: () => false,
      useOutbox: () => jobs,
      retry() {}, discard: async () => {},
    },
    '@/components/Overlays': { useOverlays: () => ({ showToast: (...args) => screen.calls.toasts.push(args), showOptions: (value) => options.push(value) }) },
  });
  return { screen, listeners, options, done: (job) => listeners.forEach((listener) => listener(job)) };
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
