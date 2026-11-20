const { React, loadPure, host, liveAccessMock, livesMock } = require('./harness.cjs');

// Helpers for the lives 🔴 screen tests (go-live.tsx and live/[id].tsx). The live machine and the heart rules
// are the real files (they're pure); LiveKit is a pretend "stage" that writes down what it was asked to do, in
// one shared `log` (so a test can check the ORDER: e.g. the camera stops before the server is told).

const LIVE = '11111111-2222-4333-8444-555555555555';
const HOST = '99999999-8888-4777-8666-555555555555';
const GUEST = '77777777-6666-4555-8444-333333333333';

function fakeStage(log, { connect, publish } = {}) {
  const handles = [];
  const module = {
    StageView: host('StageView'),
    resumeLiveAudio: async () => { log.push('resumeLiveAudio'); },
    createStage(events) {
      let connected = false;
      const handle = {
        events,
        async connect(url, token) {
          log.push(`connect:${token}`);
          if (connect) await connect(url, token);
          connected = true;
        },
        async publish(facing) {
          log.push(`publish:${facing}`);
          if (publish) await publish(facing);
        },
        async unpublish() { log.push('unpublish'); },
        async disconnect(options) { log.push(options?.keepAudio ? 'disconnect:keepAudio' : 'disconnect'); connected = false; },
        async flip() { log.push('flip'); },
        async setMic(on) { log.push(`mic:${on}`); },
        async setCamera(on) { log.push(`camera:${on}`); },
        async sendHearts(n, to) { log.push(`hearts:${n}:${to}`); },
        async broadcastHearts(n) { log.push(`broadcast:${n}`); },
        subscribe: () => () => {},
        room: () => (connected ? {} : null),
        facing: () => 'front',
        identity: () => null,
      };
      handles.push(handle);
      return handle;
    },
  };
  return { module, handles };
}

function person(id, username, name) {
  return { id, username, display_name: name, avatar_path: null };
}

function status(overrides = {}) {
  return {
    status: 'live', role: 'viewer', live_id: LIVE,
    host: person(HOST, 'sam', 'Sam'), cohost: null,
    started_at: '2026-11-20T10:00:00.000Z', on_air_at: '2026-11-20T10:00:05.000Z', ends_at: '2026-11-20T11:00:00.000Z',
    comments_on: true, viewers: 2, invite: null, ended_reason: null, empty_ends_at: null,
    ...overrides,
  };
}

// What a screen did: pop-ups, toasts, menus, navigation, reports and blocks.
function newCalls() {
  return { alerts: [], toasts: [], options: [], routes: [], reports: [], blocks: [] };
}

// Presses the button called `text` in the newest pop-up (Alert.alert) that has one.
function pressAlert(calls, text) {
  for (let i = calls.alerts.length - 1; i >= 0; i--) {
    const button = (calls.alerts[i][2] ?? []).find((b) => b.text === text);
    if (button) return button.onPress?.();
  }
  throw new Error(`No pop-up button "${text}" in ${JSON.stringify(calls.alerts.map((a) => a[0]))}`);
}

// The mocks every live screen needs. `lives` / `access` / extra override the defaults.
function liveScreenMocks({ log, stage, access, lives = {}, calls, params = {} }) {
  const overlays = {
    showToast: (message) => calls.toasts.push(message),
    showOptions: (request) => calls.options.push(request),
  };
  const appState = { listener: null };
  const exits = [];
  const focus = { effect: null, cleanup: null };
  const mocks = {
    'expo-router': {
      router: {
        back: () => calls.routes.push(['back']),
        push: (to) => calls.routes.push(['push', to]),
        replace: (to) => calls.routes.push(['replace', to]),
        dismissTo: (to) => calls.routes.push(['dismissTo', to]),
        canGoBack: () => true,
      },
      useLocalSearchParams: () => params,
      useFocusEffect: (effect) => { focus.effect = effect; React.useEffect(() => { focus.cleanup = effect(); return () => focus.cleanup?.(); }, [effect]); },
    },
    'react-native': {
      ...Object.fromEntries(['View', 'Text', 'Pressable', 'Switch', 'ScrollView', 'RefreshControl', 'KeyboardAvoidingView', 'Modal', 'Image', 'ActivityIndicator', 'TextInput'].map((name) => [name, host(name)])),
      FlatList: (props) => React.createElement('FlatList', props, props.data?.map((item, index) => React.createElement(React.Fragment, { key: index }, props.renderItem({ item, index })))),
      StyleSheet: { create: (value) => value, absoluteFill: {} },
      Platform: { OS: 'ios' },
      Alert: { alert: (...args) => calls.alerts.push(args) },
      AppState: {
        currentState: 'active',
        addEventListener: (_type, listener) => { appState.listener = listener; return { remove() { if (appState.listener === listener) appState.listener = null; } }; },
      },
      Linking: { openSettings: async () => {}, openURL: async () => {} },
    },
    '@/components/IconButton': { IconButton: host('IconButton') },
    '@/components/SafeEdge': { SafeEdge: host('SafeEdge') },
    '@/components/Overlays': { useOverlays: () => overlays },
    '@/components/live/LiveComments': { LiveCommentList: host('LiveCommentList'), LiveComposer: host('LiveComposer') },
    '@/components/live/LiveEndedCard': { LiveCard: host('LiveCard'), HostSummaryCard: host('HostSummaryCard') },
    '@/components/live/LiveHearts': { LiveHearts: host('LiveHearts'), useFloatingHearts: () => ({ hearts: [], add: (n) => log.push(`draw:${n}`), done() {} }) },
    '@/components/live/LiveTopBar': { LiveTopBar: host('LiveTopBar'), personName: (p) => p?.display_name || p?.username || 'Your friend' },
    '@/components/live/ViewersSheet': { ViewersSheet: host('ViewersSheet'), viewerName: (v) => v.display_name || v.username },
    '@/components/live/InviteSheet': { InviteSheet: host('InviteSheet') },
    '@/components/live/LiveRulesSheet': { LiveRulesSheet: host('LiveRulesSheet') },
    '@/lib/liveAccess': access ?? liveAccessMock(true, { stage }),
    '@/lib/liveExit': { setLiveExit: (fn) => { exits.push(fn); return () => {}; }, leaveLiveNow: async () => {}, openUnlessLive: (open) => open() },
    '@/lib/liveHearts': loadPure('src/lib/liveHearts.ts'),
    '@/lib/liveMachine': loadPure('src/lib/liveMachine.ts'),
    '@/lib/lives': livesMock(lives),
    '@/lib/useSafetyActions': {
      useSafetyActions: () => ({
        report: (args) => calls.reports.push(args),
        confirmBlock: (user, onBlocked) => calls.blocks.push({ user, onBlocked }),
      }),
    },
  };
  return { mocks, appState, exits, focus };
}

// Lets every waiting promise (and the screen's reaction to it) finish.
async function settle(act, rounds = 8) {
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((resolve) => setImmediate(resolve)); });
}

module.exports = { LIVE, HOST, GUEST, fakeStage, person, status, newCalls, pressAlert, liveScreenMocks, settle, liveAccessMock, livesMock };
