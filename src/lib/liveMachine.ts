// ---------------------------------------------------------------------------
// Lives 🔴: what the live screens are doing right now, as one pure "reducer" (no LiveKit, no React, no server
// calls), so every step can be tested. The screens (go-live and live/[id]) send it what happened (an event)
// and do the work its state asks for (see liveTodo below). Waits are asked for with `retryInMs`: the screen
// starts a timer and sends { type: 'retry' } when it runs out.
//
// Viewer:  checking → joining → watching ⇄ reconnecting → rejoining → joining … → lost
//          checking → blocked (not allowed / removed / ended / other phone / log in again)
//                   → waiting (the host brought on someone you're not friends with: re-check every 15 s)
//                   → full (try again every 30 s) → unavailable (busy / not set up / not working)
//          watching → invited → going_on → on_stage → leaving_stage → watching
// Host:    ready → starting → live ⇄ away (app in the background) → ending → summary
// Anything the server says that isn't "live" wins over everything.
// ---------------------------------------------------------------------------

import type { LiveRole } from './liveAccess';

export type LiveScreen = 'host' | 'viewer';

export type LivePhase =
  | 'checking' // asking the server (liveStatus / livePing)
  | 'blocked' // can't watch (why: BlockedWhy)
  | 'waiting' // paused by the stage rule (re-check every 15 s, back in by itself)
  | 'full' // the live is full (re-check every 30 s)
  | 'unavailable' // why: 'busy' | 'not_set_up' | 'unavailable' (Try again)
  | 'joining' // getting a ticket (token) and connecting (host: and sending the camera again)
  | 'watching'
  | 'reconnecting' // LiveKit's own resume (up to 30 s)
  | 'rejoining' // waiting `retryInMs` before the next try with a fresh ticket
  | 'lost' // "Connection lost" (Try again)
  | 'away' // the app is in the background
  | 'invited' // the host asked you to come on
  | 'going_on' // coming on stage (a co-host ticket; "Getting the stage ready…" retries)
  | 'on_stage'
  | 'leaving_stage' // back to watching (stop the camera, reconnect hidden)
  | 'ready' // host: the countdown hasn't started
  | 'starting' // host: making the live, connecting, sending the camera
  | 'live' // host: on air
  | 'ending' // host: stopping
  | 'summary' // host: the live is over (why = the ended reason, when known)
  | 'failed'; // host: couldn't go live (why: HostFailure)

export type BlockedWhy = 'not_allowed' | 'removed' | 'ended' | 'update' | 'other_device' | 'login';
export type UnavailableWhy = 'busy' | 'not_set_up' | 'unavailable';
export type HostFailure = 'permission' | 'not_set_up' | 'unavailable' | 'busy' | 'full' | 'limit' | 'network' | 'other_device' | 'login';
// Why coming on stage didn't work (the screen goes back to watching and shows a line).
export type StageFailure = 'permission' | 'stage_timeout' | 'full' | 'busy' | 'unavailable';
// How LiveKit said the connection ended (LiveStage turns LiveKit's own codes into these).
export type StageDisconnectReason = 'client' | 'duplicate' | 'removed' | 'room_deleted' | 'other';

export type LiveMachine = {
  screen: LiveScreen;
  phase: LivePhase;
  role: LiveRole | null; // the role the server gave you (ticket or ping)
  why: string | null; // for blocked / unavailable / failed / summary / a stage failure
  message: string | null; // the server's own words, when it sent some
  round: 'rejoin' | 'removed' | null; // which retry round is running (null = none)
  attempt: number; // tries made in this round
  retryInMs: number | null; // the screen sends { type: 'retry' } after this long
  resumeTo: LivePhase | null; // where 'reconnecting' goes back to
  resume: boolean; // host: back from the background, turn the mic and camera back on (then send 'resumed')
  invite: { id: string; expires_at: string } | null;
  stageWaitSince: number | null; // when coming on stage started (for the 70 s limit)
  userMuted: boolean; // your own mute choice (kept apart from the background mute)
  step: number; // goes up on every change (screens can run effects per step)
};

// The status part of liveStatus / livePing that the machine needs.
export type StatusInfo = {
  status: 'live' | 'paused' | 'ended' | 'removed' | 'not_allowed';
  role?: LiveRole | null;
  invite?: { id: string; expires_at: string } | null;
  ended_reason?: string | null;
};

