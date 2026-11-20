const test = require('node:test');
const assert = require('node:assert/strict');
const { React, renderer, loadScreen, act, unmount, host } = require('./harness.cjs');
const { LIVE, fakeStage, status, newCalls, pressAlert, liveScreenMocks, settle, liveAccessMock } = require('./live-helpers.cjs');

// 🔴 Going live (src/app/(app)/go-live.tsx), the host's screen:
// - the 3·2·1 countdown hides the setup: make the live → ticket → LiveKit → camera → on air;
// - failures each get their own words (camera/microphone, not set up, busy, no internet), never a blanket one;
// - End stops the camera and disconnects BEFORE telling the server, and the summary shows even if the server
//   never answers; the live-now flag is cleared only when Done is tapped;
// - the server ending the live shows the reason's own words (only the host is ever told why).

const PERMISSION = 'Peekaboo needs your camera and microphone so friends can see and hear you';

function renderHost({ lives = {}, stageOptions = {}, role = 'host' } = {}) {
  const log = [];
  const calls = newCalls();
  const { module, handles } = fakeStage(log, stageOptions);
  const access = liveAccessMock(true, { stage: module });
  access.setLiveNow(role); // the Go live button sets this before the screen opens
  access.holdCameraForLive();
  const defaults = {
    startLive: async () => { log.push('startLive'); return LIVE; },
    getLiveToken: async () => { log.push('token'); return { ok: true, url: 'wss://example.livekit.cloud', token: 'host-token', room: `live_${LIVE}`, role: 'host', identity: 'alice', expires_at: '' }; },
    liveOnAir: async () => { log.push('onAir'); },
    livePing: async () => status({ role: 'host', host: { id: 'alice', username: 'alice', display_name: 'Alice', avatar_path: null }, viewers: 3 }),
    liveStatus: async () => status({ role: 'host' }),
    endLiveInBackground: async () => { log.push('endLive'); return { seconds: 1380, viewers: 12, comments: 40, hearts: 248, ended_reason: 'host' }; },
    fetchLiveComments: async () => [],
    listenToLive: () => () => {},
  };
  const { mocks, appState, exits, backPress } = liveScreenMocks({ log, stage: module, access, lives: { ...defaults, ...lives }, calls, params: { facing: 'front' } });
  const screen = loadScreen('src/app/(app)/go-live.tsx', mocks);
  return { screen, log, calls, access, handles, appState, exits, backPress };
}

async function open(setup) {
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(setup.screen.Component)); });
  await settle(act);
  const find = (type) => tree.root.findAllByType(type);
  const card = () => find('LiveCard')[0] ?? null;
  const summary = () => find('HostSummaryCard')[0] ?? null;
  const topBar = () => find('LiveTopBar')[0];
  // The countdown's 1-second ticks (the harness writes timers down instead of running them).
  const tickCountdown = async () => {
    for (let i = 0; i < 3; i++) {
      const timers = setup.screen.calls.timers;
      await act(async () => { timers[timers.length - 1]?.(); });
    }
  };
  return { tree, find, card, summary, topBar, tickCountdown };
}

test('the countdown hides the setup: make the live → ticket → connect → camera → on air, then the LIVE pill', async () => {
  const setup = renderHost();
  const live = await open(setup);
  try {
    assert.deepEqual(setup.log.slice(0, 5), ['startLive', 'token', 'connect:host-token', 'publish:front', 'onAir']);
    // Still counting down: no LIVE pill yet.
    assert.equal(live.topBar().props.onAir, false);
    await live.tickCountdown();
    assert.equal(live.topBar().props.onAir, true);
    assert.equal(setup.access.liveNowRole(), 'host');
    assert.equal(live.card(), null);
  } finally { await unmount(live.tree); }
});

