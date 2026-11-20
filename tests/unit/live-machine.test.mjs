import { expect, it } from 'vitest';

import { loadTs } from './liveLoad.mjs';

// The live screens' state machine (lib/liveMachine.ts): every transition the design lists, every way LiveKit
// can drop you, the retry rounds (2/5/10 s, and 2/5/15/30/60 s after a removal), full/unavailable, the stage,
// the background rules, and that a server "not live" always wins.

const m = loadTs('src/lib/liveMachine.ts', {});
const run = (state, ...events) => events.reduce((s, e) => m.liveReducer(s, e), state);
const viewer = () => m.newLiveMachine('viewer');
const host = () => m.newLiveMachine('host');
const live = (role = 'viewer', extra = {}) => ({ type: 'status', info: { status: 'live', role, ...extra } });
const watching = () => run(viewer(), live(), { type: 'token_ok', role: 'viewer' }, { type: 'connected' });
const onStage = () => run(watching(), { type: 'invite', invite: { id: 'i1', expires_at: 'x' } }, { type: 'accept', now: 0 }, { type: 'token_ok', role: 'cohost' }, { type: 'connected' });
const hostLive = () => run(host(), { type: 'start' }, { type: 'token_ok', role: 'host' }, { type: 'connected' }, { type: 'on_air' });

it('loads nothing (pure)', () => {
  const required = [];
  loadTs('src/lib/liveMachine.ts', {}, { required });
  expect(required).toEqual([]);
});

it('viewer: checking → joining → watching, with the right things to do at each step', () => {
  let s = viewer();
  expect(s.phase).toBe('checking');
  expect(m.liveTodo(s)).toBe('status');
  s = m.liveReducer(s, live());
  expect(s.phase).toBe('joining');
  expect(m.liveTodo(s)).toBe('connect');
  s = m.liveReducer(s, { type: 'token_ok', role: 'viewer' });
  expect(s.phase).toBe('joining');
  s = m.liveReducer(s, { type: 'connected' });
  expect(s.phase).toBe('watching');
  expect(m.liveTodo(s)).toBe(null);
  expect(m.shouldDisconnect(s)).toBe(false);
  expect(m.holdsCamera(s)).toBe(false);
  // Every new thing to do moves the step on (token_ok only remembers the role: the screen is already
  // connecting); no change keeps the same object.
  expect(s.step).toBe(2);
  expect(m.liveReducer(s, { type: 'reconnected' })).toBe(s);
});

it('viewer: what the first status check can say', () => {
  for (const [status, phase, why] of [
    ['ended', 'blocked', 'ended'], ['removed', 'blocked', 'removed'], ['not_allowed', 'blocked', 'not_allowed'], ['paused', 'waiting', null],
  ]) {
    const s = m.liveReducer(viewer(), { type: 'status', info: { status } });
    expect(s.phase, status).toBe(phase);
    expect(s.why, status).toBe(why);
    expect(m.shouldDisconnect(s)).toBe(true);
  }
  // Paused: re-check every 15 s and get back in by itself.
  let s = m.liveReducer(viewer(), { type: 'status', info: { status: 'paused' } });
  expect(s.retryInMs).toBe(15_000);
  s = m.liveReducer(s, { type: 'retry' });
  expect(s.phase).toBe('checking');
  s = m.liveReducer(s, live());
  expect(s.phase).toBe('joining');
  // No internet on the first check: "Connection lost" (Try again → checking).
  s = m.liveReducer(viewer(), { type: 'status_failed' });
  expect(s.phase).toBe('lost');
  expect(m.liveReducer(s, { type: 'open' }).phase).toBe('checking');
});

