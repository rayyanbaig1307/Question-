const test = require('node:test');
const assert = require('node:assert/strict');
const { React, renderer, loadScreen, act, unmount, host, textOf } = require('./harness.cjs');
const { LIVE, HOST, GUEST, fakeStage, person, status, newCalls, pressAlert, liveScreenMocks, settle, liveAccessMock } = require('./live-helpers.cjs');

// 🔴 Watching a friend's live (src/app/(app)/live/[id].tsx), and being brought on as the co-host:
// - phones that can't do lives say why; nothing is loaded;
// - "live now" is set before the server is asked anything;
// - the ended, removed, can't-watch, waiting, full and "not working" cards (with Report and Block where the
//   person was there – reports are taken for 24 hours after a live);
// - Block @cohost in ⋯; blocking a commenter keeps the live open;
// - coming on stage: camera and microphone first (no → we answer "not now" for you), then the rules if needed,
//   then off the viewer connection → camera held → a co-host ticket (retrying while the stage gets ready) →
//   connect → camera on;
// - a comment that breaks the rules is refused before anything is sent.

const SAM = person(HOST, 'sam', 'Sam');
const AYAAN = person(GUEST, 'ayaan', 'Ayaan');

function renderViewer({ lives = {}, access, permissions = 'ok', stageOptions = {} } = {}) {
  const log = [];
  const calls = newCalls();
  const { module, handles } = fakeStage(log, stageOptions);
  const liveAccess = access ?? liveAccessMock(true, { stage: module });
  const handlers = {};
  let tickets = 0;
  const defaults = {
    liveStatus: async () => { log.push(`status(as ${liveAccess.liveNowRole()})`); return status(); },
    livePing: async () => status(),
    getLiveToken: async () => { tickets++; log.push('token'); return { ok: true, url: 'wss://x', token: `viewer-token`, room: `live_${LIVE}`, role: 'viewer', identity: 'alice', expires_at: '' }; },
    leaveLive: async () => { log.push('leaveLive'); },
    listenToLive: (_id, _me, given) => { Object.assign(handlers, given); return () => {}; },
    fetchLiveComments: async () => [],
    answerCohostInvite: async (invite, accept) => { log.push(`answer:${accept}`); return { role: accept ? 'cohost' : 'viewer' }; },
    endCohost: async () => { log.push('endCohost'); },
    // On stage: the people who may see you (the host and you).
    fetchStageWatchers: async () => [HOST, 'alice'],
    sendLiveComment: async (_id, text) => { log.push(`comment:${text}`); return { id: 'c-new', live_id: LIVE, user_id: 'alice', name: 'Alice', avatar_path: null, body: text, created_at: '', deleted_at: null }; },
  };
  const { mocks, appState, focus } = liveScreenMocks({ log, stage: module, access: liveAccess, lives: { ...defaults, ...lives }, calls, params: { id: LIVE } });
  mocks['@/lib/livePermissions'] = { ensureLivePermissions: async () => { log.push(`permissions:${permissions}`); return permissions; }, openPhoneSettings() {} };
  const screen = loadScreen('src/app/(app)/live/[id].tsx', mocks);
  return { screen, log, calls, access: liveAccess, handlers, handles, appState, focus, tickets: () => tickets };
}

async function open(setup) {
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(setup.screen.Component)); });
  await settle(act);
  const find = (type) => tree.root.findAllByType(type);
  const card = () => find('LiveCard')[0] ?? null;
  const buttons = () => (card() ? card().findAllByType('Button').map((b) => b.props.title) : []);
  // Runs the newest waiting timer the screen set (retries).
  const runLastTimer = async () => {
    const timers = setup.screen.calls.timers;
    await act(async () => { timers[timers.length - 1](); });
    await settle(act);
  };
  return { tree, find, card, buttons, runLastTimer };
}

test('phones that can\'t do lives say why (and never load LiveKit)', async () => {
  for (const [reason, words] of [
    ['update', 'Update Peekaboo to watch lives 🔴'],
    ['android', "Lives aren't on Android yet – soon! 🔴"],
    ['off', 'Lives are switched off for now.'],
    ['broken', "Lives aren't working on this phone right now."],
  ]) {
    const access = liveAccessMock(false);
    access.liveUnavailableReason = () => reason;
    const setup = renderViewer({ access });
    const live = await open(setup);
    try {
      assert.equal(live.find('EmptyState')[0].props.title, words);
      assert.equal(access.calls.loads, 0);
      assert.deepEqual(setup.log, []);
      assert.equal(access.liveNowRole(), null);
    } finally { await unmount(live.tree); }
  }
});

