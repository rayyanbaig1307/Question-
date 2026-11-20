import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { Alert, AppState, Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { IconButton } from '@/components/IconButton';
import { KeyboardSafeView } from '@/components/KeyboardSafeView';
import { useOverlays, type SheetOption } from '@/components/Overlays';
import { SafeEdge } from '@/components/SafeEdge';
import { InviteSheet } from '@/components/live/InviteSheet';
import { LiveCommentList, LiveComposer } from '@/components/live/LiveComments';
import { LiveCard } from '@/components/live/LiveEndedCard';
import { LiveHearts, useFloatingHearts } from '@/components/live/LiveHearts';
import { LiveRulesCard } from '@/components/live/LiveRulesSheet';
import { LiveTopBar, personName } from '@/components/live/LiveTopBar';
import { useMe } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import {
  HEARTS_ENABLED,
  holdCameraForLive,
  isCameraHeldByLive,
  isLiveAvailable,
  LIVE_UNAVAILABLE_WORDS,
  liveBroken,
  liveMaybeAvailable,
  liveNowRole,
  liveUnavailableReason,
  loadLiveStage,
  markLiveBroken,
  releaseCameraFromLive,
  setLiveNow,
  subscribeLiveBroken,
  waitForCameraRelease,
  whileLeaving,
  type LiveStageModule,
} from '@/lib/liveAccess';
import { setLiveExit } from '@/lib/liveExit';
import { HeartSender } from '@/lib/liveHearts';
import {
  holdsCamera,
  isPermissionError,
  LIVE_MACHINE_WORDS,
  liveReducer,
  liveTodo,
  newLiveMachine,
  shouldDisconnect,
  VIEWER_PING_MS,
  type LiveEvent,
  type LivePhase,
  type StatusInfo,
} from '@/lib/liveMachine';
import { ensureLivePermissions, openPhoneSettings } from '@/lib/livePermissions';
import {
  answerCohostInvite,
  checkLiveComment,
  deleteLiveComment,
  endCohost,
  fetchLiveComments,
  fetchStageWatchers,
  getLiveToken,
  isLiveId,
  LIVE_TOKEN_WORDS,
  leaveLive,
  listenToLive,
  liveHint,
  livePing,
  liveStatus,
  sendLiveComment,
  type LiveComment,
  type LivePerson,
  type LiveStatus,
} from '@/lib/lives';
import { useSafetyActions } from '@/lib/useSafetyActions';
import { colors, radius, space } from '@/theme';

type StageHandle = ReturnType<LiveStageModule['createStage']>;
type Facing = 'front' | 'back';

// Where you're in the live's room (for pings, comments and hearts).
const IN_ROOM: readonly LivePhase[] = ['watching', 'invited', 'on_stage', 'reconnecting'];
// On stage: how often the list of people who may see you is fetched again (someone new may have come in).
const WATCHERS_REFRESH_MS = 5000;
// Leaving the screen: the camera is given back once LiveKit's camera has stopped, or after this long.
const STOP_WAIT_MS = 3000;

// The words on the "can't watch" cards (`why` from the live machine). The server's own words come first.
export function viewerCardWords(why: string | null, message: string | null): string {
  switch (why) {
    case 'ended':
      return LIVE_TOKEN_WORDS.ended;
    case 'removed':
      return LIVE_TOKEN_WORDS.removed;
    case 'other_device':
      return LIVE_MACHINE_WORDS.other_device;
    case 'login':
      return message ?? LIVE_MACHINE_WORDS.login;
    case 'update':
      return LIVE_UNAVAILABLE_WORDS.update;
    case 'busy':
    case 'not_set_up':
    case 'unavailable':
      return message ?? LIVE_TOKEN_WORDS[why] ?? LIVE_TOKEN_WORDS.unavailable;
    case 'not_allowed':
    default:
      return LIVE_TOKEN_WORDS.not_allowed;
  }
}

// Why coming on stage didn't work (shown as a short message once you're back to watching).
export function stageFailureWords(why: string | null): string | null {
  switch (why) {
    case 'permission':
      return LIVE_MACHINE_WORDS.stage_permission;
    case 'stage_timeout':
      return LIVE_MACHINE_WORDS.stage_timeout;
    case 'full':
      return LIVE_TOKEN_WORDS.full;
    case 'busy':
      return LIVE_TOKEN_WORDS.busy;
    case 'unavailable':
      return LIVE_TOKEN_WORDS.unavailable;
    default:
      return null;
  }
}

function leaveScreen() {
  if (router.canGoBack?.()) router.back();
  else router.replace('/');
}

// Watching a friend's live 🔴 (and being on their stage as the co-host). Opened from a live circle on Home,
// a "Sam is live" notification or a link. Only the host's friends get in – the server checks every time.
export default function WatchLive() {
  const { userId } = useMe();
  const params = useLocalSearchParams<{ id?: string }>();
  const liveId = typeof params.id === 'string' ? params.id : '';
  const [check] = useState<'ok' | 'bad_link' | 'in_live' | 'unavailable'>(() => {
    if (!isLiveId(liveId)) return 'bad_link';
    const role = liveNowRole();
    if (role === 'host' || role === 'cohost') return 'in_live';
    // The real check (it wakes LiveKit's parts on the phone) runs only here, when a live is opened.
    return liveMaybeAvailable() && isLiveAvailable() ? 'ok' : 'unavailable';
  });
  if (check === 'ok') return <Watch liveId={liveId} userId={userId} />;
  const reason = liveUnavailableReason() ?? 'broken';
  const title =
    check === 'unavailable'
      ? LIVE_UNAVAILABLE_WORDS[reason]
      : check === 'in_live'
        ? "You're in a live right now"
        : LIVE_TOKEN_WORDS.not_allowed;
  return (
    <View style={styles.center}>
      <EmptyState emoji="🔴" title={title}>
        <Button title="Back" icon="arrow-back" onPress={leaveScreen} />
      </EmptyState>
    </View>
  );
}

function Watch({ liveId, userId }: { liveId: string; userId: string }) {
  const { showOptions, showToast } = useOverlays();
  const { report, confirmBlock } = useSafetyActions();
  const [first] = useState(() => newLiveMachine('viewer'));
  const [m, dispatch] = useReducer(liveReducer, first);
  // The newest state, for the steps that run in the background. Every event goes through `send`, which works
  // out the same next state here straight away, so this never lags behind `m`.
  const machine = useRef(first);
  const alive = useRef(true);
  const send = useCallback((event: LiveEvent) => {
    if (!alive.current) return;
    machine.current = liveReducer(machine.current, event);
    dispatch(event);
  }, []);

  const [info, setInfo] = useState<LiveStatus | null>(null);
  const hostId = useRef<string | null>(null);
  // The co-host you saw last (so you can still report them after the live ends: the server stops naming them).
  const [lastCohost, setLastCohost] = useState<LivePerson | null>(null);
  // LiveKit (loaded only once you join) and this screen's connection to it.
  const [stageParts, setStageParts] = useState<{ module: LiveStageModule; handle: StageHandle } | null>(null);
  const stage = useRef<StageHandle | null>(null);
  // LiveKit couldn't load on this phone (lives switch themselves off until the app is closed).
  const broken = useSyncExternalStore(subscribeLiveBroken, liveBroken, liveBroken);
  const [connectedOnce, setConnectedOnce] = useState(false);
  const [comments, setComments] = useState<LiveComment[]>([]);
  const [facing, setFacing] = useState<Facing>('front');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const leftMyself = useRef(false);
  const joined = useRef(false);
  // Which connect (or leave-stage) is the current one: an older one still waiting for an answer stops itself.
  const runId = useRef(0);
  // This screen's hold on the camera (so a late release can't take it from a newer live).
  const cameraHold = useRef<number | null>(null);
  // Another screen is on top of this one (a chat opened from a notification, for example).
  const blurred = useRef(false);
  const sender = useRef(new HeartSender());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { hearts, add: drawHearts, done: heartDone } = useFloatingHearts();
  const lastTap = useRef(0);

  const remember = useCallback((status: LiveStatus) => {
    if (status.host?.id) hostId.current = status.host.id;
    if (status.cohost) setLastCohost(status.cohost);
    setInfo(status);
  }, []);

  // ---------------------------------------------------------------------------
  // The stage (LiveKit), made once.
  // ---------------------------------------------------------------------------
  const ensureStage = useCallback(
    (module: LiveStageModule): StageHandle => {
      if (stage.current) return stage.current;
      const made = module.createStage({
        hostId: hostId.current ?? '',
        onReconnecting: () => send({ type: 'reconnecting' }),
        onDisconnected: (reason) => send({ type: 'disconnected', reason }),
        onHearts: (count) => {
          if (HEARTS_ENABLED) drawHearts(count);
        },
        onReconnected: () => {
          send({ type: 'reconnected' });
          // Back on stage after a drop: ask the server straight away whether you're still on (the host may have
          // taken you off meanwhile – then the camera must stop now, not at the next ping).
          if (machine.current.phase === 'on_stage') {
            livePing(liveId)
              .then((status) => {
                if (!alive.current) return;
                remember(status);
                send({ type: 'status', info: status as StatusInfo });
              })
              .catch(() => {});
          }
        },
        // The host took you off the stage.
        onPublishAllowed: (allowed) => {
          if (!allowed) send({ type: 'taken_off' });
        },
      });
      stage.current = made;
      setStageParts({ module, handle: made });
      return made;
    },
    [send, drawHearts, liveId, remember],
  );

  // ---------------------------------------------------------------------------
  // The steps the machine asks for.
  // ---------------------------------------------------------------------------
  const runStatus = useCallback(() => {
    liveStatus(liveId).then(
      (status) => {
        if (!alive.current) return;
        remember(status);
        send({ type: 'status', info: status as StatusInfo });
      },
      () => send({ type: 'status_failed' }),
    );
  }, [liveId, remember, send]);

  // Get a ticket and connect: hidden as a viewer, or (coming on stage) with your camera and microphone.
  const runConnect = useCallback(async () => {
    const run = ++runId.current;
    const stale = () => runId.current !== run;
    const goingOn = machine.current.phase === 'going_on';
    // Only someone coming on (or already on) may send their camera: the camera is handed over to the live
    // first (the camera screens let go of it).
    const mayPublish = goingOn || machine.current.role === 'cohost';
    if (mayPublish) cameraHold.current = holdCameraForLive();
    await (mayPublish ? waitForCameraRelease() : Promise.resolve());
    if (stale() || !alive.current) return;
    const ticket = await getLiveToken(liveId, userId);
    if (stale() || !alive.current) return;
    if (!ticket.ok) {
      send({ type: 'token_failed', reason: ticket.reason, message: ticket.message, now: Date.now() });
      return;
    }
    if (goingOn && ticket.role !== 'cohost') {
      // The host changed their mind meanwhile.
      send({ type: 'taken_off' });
      return;
    }
    if (ticket.role === 'cohost' && !mayPublish) {
      // The server still has you on stage (coming on didn't work out earlier). Never send your camera from
      // here: end that turn first, then try again for a plain watching ticket.
      await endCohost(liveId).catch(() => {});
      if (!stale()) send({ type: 'token_failed', reason: 'network', message: null, now: Date.now() });
      return;
    }
    // On stage: who may see and hear you. LiveKit is told before anything is sent, and refuses everyone else.
    let watchers: string[] | null = null;
    if (ticket.role === 'cohost') {
      watchers = await fetchStageWatchers(liveId).catch(() => null);
      if (stale() || !alive.current) return;
      if (!watchers?.length) {
        send({ type: 'token_failed', reason: 'network', message: null, now: Date.now() });
        return;
      }
    }
    send({ type: 'token_ok', role: ticket.role });
    const module = loadLiveStage();
    if (!module) {
      markLiveBroken('LiveKit could not load');
      return;
    }
    const handle = ensureStage(module);
    if (watchers) handle.setWatchers(watchers);
    // Connecting on its own: a refusal from the server is never "the camera wasn't allowed".
    try {
      await handle.connect(ticket.url, ticket.token);
    } catch {
      if (!stale()) send({ type: 'connect_failed', permission: false, now: Date.now() });
      return;
    }
    if (stale()) return;
    if (ticket.role === 'cohost') {
      try {
        await handle.publish(facing);
        await handle.setMic(!machine.current.userMuted);
      } catch (error) {
        if (!stale()) send({ type: 'connect_failed', permission: isPermissionError(error), now: Date.now() });
        return;
      }
      if (stale()) return;
    }
    if (!alive.current) {
      handle.disconnect().catch(() => {});
      return;
    }
    joined.current = true;
    setConnectedOnce(true);
    send({ type: 'connected' });
  }, [liveId, userId, send, ensureStage, facing]);

  // Back to watching: end the stage on the server (whatever the reason: it only ever ends your own turn) →
  // camera off → disconnect → a viewer ticket → connect hidden → give the camera back.
  const runLeaveStage = useCallback(async () => {
    const run = ++runId.current;
    const stale = () => runId.current !== run;
    const line = stageFailureWords(machine.current.why);
    if (line) showToast(line);
    leftMyself.current = false;
    await endCohost(liveId).catch(() => {});
    const handle = stage.current;
    await handle?.unpublish().catch(() => {});
    await handle?.disconnect({ keepAudio: true }).catch(() => {});
    if (stale()) return;
    const backToWatching = () => {
      releaseCameraFromLive(cameraHold.current);
      setLiveNow(blurred.current ? null : 'viewer');
    };
    const ticket = await getLiveToken(liveId, userId);
    if (stale() || !alive.current) return;
    if (ticket.ok && ticket.role === 'cohost') {
      // The server still has you on stage (the end didn't arrive): never connect with that ticket. Try again.
      await endCohost(liveId).catch(() => {});
      backToWatching();
      if (!stale()) send({ type: 'token_failed', reason: 'network', message: null, now: Date.now() });
      return;
    }
    if (!ticket.ok) {
      backToWatching();
      send({ type: 'token_failed', reason: ticket.reason, message: ticket.message, now: Date.now() });
      return;
    }
    const module = loadLiveStage();
    if (!module) {
      releaseCameraFromLive(cameraHold.current);
      markLiveBroken('LiveKit could not load');
      return;
    }
    try {
      await ensureStage(module).connect(ticket.url, ticket.token);
    } catch {
      backToWatching();
      if (!stale()) send({ type: 'connect_failed', permission: false, now: Date.now() });
      return;
    }
    if (stale()) return;
    backToWatching();
    send({ type: 'connected' });
  }, [liveId, userId, send, ensureStage, showToast]);

  // In the background (or another screen on top): stop watching, so no minutes are used. On stage: leave it.
  // With another screen on top, nothing is live for you any more (updates may run, the screen may dim, live
  // notifications show) until you come back to the live.
  const runAway = useCallback(async () => {
    runId.current += 1; // any connect still waiting stops
    const handle = stage.current;
    // (The machine keeps your role while you're away: a co-host leaves the stage.)
    if (machine.current.role === 'cohost') endCohost(liveId).catch(() => {});
    await handle?.unpublish().catch(() => {});
    await handle?.disconnect().catch(() => {});
    releaseCameraFromLive(cameraHold.current);
    setLiveNow(blurred.current ? null : 'viewer');
    if (joined.current) leaveLive(liveId).catch(() => {});
  }, [liveId]);

  // You're "on stage" (co-host) or just watching – nothing restarts the app either way. Set before the server
  // is asked anything (this runs before the steps below). Not while another screen is on top (see runAway).
  const onStage = m.role === 'cohost' && holdsCamera(m);
  useEffect(() => {
    if (blurred.current) return;
    setLiveNow(onStage ? 'cohost' : 'viewer');
  }, [onStage]);

  // On stage: the list of people who may see you is fetched again every few seconds (someone may have come in,
  // or someone may have to wait now). If it can't be fetched, the old list stays.
  const sending = m.phase === 'on_stage' || (m.phase === 'reconnecting' && m.resumeTo === 'on_stage');
  useEffect(() => {
    const handle = stageParts?.handle;
    if (!sending || !handle) return;
    let stop = false;
    const timer = setInterval(() => {
      fetchStageWatchers(liveId)
        .then((list) => {
          if (!stop) handle.setWatchers(list);
        })
        .catch(() => {});
    }, WATCHERS_REFRESH_MS);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [sending, stageParts, liveId]);

  const doneStep = useRef(-1);
  useEffect(() => {
    if (doneStep.current === m.step) return;
    doneStep.current = m.step;
    switch (liveTodo(m)) {
      case 'status':
        runStatus();
        break;
      case 'connect':
        runConnect();
        break;
      case 'leave_stage':
        runLeaveStage();
        break;
      case 'away':
        runAway();
        break;
    }
  }, [m, runStatus, runConnect, runLeaveStage, runAway]);

  // States without a connection: close it (and give the camera back once it's closed).
  useEffect(() => {
    if (!shouldDisconnect(m) || m.phase === 'away') return;
    const handle = stage.current;
    const between = m.phase === 'rejoining';
    (async () => {
      await handle?.unpublish().catch(() => {});
      await handle?.disconnect(between ? { keepAudio: true } : undefined).catch(() => {});
      if (!holdsCamera(machine.current)) releaseCameraFromLive(cameraHold.current);
    })();
  }, [m]);

  // Waits the machine asked for (re-checks and retries).
  useEffect(() => {
    if (m.retryInMs === null) return;
    const timer = setTimeout(() => send({ type: 'retry' }), m.retryInMs);
    return () => clearTimeout(timer);
  }, [m.step, m.retryInMs, send]);

  // Pings every 30 seconds while you're in the room ("I'm still here", and what changed).
  const inRoom = IN_ROOM.includes(m.phase) || m.phase === 'going_on';
  useEffect(() => {
    if (!inRoom) return;
    let stop = false;
    const timer = setInterval(() => {
      livePing(liveId)
        .then((status) => {
          if (stop || !alive.current) return;
          remember(status);
          send({ type: 'status', info: status as StatusInfo });
        })
        .catch(() => {}); // a failed ping is ignored
    }, VIEWER_PING_MS);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [inRoom, liveId, remember, send]);

  // The host's camera is off (their app went to the background, or a phone call): "⏸ Sam will be right back".
  // Checked every 2 seconds from the connection itself (the host's camera is there but switched off).
  const [hostAway, setHostAway] = useState(false);
  const watchingNow = m.phase === 'watching' || m.phase === 'invited' || m.phase === 'on_stage';
  useEffect(() => {
    const handle = stageParts?.handle;
    if (!watchingNow || !handle) return;
    const check = () => {
      const host = hostId.current ? handle.room()?.remoteParticipants?.get(hostId.current) : undefined;
      // Only once the host has been seen sending (not before their first picture arrives).
      setHostAway(!!host && host.videoTrackPublications.size > 0 && !host.isCameraEnabled);
    };
    check();
    const timer = setInterval(check, 2000);
    return () => {
      clearInterval(timer);
      setHostAway(false);
    };
  }, [watchingNow, stageParts]);

  // The newest comments each time you (re)join.
  useEffect(() => {
    if (!inRoom) return;
    fetchLiveComments(liveId)
      .then((list) => alive.current && setComments(list))
      .catch(() => {});
  }, [inRoom, liveId]);

  // New and deleted comments, and the host asking you on, as they happen.
  useEffect(
    () =>
      listenToLive(liveId, userId, {
        onComment: (comment) => setComments((now) => (now.some((c) => c.id === comment.id) ? now : [comment, ...now].slice(0, 50))),
        onCommentGone: (commentId) => setComments((now) => now.filter((c) => c.id !== commentId)),
        onInvite: (invite) => send({ type: 'invite', invite: { id: invite.id, expires_at: invite.expires_at } }),
        onInviteChange: (changed) => {
          if (changed.guest_id === userId && changed.answer && changed.id === machine.current.invite?.id) send({ type: 'invite_gone' });
        },
      }),
    [liveId, userId, send],
  );

  // The app going to the background (or another screen opening on top) stops watching; coming back rejoins.
  // While another screen is on top, the app's own coming and going is ignored: only coming back to this
  // screen rejoins (never hidden underneath another screen).
  useEffect(() => {
    let last = AppState.currentState;
    const subscription = AppState.addEventListener('change', (state) => {
      if (!blurred.current) {
        if (state === 'background') send({ type: 'app_state', active: false });
        if (state === 'active' && last === 'background') send({ type: 'app_state', active: true });
      }
      last = state;
    });
    return () => subscription.remove();
  }, [send]);
  useFocusEffect(
    useCallback(() => {
      if (blurred.current) {
        blurred.current = false;
        // Live again before the server is asked anything.
        setLiveNow('viewer');
        send({ type: 'app_state', active: true });
      }
      return () => {
        blurred.current = true;
        send({ type: 'app_state', active: false });
      };
    }, [send]),
  );

  // "Leave the stage to open this?" (a notification tapped while you're on stage).
  useEffect(() => {
    if (!onStage) return;
    return setLiveExit(async () => {
      leftMyself.current = false;
      runId.current += 1;
      await endCohost(liveId).catch(() => {});
      await stage.current?.unpublish().catch(() => {});
      await stage.current?.disconnect().catch(() => {});
      releaseCameraFromLive(cameraHold.current);
      setLiveNow('viewer');
    });
  }, [onStage, liveId]);

  // Leaving the screen: stop sending and disconnect first, then tell the server (a waiting app update waits for
  // that: whileLeaving). The camera is given back only once LiveKit's camera has stopped (or after a few
  // seconds if stopping hangs), and only if no newer live took it meanwhile.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      runId.current += 1;
      if (flushTimer.current) clearTimeout(flushTimer.current);
      const handle = stage.current;
      // Still on stage (the shared "live now" role says so: leaving the screen may already have moved the steps on).
      const role = liveNowRole();
      const wasOnStage = role === 'cohost';
      const hold = cameraHold.current;
      const heldCamera = isCameraHeldByLive();
      const stopping = (async () => {
        await handle?.unpublish().catch(() => {});
        await handle?.disconnect().catch(() => {});
      })();
      whileLeaving(
        stopping.then(() =>
          Promise.all([
            wasOnStage ? endCohost(liveId).catch(() => {}) : null,
            joined.current ? leaveLive(liveId).catch(() => {}) : null,
          ]),
        ),
      );
      // A plain viewer never had the camera: nothing to wait for.
      if (!wasOnStage && !heldCamera) {
        if (liveNowRole() === role) setLiveNow(null);
        return;
      }
      Promise.race([stopping, new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS))]).finally(() => {
        releaseCameraFromLive(hold);
        if (liveNowRole() === role) setLiveNow(null);
      });
    };
  }, [liveId]);

  // ---------------------------------------------------------------------------
  // Hearts: drawn at once, sent to the host only, at most one message every 400 ms.
  // ---------------------------------------------------------------------------
  const tapHeart = useCallback(() => {
    if (!HEARTS_ENABLED || !IN_ROOM.includes(machine.current.phase)) return;
    sender.current.tap();
    drawHearts(1);
    if (flushTimer.current) return;
    // Sends what's waiting, then again after the 400 ms gap while more taps keep coming.
    const flush = () => {
      flushTimer.current = null;
      const host = hostId.current;
      const count = sender.current.take(Date.now());
      if (count > 0 && host) stage.current?.sendHearts(count, host).catch(() => {});
      const wait = sender.current.waitMs(Date.now());
      if (wait !== null) flushTimer.current = setTimeout(flush, wait);
    };
    flushTimer.current = setTimeout(flush, sender.current.waitMs(Date.now()) ?? 0);
  }, [drawHearts]);
  // Double-tap the live for a heart.
  function tapVideo() {
    const now = Date.now();
    if (now - lastTap.current < 300) {
      lastTap.current = 0;
      tapHeart();
    } else lastTap.current = now;
  }

  // ---------------------------------------------------------------------------
  // Coming on stage
  // ---------------------------------------------------------------------------
  const answerInvite = useCallback(async () => {
    const invite = machine.current.invite;
    if (!invite) return;
    setInviteBusy(true);
    try {
      // The camera and microphone first. Not allowed: we say "not now" for you.
      const allowed = await ensureLivePermissions();
      if (allowed !== 'ok') {
        answerCohostInvite(invite.id, false).catch(() => {});
        send({ type: 'decline' });
        Alert.alert(
          LIVE_MACHINE_WORDS.stage_permission,
          undefined,
          allowed === 'settings'
            ? [{ text: 'Not now', style: 'cancel' }, { text: 'Open Settings', onPress: openPhoneSettings }]
            : [{ text: 'OK' }],
        );
        return;
      }
      let role: 'cohost' | 'viewer';
      try {
        ({ role } = await answerCohostInvite(invite.id, true));
      } catch (error) {
        const hint = liveHint(error);
        if (hint === 'live_rules') {
          // The Live rules first (the ask stays open meanwhile); then we answer again.
          setRulesOpen(true);
          return;
        }
        send({ type: 'invite_gone' });
        showToast(hint === 'live_invite_gone' ? 'That ask ran out' : friendlyError(error));
        return;
      }
      if (role !== 'cohost') {
        send({ type: 'invite_gone' });
        return;
      }
      // Off the viewer connection, then on with your camera.
      await stage.current?.disconnect({ keepAudio: true }).catch(() => {});
      setLiveNow('cohost');
      cameraHold.current = holdCameraForLive();
      send({ type: 'accept', now: Date.now() });
      // Who is on stage now (for the names at the top) – not only at the next ping.
      liveStatus(liveId)
        .then((status) => {
          if (!alive.current) return;
          remember(status);
          send({ type: 'status', info: status as StatusInfo });
        })
        .catch(() => {});
    } finally {
      if (alive.current) setInviteBusy(false);
    }
  }, [send, showToast, liveId, remember]);

  const declineInvite = useCallback(() => {
    setRulesOpen(false);
    const invite = machine.current.invite;
    if (invite) answerCohostInvite(invite.id, false).catch(() => {});
    send({ type: 'decline' });
  }, [send]);

  const inviteExpired = useCallback(() => send({ type: 'invite_gone' }), [send]);

  function leaveStage() {
    leftMyself.current = true;
    send({ type: 'leave_stage' });
  }

  async function flip() {
    setFacing((now) => (now === 'front' ? 'back' : 'front'));
    try {
      await stage.current?.flip();
    } catch (error) {
      console.warn('Could not flip the live camera', error);
    }
  }

  async function toggleMute() {
    const muted = !m.userMuted;
    send({ type: 'mute', muted });
    try {
      await stage.current?.setMic(!muted);
    } catch (error) {
      console.warn('Could not change the microphone', error);
    }
  }

  // ---------------------------------------------------------------------------
  // Comments, reports and blocks
  // ---------------------------------------------------------------------------
  async function sendComment(text: string): Promise<boolean> {
    const problem = checkLiveComment(text);
    if (problem) {
      Alert.alert('Not sent', problem);
      return false;
    }
    try {
      const comment = await sendLiveComment(liveId, text);
      setComments((now) => (now.some((c) => c.id === comment.id) ? now : [comment, ...now].slice(0, 50)));
      return true;
    } catch (error) {
      Alert.alert('Not sent', friendlyError(error));
      return false;
    }
  }

  function commentMenu(comment: LiveComment) {
    const person = { id: comment.user_id, username: comment.name.replace(/^@/, '') };
    const drop = () => setComments((now) => now.filter((c) => c.id !== comment.id));
    const options: SheetOption[] = [];
    if (comment.user_id === userId) {
      options.push({
        label: 'Delete comment',
        destructive: true,
        onPress: () => {
          deleteLiveComment(comment.id)
            .then(drop)
            .catch((error) => Alert.alert('Could not delete', friendlyError(error)));
        },
      });
    } else {
      options.push(
        { label: 'Report comment', onPress: () => report({ user: person, contentType: 'live_comment', contentId: comment.id, onBlocked: drop }) },
        // The live stays open: only their comments go.
        { label: `Block ${comment.name}`, destructive: true, onPress: () => confirmBlock(person, () => setComments((now) => now.filter((c) => c.user_id !== person.id))) },
      );
    }
    showOptions({ title: comment.name, options });
  }

  const host = info?.host ?? null;
  const cohost = info?.cohost ?? null;

  const reportLive = (person: LivePerson) => report({ user: { id: person.id, username: person.username }, contentType: 'live', contentId: liveId, onBlocked: () => {} });
  // Blocking the host: you can't watch any more, so you leave. Blocking the co-host keeps you here (you'll wait
  // until they leave the stage – friends of both only).
  const blockHost = (person: LivePerson) => confirmBlock({ id: person.id, username: person.username }, leaveScreen);
  const blockCohost = (person: LivePerson) => confirmBlock({ id: person.id, username: person.username }, () => send({ type: 'open' }));

  function openMenu() {
    const options: SheetOption[] = [];
    if (host) options.push({ label: `Report @${host.username}`, onPress: () => reportLive(host) });
    if (cohost && cohost.id !== userId) options.push({ label: `Report @${cohost.username}`, onPress: () => reportLive(cohost) });
    if (host) options.push({ label: `Block @${host.username}`, destructive: true, onPress: () => blockHost(host) });
    if (cohost && cohost.id !== userId) options.push({ label: `Block @${cohost.username}`, destructive: true, onPress: () => blockCohost(cohost) });
    options.push({ label: 'Leave', onPress: leaveScreen });
    showOptions({ options });
  }

  // Report and Block on the end, removed and waiting cards (reports are taken for 24 hours after a live).
  function safetyButtons() {
    const people = [host, lastCohost].filter((p, i, all): p is LivePerson => !!p && p.id !== userId && all.findIndex((q) => q?.id === p.id) === i);
    return people.flatMap((person) => [
      <Button key={`report-${person.id}`} title={`Report @${person.username}`} icon="flag" variant="secondary" onPress={() => reportLive(person)} />,
      <Button
        key={`block-${person.id}`}
        title={`Block @${person.username}`}
        icon="hand-left"
        variant="secondary"
        onPress={() => (person.id === host?.id ? blockHost(person) : blockCohost(person))}
      />,
    ]);
  }

  // ---------------------------------------------------------------------------
  // What's on screen
  // ---------------------------------------------------------------------------
  if (broken) {
    return (
      <View style={styles.center}>
        <EmptyState emoji="🔴" title={LIVE_UNAVAILABLE_WORDS.broken}>
          <Button title="Back" icon="arrow-back" onPress={leaveScreen} />
        </EmptyState>
      </View>
    );
  }

  const StageView = stageParts?.module.StageView;
  const handle = stageParts?.handle ?? null;
  const hostName = personName(host);
  const live = IN_ROOM.includes(m.phase) || m.phase === 'going_on' || m.phase === 'leaving_stage';
  const starting = !connectedOnce && (m.phase === 'checking' || m.phase === 'joining');
  let banner: string | null = null;
  if (m.phase === 'reconnecting' || m.phase === 'rejoining') banner = LIVE_MACHINE_WORDS.reconnecting;
  else if (m.phase === 'going_on') banner = m.message ?? LIVE_MACHINE_WORDS.stage_wait;
  else if (hostAway && watchingNow) banner = `⏸ ${hostName} ${LIVE_MACHINE_WORDS.host_away}`;

  let card = null;
  if (m.phase === 'blocked' && m.why === 'ended') {
    card = (
      <LiveCard emoji="👋" title={`${hostName}'s live has ended`}>
        {/* The chat takes this screen's place: the live is over, so nothing should still count as "live now". */}
        {host ? <Button title="Say something nice 💬" onPress={() => router.replace(`/chat/${host.id}`)} /> : null}
        {safetyButtons()}
        <Button title="Done" variant="plain" onPress={leaveScreen} />
      </LiveCard>
    );
  } else if (m.phase === 'blocked' && m.why === 'removed') {
    card = (
      <LiveCard emoji="🚪" title={LIVE_TOKEN_WORDS.removed}>
        {safetyButtons()}
        <Button title="Done" variant="plain" onPress={leaveScreen} />
      </LiveCard>
    );
  } else if (m.phase === 'blocked') {
    card = (
      <LiveCard emoji="🔒" title={viewerCardWords(m.why, m.message)}>
        <Button title="Done" variant="plain" onPress={leaveScreen} />
      </LiveCard>
    );
  } else if (m.phase === 'waiting') {
    card = (
      <LiveCard emoji="⏳" title="Hang on a moment" message={LIVE_TOKEN_WORDS.paused}>
        {safetyButtons()}
        <Button title="Leave" variant="plain" onPress={leaveScreen} />
      </LiveCard>
    );
  } else if (m.phase === 'full' || m.phase === 'unavailable' || m.phase === 'lost') {
    const title = m.phase === 'full' ? LIVE_MACHINE_WORDS.full : m.phase === 'lost' ? LIVE_MACHINE_WORDS.lost : viewerCardWords(m.why, m.message);
    card = (
      <LiveCard emoji={m.phase === 'full' ? '🙈' : '📡'} title={title}>
        <Button title="Try again" icon="refresh" onPress={() => send({ type: 'open' })} />
        <Button title="Leave" variant="plain" onPress={leaveScreen} />
      </LiveCard>
    );
  }

  return (
    <View style={styles.fill}>
      <Pressable style={StyleSheet.absoluteFill} onPress={tapVideo} accessible={false}>
        {StageView && handle && host ? (
          <StageView stage={handle} hostId={host.id} cohostId={cohost?.id ?? null} style={StyleSheet.absoluteFill} />
        ) : null}
      </Pressable>

      {starting ? (
        <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
          <Avatar path={host?.avatar_path} name={hostName} size={96} />
          <Text style={styles.starting}>Starting…</Text>
        </View>
      ) : null}

      <LiveTopBar
        host={host}
        cohost={cohost}
        onAirAt={info?.on_air_at ?? null}
        onAir={live}
        viewers={live ? (info?.viewers ?? null) : null}
        onMenu={live || m.phase === 'waiting' ? openMenu : undefined}
        onClose={leaveScreen}
      />

      {banner ? (
        <View style={styles.banner} pointerEvents="none">
          <Text style={styles.bannerText}>{banner}</Text>
        </View>
      ) : null}

      {HEARTS_ENABLED ? <LiveHearts hearts={hearts} onDone={heartDone} /> : null}

      {live ? (
        <KeyboardSafeView style={styles.bottomArea} pointerEvents="box-none">
          <SafeEdge edge="bottom" style={styles.bottom} pointerEvents="box-none">
            <LiveCommentList comments={comments} onLongPress={commentMenu} />
            {m.phase === 'on_stage' ? (
              <View style={styles.stageControls}>
                <Button title="Leave stage" icon="exit-outline" variant="secondary" small onPress={leaveStage} />
                <IconButton icon="camera-reverse" label="Flip camera" size={40} onPress={flip} />
                <IconButton
                  icon={m.userMuted ? 'mic-off' : 'mic'}
                  label={m.userMuted ? 'Turn the microphone on' : 'Mute the microphone'}
                  size={40}
                  color={m.userMuted ? colors.red : colors.white}
                  onPress={toggleMute}
                />
              </View>
            ) : null}
            <LiveComposer
              commentsOn={info?.comments_on !== false}
              onSend={sendComment}
              extra={
                HEARTS_ENABLED ? (
                  <Pressable onPress={tapHeart} style={styles.heart} accessibilityRole="button" accessibilityLabel="Send a heart">
                    <Text style={styles.heartText}>❤️</Text>
                  </Pressable>
                ) : null
              }
            />
          </SafeEdge>
        </KeyboardSafeView>
      ) : null}

      {card}

      <InviteSheet
        visible={m.phase === 'invited' || rulesOpen}
        hostName={hostName}
        expiresAt={m.invite?.expires_at ?? null}
        busy={inviteBusy}
        onJoin={answerInvite}
        onNotNow={declineInvite}
        onExpired={inviteExpired}
        // The Live rules, in the same sheet (the ask stays open meanwhile), then the answer is sent again.
        rules={
          rulesOpen ? (
            <LiveRulesCard
              onAccepted={() => {
                setRulesOpen(false);
                answerInvite();
              }}
              onClose={() => {
                setRulesOpen(false);
                declineInvite();
              }}
              // Reading the Privacy Policy or the Guidelines isn't a "no": the ask stays open meanwhile.
              onOpenPage={() => setRulesOpen(false)}
            />
          ) : null
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.black,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    backgroundColor: colors.black,
  },
  starting: {
    color: colors.white,
    fontSize: 16,
    fontWeight: '800',
  },
  banner: {
    position: 'absolute',
    top: 110,
    alignSelf: 'center',
    maxWidth: '88%',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  bannerText: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '800',
    textAlign: 'center',
  },
  bottomArea: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
  bottom: {
    paddingHorizontal: space.md,
    paddingBottom: space.sm,
    gap: space.sm,
  },
  stageControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  heart: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  heartText: {
    fontSize: 22,
  },
});
