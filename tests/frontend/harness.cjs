const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const renderer = require('react-test-renderer');
const { execFileSync } = require('node:child_process');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const root = path.resolve(__dirname, '../..');
const originalRevision = 'a9e5ddf88e785bd8378b2b7d9dcd7e341df439b1';

function readSource(relative) {
  if (process.env.QA_ORIGINAL === '1') {
    return execFileSync('git', ['show', `${originalRevision}:${relative.replace(/\\/g, '/')}`], { cwd: root, encoding: 'utf8' });
  }
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

// A small app file with no imports of its own (e.g. src/lib/lensLooks.ts, the list of face filters), loaded for real
// so the screens use the same list as the app. Any import inside it fails on purpose: these files must stay free
// of Skia, the camera and the rest. A file that isn't there (QA_ORIGINAL=1 runs against an older commit) gives {}.
function loadPure(relative) {
  let source;
  try { source = readSource(relative); } catch { return {}; }
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  const context = vm.createContext({
    module, exports: module.exports,
    require: id => { throw new Error(`pure module must not import ${id}`); },
  });
  vm.runInContext(compiled, context, { filename: relative });
  return module.exports;
}

// A stand-in for src/lib/frameAccess.ts. `available`: this download has the 4 stretchy filters. `broken`: they
// already switched themselves off on this phone. `framesBroken()` and `markFramesBroken()` work like the real ones
// (the screens re-render when the filters switch themselves off).
function frameAccessMock(available, { broken = false } = {}) {
  let isBroken = broken;
  const listeners = new Set();
  const subscribeFramesBroken = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
  const framesBroken = () => isBroken;
  return {
    WARPS_ENABLED: true, WARPS_ON_ANDROID: false, FRAME_PATH: 'share', FRAME_DELAY: 1, STALE_MS: 1000,
    FRAME_PIXEL_FORMAT: 'yuv', FRAME_PLACEMENT: 'rule', FRAME_SETUP_MS: 4000,
    FRAME_ERROR_WINDOW_MS: 2000, FRAME_ERROR_MIN: 10, FRAME_ERROR_RATE: 0.5, LOOK_COOL_DOWN_MS: 1500, LOOK_MAX_FAILS: 5,
    FRAME_ACCESS_AVAILABLE: available,
    framesBroken,
    markFramesBroken() { if (isBroken) return; isBroken = true; listeners.forEach((listener) => listener()); },
    subscribeFramesBroken,
    useWarpLooksOn() {
      const nowBroken = React.useSyncExternalStore(subscribeFramesBroken, framesBroken, framesBroken);
      return available && !nowBroken;
    },
  };
}

// A stand-in for src/lib/liveAccess.ts (lives 🔴). `available`: this download can do lives (version 1.2.0 or
// newer with LiveKit inside). The default is false, like App Store 1.0/1.1, old TestFlight builds, old APKs and
// Expo Go, so every screen looks the way it does there. `isLiveAvailable` counts its calls (the camera and Home
// must never call it). The live-now flag and the camera hand-off work like the real ones.
function liveAccessMock(available = false, { stage = null } = {}) {
  let role = null;
  let held = false;
  let holdId = 0;
  const leaving = new Set();
  const roleListeners = new Set();
  const cameraListeners = new Set();
  const ended = new Set();
  const waiting = new Map();
  const calls = { isLiveAvailable: 0, holds: 0, releases: 0, released: 0, roles: [], loads: 0, afterLive: [] };
  const tell = (set) => [...set].forEach((listener) => listener());
  const mock = {
    LIVE_ENABLED: true, LIVE_FOR_EVERYONE: false, LIVE_ON_ANDROID: false, HEARTS_ENABLED: true, LIVE_MIN_APP_VERSION: '1.2.0',
    LIVE_NATIVE_MODULES: ['WebRTCModule', 'LivekitReactNativeModule'], CAMERA_RELEASE_MIN_MS: 500, CAMERA_RELEASE_MAX_MS: 1200, LEAVE_WAIT_MS: 8000,
    LIVE_UNAVAILABLE_WORDS: {
      update: 'Update Peekaboo to watch lives 🔴',
      android: "Lives aren't on Android yet – soon! 🔴",
      off: 'Lives are switched off for now.',
      broken: "Lives aren't working on this phone right now.",
    },
    calls,
    // Leaving work the screens registered (whileLeaving); `leaving` lets a test wait for it.
    leaving,
    whileLeaving(work) { const tracked = Promise.resolve(work).catch(() => {}).finally(() => leaving.delete(tracked)); leaving.add(tracked); },
    versionAtLeast: () => true,
    liveBroken: () => false, markLiveBroken() {}, subscribeLiveBroken: () => () => {},
    liveSwitchedOn: () => available,
    liveMaybeAvailable: () => available,
    isLiveAvailable: () => { calls.isLiveAvailable++; return available; },
    liveUnavailableReason: () => (available ? null : 'update'),
    loadLiveStage: () => { calls.loads++; return available ? stage : null; },
    setLiveNow(next) {
      if (role === next) return;
      const before = role;
      role = next;
      calls.roles.push(next);
      tell(roleListeners);
      if (before !== null && next === null) {
        tell(ended);
        const jobs = [...waiting.values()];
        waiting.clear();
        jobs.forEach((job) => job());
      }
    },
    liveNowRole: () => role,
    isLiveNow: () => role !== null,
    useLiveNow: () => React.useSyncExternalStore((l) => { roleListeners.add(l); return () => roleListeners.delete(l); }, () => role),
    onLiveEnded: (listener) => { ended.add(listener); return () => ended.delete(listener); },
    runAfterLive(key, work) { calls.afterLive.push(key); if (role === null) work(); else waiting.set(key, work); },
    holdCameraForLive() { holdId += 1; if (held) return holdId; held = true; calls.holds++; tell(cameraListeners); return holdId; },
    useCameraHeldByLive: () => React.useSyncExternalStore((l) => { cameraListeners.add(l); return () => cameraListeners.delete(l); }, () => held),
    isCameraHeldByLive: () => held,
    markCameraReleased() { calls.released++; },
    waitForCameraRelease: async () => {},
    releaseCameraFromLive(hold) { if (!held) return; if (typeof hold === 'number' && hold !== holdId) return; held = false; calls.releases++; tell(cameraListeners); },
  };
  return mock;
}

// A stand-in for src/lib/lives.ts: the server says nothing is live and you can't go live, unless a test says so.
function livesMock(overrides = {}) {
  return {
    LIVE_COMMENT_MAX: 150,
    LIVE_TOKEN_WORDS: {
      login: 'Please log in again.', login_changed: 'Your login changed – please log in again.', not_set_up: "Lives aren't set up yet.",
      unavailable: "Lives aren't working right now – try again in a bit.", not_allowed: "This live is only for the host's friends.",
      removed: 'You were removed from this live.', ended: 'This live has ended.',
      paused: "Your friend brought someone on – this part is just for their shared friends. We'll let you back in after.",
      full: 'This live is full right now – try again in a bit.', busy: 'Lives are busy right now – try again later.',
      stage_wait: 'Getting the stage ready…', network: "Couldn't reach the server – check your internet.",
    },
    isLiveId: (value) => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value),
    liveHint: (error) => error?.hint ?? null,
    useLiveBubble: () => false,
    fetchLiveState: async () => ({ can_go_live: false, why_not: 'testers', my_live: null, max_minutes: 60, lives_left_today: 0, rules_accepted: false }),
    fetchFriendsLiveNow: async () => [],
    checkLiveComment: () => null,
    fetchStageWatchers: async () => [],
    listenToLive: () => () => {},
    fetchLiveComments: async () => [],
    ...overrides,
  };
}

