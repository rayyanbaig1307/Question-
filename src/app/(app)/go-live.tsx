import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Alert, AppState, BackHandler, Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { IconButton } from '@/components/IconButton';
import { KeyboardSafeView } from '@/components/KeyboardSafeView';
import { useOverlays, type SheetOption } from '@/components/Overlays';
import { SafeEdge } from '@/components/SafeEdge';
import { LiveCommentList, LiveComposer } from '@/components/live/LiveComments';
import { HostSummaryCard, LiveCard, type LiveNumbers } from '@/components/live/LiveEndedCard';
import { LiveHearts, useFloatingHearts } from '@/components/live/LiveHearts';
import { LiveTopBar } from '@/components/live/LiveTopBar';
import { ViewersSheet, viewerName } from '@/components/live/ViewersSheet';
import { useMe } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import {
  HEARTS_ENABLED,
  holdCameraForLive,
  isLiveAvailable,
  LIVE_UNAVAILABLE_WORDS,
  liveNowRole,
  liveUnavailableReason,
  loadLiveStage,
  releaseCameraFromLive,
  setLiveNow,
  waitForCameraRelease,
  type LiveStageModule,
} from '@/lib/liveAccess';
import { setLiveExit } from '@/lib/liveExit';
import { encodeHearts, HEART_TOPIC, HeartCollector, HOST_SEND_EVERY_MS } from '@/lib/liveHearts';
import {
  HOST_PING_MS,
  isPermissionError,
  LIVE_MACHINE_WORDS,
  liveReducer,
  liveTodo,
  newLiveMachine,
  shouldDisconnect,
  type HostFailure,
  type LiveEvent,
  type StatusInfo,
} from '@/lib/liveMachine';
import { LIVE_PERMISSION_WORDS, openPhoneSettings } from '@/lib/livePermissions';
import {
  cancelCohostInvite,
  checkLiveComment,
  deleteLiveComment,
  endCohost,
  endLiveInBackground,
  fetchLiveComments,
  getLiveToken,
  inviteCohost,
  listenToLive,
  liveHint,
  liveOnAir,
  livePing,
  liveStatus,
  removeLiveViewer,
  sendLiveComment,
  setLiveComments,
  startLive,
  type LiveComment,
  type LiveStatus,
  type LiveSummary,
  type LiveViewer,
} from '@/lib/lives';
import { useSafetyActions } from '@/lib/useSafetyActions';
import { colors, radius, space } from '@/theme';

type StageHandle = ReturnType<LiveStageModule['createStage']>;
type Facing = 'front' | 'back';

const COUNTDOWN_FROM = 3;
const FIVE_MINUTES = 5 * 60_000;
// A friend has 60 seconds to answer "come on"; a few seconds more for the answer to arrive.
const INVITE_WAIT_MS = 63_000;

// What a server "no" from start_live means for the host screen (the server's own words are shown with it).
export function hostFailureForHint(hint: string | null): HostFailure {
  if (!hint) return 'network';
  if (hint === 'live_busy') return 'busy';
  if (hint === 'live_login') return 'login';
  return 'limit';
}

// The words for a failed start, by reason (never a blanket "check your internet").
export function hostFailureWords(why: string | null, message: string | null): string {
  switch (why) {
    case 'permission':
      return LIVE_PERMISSION_WORDS;
    case 'not_set_up':
    case 'unavailable':
      return LIVE_MACHINE_WORDS.host_unavailable;
    case 'network':
      return LIVE_MACHINE_WORDS.host_network;
    case 'login':
      return message ?? LIVE_MACHINE_WORDS.login;
    case 'other_device':
      return LIVE_MACHINE_WORDS.other_device;
    default:
      return message ?? LIVE_MACHINE_WORDS.host_unavailable;
  }
}

function leaveScreen() {
  if (router.canGoBack?.()) router.back();
  else router.replace('/');
}