test('joining: "live now" is set first, then the status, the ticket, and a hidden connection (no camera)', async () => {
  const setup = renderViewer();
  const live = await open(setup);
  try {
    assert.deepEqual(setup.log.slice(0, 3), ['status(as viewer)', 'token', 'connect:viewer-token']);
    assert.equal(setup.log.some((step) => step.startsWith('publish')), false, 'a viewer never sends their camera');
    assert.equal(live.card(), null);
    assert.equal(live.find('LiveTopBar')[0].props.onAir, true);
    assert.equal(setup.access.calls.holds, 0);
  } finally { await unmount(live.tree); }
  // Leaving: disconnect first, then tell the server; nothing is live any more.
  await settle(act);
  const end = setup.log.slice(-2);
  assert.deepEqual(end, ['disconnect', 'leaveLive']);
  assert.equal(setup.access.liveNowRole(), null);
});

test('the host\'s camera switched off (their app went to the background): "⏸ Sam will be right back"', async () => {
  const setup = renderViewer();
  const live = await open(setup);
  try {
    const sam = { videoTrackPublications: new Map([['camera', {}]]), isCameraEnabled: true };
    setup.handles[0].room = () => ({ remoteParticipants: new Map([[HOST, sam]]) });
    const check = async () => { for (const run of setup.screen.calls.intervals.values()) await act(async () => { run(); }); };
    await check();
    assert.equal(textOf(live.tree.toJSON()).includes('will be right back'), false);
    sam.isCameraEnabled = false;
    await check();
    assert.ok(textOf(live.tree.toJSON()).includes('⏸ Sam will be right back'));
    sam.isCameraEnabled = true;
    await check();
    assert.equal(textOf(live.tree.toJSON()).includes('will be right back'), false);
  } finally { await unmount(live.tree); }
});

test('the end card: never says why, offers "Say something nice", Report and Block', async () => {
  const setup = renderViewer({ lives: { liveStatus: async () => status({ status: 'ended', role: null, ended_reason: null }) } });
  const live = await open(setup);
  try {
    assert.equal(live.card().props.title, "Sam's live has ended");
    assert.deepEqual(live.buttons(), ['Say something nice 💬', 'Report @sam', 'Block @sam', 'Done']);
    await act(() => live.card().findAllByType('Button')[0].props.onPress());
    // The chat takes the live screen's place (the live is over: nothing counts as "live now" any more).
    assert.deepEqual(setup.calls.routes.at(-1), ['replace', `/chat/${HOST}`]);
    await act(() => live.card().findAllByType('Button')[1].props.onPress());
    assert.equal(setup.calls.reports.at(-1).contentType, 'live');
    assert.equal(setup.calls.reports.at(-1).contentId, LIVE);
    assert.equal(setup.calls.reports.at(-1).user.id, HOST);
  } finally { await unmount(live.tree); }
});

test('removed, not allowed and waiting cards (Report and Block where you were there)', async () => {
  let setup = renderViewer({ lives: { liveStatus: async () => status({ status: 'removed', role: null }) } });
  let live = await open(setup);
  try {
    assert.equal(live.card().props.title, 'You were removed from this live.');
    assert.deepEqual(live.buttons(), ['Report @sam', 'Block @sam', 'Done']);
  } finally { await unmount(live.tree); }

  setup = renderViewer({ lives: { liveStatus: async () => ({ status: 'not_allowed', role: null, live_id: LIVE, host: null, cohost: null, viewers: 0, invite: null }) } });
  live = await open(setup);
  try {
    assert.equal(live.card().props.title, "This live is only for the host's friends.");
    assert.deepEqual(live.buttons(), ['Done']);
  } finally { await unmount(live.tree); }

  // Paused by the stage rule: wait (re-checked every 15 seconds), and back in by itself.
  let paused = true;
  setup = renderViewer({ lives: { liveStatus: async () => (paused ? status({ status: 'paused', role: null }) : status()) } });
  live = await open(setup);
  try {
    assert.equal(live.card().props.message, "Your friend brought someone on – this part is just for their shared friends. We'll let you back in after.");
    assert.deepEqual(live.buttons(), ['Report @sam', 'Block @sam', 'Leave']);
    paused = false;
    await live.runLastTimer();
    assert.equal(live.card(), null);
    assert.ok(setup.log.includes('connect:viewer-token'));
  } finally { await unmount(live.tree); }
});