export type LiveEvent =
  | { type: 'open' } // the viewer screen opened, or Try again
  | { type: 'status'; info: StatusInfo } // an answer from liveStatus or livePing
  | { type: 'status_failed' } // liveStatus failed (no internet); failed pings are ignored, don't send them
  | { type: 'token_ok'; role: LiveRole }
  | { type: 'token_failed'; reason: string | null; message?: string | null; now: number }
  | { type: 'connected' } // the room connected (host: and the camera is out again, after a rejoin)
  | { type: 'connect_failed'; permission?: boolean; now: number }
  | { type: 'reconnecting' } // LiveKit is resuming by itself
  | { type: 'reconnected' }
  | { type: 'disconnected'; reason: StageDisconnectReason }
  | { type: 'retry' } // the `retryInMs` timer ran out
  | { type: 'blocked'; why: BlockedWhy }
  | { type: 'invite'; invite: { id: string; expires_at: string } }
  | { type: 'invite_gone' }
  | { type: 'accept'; now: number } // answerCohostInvite said 'cohost'
  | { type: 'decline' }
  | { type: 'leave_stage' } // you tapped Leave stage
  | { type: 'taken_off' } // the host took you off (no more publishing, or a ping says 'viewer')
  | { type: 'app_state'; active: boolean }
  | { type: 'mute'; muted: boolean }
  | { type: 'resumed' } // host: the mic and camera are back after the background
  // host only
  | { type: 'start' } // the countdown starts (or Try again)
  | { type: 'on_air' } // liveOnAir worked: you're live
  | { type: 'failed'; why: HostFailure; message?: string | null }
  | { type: 'end' } // ✕ → End
  | { type: 'ended'; reason?: string | null }; // the live is over (the summary can show)

// Fixed times (milliseconds).
export const WAITING_RECHECK_MS = 15_000;
export const FULL_RETRY_MS = 30_000;
export const RECONNECT_GIVE_UP_MS = 30_000;
export const REJOIN_DELAYS_MS = [2_000, 5_000, 10_000] as const;
// After a removal the server may block you for about a minute (a "hard" removal), so wait longer.
export const AFTER_REMOVAL_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const;
export const STAGE_WAIT_RETRY_MS = 2_000;
export const STAGE_WAIT_MAX_MS = 70_000;
export const HOST_PING_MS = 15_000;
export const VIEWER_PING_MS = 30_000;

export function newLiveMachine(screen: LiveScreen): LiveMachine {
  return {
    screen,
    phase: screen === 'host' ? 'ready' : 'checking',
    role: screen === 'host' ? 'host' : null,
    why: null,
    message: null,
    round: null,
    attempt: 0,
    retryInMs: null,
    resumeTo: null,
    resume: false,
    invite: null,
    stageWaitSince: null,
    userMuted: false,
    step: 0,
  };
}

// Phases where you are (or should be) in the room.
const IN_ROOM: readonly LivePhase[] = ['watching', 'reconnecting', 'invited', 'on_stage', 'live'];
// Phases where the server's "no" can still arrive and must win.
const OVER: readonly LivePhase[] = ['blocked', 'summary', 'failed', 'ending'];

type Patch = Partial<Omit<LiveMachine, 'screen' | 'step'>>;

function to(state: LiveMachine, patch: Patch): LiveMachine {
  return { ...state, retryInMs: null, ...patch, step: state.step + 1 };
}

// Start (or continue) a retry round; when it's used up: 'lost'.
function nextTry(state: LiveMachine, round: 'rejoin' | 'removed' = state.round ?? 'rejoin'): LiveMachine {
  const delays = round === 'removed' ? AFTER_REMOVAL_DELAYS_MS : REJOIN_DELAYS_MS;
  const attempt = state.round === round ? state.attempt : 0;
  if (attempt >= delays.length) {
    return to(state, { phase: 'lost', round: null, attempt: 0, why: null, invite: null, resumeTo: null });
  }
  return to(state, { phase: 'rejoining', round, attempt, retryInMs: delays[attempt], invite: null, resumeTo: null });
}