it('viewer: a ticket "no" for each reason', () => {
  const joining = () => m.liveReducer(viewer(), live());
  const fail = (reason) => m.liveReducer(joining(), { type: 'token_failed', reason, message: `words for ${reason}`, now: 0 });
  expect(fail('not_allowed')).toMatchObject({ phase: 'blocked', why: 'not_allowed' });
  expect(fail('removed')).toMatchObject({ phase: 'blocked', why: 'removed' });
  expect(fail('ended')).toMatchObject({ phase: 'blocked', why: 'ended' });
  expect(fail('login')).toMatchObject({ phase: 'blocked', why: 'login' });
  expect(fail('login_changed')).toMatchObject({ phase: 'blocked', why: 'login' });
  expect(fail('paused')).toMatchObject({ phase: 'waiting', retryInMs: 15_000 });
  // Full: try again every 30 s.
  const full = fail('full');
  expect(full).toMatchObject({ phase: 'full', retryInMs: 30_000, message: 'words for full' });
  expect(m.liveReducer(full, { type: 'retry' }).phase).toBe('checking');
  // Busy / not set up / not working: the words + Try again (no automatic retry).
  for (const reason of ['busy', 'not_set_up', 'unavailable']) {
    const s = fail(reason);
    expect(s).toMatchObject({ phase: 'unavailable', why: reason, retryInMs: null, message: `words for ${reason}` });
    expect(m.liveReducer(s, { type: 'open' }).phase).toBe('checking');
  }
  // No internet: the rejoin round.
  expect(fail('network')).toMatchObject({ phase: 'rejoining', retryInMs: 2000 });
});

it('viewer: LiveKit\'s own resume, then fresh tickets at 2/5/10 s, then "Connection lost"', () => {
  let s = m.liveReducer(watching(), { type: 'reconnecting' });
  expect(s).toMatchObject({ phase: 'reconnecting', resumeTo: 'watching', retryInMs: 30_000 });
  expect(m.liveReducer(s, { type: 'reconnected' }).phase).toBe('watching');
  // The resume took over 30 s.
  s = m.liveReducer(s, { type: 'retry' });
  expect(s).toMatchObject({ phase: 'rejoining', retryInMs: 2000, attempt: 0 });
  expect(m.shouldDisconnect(s)).toBe(true);
  const delays = [];
  for (let i = 0; i < 3; i++) {
    delays.push(s.retryInMs);
    s = m.liveReducer(s, { type: 'retry' });
    expect(s.phase).toBe('joining');
    expect(m.liveTodo(s)).toBe('connect');
    s = m.liveReducer(s, { type: 'connect_failed', now: 0 });
  }
  expect(delays).toEqual([2000, 5000, 10_000]);
  expect(s.phase).toBe('lost');
  // A try that works ends the round.
  let t = m.liveReducer(watching(), { type: 'disconnected', reason: 'other' });
  expect(t).toMatchObject({ phase: 'rejoining', retryInMs: 2000 });
  t = run(t, { type: 'retry' }, { type: 'token_ok', role: 'viewer' }, { type: 'connected' });
  expect(t).toMatchObject({ phase: 'watching', round: null, attempt: 0 });
});

it('LiveKit disconnect reasons', () => {
  expect(m.liveReducer(watching(), { type: 'disconnected', reason: 'room_deleted' })).toMatchObject({ phase: 'blocked', why: 'ended' });
  expect(m.liveReducer(watching(), { type: 'disconnected', reason: 'duplicate' })).toMatchObject({ phase: 'blocked', why: 'other_device' });
  // We closed it ourselves: nothing changes.
  const w = watching();
  expect(m.liveReducer(w, { type: 'disconnected', reason: 'client' })).toBe(w);
  // A drop while not connected (e.g. we already went to waiting) is ignored.
  const waiting = m.liveReducer(viewer(), { type: 'status', info: { status: 'paused' } });
  expect(m.liveReducer(waiting, { type: 'disconnected', reason: 'other' })).toBe(waiting);
  expect(m.liveReducer(watching(), { type: 'disconnected', reason: 'other' }).phase).toBe('rejoining');
});