// Going live 🔴 (the host). Opened by the Go live button on the camera (GoLiveSheet), which already checked
// the camera, the microphone and this phone, and set "live now". A 3·2·1 countdown hides the setup:
// make the live → ticket → LiveKit → camera → on air (friends see it and get the notification only then).
// Ending: the phone stops sending first, then tells the server (in the background); the summary shows at once.
export default function GoLive() {
  const { userId, profile } = useMe();
  const params = useLocalSearchParams<{ facing?: string }>();
  // Only when opened from the Go live button (it shows what going live means first) and lives work here.
  const [ready] = useState(() => liveNowRole() === 'host' && isLiveAvailable());
  if (!ready) return <CantGoLive />;
  return <HostLive userId={userId} me={profile} startFacing={params.facing === 'back' ? 'back' : 'front'} />;
}

function CantGoLive() {
  const reason = liveUnavailableReason();
  useEffect(() => {
    // Nothing started: give the camera back, and nothing is live.
    releaseCameraFromLive();
    if (liveNowRole() === 'host') setLiveNow(null);
  }, []);
  return (
    <View style={styles.center}>
      <EmptyState
        emoji="🔴"
        title={reason ? LIVE_UNAVAILABLE_WORDS[reason] : 'Go live from the camera'}
        message={reason ? undefined : 'Swipe the bubbles to 🔴 and tap the button.'}>
        <Button title="Back" icon="arrow-back" onPress={leaveScreen} />
      </EmptyState>
    </View>
  );
}