function blocked(state: LiveMachine, why: BlockedWhy, message: string | null = null): LiveMachine {
  if (state.screen === 'host') {
    if (why === 'ended' || why === 'removed' || why === 'not_allowed') return to(state, { phase: 'summary', why: state.why, round: null, attempt: 0, invite: null });
    return to(state, { phase: 'failed', why, message, round: null, attempt: 0, invite: null });
  }
  return to(state, { phase: 'blocked', why, message, role: null, round: null, attempt: 0, invite: null, stageWaitSince: null, resumeTo: null });
}

function waiting(state: LiveMachine, message: string | null = null): LiveMachine {
  if (state.screen === 'host') return state;
  return to(state, { phase: 'waiting', why: null, message, role: null, round: null, attempt: 0, retryInMs: WAITING_RECHECK_MS, invite: null, stageWaitSince: null, resumeTo: null });
}

// A server answer that isn't "live" (from a ping or a status check) wins over everything.
function notLive(state: LiveMachine, info: StatusInfo): LiveMachine {
  switch (info.status) {
    case 'paused':
      return waiting(state);
    case 'removed':
      return blocked(state, 'removed');
    case 'not_allowed':
      return blocked(state, 'not_allowed');
    case 'ended':
    default:
      if (state.screen === 'host') {
        return to(state, { phase: 'summary', why: info.ended_reason ?? state.why ?? null, round: null, attempt: 0, invite: null, resume: false });
      }
      return blocked(state, 'ended');
  }
}

function onStatus(state: LiveMachine, info: StatusInfo): LiveMachine {
  if (state.phase === 'summary' || state.phase === 'failed') {
    // The host's summary only takes a better reason.
    if (state.phase === 'summary' && info.status === 'ended' && info.ended_reason && !state.why) return to(state, { why: info.ended_reason });
    return state;
  }
  if (state.phase === 'blocked') return state;
  if (info.status !== 'live') return notLive(state, info);
  const role = info.role ?? state.role;

  switch (state.phase) {
    case 'checking':
      if (state.screen === 'host') {
        // Back from the background (or a check after a drop): still live.
        return to(state, { phase: 'live', role: 'host', resume: true, round: null, attempt: 0 });
      }
      // After a removal the room may refuse you for about a minute: the slow retry round.
      if (state.round === 'removed') return { ...nextTry(state, 'removed'), role };
      return to(state, { phase: 'joining', role, why: null, message: null, invite: info.invite ?? null });
    case 'waiting':
    case 'full':
    case 'unavailable':
    case 'lost':
      return to(state, { phase: 'joining', role, why: null, message: null, round: null, attempt: 0 });
    case 'watching':
      if (info.invite && state.role !== 'cohost') return to(state, { phase: 'invited', invite: info.invite });
      return state;
    case 'invited':
      if (!info.invite) return to(state, { phase: 'watching', invite: null });
      return state;
    case 'on_stage':
      // The server says you're a viewer again: the host took you off.
      if (info.role === 'viewer') return to(state, { phase: 'leaving_stage', role: 'viewer', why: null });
      return state;
    default:
      return state;
  }
}

function hostFailureFor(reason: string | null): HostFailure {
  switch (reason) {
    case 'not_set_up':
    case 'unavailable':
    case 'busy':
    case 'full':
    case 'network':
    case 'login':
      return reason;
    case 'login_changed':
      return 'login';
    default:
      return reason && /limit|testers|off|banned|restricted|birthday|rules|friends|new_account/.test(reason) ? 'limit' : 'unavailable';
  }
}