test('full, busy and not working: their own words and Try again', async () => {
  let setup = renderViewer({ lives: { getLiveToken: async () => ({ ok: false, reason: 'full', message: 'This live is full right now – try again in a bit.', status: 403 }) } });
  let live = await open(setup);
  try {
    assert.equal(live.card().props.title, 'This live is full right now');
    assert.deepEqual(live.buttons(), ['Try again', 'Leave']);
  } finally { await unmount(live.tree); }

  setup = renderViewer({ lives: { getLiveToken: async () => ({ ok: false, reason: 'busy', message: 'Lives are busy right now – try again later.', status: 403 }) } });
  live = await open(setup);
  try {
    assert.equal(live.card().props.title, 'Lives are busy right now – try again later.');
    assert.deepEqual(live.buttons(), ['Try again', 'Leave']);
  } finally { await unmount(live.tree); }

  setup = renderViewer({ lives: { getLiveToken: async () => ({ ok: false, reason: 'not_set_up', message: "Lives aren't set up yet.", status: 503 }) } });
  live = await open(setup);
  try {
    assert.equal(live.card().props.title, "Lives aren't set up yet.");
  } finally { await unmount(live.tree); }
});

test('⋯ has Report and Block for the host and the co-host; blocking the co-host keeps you on the live', async () => {
  const setup = renderViewer({ lives: { liveStatus: async () => status({ cohost: AYAAN }) } });
  const live = await open(setup);
  try {
    await act(() => live.find('LiveTopBar')[0].props.onMenu());
    const labels = JSON.parse(JSON.stringify(setup.calls.options.at(-1).options.map((o) => o.label)));
    assert.deepEqual(labels, ['Report @sam', 'Report @ayaan', 'Block @sam', 'Block @ayaan', 'Leave']);
    await act(() => setup.calls.options.at(-1).options[3].onPress());
    const block = setup.calls.blocks.at(-1);
    assert.equal(block.user.id, GUEST);
    const routesBefore = setup.calls.routes.length;
    await act(async () => { block.onBlocked(); });
    await settle(act);
    assert.equal(setup.calls.routes.length, routesBefore, 'still on the live');
  } finally { await unmount(live.tree); }
});

test('blocking someone from their comment keeps the live open and hides their comments', async () => {
  const comment = { id: 'c1', live_id: LIVE, user_id: 'bea', name: 'Bea', avatar_path: null, body: 'hi', created_at: '', deleted_at: null };
  const setup = renderViewer({ lives: { fetchLiveComments: async () => [comment] } });
  const live = await open(setup);
  try {
    const list = () => live.find('LiveCommentList')[0];
    assert.equal(list().props.comments.length, 1);
    await act(() => list().props.onLongPress(comment));
    const menu = JSON.parse(JSON.stringify(setup.calls.options.at(-1).options.map((o) => o.label)));
    assert.deepEqual(menu, ['Report comment', 'Block Bea']);
    await act(() => setup.calls.options.at(-1).options[1].onPress());
    await act(async () => { setup.calls.blocks.at(-1).onBlocked(); });
    assert.equal(list().props.comments.length, 0);
    assert.equal(setup.calls.routes.length, 0);
  } finally { await unmount(live.tree); }
});

test('a comment that breaks the rules is refused before anything is sent', async () => {
  const setup = renderViewer({ lives: { checkLiveComment: (text) => (text === 'bad' ? "That word isn't allowed on Peekaboo." : null) } });
  const live = await open(setup);
  try {
    const composer = live.find('LiveComposer')[0];
    let sent;
    await act(async () => { sent = await composer.props.onSend('bad'); });
    assert.equal(sent, false);
    assert.equal(setup.calls.alerts.at(-1)[1], "That word isn't allowed on Peekaboo.");
    assert.equal(setup.log.some((s) => s.startsWith('comment:')), false);
    await act(async () => { sent = await composer.props.onSend('nice!'); });
    assert.equal(sent, true);
    assert.ok(setup.log.includes('comment:nice!'));
  } finally { await unmount(live.tree); }
});