function HostLive({ userId, me, startFacing }: {
  userId: string;
  me: { username?: string | null; display_name?: string | null; avatar_path?: string | null } | null;
  startFacing: Facing;
}) {
  const { showOptions, showToast } = useOverlays();
  const { report, confirmBlock } = useSafetyActions();
  const [first] = useState(() => newLiveMachine('host'));
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

  // LiveKit (loaded only once the live starts) and this screen's connection to it.
  const [stageParts, setStageParts] = useState<{ module: LiveStageModule; handle: StageHandle } | null>(null);
  const stage = useRef<StageHandle | null>(null);
  const stageModuleRef = useRef<LiveStageModule | null>(null);
  const liveId = useRef<string | null>(null);
  const [id, setId] = useState<string | null>(null);
  const [facing, setFacing] = useState<Facing>(startFacing);
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [onAirAt, setOnAirAt] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(COUNTDOWN_FROM);
  const [comments, setComments] = useState<LiveComment[]>([]);
  const [viewersOpen, setViewersOpen] = useState(false);
  // The friend you asked on (waiting for their answer). The ref is the same, for the live updates.
  const [invite, setInvite] = useState<{ id: string; guest: LiveViewer } | null>(null);
  const openInvite = useRef<{ id: string; guest: LiveViewer } | null>(null);
  const [mostViewers, setMostViewers] = useState(0);
  const [heartTotal, setHeartTotal] = useState(0);
  // The summary's numbers from the server (until it answers, the phone's own numbers show).
  const [serverNumbers, setServerNumbers] = useState<LiveNumbers | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const collector = useRef(new HeartCollector(userId));
  const { hearts, add: drawHearts, done: heartDone } = useFloatingHearts();
  const stopped = useRef(false);
  const ended = useRef(false);
  const myName = me?.display_name || me?.username || 'You';

  const showInvite = useCallback((next: { id: string; guest: LiveViewer } | null) => {
    openInvite.current = next;
    setInvite(next);
  }, []);

  // ---------------------------------------------------------------------------
  // Stopping: the phone stops sending first (camera off, disconnect, camera given back), only then the server.
  // ---------------------------------------------------------------------------
  const stopSending = useCallback(async () => {
    if (stopped.current) return;
    stopped.current = true;
    const handle = stage.current;
    try {
      await handle?.unpublish();
    } catch {
      // Already stopped.
    }
    try {
      await handle?.disconnect();
    } catch {
      // Already gone.
    }
    releaseCameraFromLive();
  }, []);

  // Tells the server the live is over (in the background, with retries). Its numbers replace the phone's.
  const tellServerEnded = useCallback(() => {
    const live = liveId.current;
    if (!live || ended.current) return;
    ended.current = true;
    endLiveInBackground(live, collector.current.total).then((summary: LiveSummary | null) => {
      if (!summary || !alive.current) return;
      setServerNumbers({ minutes: summary.seconds / 60, viewers: summary.viewers, hearts: summary.hearts, comments: summary.comments });
      if (summary.ended_reason && summary.ended_reason !== 'host') send({ type: 'status', info: { status: 'ended', ended_reason: summary.ended_reason } });
    });
  }, [send]);

  // Back from the background or a phone call: sound, then the mic as YOU left it, then the camera.
  const resumeSending = useCallback(async () => {
    const handle = stage.current;
    const phase = machine.current.phase;
    if (!handle || stopped.current || (phase !== 'live' && phase !== 'reconnecting')) return;
    try {
      await stageModuleRef.current?.resumeLiveAudio();
      await handle.setMic(!machine.current.userMuted);
      await handle.setCamera(true);
    } catch (error) {
      console.warn('Could not turn the live camera back on', error);
    }
  }, []);


  // ---------------------------------------------------------------------------
  // The stage (LiveKit), made once.
  // ---------------------------------------------------------------------------
  const ensureStage = useCallback((module: LiveStageModule): StageHandle => {
    if (stage.current) return stage.current;
    const made = module.createStage({
      hostId: userId,
      onReconnecting: () => send({ type: 'reconnecting' }),
      onReconnected: () => send({ type: 'reconnected' }),
      onDisconnected: (reason) => send({ type: 'disconnected', reason }),
      onHeartFromViewer: (sender, count) => {
        if (!HEARTS_ENABLED) return;
        const counted = collector.current.receive(HEART_TOPIC, sender, encodeHearts(count), Date.now());
        if (counted <= 0) return;
        drawHearts(counted);
        setHeartTotal(collector.current.total);
      },
      onMediaError: () => resumeSending(),
    });
    stage.current = made;
    stageModuleRef.current = module;
    setStageParts({ module, handle: made });
    return made;
  }, [userId, send, drawHearts, resumeSending]);

  // ---------------------------------------------------------------------------
  // Going live: make the live → ticket → LiveKit → camera → on air.
  // ---------------------------------------------------------------------------
  const runStart = useCallback(async () => {
    stopped.current = false;
    ended.current = false;
    holdCameraForLive();
    let live: string;
    try {
      live = await startLive(userId);
    } catch (error) {
      const hint = liveHint(error);
      send({ type: 'failed', why: hostFailureForHint(hint), message: hint ? (error as Error).message : null });
      return;
    }
    liveId.current = live;
    // The screen closed meanwhile (its clean-up already ran): end the new live straight away.
    const closed = () => !alive.current || stopped.current;
    if (closed()) {
      tellServerEnded();
      return;
    }
    setId(live);
    // Every failure from here on also ends the live on the server (best effort).
    const giveUp = (event: LiveEvent) => {
      send(event);
      tellServerEnded();
    };
    const ticket = await getLiveToken(live, userId);
    if (!ticket.ok) {
      giveUp({ type: 'token_failed', reason: ticket.reason, message: ticket.message, now: Date.now() });
      return;
    }
    send({ type: 'token_ok', role: ticket.role });
    const module = loadLiveStage();
    if (!module) {
      giveUp({ type: 'failed', why: 'unavailable', message: LIVE_UNAVAILABLE_WORDS.broken });
      return;
    }
    const handle = ensureStage(module);
    await waitForCameraRelease();
    if (closed()) return;
    try {
      await handle.connect(ticket.url, ticket.token);
      await handle.publish(facing);
    } catch (error) {
      giveUp({ type: 'connect_failed', permission: isPermissionError(error), now: Date.now() });
      return;
    }
    if (closed()) {
      // Closed while connecting: stop sending at once.
      await handle.unpublish().catch(() => {});
      await handle.disconnect().catch(() => {});
      releaseCameraFromLive();
      return;
    }
    try {
      await liveOnAir(live);
    } catch (error) {
      const hint = liveHint(error);
      giveUp({ type: 'failed', why: hint ? 'unavailable' : 'network', message: hint ? (error as Error).message : null });
      return;
    }
    if (!alive.current) return;
    setOnAirAt(new Date().toISOString());
    send({ type: 'on_air' });
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [userId, send, tellServerEnded, ensureStage, facing]);

  // A dropped connection that LiveKit couldn't resume: a fresh ticket, connect, send the camera again.
  const runRejoin = useCallback(async () => {
    const live = liveId.current;
    const module = stageModuleRef.current ?? loadLiveStage();
    if (!live || !module) {
      send({ type: 'ended', reason: 'host_gone' });
      return;
    }
    const ticket = await getLiveToken(live, userId);
    if (!ticket.ok) {
      send({ type: 'token_failed', reason: ticket.reason, message: ticket.message, now: Date.now() });
      return;
    }
    send({ type: 'token_ok', role: ticket.role });
    const handle = ensureStage(module);
    try {
      await handle.connect(ticket.url, ticket.token);
      await handle.publish(facing);
      await handle.setMic(!machine.current.userMuted);
    } catch (error) {
      send({ type: 'connect_failed', permission: isPermissionError(error), now: Date.now() });
      return;
    }
    send({ type: 'connected' });
  }, [userId, send, ensureStage, facing]);

  // End: the phone stops sending first, then the server is told (in the background). The summary shows meanwhile.
  const runEnd = useCallback(async () => {
    await stopSending();
    tellServerEnded();
    send({ type: 'ended' });
  }, [stopSending, tellServerEnded, send]);

  // ---------------------------------------------------------------------------
  // Do what the machine asks for, once per change.
  // ---------------------------------------------------------------------------
  const doneStep = useRef(-1);
  useEffect(() => {
    if (doneStep.current === m.step) return;
    doneStep.current = m.step;
    const todo = liveTodo(m);
    if (todo === 'start') runStart();
    else if (todo === 'connect') runRejoin();
    else if (todo === 'end') runEnd();
    else if (todo === 'away') {
      // In the background: camera and microphone off (friends see you're away).
      stage.current?.setCamera(false).catch(() => {});
      stage.current?.setMic(false).catch(() => {});
    } else if (todo === 'resume') {
      resumeSending().finally(() => send({ type: 'resumed' }));
    } else if (todo === 'status') {
      const live = liveId.current;
      if (!live) send({ type: 'status_failed' });
      else
        liveStatus(live)
          .then((info) => {
            if (!alive.current) return;
            setStatus(info);
            send({ type: 'status', info: info as StatusInfo });
          })
          .catch(() => send({ type: 'status_failed' }));
    }
  }, [m, runStart, runRejoin, runEnd, resumeSending, send]);

  // The live is over (ended, failed, lost): stop sending and tell the server.
  const phase = m.phase;
  useEffect(() => {
    if (phase === 'lost') {
      send({ type: 'ended', reason: 'host_gone' });
      return;
    }
    if (phase === 'summary' || phase === 'failed') {
      stopSending().then(() => {
        if (machine.current.phase === 'summary') tellServerEnded();
      });
    } else if (phase === 'rejoining' && shouldDisconnect(machine.current)) {
      // Between tries: the camera stays held for the next one.
      stage.current?.disconnect({ keepAudio: true }).catch(() => {});
    }
  }, [phase, send, stopSending, tellServerEnded]);

  // Waits the machine asked for (retries).
  useEffect(() => {
    if (m.retryInMs === null) return;
    const timer = setTimeout(() => send({ type: 'retry' }), m.retryInMs);
    return () => clearTimeout(timer);
  }, [m.step, m.retryInMs, send]);

  // Start straight away, with the 3·2·1 countdown on top.
  useEffect(() => {
    send({ type: 'start' });
  }, [send]);
  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => setCountdown((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  // ---------------------------------------------------------------------------
  // While live: pings every 15 seconds, comments, hearts, invites, the app going to the background.
  // ---------------------------------------------------------------------------
  const onAir = m.phase === 'live' || m.phase === 'reconnecting' || m.phase === 'away';
  // No pings while the app is in the background: after about 90 seconds without one, the server ends the live.
  const pinging = m.phase === 'live' || m.phase === 'reconnecting';
  useEffect(() => {
    if (!pinging || !id) return;
    let stop = false;
    const ping = () =>
      livePing(id)
        .then((info) => {
          if (stop || !alive.current) return;
          setStatus(info);
          if (info.on_air_at) setOnAirAt(info.on_air_at);
          setMostViewers((most) => Math.max(most, info.viewers));
          send({ type: 'status', info: info as StatusInfo });
        })
        .catch(() => {}); // a failed ping is ignored (the next one tries again)
    ping();
    const timer = setInterval(ping, HOST_PING_MS);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [pinging, id, send]);

  // A clock for the banners (5 minutes left, nobody watching).
  useEffect(() => {
    if (!onAir) return;
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [onAir]);

  // Hearts: every half second, send the hearts that came in on to everyone.
  useEffect(() => {
    if (!onAir || !HEARTS_ENABLED) return;
    const timer = setInterval(() => {
      const count = collector.current.take();
      if (count > 0) stage.current?.broadcastHearts(count).catch(() => {});
    }, HOST_SEND_EVERY_MS);
    return () => clearInterval(timer);
  }, [onAir]);

  // Comments and co-host answers, live.
  useEffect(() => {
    if (!id) return;
    fetchLiveComments(id)
      .then((list) => alive.current && setComments(list))
      .catch(() => {});
    return listenToLive(id, userId, {
      onComment: (comment) => setComments((now) => (now.some((c) => c.id === comment.id) ? now : [comment, ...now].slice(0, 50))),
      onCommentGone: (commentId) => setComments((now) => now.filter((c) => c.id !== commentId)),
      onInviteChange: (changed) => {
        const open = openInvite.current;
        if (open && open.id === changed.id && changed.answer) {
          showInvite(null);
          const name = viewerName(open.guest);
          if (changed.answer === 'declined') showToast(`${name} said not now`);
          else if (changed.answer === 'expired') showToast(`${name} didn't answer`);
          else if (changed.answer === 'accepted') showToast(`${name} is on with you 🎉`);
        }
        if (changed.answer === 'accepted') liveStatus(id).then((info) => alive.current && setStatus(info)).catch(() => {});
      },
    });
  }, [id, userId, showToast, showInvite]);

  // An ask runs out after 60 seconds. The server marks it within a minute; the phone doesn't wait for that.
  useEffect(() => {
    if (!invite) return;
    const timer = setTimeout(() => {
      const open = openInvite.current;
      if (!open || open.id !== invite.id) return;
      showInvite(null);
      showToast(`${viewerName(open.guest)} didn't answer`);
    }, INVITE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [invite, showInvite, showToast]);

  // The app going to the background and coming back. (A phone call that doesn't leave the app: when it comes
  // back to the front, the sound, mic and camera are turned back on too.)
  useEffect(() => {
    let last = AppState.currentState;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background') send({ type: 'app_state', active: false });
      if (state === 'active') {
        if (last === 'background') send({ type: 'app_state', active: true });
        else if (machine.current.phase === 'live') resumeSending();
      }
      last = state;
    });
    return () => subscription.remove();
  }, [send, resumeSending]);

  // "End your live to open this?" (a notification tapped mid-live): end it properly, then leave.
  useEffect(
    () =>
      setLiveExit(async () => {
        await stopSending();
        tellServerEnded();
        setLiveNow(null);
        leaveScreen();
      }),
    [stopSending, tellServerEnded],
  );

  // Leaving the screen any other way: the same steps as End (the phone stops sending first, then the server is
  // told), then nothing is live any more. A stop that hangs is given up on after a few seconds.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      Promise.race([stopSending(), new Promise((resolve) => setTimeout(resolve, 3000))]).finally(() => {
        tellServerEnded();
        setLiveNow(null);
      });
    };
  }, [stopSending, tellServerEnded]);

  // ---------------------------------------------------------------------------
  // Buttons
  // ---------------------------------------------------------------------------
  const confirmEnd = useCallback(() => {
    Alert.alert('End your live?', 'Your friends will see that it has ended.', [
      { text: 'Keep going', style: 'cancel' },
      {
        text: 'End',
        style: 'destructive',
        onPress: () => {
          // The summary's minutes count up to now (the clock otherwise only ticks every few seconds).
          setNow(Date.now());
          send({ type: 'end' });
        },
      },
    ]);
  }, [send]);

  // Android's back button while you're live: the same as ✕ (it asks first, so a slip doesn't end the live).
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      const phase = machine.current.phase;
      if (phase !== 'live' && phase !== 'reconnecting' && phase !== 'away') return false;
      confirmEnd();
      return true;
    });
    return () => subscription.remove();
  }, [confirmEnd]);

  function done() {
    setLiveNow(null);
    leaveScreen();
  }

  function retry() {
    send({ type: 'start' });
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

  function openMenu() {
    const live = liveId.current;
    if (!live) return;
    const on = status?.comments_on !== false;
    showOptions({
      options: [
        {
          label: on ? 'Turn comments off' : 'Turn comments on',
          onPress: async () => {
            try {
              await setLiveComments(live, !on);
              setStatus((now) => (now ? { ...now, comments_on: !on } : now));
              showToast(on ? 'Comments are off' : 'Comments are on');
            } catch (error) {
              Alert.alert('Could not change comments', friendlyError(error));
            }
          },
        },
      ],
    });
  }

  function askBringOn(viewer: LiveViewer) {
    const live = liveId.current;
    if (!live) return;
    const name = viewerName(viewer);
    Alert.alert(`Bring ${name} on?`, `While ${name} is on, only friends of you both can watch.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Ask them',
        onPress: async () => {
          // The viewers sheet closes first: the answer shows as a message on the live, which the sheet would cover.
          setViewersOpen(false);
          try {
            const inviteId = await inviteCohost(live, viewer.user_id);
            showInvite({ id: inviteId, guest: viewer });
            showToast(`Asked ${name} 🎥`);
          } catch (error) {
            const hint = liveHint(error);
            if (hint === 'live_invite_wait') showToast(`You can't ask ${name} again this live`);
            else if (hint === 'live_guest_cant') showToast(`${name} can't come on right now`);
            else showToast(friendlyError(error));
          }
        },
      },
    ]);
  }

  function cancelAsk() {
    const live = liveId.current;
    if (!live) return;
    showInvite(null);
    cancelCohostInvite(live).catch(() => {});
  }

  // The ⋯ next to a friend in the viewers sheet. A system pop-up (it can show on top of the open sheet, which
  // the app's own menus can't).
  function removeMenu(viewer: LiveViewer) {
    const live = liveId.current;
    if (!live) return;
    const name = viewerName(viewer);
    const remove = async (alsoBlock: boolean) => {
      try {
        await removeLiveViewer(live, viewer.user_id, alsoBlock);
        setViewersOpen(false);
        showToast(alsoBlock ? `Removed and blocked ${name}` : `Removed ${name}`);
      } catch (error) {
        Alert.alert('Could not remove', friendlyError(error));
      }
    };
    Alert.alert(name, undefined, [
      { text: 'Remove from my live', style: 'destructive', onPress: () => remove(false) },
      { text: 'Remove and block', style: 'destructive', onPress: () => remove(true) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  async function backToWatching(viewer: LiveViewer) {
    const live = liveId.current;
    if (!live) return;
    try {
      await endCohost(live);
      setStatus((now) => (now ? { ...now, cohost: null } : now));
      setViewersOpen(false);
      showToast(`${viewerName(viewer)} is back to watching`);
    } catch (error) {
      Alert.alert('Could not change', friendlyError(error));
    }
  }

  async function sendComment(text: string): Promise<boolean> {
    const live = liveId.current;
    if (!live) return false;
    const problem = checkLiveComment(text);
    if (problem) {
      Alert.alert('Not sent', problem);
      return false;
    }
    try {
      const comment = await sendLiveComment(live, text);
      setComments((now) => (now.some((c) => c.id === comment.id) ? now : [comment, ...now].slice(0, 50)));
      return true;
    } catch (error) {
      Alert.alert('Not sent', friendlyError(error));
      return false;
    }
  }

  function commentMenu(comment: LiveComment) {
    const live = liveId.current;
    if (!live) return;
    const person = { id: comment.user_id, username: comment.name.replace(/^@/, '') };
    const drop = () => setComments((now) => now.filter((c) => c.id !== comment.id));
    const options: SheetOption[] = [
      {
        label: 'Delete comment',
        destructive: true,
        onPress: () => {
          deleteLiveComment(comment.id)
            .then(drop)
            .catch((error) => Alert.alert('Could not delete', friendlyError(error)));
        },
      },
    ];
    if (comment.user_id !== userId) {
      options.unshift({ label: 'Report comment', destructive: false, onPress: () => report({ user: person, contentType: 'live_comment', contentId: comment.id, onBlocked: drop }) });
      options.push(
        {
          label: 'Remove from my live',
          destructive: true,
          onPress: () => {
            removeLiveViewer(live, comment.user_id, false)
              .then(() => showToast(`Removed ${comment.name}`))
              .catch((error) => Alert.alert('Could not remove', friendlyError(error)));
          },
        },
        { label: `Block ${comment.name}`, destructive: true, onPress: () => confirmBlock(person, () => setComments((now) => now.filter((c) => c.user_id !== person.id))) },
      );
    }
    showOptions({ title: comment.name, options });
  }

  // ---------------------------------------------------------------------------
  // What's on screen
  // ---------------------------------------------------------------------------
  const StageView = stageParts?.module.StageView;
  const handle = stageParts?.handle ?? null;
  const viewers = status?.viewers ?? 0;
  // The summary: the server's numbers once it answers; until then the phone's own (no comment count).
  const started = onAirAt ? Date.parse(onAirAt) : NaN;
  const numbers: LiveNumbers = serverNumbers ?? {
    minutes: Number.isFinite(started) ? Math.max(0, now - started) / 60_000 : 0,
    viewers: mostViewers,
    hearts: heartTotal,
    comments: null,
  };
  const endsAt = status?.ends_at ? Date.parse(status.ends_at) : NaN;
  const emptyEndsAt = status?.empty_ends_at ? Date.parse(status.empty_ends_at) : NaN;
  const live = m.phase === 'live' || m.phase === 'reconnecting';
  const maxMinutes = status?.started_at && status.ends_at ? Math.round((Date.parse(status.ends_at) - Date.parse(status.started_at)) / 60_000) : 60;
  let banner: string | null = null;
  if (m.phase === 'reconnecting') banner = LIVE_MACHINE_WORDS.reconnecting;
  else if (live && viewers === 0 && Number.isFinite(emptyEndsAt) && emptyEndsAt - now <= 60_000) {
    banner = "Nobody's watching yet – your live ends in a minute if nobody joins.";
  } else if (live && Number.isFinite(endsAt) && endsAt - now <= FIVE_MINUTES && endsAt > now) {
    banner = `${Math.max(1, Math.ceil((endsAt - now) / 60_000))} min left`;
  }

  return (
    <View style={styles.fill}>
      {StageView && handle ? (
        <StageView stage={handle} hostId={userId} cohostId={status?.cohost?.id ?? null} style={StyleSheet.absoluteFill} />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.center]}>
          <Avatar path={me?.avatar_path} name={myName} size={96} />
        </View>
      )}

      <LiveTopBar
        host={{ id: userId, username: me?.username ?? '', display_name: me?.display_name ?? '', avatar_path: me?.avatar_path ?? null }}
        cohost={status?.cohost ?? null}
        onAirAt={onAirAt}
        onAir={live && countdown <= 0}
        viewers={live ? viewers : null}
        onViewers={() => setViewersOpen(true)}
        onMenu={live ? openMenu : undefined}
        onClose={live || m.phase === 'away' ? confirmEnd : done}
        closeLabel="End your live"
      />

      {banner ? (
        <View style={styles.banner} pointerEvents="none">
          <Text style={styles.bannerText}>{banner}</Text>
        </View>
      ) : null}

      {invite ? (
        <View style={styles.asking}>
          <Text style={styles.askingText} numberOfLines={1}>
            Waiting for {viewerName(invite.guest)}…
          </Text>
          <Pressable onPress={cancelAsk} accessibilityRole="button" accessibilityLabel="Cancel the ask">
            <Text style={styles.askingCancel}>Cancel</Text>
          </Pressable>
        </View>
      ) : null}

      {HEARTS_ENABLED ? <LiveHearts hearts={hearts} onDone={heartDone} /> : null}

      {live ? (
        <KeyboardSafeView style={styles.bottomArea} pointerEvents="box-none">
          <SafeEdge edge="bottom" style={styles.bottom} pointerEvents="box-none">
            <LiveCommentList comments={comments} onLongPress={commentMenu} />
            <View style={styles.controls}>
              <View style={styles.composer}>
                <LiveComposer commentsOn onSend={sendComment} note={false} />
              </View>
              <IconButton icon="camera-reverse" label="Flip camera" size={40} onPress={flip} />
              <IconButton
                icon={m.userMuted ? 'mic-off' : 'mic'}
                label={m.userMuted ? 'Turn the microphone on' : 'Mute the microphone'}
                size={40}
                color={m.userMuted ? colors.red : colors.white}
                onPress={toggleMute}
              />
            </View>
          </SafeEdge>
        </KeyboardSafeView>
      ) : null}

      {m.phase === 'away' ? <LiveCard emoji="⏸" title="Your live is paused" message="Come back within a minute or it ends." /> : null}

      {(m.phase === 'ready' || m.phase === 'starting' || (live && countdown > 0)) && countdown > 0 ? (
        <View style={[StyleSheet.absoluteFill, styles.countdown]} pointerEvents="none">
          <Text style={styles.countdownText} accessibilityLabel={`Going live in ${countdown}`}>
            {countdown}
          </Text>
        </View>
      ) : null}
      {m.phase === 'starting' && countdown <= 0 ? (
        <View style={styles.banner} pointerEvents="none">
          <Text style={styles.bannerText}>Starting…</Text>
        </View>
      ) : null}

      {m.phase === 'failed' ? (
        <LiveCard emoji={m.why === 'permission' ? '📷' : '😕'} title={hostFailureWords(m.why, m.message)}>
          {m.why === 'permission' ? <Button title="Open Settings" icon="settings-outline" onPress={openPhoneSettings} /> : null}
          {m.why === 'network' || m.why === 'unavailable' || m.why === 'not_set_up' || m.why === 'busy' || m.why === 'full' ? (
            <Button title="Try again" icon="refresh" onPress={retry} />
          ) : null}
          <Button title="Close" variant="secondary" onPress={done} />
        </LiveCard>
      ) : null}

      {m.phase === 'ending' || m.phase === 'summary' ? (
        <HostSummaryCard numbers={numbers} reason={m.phase === 'summary' ? m.why : null} maxMinutes={maxMinutes} onDone={done} />
      ) : null}

      {id ? (
        <ViewersSheet
          visible={viewersOpen && live}
          liveId={id}
          cohostId={status?.cohost?.id ?? null}
          inviteOpen={!!invite}
          onClose={() => setViewersOpen(false)}
          onBringOn={askBringOn}
          onCantBringOn={(viewer) => Alert.alert(`${viewerName(viewer)} can't come on right now`)}
          onRemove={removeMenu}
          onBackToWatching={backToWatching}
        />
      ) : null}
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
    backgroundColor: colors.black,
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
  asking: {
    position: 'absolute',
    top: 160,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  askingText: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '700',
    maxWidth: 200,
  },
  askingCancel: {
    color: colors.live,
    fontSize: 14,
    fontWeight: '900',
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
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  composer: {
    flex: 1,
  },
  countdown: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  countdownText: {
    color: colors.white,
    fontSize: 120,
    fontWeight: '900',
  },
});