function onTokenFailed(state: LiveMachine, reason: string | null, message: string | null, now: number): LiveMachine {
  switch (reason) {
    case 'paused':
      return state.screen === 'host' ? to(state, { phase: 'failed', why: 'unavailable', message }) : waiting(state, message);
    case 'not_allowed':
    case 'removed':
    case 'ended':
      return blocked(state, reason, message);
    case 'login':
    case 'login_changed':
      return blocked(state, 'login', message);
  }

  if (state.screen === 'host') {
    // While starting, every "no" is a failure with its own words. While rejoining, keep trying.
    if (state.phase === 'starting' || state.phase === 'ready') return to(state, { phase: 'failed', why: hostFailureFor(reason), message });
    if (reason === 'network' || reason === 'unavailable' || reason === null) return nextTry(state);
    return to(state, { phase: 'failed', why: hostFailureFor(reason), message });
  }

  if (state.phase === 'going_on') {
    const since = state.stageWaitSince ?? now;
    const timeLeft = now - since < STAGE_WAIT_MAX_MS;
    if ((reason === 'stage_wait' || reason === 'network' || reason === null) && timeLeft) {
      return to(state, { retryInMs: STAGE_WAIT_RETRY_MS, message, stageWaitSince: since });
    }
    const why: StageFailure = reason === 'full' || reason === 'busy' ? reason : reason === 'stage_wait' || reason === 'network' || reason === null ? 'stage_timeout' : 'unavailable';
    return to(state, { phase: 'leaving_stage', role: 'viewer', why, message: null, stageWaitSince: null });
  }

  if (reason === 'full') return to(state, { phase: 'full', why: 'full', message, round: null, attempt: 0, retryInMs: FULL_RETRY_MS, invite: null });
  // A busy or not-working server only stops the first join; a rejoin keeps trying.
  if ((reason === 'busy' || reason === 'not_set_up' || reason === 'unavailable') && !state.round) {
    return to(state, { phase: 'unavailable', why: reason, message, round: null, attempt: 0, invite: null });
  }
  // No internet (or anything else): try again in a moment.
  return nextTry(state);
}

function onConnectFailed(state: LiveMachine, permission: boolean, now: number): LiveMachine {
  if (state.screen === 'host') {
    if (permission) return to(state, { phase: 'failed', why: 'permission' });
    if (state.phase === 'starting') return to(state, { phase: 'failed', why: 'network' });
    return nextTry(state);
  }
  if (state.phase === 'going_on') {
    if (permission) return to(state, { phase: 'leaving_stage', role: 'viewer', why: 'permission', stageWaitSince: null });
    return onTokenFailed(state, 'network', null, now);
  }
  return nextTry(state);
}

function onDisconnected(state: LiveMachine, reason: StageDisconnectReason): LiveMachine {
  // Only a connection that was up (or coming up) can drop.
  const connected = IN_ROOM.includes(state.phase) || state.phase === 'joining' || state.phase === 'going_on' || (state.screen === 'host' && state.phase === 'away');
  if (!connected || reason === 'client') return state;
  switch (reason) {
    case 'room_deleted':
      return state.screen === 'host' ? to(state, { phase: 'summary', round: null, attempt: 0, invite: null }) : blocked(state, 'ended');
    case 'duplicate':
      return blocked(state, 'other_device');
    case 'removed':
      // The server decides what it meant: removed, paused (waiting), a new role (rejoin), or ended.
      if (state.screen === 'host') return to(state, { phase: 'checking', round: null, attempt: 0 });
      return to(state, { phase: 'checking', round: 'removed', attempt: 0, invite: null, resumeTo: null, stageWaitSince: null });
    default:
      return nextTry({ ...state, round: null, attempt: 0 });
  }
}