test('asked on stage without the camera or microphone: we answer "not now" for you, and nothing starts', async () => {
  const setup = renderViewer({ permissions: 'settings' });
  const live = await open(setup);
  try {
    await act(() => setup.handlers.onInvite({ id: 'inv-1', live_id: LIVE, guest_id: 'alice', expires_at: new Date(Date.now() + 60_000).toISOString() }));
    const sheet = () => live.find('InviteSheet')[0];
    assert.equal(sheet().props.visible, true);
    assert.equal(sheet().props.hostName, 'Sam');
    await act(async () => { await sheet().props.onJoin(); });
    await settle(act);
    assert.ok(setup.log.includes('permissions:settings'));
    assert.ok(setup.log.includes('answer:false'));
    assert.equal(setup.log.includes('answer:true'), false);
    assert.equal(setup.access.calls.holds, 0);
    assert.equal(setup.calls.alerts.at(-1)[0], 'You need to allow the camera and microphone to come on.');
    assert.equal(sheet().props.visible, false);
  } finally { await unmount(live.tree); }
});

test('coming on stage: permissions → yes → off the viewer connection → camera held → co-host ticket (retries while the stage gets ready) → camera on', async () => {
  let stageReady = false;
  const setup = renderViewer({
    lives: {
      getLiveToken: async () => {
        setup.log.push('token');
        if (setup.access.liveNowRole() !== 'cohost') return { ok: true, url: 'wss://x', token: 'viewer-token', room: 'r', role: 'viewer', identity: 'alice', expires_at: '' };
        if (!stageReady) return { ok: false, reason: 'stage_wait', message: 'Getting the stage ready…', status: 503 };
        return { ok: true, url: 'wss://x', token: 'cohost-token', room: 'r', role: 'cohost', identity: 'alice', expires_at: '' };
      },
    },
  });
  const live = await open(setup);
  try {
    await act(() => setup.handlers.onInvite({ id: 'inv-2', live_id: LIVE, guest_id: 'alice', expires_at: new Date(Date.now() + 60_000).toISOString() }));
    setup.log.length = 0;
    await act(async () => { await live.find('InviteSheet')[0].props.onJoin(); });
    await settle(act);
    assert.deepEqual(setup.log.filter((step) => !step.startsWith('status')).slice(0, 4), ['permissions:ok', 'answer:true', 'disconnect:keepAudio', 'token']);
    // Who is on stage is asked at once (the names at the top don't wait for the next ping).
    assert.ok(setup.log.includes('status(as cohost)'));
    assert.equal(setup.access.liveNowRole(), 'cohost');
    assert.equal(setup.access.isCameraHeldByLive(), true);
    // "Getting the stage ready…" while the server clears the stage; tried again 2 seconds later.
    assert.equal(textOf(live.tree.toJSON()).includes('Getting the stage ready…'), true);
    stageReady = true;
    await live.runLastTimer();
    assert.deepEqual(setup.log.slice(-4), ['token', 'connect:cohost-token', 'publish:front', 'mic:true']);
    // LiveKit was told who may see you BEFORE connecting (everyone else is refused by LiveKit itself).
    assert.deepEqual(setup.handles[0].watchers, [HOST, 'alice']);
    assert.ok(live.find('Button').some((b) => b.props.title === 'Leave stage'));

    // Leave stage: end the stage, stop the camera, back to a hidden viewer connection, camera given back.
    setup.log.length = 0;
    await act(() => live.find('Button').find((b) => b.props.title === 'Leave stage').props.onPress());
    await settle(act);
    assert.deepEqual(setup.log.slice(0, 5), ['endCohost', 'unpublish', 'disconnect:keepAudio', 'token', 'connect:viewer-token']);
    assert.equal(setup.access.isCameraHeldByLive(), false);
    assert.equal(setup.access.liveNowRole(), 'viewer');
  } finally { await unmount(live.tree); }
});