test('failures say why: camera/microphone, not set up, busy, no internet – and a failure after the start ends that live', async () => {
  // The camera or microphone refused while connecting.
  let setup = renderHost({ stageOptions: { publish: async () => { const e = new Error('Permission denied'); e.name = 'NotAllowedError'; throw e; } } });
  let live = await open(setup);
  try {
    assert.equal(live.card().props.title, PERMISSION);
    assert.ok(live.find('Button').some((b) => b.props.title === 'Open Settings'));
    assert.ok(setup.log.includes('endLive'), 'the live made a moment ago is ended again');
    assert.equal(setup.log.includes('onAir'), false, 'friends never get told about a live that failed');
  } finally { await unmount(live.tree); }

  // The server isn't set up for lives yet.
  setup = renderHost({ lives: { getLiveToken: async () => ({ ok: false, reason: 'not_set_up', message: "Lives aren't set up yet.", status: 503 }) } });
  live = await open(setup);
  try {
    assert.equal(live.card().props.title, "Lives aren't working right now – try again in a bit.");
    assert.ok(live.find('Button').some((b) => b.props.title === 'Try again'));
  } finally { await unmount(live.tree); }

  // Too many lives right now: the server's own words.
  setup = renderHost({ lives: { startLive: async () => { const e = new Error('Lives are busy right now – try again later'); e.hint = 'live_busy'; throw e; } } });
  live = await open(setup);
  try {
    assert.equal(live.card().props.title, 'Lives are busy right now – try again later');
  } finally { await unmount(live.tree); }

  // No internet: its own line, with Try again and Close.
  setup = renderHost({ lives: { startLive: async () => { throw new Error('Network request failed'); } } });
  live = await open(setup);
  try {
    assert.equal(live.card().props.title, "Couldn't go live – check your internet");
    const titles = live.find('Button').map((b) => b.props.title);
    assert.ok(titles.includes('Try again') && titles.includes('Close'));
    // Try again starts over.
    await act(() => live.find('Button').find((b) => b.props.title === 'Try again').props.onPress());
    await settle(act);
  } finally { await unmount(live.tree); }
});

test('End: the camera stops and disconnects BEFORE the server is told; the summary shows; Done clears the live', async () => {
  const setup = renderHost();
  const live = await open(setup);
  try {
    await live.tickCountdown();
    setup.log.length = 0;
    await act(() => live.topBar().props.onClose());
    assert.equal(setup.calls.alerts.at(-1)[0], 'End your live?');
    await act(() => pressAlert(setup.calls, 'End'));
    await settle(act);
    const order = setup.log.filter((step) => ['unpublish', 'disconnect', 'endLive'].includes(step));
    assert.deepEqual(order.slice(0, 3), ['unpublish', 'disconnect', 'endLive']);
    assert.ok(setup.access.calls.releases >= 1, 'the camera is given back');
    // The server's numbers replace the phone's.
    assert.deepEqual(JSON.parse(JSON.stringify(live.summary().props.numbers)), { minutes: 23, viewers: 12, hearts: 248, comments: 40 });
    // Still "live" (nothing restarts the app) until Done.
    assert.equal(setup.access.liveNowRole(), 'host');
    await act(() => live.summary().props.onDone());
    assert.equal(setup.access.liveNowRole(), null);
    assert.deepEqual(setup.calls.routes.at(-1), ['back']);
  } finally { await unmount(live.tree); }
});

test('Android\'s back button mid-live asks "End your live?" first (Keep going = still live)', async () => {
  const setup = renderHost();
  const live = await open(setup);
  try {
    await live.tickCountdown();
    let handled;
    await act(async () => { handled = setup.backPress.listener(); });
    assert.equal(handled, true);
    assert.equal(setup.calls.alerts.at(-1)[0], 'End your live?');
    assert.deepEqual(setup.calls.routes, []);
    assert.equal(setup.log.includes('endLive'), false);
  } finally { await unmount(live.tree); }
});

test('the summary shows even when the server never answers', async () => {
  const setup = renderHost({ lives: { endLiveInBackground: async () => { setup.log.push('endLive'); return null; } } });
  const live = await open(setup);
  try {
    await live.tickCountdown();
    await act(() => live.topBar().props.onClose());
    await act(() => pressAlert(setup.calls, 'End'));
    await settle(act);
    const numbers = live.summary().props.numbers;
    assert.equal(numbers.comments, null, 'the phone\'s own numbers (no comment count without the server)');
    assert.equal(typeof numbers.minutes, 'number');
  } finally { await unmount(live.tree); }
});

test('the server ended it: the summary gives the reason (nobody joined, time, reports…)', async () => {
  let pings = 0;
  const setup = renderHost({
    lives: {
      livePing: async () => {
        pings++;
        return pings === 1 ? status({ role: 'host', viewers: 0 }) : status({ status: 'ended', role: null, ended_reason: 'empty' });
      },
      endLiveInBackground: async () => ({ seconds: 300, viewers: 0, comments: 0, hearts: 0, ended_reason: 'empty' }),
    },
  });
  const live = await open(setup);
  try {
    await live.tickCountdown();
    // The second ping (every 15 seconds) says it ended.
    const ping = [...setup.screen.calls.intervals.values()].find(Boolean);
    for (const run of setup.screen.calls.intervals.values()) await act(async () => { run(); });
    await settle(act);
    assert.ok(ping);
    assert.equal(live.summary().props.reason, 'empty');
    assert.ok(setup.log.includes('disconnect'));
  } finally { await unmount(live.tree); }
});