it('removed by LiveKit: the server decides, and a rejoin waits 2/5/15/30/60 s (a removal can block you for a minute)', () => {
  let s = m.liveReducer(watching(), { type: 'disconnected', reason: 'removed' });
  expect(s).toMatchObject({ phase: 'checking', round: 'removed' });
  expect(m.liveTodo(s)).toBe('status');
  // The server says: removed / paused / ended.
  expect(m.liveReducer(s, { type: 'status', info: { status: 'removed' } })).toMatchObject({ phase: 'blocked', why: 'removed' });
  expect(m.liveReducer(s, { type: 'status', info: { status: 'paused' } }).phase).toBe('waiting');
  expect(m.liveReducer(s, { type: 'status', info: { status: 'ended' } })).toMatchObject({ phase: 'blocked', why: 'ended' });
  // …or still live (a new role, or a soft removal): rejoin slowly.
  s = m.liveReducer(s, live('viewer'));
  expect(s).toMatchObject({ phase: 'rejoining', round: 'removed', retryInMs: 2000 });
  const delays = [];
  for (let i = 0; i < 5; i++) {
    delays.push(s.retryInMs);
    s = run(s, { type: 'retry' }, { type: 'token_ok', role: 'viewer' }, { type: 'connect_failed', now: 0 });
  }
  expect(delays).toEqual([2000, 5000, 15_000, 30_000, 60_000]);
  expect(s.phase).toBe('lost');
});

it('a ping that isn\'t "live" wins over everything', () => {
  for (const make of [watching, onStage]) {
    expect(m.liveReducer(make(), { type: 'status', info: { status: 'paused' } }).phase).toBe('waiting');
    expect(m.liveReducer(make(), { type: 'status', info: { status: 'removed' } }).phase).toBe('blocked');
    expect(m.liveReducer(make(), { type: 'status', info: { status: 'not_allowed' } }).phase).toBe('blocked');
    expect(m.liveReducer(make(), { type: 'status', info: { status: 'ended' } })).toMatchObject({ phase: 'blocked', why: 'ended' });
  }
  const reconnecting = m.liveReducer(watching(), { type: 'reconnecting' });
  expect(m.liveReducer(reconnecting, { type: 'status', info: { status: 'ended' } }).phase).toBe('blocked');
  // Once blocked, nothing moves it (only Try again on the screens that offer it).
  const blocked = m.liveReducer(watching(), { type: 'status', info: { status: 'removed' } });
  expect(m.liveReducer(blocked, live())).toBe(blocked);
  expect(m.liveReducer(blocked, { type: 'token_failed', reason: 'network', now: 0 })).toBe(blocked);
});

it('co-host: invited → going on (with "Getting the stage ready…" retries) → on stage → back to watching', () => {
  let s = m.liveReducer(watching(), { type: 'invite', invite: { id: 'i1', expires_at: 'x' } });
  expect(s).toMatchObject({ phase: 'invited', invite: { id: 'i1' } });
  // An invite also arrives through a ping.
  expect(m.liveReducer(watching(), live('viewer', { invite: { id: 'i2', expires_at: 'y' } }))).toMatchObject({ phase: 'invited', invite: { id: 'i2' } });
  expect(m.liveReducer(s, { type: 'decline' }).phase).toBe('watching');
  expect(m.liveReducer(s, { type: 'invite_gone' }).phase).toBe('watching');
  s = m.liveReducer(s, { type: 'accept', now: 1000 });
  expect(s).toMatchObject({ phase: 'going_on', role: 'cohost', stageWaitSince: 1000 });
  expect(m.liveTodo(s)).toBe('connect');
  expect(m.holdsCamera(s)).toBe(true);
  // The server is still clearing the stage: retry every 2 s…
  s = m.liveReducer(s, { type: 'token_failed', reason: 'stage_wait', message: 'Getting the stage ready…', now: 3000 });
  expect(s).toMatchObject({ phase: 'going_on', retryInMs: 2000 });
  expect(m.liveTodo(s)).toBe(null);
  s = m.liveReducer(s, { type: 'retry' });
  expect(m.liveTodo(s)).toBe('connect');
  s = run(s, { type: 'token_ok', role: 'cohost' }, { type: 'connected' });
  expect(s).toMatchObject({ phase: 'on_stage', role: 'cohost' });
  expect(m.holdsCamera(s)).toBe(true);
  // Leave stage: the leave steps run with the camera still held, then watching (camera released).
  s = m.liveReducer(s, { type: 'leave_stage' });
  expect(s).toMatchObject({ phase: 'leaving_stage', role: 'viewer' });
  expect(m.liveTodo(s)).toBe('leave_stage');
  expect(m.holdsCamera(s)).toBe(true);
  s = run(s, { type: 'token_ok', role: 'viewer' }, { type: 'connected' });
  expect(s).toMatchObject({ phase: 'watching', role: 'viewer' });
  expect(m.holdsCamera(s)).toBe(false);
});