test('closing the live screen while on stage ends the stage, stops the camera and gives it back', async () => {
  const setup = renderViewer({
    lives: {
      getLiveToken: async () => {
        const role = setup.access.liveNowRole() === 'cohost' ? 'cohost' : 'viewer';
        return { ok: true, url: 'wss://x', token: `${role}-token`, room: 'r', role, identity: 'alice', expires_at: '' };
      },
    },
  });
  const live = await open(setup);
  await act(() => setup.handlers.onInvite({ id: 'inv-4', live_id: LIVE, guest_id: 'alice', expires_at: new Date(Date.now() + 60_000).toISOString() }));
  await act(async () => { await live.find('InviteSheet')[0].props.onJoin(); });
  await settle(act);
  assert.ok(setup.log.includes('connect:cohost-token'));
  assert.equal(setup.access.liveNowRole(), 'cohost');
  setup.log.length = 0;
  // Leaving the screen (it loses focus first, then closes).
  await unmount(live.tree);
  await settle(act);
  assert.ok(setup.log.includes('endCohost'), 'the stage is ended for the host too');
  assert.ok(setup.log.indexOf('unpublish') < setup.log.indexOf('endCohost'), 'the camera stops first');
  assert.equal(setup.access.isCameraHeldByLive(), false);
  assert.equal(setup.access.liveNowRole(), null);
});

test('the Live rules come first if you never agreed (the ask stays open), then the answer is sent again', async () => {
  let rulesAgreed = false;
  const setup = renderViewer({
    lives: {
      getLiveToken: async () => {
        const role = setup.access.liveNowRole() === 'cohost' ? 'cohost' : 'viewer';
        return { ok: true, url: 'wss://x', token: `${role}-token`, room: 'r', role, identity: 'alice', expires_at: '' };
      },
      answerCohostInvite: async (_invite, accept) => {
        setup.log.push(`answer:${accept}`);
        if (accept && !rulesAgreed) { const e = new Error('Read the Live rules first.'); e.hint = 'live_rules'; throw e; }
        return { role: accept ? 'cohost' : 'viewer' };
      },
    },
  });
  const live = await open(setup);
  try {
    await act(() => setup.handlers.onInvite({ id: 'inv-3', live_id: LIVE, guest_id: 'alice', expires_at: new Date(Date.now() + 60_000).toISOString() }));
    await act(async () => { await live.find('InviteSheet')[0].props.onJoin(); });
    await settle(act);
    // The rules show inside the same sheet (a phone can't open a second pop-up sheet while one is open).
    const rules = () => live.find('InviteSheet')[0].props.rules;
    assert.ok(rules());
    assert.equal(live.find('InviteSheet')[0].props.visible, true);
    assert.equal(setup.access.calls.holds, 0);
    rulesAgreed = true;
    await act(async () => { rules().props.onAccepted(); });
    await settle(act);
    assert.equal(setup.log.filter((s) => s === 'answer:true').length, 2);
    assert.equal(setup.access.liveNowRole(), 'cohost');
    assert.ok(setup.log.includes('connect:cohost-token'));
  } finally { await unmount(live.tree); }
});

test('the comment list and composer: empty words, the note, and "Comments are off"', async () => {
  const screen = loadScreen('src/components/live/LiveComments.tsx', {
    '@/components/IconButton': { IconButton: host('IconButton') },
    '@/lib/lives': { LIVE_COMMENT_MAX: 150 },
    '@/theme': { colors: {}, keyboardAppearance: 'dark', radius: {}, space: {} },
  });
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(screen.exports.LiveCommentList, { comments: [] })); });
  assert.equal(textOf(tree.toJSON()), 'No comments yet – say hi 👋');
  await unmount(tree);
  await act(async () => { tree = renderer.create(React.createElement(screen.exports.LiveComposer, { commentsOn: true, onSend: async () => true })); });
  const input = tree.root.findByType('TextInput');
  assert.equal(input.props.placeholder, 'Add a comment…');
  assert.equal(input.props.maxLength, 150);
  assert.ok(textOf(tree.toJSON()).includes('Everyone watching sees your comment and name'));
  await unmount(tree);
  await act(async () => { tree = renderer.create(React.createElement(screen.exports.LiveComposer, { commentsOn: false, onSend: async () => true })); });
  assert.equal(textOf(tree.toJSON()), 'Comments are off');
  assert.equal(tree.root.findAllByType('TextInput').length, 0);
  await unmount(tree);
});

