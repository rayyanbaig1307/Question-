import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import { loadLibrary } from '../unit/libHarness.mjs';
const require = createRequire(import.meta.url);
const { React, renderer, act, unmount } = require('../frontend/harness.cjs');
afterEach(() => vi.useRealTimers());

function harness() {
  let actions, menu;
  const alerts = [], toast = vi.fn(), route = vi.fn();
  const block = vi.fn(async () => {}), report = vi.fn(async () => {});
  const lib = loadLibrary('useSafetyActions', {
    mocks: {
      react: React,
      'expo-router': { router: { canGoBack: () => true, back: route } },
      'react-native': { Alert: { alert: (...args) => alerts.push(args) } },
      '@/components/Overlays': { useOverlays: () => ({ showOptions: (value) => { menu = value; }, showToast: toast }) },
      './auth': { useAuth: () => ({ userId: 'A' }) },
      './safety': { blockUser: block, reportContent: report, REPORT_REASONS: [{ code: 'spam', label: 'Spam' }] },
    },
  });
  function Consumer() { actions = lib.useSafetyActions(); return null; }
  return {
    alerts, toast, route, block, report,
    get actions() { return actions; }, get menu() { return menu; },
    async render() { let tree; await act(() => { tree = renderer.create(React.createElement(Consumer)); }); return tree; },
  };
}
const user = { id: 'target', username: 'target' };

it('a native Block confirmation cannot act after its account screen unmounts', async () => {
  const h = harness(), tree = await h.render();
  h.actions.confirmBlock(user);
  const callback = h.alerts[0][2].find((button) => button.text === 'Block').onPress;
  await unmount(tree);
  await callback();
  expect(h.block).not.toHaveBeenCalled();
});

it('a report menu callback cannot act after its account screen unmounts', async () => {
  const h = harness(), tree = await h.render();
  h.actions.report({ user, contentType: 'user' });
  const callback = h.menu.options[0].onPress;
  await unmount(tree);
  await callback();
  expect(h.report).not.toHaveBeenCalled();
});

it('the delayed Block prompt after reporting does not open for a new account', async () => {
  vi.useFakeTimers();
  const h = harness(), tree = await h.render();
  h.actions.report({ user, contentType: 'user' });
  await h.menu.options[0].onPress();
  const callback = h.alerts[0][2].find((button) => button.text === 'Block').onPress;
  callback();
  await unmount(tree);
  await vi.advanceTimersByTimeAsync(400);
  expect(h.alerts).toHaveLength(1);
  expect(h.block).not.toHaveBeenCalled();
});

it('a late block response cannot navigate or show a toast in another account', async () => {
  const h = harness(), tree = await h.render();
  let finish;
  h.block.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  h.actions.confirmBlock(user);
  const callback = h.alerts[0][2].find((button) => button.text === 'Block').onPress;
  const pending = callback();
  await unmount(tree);
  finish();
  await pending;
  expect(h.toast).not.toHaveBeenCalled();
  expect(h.route).not.toHaveBeenCalled();
});

it('block and report writes carry the account that approved them', async () => {
  const h = harness(), tree = await h.render();
  try {
    h.actions.confirmBlock(user);
    await h.alerts[0][2].find((button) => button.text === 'Block').onPress();
    expect(h.block).toHaveBeenCalledWith('target', 'A');
    h.actions.report({ user, contentType: 'user' });
    await h.menu.options[0].onPress();
    expect(h.report.mock.calls[0][0]).toMatchObject({ reporterUserId: 'A', reportedUserId: 'target' });
  } finally { await unmount(tree); }
});