// A working stand-in for src/lib/outbox.ts (the sends that go out in the background): sendLater adds a job that
// screens see through useOutbox, so a test can check what shows while it's "Sending…". `set(key, changes)` moves a
// job on (for example to { state: 'failed', error: … }); `finish(key, rows)` marks it sent and tells the screens.
function outboxStore() {
  let jobs = [];
  let count = 0;
  const listeners = new Set();
  const done = new Set();
  const calls = { sendLater: [], queueShare: [], retry: [], discard: [], ackSent: [], visible: [] };
  const emit = () => listeners.forEach((listener) => listener());
  const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
  const inScope = (job, scope) => job.scope === scope || (scope.startsWith('friend:') && job.what.kind === 'peek' && job.what.friendIds.includes(scope.slice(7)));
  const store = {
    calls,
    jobs: () => jobs,
    sendLater(owner, scope, what, extra = {}) {
      calls.sendLater.push([owner, scope, what, extra]);
      const job = { key: `job-${++count}`, owner, scope, what, state: 'sending', rowIds: [`row-${count}`], maybeSaved: false, attempts: 1, createdAt: 0, ...extra };
      jobs = [...jobs, job];
      emit();
      return job.key;
    },
    queueShare(owner, plan, prepared) {
      calls.queueShare.push([owner, plan, prepared]);
      return { group: 'group-1', postId: plan.post ? 'post-1' : null, postJob: plan.post ? 'job-post' : null };
    },
    set(key, changes) { jobs = jobs.map((job) => (job.key === key ? { ...job, ...changes } : job)); emit(); },
    finish(key, rows = []) {
      store.set(key, { state: 'sent', rows });
      const job = jobs.find((entry) => entry.key === key);
      done.forEach((listener) => listener(job));
    },
    useOutbox(owner, scope) {
      const all = React.useSyncExternalStore(subscribe, () => jobs);
      return all.filter((job) => job.owner === owner && (!scope || inScope(job, scope)));
    },
    useOutboxJob: (key) => React.useSyncExternalStore(subscribe, () => jobs.find((job) => job.key === key) ?? null),
    retry: (key) => { calls.retry.push(key); },
    discard: async (key) => { calls.discard.push(key); jobs = jobs.filter((job) => job.key !== key); emit(); },
    ackSent: (key) => { calls.ackSent.push(key); jobs = jobs.filter((job) => job.key !== key); emit(); },
    whenSent: async (key) => ({ key, state: 'sent' }),
    outboxBusy: () => jobs.some((job) => job.state === 'sending' || job.state === 'waiting'),
    setVisibleScope: (scope) => { calls.visible.push(scope); },
    getVisibleScope: () => null,
    onOutboxDone: (listener) => { done.add(listener); return () => done.delete(listener); },
    inScope,
    groupSize: () => 1,
    restoreOutbox: async () => {},
    useDropSending: () => null,
  };
  return store;
}