// ---------------------------------------------------------------------------
// Review fixes: real waits between steps, a failed "come on", another screen on top, giving the camera back
// ---------------------------------------------------------------------------

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function runFor(rounds, ms = 25) {
  for (let i = 0; i < rounds; i++) await act(async () => { await wait(ms); });
}
const invite = (id) => ({ id, live_id: LIVE, guest_id: 'alice', expires_at: new Date(Date.now() + 60_000).toISOString() });

test('with real waits between the steps: one ticket, one connect, watching (no "Reconnecting…"); coming on: one co-host ticket, one connect, on stage', async () => {
  // Like LiveStage: a second connect closes the room that is still connecting (that connect then fails).
  const log = [];
  let generation = 0;
  const stageModule = {
    StageView: host('StageView'),
    resumeLiveAudio: async () => {},
    createStage(events) {
      return {
        events, watchers: null,
        setWatchers(list) { this.watchers = list; },
        async connect(_url, token) {
          const mine = ++generation;
          log.push(`connect:${token}`);
          await wait(80);
          if (mine !== generation) throw new Error('Client initiated disconnect');
        },
        async publish() { log.push('publish'); }, async unpublish() {}, async disconnect() { generation++; },
        async flip() {}, async setMic() {}, async setCamera() {}, async sendHearts() {}, async broadcastHearts() {},
        subscribe: () => () => {}, room: () => null, facing: () => 'front', identity: () => null,
      };
    },
  };
  const access = liveAccessMock(true, { stage: stageModule });
  access.waitForCameraRelease = () => wait(50);
  const setup = renderViewer({
    access,
    lives: {
      liveStatus: async () => { await wait(10); return status(); },
      getLiveToken: async () => {
        await wait(40);
        const role = access.liveNowRole() === 'cohost' ? 'cohost' : 'viewer';
        log.push(`token:${role}`);
        return { ok: true, url: 'wss://x', token: `${role}-token`, room: 'r', role, identity: 'alice', expires_at: '' };
      },
    },
  });
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(setup.screen.Component)); });
  try {
    await runFor(20);
    assert.deepEqual(log, ['token:viewer', 'connect:viewer-token']);
    assert.equal(textOf(tree.toJSON()).includes('Reconnecting'), false);
    assert.equal(tree.root.findAllByType('LiveCard').length, 0);
    // Coming on stage.
    log.length = 0;
    await act(() => setup.handlers.onInvite(invite('inv-real')));
    await act(async () => { await tree.root.findAllByType('InviteSheet')[0].props.onJoin(); });
    await runFor(20);
    assert.deepEqual(log, ['token:cohost', 'connect:cohost-token', 'publish']);
    assert.ok(tree.root.findAllByType('Button').some((b) => b.props.title === 'Leave stage'));
  } finally { await unmount(tree); }
});

test('coming on didn\'t work (the camera was refused): the turn is ended on the server and the camera is never sent again', async () => {
  let refuse = true;
  const setup = renderViewer({
    stageOptions: { publish: async () => { if (refuse) { const e = new Error('Permission denied'); e.name = 'NotAllowedError'; throw e; } } },
    lives: {
      getLiveToken: async () => {
        const role = setup.access.liveNowRole() === 'cohost' ? 'cohost' : 'viewer';
        setup.log.push(`token:${role}`);
        return { ok: true, url: 'wss://x', token: `${role}-token`, room: 'r', role, identity: 'alice', expires_at: '' };
      },
    },
  });
  const live = await open(setup);
  try {
    await act(() => setup.handlers.onInvite(invite('inv-5')));
    setup.log.length = 0;
    await act(async () => { await live.find('InviteSheet')[0].props.onJoin(); });
    await settle(act);
    refuse = false;
    assert.ok(setup.log.includes('endCohost'), 'the server no longer has you on stage');
    assert.ok(setup.log.indexOf('endCohost') < setup.log.lastIndexOf('token:viewer'), 'ended before asking for a watching ticket');
    assert.equal(setup.log.filter((s) => s.startsWith('publish')).length, 1, 'only the one try that was refused');
    assert.equal(setup.access.isCameraHeldByLive(), false);
    assert.equal(setup.access.liveNowRole(), 'viewer');
    assert.ok(setup.calls.toasts.includes('You need to allow the camera and microphone to come on.'));
  } finally { await unmount(live.tree); }
});