test('the host words for each ending', async () => {
  const screen = loadScreen('src/components/live/LiveEndedCard.tsx', { '@/components/SafeEdge': { SafeEdge: host('SafeEdge') } });
  const { hostEndLine, summaryLine } = screen.exports;
  assert.equal(hostEndLine('time', 60), "That's 60 minutes!");
  assert.equal(hostEndLine('empty'), 'Nobody joined, so we ended your live.');
  assert.equal(hostEndLine('reports'), 'Your live was ended for a safety check.');
  assert.equal(hostEndLine('host_gone'), 'Your connection dropped.');
  assert.equal(hostEndLine('owner'), 'Your live was ended.');
  assert.equal(hostEndLine('safety'), 'Your live was ended.');
  assert.equal(hostEndLine('host'), null);
  assert.equal(summaryLine({ minutes: 23, viewers: 12, hearts: 248, comments: 40 }), '23 min · 12 friends watched · ❤️ 248 · 💬 40');
});

test('opened without the Go live button (no consent seen) or on a phone without lives: nothing starts', async () => {
  const setup = renderHost({ role: null });
  const live = await open(setup);
  try {
    assert.deepEqual(setup.log, []);
    assert.equal(live.find('EmptyState')[0].props.title, 'Go live from the camera');
  } finally { await unmount(live.tree); }
});

test('a notification tapped mid-live can end the live properly first ("End and open")', async () => {
  const setup = renderHost();
  const live = await open(setup);
  try {
    await live.tickCountdown();
    setup.log.length = 0;
    const exit = setup.exits.at(-1);
    await act(async () => { await exit(); });
    assert.deepEqual(setup.log.filter((s) => ['unpublish', 'disconnect', 'endLive'].includes(s)).slice(0, 3), ['unpublish', 'disconnect', 'endLive']);
    assert.equal(setup.access.liveNowRole(), null);
  } finally { await unmount(live.tree); }
});

test('leaving the screen any other way runs the same steps as End', async () => {
  const setup = renderHost();
  const live = await open(setup);
  await live.tickCountdown();
  setup.log.length = 0;
  await unmount(live.tree);
  await settle(act);
  assert.deepEqual(setup.log.filter((s) => ['unpublish', 'disconnect', 'endLive'].includes(s)).slice(0, 3), ['unpublish', 'disconnect', 'endLive']);
  assert.equal(setup.access.liveNowRole(), null);
});

// ---------------------------------------------------------------------------
// Bringing a friend on (the viewers sheet and the answers)
// ---------------------------------------------------------------------------

test('Bring on: asks first, then the answer comes back as a toast; a friend who can\'t come on is greyed out', async () => {
  let listeners = null;
  const asked = [];
  const setup = renderHost({
    lives: {
      listenToLive: (_id, _me, handlers) => { listeners = handlers; return () => {}; },
      inviteCohost: async (id, guest) => { asked.push([id, guest]); return 'invite-1'; },
    },
  });
  const live = await open(setup);
  try {
    await live.tickCountdown();
    const sheet = () => live.find('ViewersSheet')[0];
    const ayaan = { user_id: 'ayaan', username: 'ayaan', display_name: 'Ayaan', avatar_path: null, joined_at: '', is_cohost: false, can_cohost: true };
    await act(() => sheet().props.onBringOn(ayaan));
    assert.equal(setup.calls.alerts.at(-1)[0], 'Bring Ayaan on?');
    assert.equal(setup.calls.alerts.at(-1)[1], 'While Ayaan is on, only friends of you both can watch.');
    await act(() => pressAlert(setup.calls, 'Ask them'));
    await settle(act);
    assert.deepEqual(asked, [[LIVE, 'ayaan']]);
    assert.equal(sheet().props.inviteOpen, true);
    // Declined.
    await act(() => listeners.onInviteChange({ id: 'invite-1', answer: 'declined' }));
    assert.equal(setup.calls.toasts.at(-1), 'Ayaan said not now');
    assert.equal(sheet().props.inviteOpen, false);
    // Grey "Bring on" never says why.
    // (A system pop-up: the app's own messages would be hidden behind the open viewers sheet.)
    await act(() => sheet().props.onCantBringOn(ayaan));
    assert.equal(setup.calls.alerts.at(-1)[0], "Ayaan can't come on right now");
  } finally { await unmount(live.tree); }
});