it('co-host: "Getting the stage ready…" gives up after 70 s; a camera refusal goes back to watching', () => {
  let s = run(watching(), { type: 'accept', now: 0 });
  s = m.liveReducer(s, { type: 'token_failed', reason: 'stage_wait', now: 69_000 });
  expect(s.phase).toBe('going_on');
  s = run(s, { type: 'retry' }, { type: 'token_failed', reason: 'stage_wait', now: 71_000 });
  expect(s).toMatchObject({ phase: 'leaving_stage', why: 'stage_timeout', role: 'viewer' });
  const refused = run(watching(), { type: 'accept', now: 0 }, { type: 'token_ok', role: 'cohost' }, { type: 'connect_failed', permission: true, now: 10 });
  expect(refused).toMatchObject({ phase: 'leaving_stage', why: 'permission' });
  // A paused/removed answer while going on wins (the screen disconnects and releases the camera).
  const paused = run(watching(), { type: 'accept', now: 0 }, { type: 'token_failed', reason: 'paused', now: 10 });
  expect(paused.phase).toBe('waiting');
  expect(m.holdsCamera(paused)).toBe(false);
});

it('co-host: taken off by the host (no more publishing, or a ping saying "viewer")', () => {
  expect(m.liveReducer(onStage(), { type: 'taken_off' })).toMatchObject({ phase: 'leaving_stage', role: 'viewer' });
  expect(m.liveReducer(onStage(), live('viewer'))).toMatchObject({ phase: 'leaving_stage', role: 'viewer' });
  // A ping still saying co-host changes nothing.
  const s = onStage();
  expect(m.liveReducer(s, live('cohost'))).toBe(s);
});

it('background: a viewer stops watching (rejoins on return); a co-host leaves the stage first', () => {
  let s = m.liveReducer(watching(), { type: 'app_state', active: false });
  expect(s.phase).toBe('away');
  expect(m.liveTodo(s)).toBe('away');
  expect(m.shouldDisconnect(s)).toBe(true);
  s = m.liveReducer(s, { type: 'app_state', active: true });
  expect(s.phase).toBe('checking');
  // The co-host: away too (the away steps end the stage), and back as a viewer.
  let c = m.liveReducer(onStage(), { type: 'app_state', active: false });
  expect(c.phase).toBe('away');
  expect(m.liveTodo(c)).toBe('away');
  expect(m.holdsCamera(c)).toBe(false);
  c = m.liveReducer(c, { type: 'app_state', active: true });
  expect(c).toMatchObject({ phase: 'checking', role: 'viewer' });
  // Waiting (or a retry card): its timers stop too, so nothing rejoins out of sight; coming back checks again.
  const paused = run(viewer(), { type: 'status', info: { status: 'paused' } }, { type: 'app_state', active: false });
  expect(paused).toMatchObject({ phase: 'away', retryInMs: null });
  expect(m.liveReducer(paused, { type: 'app_state', active: true }).phase).toBe('checking');
  // Not watching any more (ended, removed…): the background changes nothing.
  const blocked = m.liveReducer(viewer(), { type: 'status', info: { status: 'ended' } });
  expect(m.liveReducer(blocked, { type: 'app_state', active: false })).toBe(blocked);
});