export function liveReducer(state: LiveMachine, event: LiveEvent): LiveMachine {
  switch (event.type) {
    case 'open':
      if (state.screen === 'host') return state;
      return to(state, { phase: 'checking', why: null, message: null, round: null, attempt: 0, invite: null, stageWaitSince: null, resumeTo: null });

    case 'status':
      return onStatus(state, event.info);

    case 'status_failed':
      if (state.phase !== 'checking') return state;
      // Host back from the background: carry on as live (the next ping will tell if it ended).
      if (state.screen === 'host') return to(state, { phase: 'live', resume: true });
      if (state.round) return nextTry(state);
      return to(state, { phase: 'lost', why: null });

    case 'token_ok':
      if (OVER.includes(state.phase)) return state;
      return to(state, { role: event.role, retryInMs: state.retryInMs });

    case 'token_failed':
      if (OVER.includes(state.phase)) return state;
      return onTokenFailed(state, event.reason, event.message ?? null, event.now);

    case 'connected':
      switch (state.phase) {
        case 'joining':
          if (state.screen === 'host') return to(state, { phase: 'live', round: null, attempt: 0 });
          return to(state, { phase: state.role === 'cohost' ? 'on_stage' : 'watching', round: null, attempt: 0 });
        case 'going_on':
          return to(state, { phase: 'on_stage', role: 'cohost', stageWaitSince: null, round: null, attempt: 0 });
        case 'leaving_stage':
          return to(state, { phase: 'watching', role: 'viewer', round: null, attempt: 0 });
        default:
          return state; // the host's start goes on to 'on_air'
      }

    case 'connect_failed':
      if (OVER.includes(state.phase)) return state;
      return onConnectFailed(state, !!event.permission, event.now);

    case 'reconnecting':
      if (!IN_ROOM.includes(state.phase) || state.phase === 'reconnecting') return state;
      return to(state, { phase: 'reconnecting', resumeTo: state.phase, retryInMs: RECONNECT_GIVE_UP_MS });

    case 'reconnected':
      if (state.phase !== 'reconnecting') return state;
      return to(state, { phase: state.resumeTo ?? (state.screen === 'host' ? 'live' : 'watching'), resumeTo: null });

    case 'disconnected':
      return onDisconnected(state, event.reason);

    case 'retry':
      if (state.retryInMs === null) return state;
      switch (state.phase) {
        case 'waiting':
        case 'full':
          return to(state, { phase: 'checking', why: null, message: null });
        case 'rejoining':
          return to(state, { phase: 'joining', attempt: state.attempt + 1 });
        case 'reconnecting':
          // LiveKit's own resume took too long: get a fresh ticket.
          return nextTry({ ...state, round: null, attempt: 0 });
        case 'going_on':
          return to(state, { retryInMs: null }); // ask for the co-host ticket again
        default:
          return state;
      }

    case 'blocked':
      return blocked(state, event.why);

    case 'invite':
      if (state.phase !== 'watching' || state.role === 'cohost') return state;
      return to(state, { phase: 'invited', invite: event.invite });

    case 'invite_gone':
      if (state.phase !== 'invited') return state;
      return to(state, { phase: 'watching', invite: null });

    case 'accept':
      if (state.phase !== 'invited' && state.phase !== 'watching') return state;
      return to(state, { phase: 'going_on', role: 'cohost', invite: null, stageWaitSince: event.now, why: null, message: null, round: null, attempt: 0 });

    case 'decline':
      if (state.phase !== 'invited') return state;
      return to(state, { phase: 'watching', invite: null });

    case 'leave_stage':
    case 'taken_off':
      if (state.phase !== 'on_stage' && !(state.phase === 'reconnecting' && state.resumeTo === 'on_stage') && state.phase !== 'going_on') return state;
      return to(state, { phase: 'leaving_stage', role: 'viewer', why: null, stageWaitSince: null, resumeTo: null });

    case 'app_state':
      if (state.screen === 'host') {
        if (!event.active && (state.phase === 'live' || state.phase === 'reconnecting')) return to(state, { phase: 'away', resumeTo: null });
        if (event.active && state.phase === 'away') return to(state, { phase: 'checking' });
        return state;
      }
      if (!event.active) {
        // Watching (or on stage) stops in the background, so no minutes are used. A co-host leaves the stage.
        const busy: readonly LivePhase[] = ['joining', 'watching', 'reconnecting', 'rejoining', 'invited', 'going_on', 'on_stage', 'leaving_stage'];
        if (!busy.includes(state.phase)) return state;
        return to(state, { phase: 'away', invite: null, stageWaitSince: null, round: null, attempt: 0, resumeTo: null });
      }
      if (state.phase === 'away') return to(state, { phase: 'checking', role: 'viewer' });
      return state;

    case 'mute':
      return state.userMuted === event.muted ? state : to(state, { userMuted: event.muted, retryInMs: state.retryInMs });

    case 'resumed':
      return state.resume ? to(state, { resume: false, retryInMs: state.retryInMs }) : state;

    case 'start':
      if (state.screen !== 'host' || (state.phase !== 'ready' && state.phase !== 'failed')) return state;
      return to(state, { phase: 'starting', why: null, message: null, round: null, attempt: 0 });

    case 'on_air':
      if (state.screen !== 'host' || state.phase !== 'starting') return state;
      return to(state, { phase: 'live', round: null, attempt: 0 });

    case 'failed':
      if (state.screen !== 'host' || state.phase === 'summary') return state;
      return to(state, { phase: 'failed', why: event.why, message: event.message ?? null });

    case 'end':
      if (state.screen !== 'host' || OVER.includes(state.phase)) return state;
      return to(state, { phase: 'ending', resume: false });

    case 'ended':
      if (state.screen !== 'host') return blocked(state, 'ended');
      return to(state, { phase: 'summary', why: event.reason ?? state.why ?? null, round: null, attempt: 0, invite: null, resume: false });

    default:
      return state;
  }
}