test('the answers: didn\'t answer → a toast; cancelled → nothing; asked twice → "You can\'t ask … again this live"', async () => {
  let listeners = null;
  let refuse = false;
  const setup = renderHost({
    lives: {
      listenToLive: (_id, _me, handlers) => { listeners = handlers; return () => {}; },
      inviteCohost: async () => {
        if (refuse) { const e = new Error('You can’t ask Ayaan again this live.'); e.hint = 'live_invite_wait'; throw e; }
        return 'invite-2';
      },
    },
  });
  const live = await open(setup);
  try {
    await live.tickCountdown();
    const ayaan = { user_id: 'ayaan', username: 'ayaan', display_name: 'Ayaan', avatar_path: null, joined_at: '', is_cohost: false, can_cohost: true };
    await act(() => live.find('ViewersSheet')[0].props.onBringOn(ayaan));
    await act(() => pressAlert(setup.calls, 'Ask them'));
    await settle(act);
    await act(() => listeners.onInviteChange({ id: 'invite-2', answer: 'expired' }));
    assert.equal(setup.calls.toasts.at(-1), "Ayaan didn't answer");
    const before = setup.calls.toasts.length;
    await act(() => listeners.onInviteChange({ id: 'invite-2', answer: 'cancelled' }));
    assert.equal(setup.calls.toasts.length, before);
    refuse = true;
    await act(() => live.find('ViewersSheet')[0].props.onBringOn(ayaan));
    await act(() => pressAlert(setup.calls, 'Ask them'));
    await settle(act);
    assert.equal(setup.calls.toasts.at(-1), "You can't ask Ayaan again this live");
  } finally { await unmount(live.tree); }
});

test('an ask nobody answers clears itself after a minute ("… didn\'t answer"), without waiting for the server', async () => {
  let listeners = null;
  const setup = renderHost({
    lives: {
      listenToLive: (_id, _me, handlers) => { listeners = handlers; return () => {}; },
      inviteCohost: async () => 'invite-3',
    },
  });
  const live = await open(setup);
  try {
    await live.tickCountdown();
    const ayaan = { user_id: 'ayaan', username: 'ayaan', display_name: 'Ayaan', avatar_path: null, joined_at: '', is_cohost: false, can_cohost: true };
    await act(() => live.find('ViewersSheet')[0].props.onBringOn(ayaan));
    await act(() => pressAlert(setup.calls, 'Ask them'));
    await settle(act);
    assert.equal(live.find('ViewersSheet')[0].props.inviteOpen, true);
    // The minute runs out (the newest timer is the ask's).
    const timers = setup.screen.calls.timers;
    await act(async () => { timers[timers.length - 1](); });
    assert.equal(setup.calls.toasts.at(-1), "Ayaan didn't answer");
    assert.equal(live.find('ViewersSheet')[0].props.inviteOpen, false);
    // The server's own "expired" a little later says nothing more.
    const before = setup.calls.toasts.length;
    await act(() => listeners.onInviteChange({ id: 'invite-3', answer: 'expired' }));
    assert.equal(setup.calls.toasts.length, before);
  } finally { await unmount(live.tree); }
});

test('the viewers sheet: grey Bring on when they can\'t come on; empty: "No friends watching yet"', async () => {
  const viewers = [
    { user_id: 'a', username: 'ayaan', display_name: 'Ayaan', avatar_path: null, joined_at: '2026-11-20T10:01:00Z', is_cohost: false, can_cohost: false },
    { user_id: 'b', username: 'bea', display_name: 'Bea', avatar_path: null, joined_at: '2026-11-20T10:02:00Z', is_cohost: false, can_cohost: true },
  ];
  const bringOn = [];
  const cant = [];
  const load = (list) => loadScreen('src/components/live/ViewersSheet.tsx', {
    '@/components/IconButton': { IconButton: host('IconButton') },
    '@/components/SafeEdge': { SafeEdge: host('SafeEdge') },
    '@/lib/lives': { fetchLiveViewers: async () => list },
  });
  const props = { visible: true, liveId: LIVE, cohostId: null, inviteOpen: false, onClose() {}, onBringOn: (v) => bringOn.push(v.username), onCantBringOn: (v) => cant.push(v.username), onRemove() {}, onBackToWatching() {} };
  let screen = load(viewers);
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(screen.exports.ViewersSheet, props)); });
  await settle(act);
  try {
    const bring = (name) => tree.root.findAllByType('Pressable').find((p) => p.props.accessibilityLabel === `Bring ${name} on`);
    assert.equal(bring('Ayaan').props.accessibilityState.disabled, true);
    assert.equal(bring('Bea').props.accessibilityState.disabled, false);
    await act(() => bring('Ayaan').props.onPress());
    await act(() => bring('Bea').props.onPress());
    assert.deepEqual(cant, ['ayaan']);
    assert.deepEqual(bringOn, ['bea']);
  } finally { await unmount(tree); }

  screen = load([]);
  await act(async () => { tree = renderer.create(React.createElement(screen.exports.ViewersSheet, props)); });
  await settle(act);
  try {
    assert.ok(tree.root.findAllByType('Text').some((t) => t.props.children === 'No friends watching yet'));
  } finally { await unmount(tree); }
});