function host(name) {
  return function Host(props) {
    if (name === 'Modal' && !props.visible) return null;
    return React.createElement(name, props, props.children);
  };
}

// `timers: 'real'` lets setTimeout really run (after its delay); the default only records the callbacks so a
// test can run them by hand (timer number n is calls.timers[n - 1]; a timer the screen stopped again is in
// calls.clearedTimers).
let pendingBubble = null;

function loadScreen(relative, overrides = {}, { timers = 'recorded' } = {}) {
  const calls = { alerts: [], toasts: [], routes: [], timers: [], clearedTimers: new Set(), intervals: new Map(), appState: new Set(), outbox: { sendLater: [], queueShare: [] }, preupload: { prepareUpload: [], discardUpload: [], markUsed: [], prepareAvatar: [], discardAvatar: [] } };
  const componentNames = ['Avatar', 'Button', 'DareRulesSheet', 'PostPreview', 'StoryPreview', 'ScreenHeader', 'VideoClip', 'TextField', 'FormScreen', 'EmptyState', 'LegalText', 'KeyboardSafeView', 'StoryAvatar'];
  const modules = {
    react: React,
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': {
      ...Object.fromEntries(['View', 'Text', 'Pressable', 'Switch', 'ScrollView', 'RefreshControl', 'KeyboardAvoidingView', 'Modal', 'Image', 'ActivityIndicator', 'TextInput'].map(name => [name, host(name)])),
      FlatList: props => React.createElement('FlatList', props,
        props.ListHeaderComponent,
        props.data?.length ? props.data.map((item, index) => React.createElement(React.Fragment, { key: props.keyExtractor?.(item, index) ?? index }, props.renderItem({ item, index }))) : props.ListEmptyComponent,
        props.ListFooterComponent),
      StyleSheet: { create: value => value, absoluteFill: {} },
      Platform: { OS: 'android' },
      Alert: { alert: (...args) => calls.alerts.push(args) },
      // Coming back to the app: a test calls each listener in calls.appState with 'active'.
      AppState: { currentState: 'active', addEventListener: (event, listener) => { calls.appState.add(listener); return { remove: () => calls.appState.delete(listener) }; } },
      useWindowDimensions: () => ({ width: 320, height: 568 }),
    },
    '@expo/vector-icons/Ionicons': host('Ionicons'),
    'expo-haptics': { notificationAsync: async () => {}, impactAsync: async () => {}, selectionAsync: async () => {}, NotificationFeedbackType: { Success: 'success' }, ImpactFeedbackStyle: { Light: 'light' } },
    'expo-router': { router: Object.fromEntries(['back', 'push', 'replace', 'dismissTo'].map(name => [name, (...args) => calls.routes.push([name, ...args])])), useLocalSearchParams: () => ({ uri: 'file:///qa-photo.jpg' }) },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) },
    '@/theme': { colors: {}, font: {}, radius: {}, space: {} },
    '@/components/Overlays': { useOverlays: () => ({ showToast: (...args) => calls.toasts.push(args) }) },
    '@/lib/auth': { useMe: () => ({ userId: 'alice', profile: { id: 'alice', username: 'alice', display_name: 'Alice' } }) },
    '@/lib/errors': { friendlyError: e => e.message || String(e) },
    '@/lib/cleanWords': { checkClean: () => null },
    '@/lib/friends': { fetchFriends: async () => [], cachedFriends: () => null, warmFriends() {} },
    '@/lib/media': { resizePhoto: async uri => uri, videoTooBig: () => false },
    '@/lib/dares': { todayDareDay: () => '2026-11-04', useDare: () => ({ text: 'QA dare' }) },
    '@/lib/drop': { lateLabel: () => ({ onTime: true, text: 'On time' }), useMyDropPosts: () => 0 },
    // 📤 The outbox (sends go out in the background): sends are only recorded here. Tests that need to see
    // "Sending…" bubbles pass outboxStore().
    '@/lib/outbox': {
      sendLater: (...args) => { calls.outbox.sendLater.push(args); return `job-${calls.outbox.sendLater.length}`; },
      queueShare: (...args) => { calls.outbox.queueShare.push(args); return { group: 'group-1', postId: args[1].post ? 'post-1' : null, postJob: args[1].post ? 'job-post' : null }; },
      useOutbox: () => [], useOutboxJob: () => null,
      retry() {}, discard: async () => {}, ackSent() {},
      whenSent: async (key) => ({ key, state: 'sent' }),
      outboxBusy: () => false, setVisibleScope() {}, getVisibleScope: () => null,
      onOutboxDone: () => () => {}, inScope: () => false, groupSize: () => 1, restoreOutbox: async () => {},
      useDropSending: () => null,
    },
    // 📤 Early uploads: recorded, and never finish by themselves.
    '@/lib/preupload': {
      prepareUpload: (...args) => { calls.preupload.prepareUpload.push(args); return { key: `early-${calls.preupload.prepareUpload.length}`, owner: args[0], uri: args[1]?.uri, folder: args[2], done: new Promise(() => {}), state: 'uploading' }; },
      discardUpload: (...args) => { calls.preupload.discardUpload.push(args); },
      markUsed: (...args) => { calls.preupload.markUsed.push(args); },
      prepareAvatar: (...args) => { calls.preupload.prepareAvatar.push(args); return { owner: args[0], uri: args[1], path: `${args[0]}/early-avatar.jpg`, done: Promise.resolve(`${args[0]}/early-avatar.jpg`), state: 'uploading' }; },
      discardAvatar: (...args) => { calls.preupload.discardAvatar.push(args); },
      markAvatarUsed() {}, cleanLeftoverUploads: async () => {}, avatarReady: (avatar) => avatar.done,
    },
    // ⚡ The extras that wait until Home is drawn (lib/startup.ts): already started in these tests, unless a test
    // passes its own.
    '@/lib/startup': { useStartupDone: () => true, startupDone: () => true, afterStartup: async () => {}, noteHomeDrawn() {}, subscribeStartup: () => () => {} },
    // No restart for a new app version while the editor or "Send to…" is open: nothing to do in tests.
    '@/lib/appUpdates': { useNoRestartWhileOpen() {}, useStayUpToDate() {} },
    '@/components/OutboxBanner': { SendingPill: host('SendingPill'), OutboxToasts: host('OutboxToasts') },
    '@/lib/legal': { useDareRulesAccepted: () => ({ accepted: true }) },
    '@/lib/chat': { sendSnap: async () => {}, sendChatPhoto: async () => {}, isChatPhoto: () => false },
    '@/lib/posts': { createPost: async () => ({ id: 'qa-post', drop_late_seconds: 0 }) },
    '@/lib/stories': { createStory: async () => {} },
    '@/lib/storyRings': { refreshStoryBadges: async () => {}, setStoryRings: () => {}, useStoryBadge: () => null },
    '@/lib/guess': { postMystery: async () => {} },
    // 🕵️ Guess Who in group chats: a server without it (nothing to show, nothing to listen to).
    '@/lib/groupGuess': { fetchGroupGuesses: async () => null, subscribeToGroupGuesses: () => () => {}, postGroupGuess: async () => {} },
    '@/components/groups/GroupGuessCard': { GroupGuessCard: host('GroupGuessCard') },
    // 🚪 Leave / 🗑️ Delete in a group's ⋯ menu: nothing by default (tests/frontend/group-delete.test.cjs loads the real one).
    '@/components/groups/leaveOrDelete': { leaveOrDeleteOptions: () => [] },
    '@/components/SocialSignIn': { SOCIAL_SIGN_IN_AVAILABLE: false, SocialSignInButtons: host('SocialSignInButtons') },
    // Peekaboo+ (payments, chat backgrounds, pinned chats): off by default, so screens look like they do without it.
    '@/lib/plus': {
      CAN_BUY_PLUS: false, usePlus: () => false, usePlusAnswer: () => 'no', hasPlus: () => false, usePersonPlus: () => false,
      useStorePlus: () => false, useServerPlus: () => false, refreshServerPlus: async () => {},
      configurePurchases: async () => {}, logOutPurchases: async () => {},
      getPlusPrice: async () => null, buyPlus: async () => 'cancelled', restorePurchases: async () => 'not-found',
      openManageSubscription: async () => {},
      MANAGE_SUBSCRIPTION_URL: 'https://apps.apple.com/account/subscriptions',
      WAITING_FOR_PARENT: "Waiting for a parent to approve. You'll get Peekaboo+ as soon as it's approved.",
    },
    // Terms agreed on this phone: nothing remembered (tests that need it pass their own).
    // When Peekaboo+ ends (puts the free theme and icon back): does nothing in these tests.
    // Chat screens tell the notifications which chat is open (so its own messages don't pop up): nothing here.
    '@/lib/notifications': { useOpenChat() {} },
    '@/lib/plusLapse': { usePlusLapse() {}, endPlusExtras: async () => {} },
    // Dare safety: every dare is fine unless a test says otherwise (the rules themselves: tests/unit/dare-safety.test.mjs).
    '@/lib/dareSafety': { checkDare: () => null, dareProblem: () => null },
    // The public chat (18+): hidden unless a test says who is looking.
    '@/lib/publicChat': {
      PUBLIC_CHAT: 'public', PUBLIC_TEXT_MAX: 300, usePublicChatStatus: () => 'under_18', fetchPublicChatStatus: async () => 'under_18',
      sendPublicPhoto: async () => {}, fetchPublicPhotos: async () => [], deletePublicPhoto: async () => {}, subscribeToPublicChat: () => () => {},
      fetchPublicChat: async () => ({ items: [], textOn: false }), sendPublicText: async () => null, sendPublicSticker: async () => null,
      deletePublicMessage: async () => {}, checkPublicText: () => null, checkPublicName: () => null, hasPublicText: text => text.trim() !== '',
      publicChatName: author => author?.display_name || author?.username || 'Someone',
    },
    // "How did you hear about Peekaboo?": not asked unless a test says so.
    '@/lib/heardAbout': { useNeedsHeardAbout: () => [false, () => {}], saveHeardAbout: async () => {}, HEARD_ABOUT_OPTIONS: [] },
    '@/components/HeardAbout': { HeardAbout: host('HeardAbout') },
    '@/lib/termsCache': { knownAgreed: () => false, knownAgreedAny: () => false, rememberAgreed() {}, forgetAgreed() {} },
    // The chat screens' keyboard lift: no keyboard in these tests.
    '@/lib/chatPins': { MAX_PINS: 3, pinKeyForFriend: id => `friend:${id}`, pinKeyForGroup: id => `group:${id}`, sortByPins: items => items, useChatPins: () => ({ pins: [], plus: false, toggle: async () => 'needs-plus' }) },
    // Peekaboo+ insights (profile views, rewatches, screenshots): nothing to show, and the setting is unknown.
    '@/lib/insights': {
      recordProfileView: async () => {}, fetchMyProfileViews: async () => null, fetchShowInProfileViews: async () => null,
      setShowInProfileViews: async () => {}, recordStoryView: async () => {}, fetchStoryInsights: async () => null,
      recordScreenshot: async () => {}, useContentScreenshots: () => {}, fetchPostScreenshots: async () => null,
    },
    // Peekaboo+ extras (Peek-a-Save, drop rewind, Guess Who hint): the server doesn't have them, so they stay hidden.
    '@/lib/plusExtras': {
      fetchPlusAllowances: async () => { throw new Error('plus_allowances is not on this server'); },
      fetchPeekASaves: async () => null,
      fetchBrokenStreaks: async () => [],
      peekASave: async () => 0,
      fetchMysteryHints: async () => null,
      getMysteryHint: async () => '',
      brokenStreakText: () => '',
      shortDate: () => '',
      hoursLeft: () => '',
    },
    '@/components/PeekASaveCard': { PeekASaveCard: host('PeekASaveCard') },
    '@/components/DropRewindOption': { DropRewindOption: host('DropRewindOption') },
    '@/lib/chatBackgrounds': { friendChatKey: id => `friend:${id}`, groupChatKey: id => `group:${id}`, useChatBackground: () => ({ plus: false, picked: null, shown: null, choose: async () => {} }) },
    '@/components/chat/ChatBackground': { ChatBackground: host('ChatBackground'), ChatInkProvider: host('ChatInkProvider'), chatInk: () => null, useChatInk: () => null },
    '@/components/chat/ChatBackgroundPicker': { ChatBackgroundPicker: host('ChatBackgroundPicker') },
    // Stickers in chat: the picker and the drawn sticker are stand-ins; Peekaboo+ stickers are the 'plus-…' ones.
    '@/components/chat/ChatSticker': { ChatSticker: host('ChatSticker') },
    '@/components/editor/StickerPicker': { StickerPicker: host('StickerPicker') },
    '@/lib/chatStickers': {
      wordStickerId: word => `word-${word.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      isKnownSticker: id => /^(plus-|word-)/.test(id) || ['googly-eyes', 'googly-eye', 'peekaboo', 'peek-bubble', 'i-see-you', 'caught'].includes(id),
      canSendSticker: (id, plus) => plus || !id.startsWith('plus-'),
      isPlusSticker: id => id.startsWith('plus-'),
      stickerName: id => id, stickerText: id => `Sticker: ${id}`,
    },
    // The list of face filters (no imports, so the real file is used).
    '@/lib/lensLooks': loadPure('src/lib/lensLooks.ts'),
    // 🌆 Main Character Mode's switches (no imports, so the real file is used), and the update channel: the real
    // file, which finds no channel here (like Expo Go), so the 🌆 bubble is off unless a test says otherwise.
    '@/lib/mainCharacter/config': loadPure('src/lib/mainCharacter/config.ts'),
    '@/lib/lensDiagnostics': loadPure('src/lib/lensDiagnostics.ts'),
    // How long and how big a video can be (no imports, so the real file is used).
    '@/lib/videoLimits': loadPure('src/lib/videoLimits.ts'),
    // Sending pictures out of the app (share sheet, Save to Photos): not possible here unless a test says so.
    '@/lib/shareOut': { CAN_SHARE_FILES: false, saveOut: async () => 'not-possible', shareOut: async () => 'not-possible' },
    // The camera's own pixels for the 4 stretchy face filters: not on this download by default (like App Store
    // build 10, TestFlight 7–9, old APKs and Expo Go), so every screen looks the way it does there. Tests for the
    // new build pass their own frameAccessMock(true).
    '@/lib/frameAccess': frameAccessMock(false),
    // Lives 🔴: not on this download by default (see liveAccessMock), and the server has nothing live.
    '@/lib/liveAccess': liveAccessMock(false),
    '@/lib/lives': livesMock(),
    '@/lib/liveExit': { setLiveExit: () => () => {}, leaveLiveNow: async () => {}, openUnlessLive: (open) => open() },
    '@/lib/livePermissions': { ensureLivePermissions: async () => 'ok', openPhoneSettings() {}, LIVE_PERMISSION_WORDS: 'Peekaboo needs your camera and microphone so friends can see and hear you' },
    '@/components/live/GoLiveSheet': { GoLiveSheet: host('GoLiveSheet') },
    // App icons (a native part only new iPhone downloads have): off by default, like Expo Go.
    '@/lib/appIcons': {
      CAN_CHANGE_APP_ICON: false,
      APP_ICONS: [
        { key: 'classic', name: null, label: 'Classic', plus: false, preview: 1 },
        { key: 'midnight', name: 'Midnight', label: 'Midnight', plus: true, preview: 2 },
      ],
      currentAppIcon: () => 'classic',
      setAppIcon: async () => {},
    },
  };
  for (const name of componentNames) modules[`@/components/${name === 'VideoClip' ? 'VideoClipSafe' : name}`] = { [name]: host(name) };
  // The "Sending…" bubble is the real one (it has no imports but React Native and the theme).
  // (An older revision without it – QA_ORIGINAL=1 – simply doesn't get it.)
  if (relative !== 'src/components/chat/PendingBubble.tsx') {
    try {
      pendingBubble = pendingBubble ?? loadScreen('src/components/chat/PendingBubble.tsx').exports;
      modules['@/components/chat/PendingBubble'] = pendingBubble;
    } catch {
      pendingBubble = null;
    }
  }
  Object.assign(modules, overrides);
  const source = readSource(relative);
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  const context = vm.createContext({
    module, exports: module.exports, console,
    setTimeout: timers === 'real'
      ? (callback, ms, ...args) => { calls.timers.push(callback); return setTimeout(callback, ms, ...args); }
      : callback => { calls.timers.push(callback); return calls.timers.length; },
    clearTimeout: timers === 'real' ? id => clearTimeout(id) : id => { calls.clearedTimers.add(id); },
    setInterval: callback => { const id = Symbol('interval'); calls.intervals.set(id, callback); return id; }, clearInterval: id => calls.intervals.delete(id),
    require: id => {
      if (!(id in modules)) throw new Error(`Missing isolated test mock for ${id}`);
      return modules[id];
    },
  });
  vm.runInContext(compiled, context, { filename: relative });
  return { Component: module.exports.default, exports: module.exports, calls, modules, getBinding: name => vm.runInContext(name, context) };
}

async function renderScreen(screen) {
  let tree;
  await renderer.act(async () => { tree = renderer.create(React.createElement(screen.Component)); });
  return tree;
}
async function act(callback) { await renderer.act(async () => { await callback(); }); }
function textOf(node) { return typeof node === 'string' ? node : node.children?.map(textOf).join('') || ''; }
function button(tree, title) { return tree.root.findAllByType('Button').find(node => node.props.title === title || (title instanceof RegExp && title.test(node.props.title))); }
function option(tree, title) { return tree.root.findAllByType('Pressable').find(node => textOf(node).startsWith(title) || node.findAllByType('Text').some(child => textOf(child) === title)); }
async function unmount(tree) { await act(() => tree.unmount()); }

module.exports = { React, renderer, loadScreen, loadPure, renderScreen, act, textOf, button, option, unmount, readSource, host, frameAccessMock, liveAccessMock, livesMock, outboxStore };