it('host: ready → starting → live, and each start failure keeps its own reason', () => {
  let s = host();
  expect(s).toMatchObject({ phase: 'ready', role: 'host' });
  expect(m.holdsCamera(s)).toBe(true);
  s = m.liveReducer(s, { type: 'start' });
  expect(s.phase).toBe('starting');
  expect(m.liveTodo(s)).toBe('start');
  s = run(s, { type: 'token_ok', role: 'host' }, { type: 'connected' });
  expect(s.phase).toBe('starting'); // live only once on air
  s = m.liveReducer(s, { type: 'on_air' });
  expect(s.phase).toBe('live');
  const starting = () => m.liveReducer(host(), { type: 'start' });
  expect(m.liveReducer(starting(), { type: 'token_failed', reason: 'not_set_up', now: 0 })).toMatchObject({ phase: 'failed', why: 'not_set_up' });
  expect(m.liveReducer(starting(), { type: 'token_failed', reason: 'unavailable', now: 0 })).toMatchObject({ phase: 'failed', why: 'unavailable' });
  expect(m.liveReducer(starting(), { type: 'token_failed', reason: 'busy', now: 0 })).toMatchObject({ phase: 'failed', why: 'busy' });
  expect(m.liveReducer(starting(), { type: 'token_failed', reason: 'network', now: 0 })).toMatchObject({ phase: 'failed', why: 'network' });
  expect(m.liveReducer(starting(), { type: 'connect_failed', permission: true, now: 0 })).toMatchObject({ phase: 'failed', why: 'permission' });
  expect(m.liveReducer(starting(), { type: 'connect_failed', now: 0 })).toMatchObject({ phase: 'failed', why: 'network' });
  expect(m.liveReducer(starting(), { type: 'failed', why: 'limit', message: "You've gone live 3 times today" })).toMatchObject({ phase: 'failed', why: 'limit' });
  // Try again from a failure.
  const failed = m.liveReducer(starting(), { type: 'token_failed', reason: 'network', now: 0 });
  expect(m.liveReducer(failed, { type: 'start' }).phase).toBe('starting');
  expect(m.shouldDisconnect(failed)).toBe(true);
  expect(m.holdsCamera(failed)).toBe(false);
});

it('host: the background turns the camera and mic off; back with the live still on resumes them', () => {
  let s = m.liveReducer(hostLive(), { type: 'mute', muted: true });
  expect(s.userMuted).toBe(true);
  s = m.liveReducer(s, { type: 'app_state', active: false });
  expect(s.phase).toBe('away');
  expect(m.liveTodo(s)).toBe('away');
  expect(m.shouldDisconnect(s)).toBe(false); // the host stays connected
  expect(m.holdsCamera(s)).toBe(true);
  s = m.liveReducer(s, { type: 'app_state', active: true });
  expect(s.phase).toBe('checking');
  s = m.liveReducer(s, live('host'));
  expect(s).toMatchObject({ phase: 'live', resume: true, userMuted: true }); // the user's own mute is kept
  expect(m.liveTodo(s)).toBe('resume');
  s = m.liveReducer(s, { type: 'resumed' });
  expect(s.resume).toBe(false);
  expect(m.liveTodo(s)).toBe(null);
  // Away too long: the server ended it → the summary with the reason.
  const gone = run(hostLive(), { type: 'app_state', active: false }, { type: 'app_state', active: true }, { type: 'status', info: { status: 'ended', ended_reason: 'host_gone' } });
  expect(gone).toMatchObject({ phase: 'summary', why: 'host_gone' });
});

it('host: the server ending the live, and the host ending it', () => {
  for (const reason of ['time', 'empty', 'reports', 'owner', 'safety', 'host_gone']) {
    expect(m.liveReducer(hostLive(), { type: 'status', info: { status: 'ended', ended_reason: reason } })).toMatchObject({ phase: 'summary', why: reason });
  }
  // The room was deleted: summary first, the reason fills in from the next status.
  let s = m.liveReducer(hostLive(), { type: 'disconnected', reason: 'room_deleted' });
  expect(s).toMatchObject({ phase: 'summary', why: null });
  s = m.liveReducer(s, { type: 'status', info: { status: 'ended', ended_reason: 'reports' } });
  expect(s.why).toBe('reports');
  // ✕ → End.
  s = m.liveReducer(hostLive(), { type: 'end' });
  expect(s.phase).toBe('ending');
  expect(m.liveTodo(s)).toBe('end');
  expect(m.holdsCamera(s)).toBe(true); // released by the end steps, after the camera stopped
  s = m.liveReducer(s, { type: 'ended', reason: 'host' });
  expect(s).toMatchObject({ phase: 'summary', why: 'host' });
  expect(m.holdsCamera(s)).toBe(false);
  // Late events don't move the summary.
  expect(m.liveReducer(s, { type: 'disconnected', reason: 'other' })).toBe(s);
  expect(m.liveReducer(s, { type: 'token_failed', reason: 'network', now: 0 })).toBe(s);
  // Another phone opened the live.
  expect(m.liveReducer(hostLive(), { type: 'disconnected', reason: 'duplicate' })).toMatchObject({ phase: 'failed', why: 'other_device' });
});