// What the screen should do now for this state (do it once per `step`):
// - 'status': ask liveStatus (→ 'status' / 'status_failed');
// - 'connect': get a ticket and connect (→ 'token_ok'/'token_failed', then 'connected'/'connect_failed');
//   the host also sends the camera again; in 'going_on' this is the co-host ticket, then publish;
// - 'leave_stage': endCohost (if you left yourself), stop the camera, disconnect, release the camera, then a
//   viewer ticket and a hidden reconnect (→ 'connected');
// - 'away': viewer – disconnect and leaveLive (a co-host also ends the stage and releases the camera);
//   host – camera and mic off (viewers see "will be right back");
// - 'resume': host – resumeLiveAudio, then the mic back to your own choice, then the camera on (→ 'resumed');
// - 'start': host – startLive → ticket → connect → publish → liveOnAir (→ 'on_air' / 'failed');
// - 'end': host – unpublish → disconnect → release the camera, then endLiveInBackground (→ 'ended');
// - null: nothing (or just wait for `retryInMs`).
export type LiveTodo = 'status' | 'connect' | 'leave_stage' | 'away' | 'resume' | 'start' | 'end' | null;

export function liveTodo(state: LiveMachine): LiveTodo {
  switch (state.phase) {
    case 'checking':
      return 'status';
    case 'joining':
      return 'connect';
    case 'going_on':
      return state.retryInMs === null ? 'connect' : null;
    case 'leaving_stage':
      return 'leave_stage';
    case 'away':
      return 'away';
    case 'live':
      return state.resume ? 'resume' : null;
    case 'starting':
      return 'start';
    case 'ending':
      return 'end';
    default:
      return null;
  }
}

// Should the LiveKit connection be closed in this state? (The screen closes it if it's open.)
export function shouldDisconnect(state: LiveMachine): boolean {
  if (state.screen === 'host') return ['summary', 'failed', 'ready', 'rejoining', 'lost'].includes(state.phase);
  return ['checking', 'blocked', 'waiting', 'full', 'unavailable', 'rejoining', 'lost', 'away'].includes(state.phase);
}

// Should this phone's camera be held for the live in this state? When it turns false, the screen calls
// releaseCameraFromLive() – but only after the camera has stopped (unpublish and disconnect first).
export function holdsCamera(state: LiveMachine): boolean {
  if (state.screen === 'host') return ['ready', 'starting', 'live', 'away', 'reconnecting', 'rejoining', 'joining', 'checking', 'ending'].includes(state.phase);
  if (state.phase === 'leaving_stage') return true; // released at the end of the leave-stage steps
  return state.role === 'cohost' && ['going_on', 'on_stage', 'reconnecting', 'joining', 'rejoining'].includes(state.phase);
}

// Is this the phone saying "you didn't allow the camera or microphone"? (getUserMedia's error)
export function isPermissionError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') return true;
  const message = String((error as { message?: unknown } | null)?.message ?? error ?? '');
  return /permission|not allowed|denied|unauthori[sz]ed/i.test(message);
}

// Words for the states that have fixed words (the screens show the server's `message` first when there is one).
export const LIVE_MACHINE_WORDS = {
  lost: 'Connection lost',
  reconnecting: 'Reconnecting…',
  other_device: 'You opened this live on another phone',
  full: 'This live is full right now',
  login: 'Please log in again.',
  stage_wait: 'Getting the stage ready…',
  stage_timeout: "Couldn't bring you on – try again",
  stage_permission: 'You need to allow the camera and microphone to come on.',
  host_network: "Couldn't go live – check your internet",
  host_unavailable: "Lives aren't working right now – try again in a bit.",
  host_away: 'will be right back',
} as const;