test('a ticket that still says "co-host" while you\'re just watching: the turn is ended and nothing is sent', async () => {
  let serverSaysCohost = true;
  const setup = renderViewer({
    lives: {
      getLiveToken: async () => {
        const role = serverSaysCohost ? 'cohost' : 'viewer';
        setup.log.push(`token:${role}`);
        return { ok: true, url: 'wss://x', token: `${role}-token`, room: 'r', role, identity: 'alice', expires_at: '' };
      },
      endCohost: async () => { setup.log.push('endCohost'); serverSaysCohost = false; },
    },
  });
  const live = await open(setup);
  try {
    assert.deepEqual(setup.log.filter((s) => !s.startsWith('status')), ['token:cohost', 'endCohost']);
    assert.equal(setup.log.some((s) => s.startsWith('connect') || s.startsWith('publish')), false);
    assert.equal(setup.access.calls.holds, 0, 'the camera is never taken');
    // The retry gets a watching ticket.
    await live.runLastTimer();
    assert.ok(setup.log.includes('connect:viewer-token'));
    assert.equal(setup.log.some((s) => s.startsWith('publish')), false);
  } finally { await unmount(live.tree); }
});

test('another screen on top: nothing counts as live any more; back to the live: live again before the server is asked', async () => {
  const setup = renderViewer();
  const live = await open(setup);
  try {
    assert.equal(setup.access.liveNowRole(), 'viewer');
    // A chat opens on top (the live screen stays underneath, without focus).
    setup.log.length = 0;
    await act(async () => { setup.focus.cleanup(); });
    await settle(act);
    assert.deepEqual([...setup.log], ['unpublish', 'disconnect', 'leaveLive']);
    assert.equal(setup.access.liveNowRole(), null, 'app updates may run, the screen may dim, live notifications show');
    // The app going to the background and back while the chat is open doesn't rejoin underneath it.
    await act(async () => { setup.appState.listener('background'); setup.appState.listener('active'); });
    await settle(act);
    assert.equal(setup.log.some((s) => s.startsWith('status') || s === 'token'), false);
    assert.equal(setup.access.liveNowRole(), null);
    // Back to the live: "live now" is set before the server is asked anything, then it rejoins.
    await act(async () => { setup.focus.cleanup = setup.focus.effect(); });
    await settle(act);
    assert.equal(setup.log[3], 'status(as viewer)', 'the first thing after coming back, with "live now" already set');
    assert.ok(setup.log.includes('connect:viewer-token'));
    assert.equal(setup.access.liveNowRole(), 'viewer');
  } finally { await unmount(live.tree); }
});

test('closing the screen while on stage gives the camera back only once LiveKit\'s camera has stopped', async () => {
  let stopped;
  const setup = renderViewer({
    lives: {
      getLiveToken: async () => {
        const role = setup.access.liveNowRole() === 'cohost' ? 'cohost' : 'viewer';
        return { ok: true, url: 'wss://x', token: `${role}-token`, room: 'r', role, identity: 'alice', expires_at: '' };
      },
    },
  });
  const live = await open(setup);
  await act(() => setup.handlers.onInvite(invite('inv-6')));
  await act(async () => { await live.find('InviteSheet')[0].props.onJoin(); });
  await settle(act);
  assert.equal(setup.access.liveNowRole(), 'cohost');
  // Stopping the camera takes a moment now.
  setup.handles[0].disconnect = () => new Promise((resolve) => { stopped = () => { setup.log.push('disconnect'); resolve(); }; });
  await unmount(live.tree);
  await settle(act);
  assert.equal(setup.access.isCameraHeldByLive(), true, 'still held while LiveKit\'s camera is stopping');
  assert.equal(setup.access.liveNowRole(), 'cohost');
  assert.equal(setup.access.leaving.size, 1, 'telling the server is registered as leaving work');
  stopped();
  await settle(act);
  assert.equal(setup.access.isCameraHeldByLive(), false);
  assert.equal(setup.access.liveNowRole(), null);
  assert.ok(setup.log.indexOf('disconnect') < setup.log.indexOf('endCohost'));
});