it('host: a dropped connection rejoins with the camera still held', () => {
  let s = m.liveReducer(hostLive(), { type: 'reconnecting' });
  expect(s).toMatchObject({ phase: 'reconnecting', resumeTo: 'live' });
  expect(m.liveReducer(s, { type: 'reconnected' }).phase).toBe('live');
  s = m.liveReducer(s, { type: 'retry' });
  expect(s.phase).toBe('rejoining');
  expect(m.holdsCamera(s)).toBe(true);
  s = run(s, { type: 'retry' }, { type: 'token_ok', role: 'host' }, { type: 'connected' });
  expect(s.phase).toBe('live');
});

it('a camera/microphone refusal is recognised by the error\'s name only (never by a server\'s words)', () => {
  expect(m.isPermissionError({ name: 'NotAllowedError', message: 'x' })).toBe(true);
  expect(m.isPermissionError({ name: 'SecurityError', message: 'Permission denied.' })).toBe(true);
  expect(m.isPermissionError({ name: 'PermissionDeniedError' })).toBe(true);
  expect(m.isPermissionError({ name: 'PermissionDismissedError' })).toBe(true);
  expect(m.isPermissionError(new Error('Permission denied by system'))).toBe(false);
  expect(m.isPermissionError({ name: 'ConnectionError', message: 'permissions denied' })).toBe(false);
  expect(m.isPermissionError({ name: 'PublishTrackError', message: 'failed to publish track, insufficient permissions' })).toBe(false);
  expect(m.isPermissionError(new Error('could not establish pc connection'))).toBe(false);
  expect(m.isPermissionError('NotAllowedError')).toBe(false);
  expect(m.isPermissionError(null)).toBe(false);
});

it('facts that need no new work never move the step (so a screen never starts or connects twice)', () => {
  // token_ok while starting, joining and going on: same step, same thing to do.
  const starting = m.liveReducer(host(), { type: 'start' });
  const started = m.liveReducer(starting, { type: 'token_ok', role: 'host' });
  expect(started.step).toBe(starting.step);
  expect(m.liveTodo(started)).toBe('start');
  const joining = m.liveReducer(viewer(), live());
  const joined = m.liveReducer(joining, { type: 'token_ok', role: 'viewer' });
  expect(joined.step).toBe(joining.step);
  const goingOn = run(watching(), { type: 'accept', now: 0 });
  const ticketed = m.liveReducer(goingOn, { type: 'token_ok', role: 'cohost' });
  expect(ticketed.step).toBe(goingOn.step);
  expect(m.liveTodo(ticketed)).toBe('connect');
  // Mute keeps the step and a running retry timer.
  const waiting = run(viewer(), { type: 'status', info: { status: 'paused' } });
  const muted = m.liveReducer(waiting, { type: 'mute', muted: true });
  expect(muted.step).toBe(waiting.step);
  expect(muted.retryInMs).toBe(waiting.retryInMs);
  // 'resumed' just clears the flag.
  const resumed = run(hostLive(), { type: 'app_state', active: false }, { type: 'app_state', active: true }, live('host'));
  const done = m.liveReducer(resumed, { type: 'resumed' });
  expect(done.step).toBe(resumed.step);
  expect(m.liveTodo(done)).toBe(null);
});

it('a viewer\'s ticket never makes them the co-host (only saying yes does)', () => {
  const joining = m.liveReducer(viewer(), live());
  const s = run(joining, { type: 'token_ok', role: 'cohost' }, { type: 'connected' });
  expect(s).toMatchObject({ phase: 'watching', role: 'viewer' });
  expect(m.holdsCamera(s)).toBe(false);
});

it('taken off while the connection was coming back: leave the stage now (the reconnect would send the camera again)', () => {
  let s = m.liveReducer(onStage(), { type: 'reconnecting' });
  expect(s).toMatchObject({ phase: 'reconnecting', resumeTo: 'on_stage' });
  s = m.liveReducer(s, live('viewer'));
  expect(s).toMatchObject({ phase: 'leaving_stage', role: 'viewer', resumeTo: null });
  expect(m.liveTodo(s)).toBe('leave_stage');
  // Still the co-host: nothing changes.
  const still = m.liveReducer(onStage(), { type: 'reconnecting' });
  expect(m.liveReducer(still, live('cohost'))).toBe(still);
});

it('host: the background while starting or rejoining – nothing goes on air while away; back in front picks up', () => {
  // Home pressed during the 3·2·1: the start carries on (same step: nothing runs twice) but goes to 'away'.
  let s = m.liveReducer(host(), { type: 'start' });
  const before = s.step;
  s = m.liveReducer(s, { type: 'app_state', active: false });
  expect(s).toMatchObject({ phase: 'starting', background: true });
  expect(s.step).toBe(before);
  s = run(s, { type: 'token_ok', role: 'host' }, { type: 'on_air' });
  expect(s.phase).toBe('away');
  expect(m.liveTodo(s)).toBe('away');
  s = m.liveReducer(s, { type: 'app_state', active: true });
  expect(s).toMatchObject({ phase: 'checking', background: false });
  s = m.liveReducer(s, live('host'));
  expect(s).toMatchObject({ phase: 'live', resume: true });
  expect(m.liveTodo(s)).toBe('resume');
  // Back in front before going on air: just clears the flag.
  const front = run(host(), { type: 'start' }, { type: 'app_state', active: false }, { type: 'app_state', active: true });
  expect(front).toMatchObject({ phase: 'starting', background: false });
  expect(run(front, { type: 'on_air' }).phase).toBe('live');
  // Live → away → the connection drops → a rejoin connects while still away: 'away', not 'live'.
  let r = run(hostLive(), { type: 'app_state', active: false }, { type: 'disconnected', reason: 'other' });
  expect(r.phase).toBe('rejoining');
  r = run(r, { type: 'retry' }, { type: 'token_ok', role: 'host' }, { type: 'connected' });
  expect(r.phase).toBe('away');
  // Rejoining → background → connected → back: the sound, mic and camera come back on.
  let j = run(hostLive(), { type: 'reconnecting' }, { type: 'retry' }, { type: 'app_state', active: false }, { type: 'retry' });
  expect(j).toMatchObject({ phase: 'joining', background: true });
  j = run(j, { type: 'connected' });
  expect(j.phase).toBe('away');
  j = run(j, { type: 'app_state', active: true }, live('host'));
  expect(j).toMatchObject({ phase: 'live', resume: true });
  // A start that failed in the background doesn't keep the flag once you're back.
  const failed = run(host(), { type: 'start' }, { type: 'app_state', active: false }, { type: 'token_failed', reason: 'network', now: 0 }, { type: 'app_state', active: true });
  expect(failed).toMatchObject({ phase: 'failed', background: false });
});

it('the fixed times match the design', () => {
  expect(m.HOST_PING_MS).toBe(15_000);
  expect(m.VIEWER_PING_MS).toBe(30_000);
  expect(m.STAGE_WAIT_RETRY_MS).toBe(2000);
  expect(m.STAGE_WAIT_MAX_MS).toBe(70_000);
  expect([...m.REJOIN_DELAYS_MS]).toEqual([2000, 5000, 10_000]);
  expect([...m.AFTER_REMOVAL_DELAYS_MS]).toEqual([2000, 5000, 15_000, 30_000, 60_000]);
});
