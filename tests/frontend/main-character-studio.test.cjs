const test = require('node:test');
const assert = require('node:assert/strict');
const { React, loadScreen, loadPure, renderScreen, act, host, textOf, unmount } = require('./harness.cjs');

// Main Character Mode 🌆, the screen (src/components/mainCharacter/MainCharacterStudio.tsx), with stand-ins for the
// camera (MainCharacterCamera), the art library, the banner, sharing and the phone's storage. Checked here:
// - swipe left/right (the pan's onDeactivate) picks the next/previous character, round and round; an up/down swipe
//   or a short one does nothing; each character brings its own scene until 🌴 picks one, which then stays;
// - 🌴 goes through the scenes; flip switches cameras;
// - from the shutter press until the poster shows: swipes, 🌴 and flip do nothing, the camera stays on, and the
//   banner plays; the poster shows only once MISSION_INTRO_MS has passed;
// - no face → the "look at the camera" message and no poster; a failed poster → a message and back to live;
// - while a live 🔴 has the camera: no camera at all, and the screen says it let go of it;
// - the small Peekaboo logo on the live poster and on the finished one, at lib/watermark.ts's spot;
// - Share / Save hand the clean poster to lib/shareOut.ts (it adds the logo); My story / Send open Send to… with
//   { uri } / { uri, pick: 'friends' }; Take another goes back to live;
// - the last character and scene are remembered (a scene picked last time only until the first swipe); with nothing
//   remembered the first character stays, also when online art arrives in front of it; a phone storage that
//   doesn't answer in time is never written over; the swipe hint shows on the first 3 visits;
// - after a live hands the camera back, the face counts as gone until the new camera sees one;
// - VoiceOver can change the character (the screen is an "adjustable" element);
// - on the finished poster, the close button has room of its own above the poster (the real SafeEdge).

const config = loadPure('src/lib/mainCharacter/config.ts');
const watermark = loadScreen('src/lib/watermark.ts', { 'expo-asset': {}, 'expo-file-system': {} }).exports;
// The real logo piece, with the real spot from lib/watermark.ts.
const wordmarkFile = loadScreen('src/components/mainCharacter/ScreenWordmark.tsx', {
  '@/lib/watermark': watermark,
  '../../../assets/images/wordmark-white.png': 7,
}).exports;

const theme = {
  colors: { white: '#FFFFFF', black: '#000000', pink: '#FF4F9A', purple: '#9B5CFF', yellow: '#FFE14D', overlay: 'rgba(0,0,0,0.35)' },
  font: {}, radius: { sm: 10, md: 16, lg: 24, pill: 999 }, space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
};

const anchors = { eyes: [[0.43, 0.12], [0.55, 0.12]], nose: [0.49, 0.15], chin: [0.49, 0.23], forehead: [0.49, 0.07], hole: [], faceWidth: 0.25, skinTone: [205, 140, 110], toneSure: true };
const character = (slug, name, scene, from = 'app') => ({ key: `${from}:${slug}`, slug, name, from, file: 1, anchors, scene });
const sceneArt = (slug, name) => ({ key: `app:${slug}`, slug, name, from: 'app', file: 2 });
const BOSS = character('street-boss', 'Street Boss', 'neon-street');
const DRIVER = character('getaway-driver', 'Getaway Driver', 'coast-highway');
const HUSTLER = character('beach-hustler', 'Beach Hustler', 'beach-drive');
const NEON = sceneArt('neon-street', 'Neon Street');
const COAST = sceneArt('coast-highway', 'Coast Highway');
const BEACH = sceneArt('beach-drive', 'Beach Drive');

// `stored`: what the phone remembers (key → text). `slowKeys`: keys the phone's storage never answers for.
// `channel`: the update channel. `permission`: the camera permission answer. `configChanges`: switches changed
// for this test (MISSION_INTRO_MS is 0 unless a test says so). `safeEdge`: the SafeEdge to use (a plain stand-in
// unless a test gives the real one).
function loadStudio({ stored = {}, slowKeys = [], channel = 'production', permission = { granted: true, canAskAgain: true }, configChanges = {}, characters = [BOSS, DRIVER, HUSTLER], scenes = [NEON, COAST, BEACH], focused = true, safeEdge = { SafeEdge: host('SafeEdge') } } = {}) {
  const storage = new Map(Object.entries(stored));
  const slow = new Set(slowKeys);
  const writes = [];
  const out = { shared: [], saved: [], shareAnswer: 'shared', saveAnswer: 'saved' };
  const haptics = [];
  const pan = { config: null };
  const library = { steps: null, value: { characters, scenes, checking: false } };
  const cam = { props: null, renders: [], captures: [], capture: null, mounted: 0 };
  const permissionAsks = [];
  const settingsOpened = [];
  const view = { focused };

  function MainCharacterCamera(props) {
    cam.props = props;
    cam.renders.push({ active: props.active, character: props.character?.slug ?? null, scene: props.scene?.slug ?? null, facing: props.facing, forceLite: props.forceLite });
    React.useEffect(() => {
      cam.mounted += 1;
      return () => { cam.mounted -= 1; };
    }, []);
    React.useImperativeHandle(props.ref, () => ({
      capture() {
        cam.captures.push({ active: cam.props.active, character: cam.props.character?.slug });
        return cam.capture ? cam.capture() : Promise.resolve({ uri: 'file:///poster.jpg' });
      },
    }), []);
    return React.createElement('MainCharacterCamera', props);
  }

  const useShared = (initial) => React.useRef({ value: initial, get() { return this.value; }, set(next) { this.value = next; } }).current;
  const screen = loadScreen('src/components/mainCharacter/MainCharacterStudio.tsx', {
    '@react-native-async-storage/async-storage': {
      __esModule: true,
      default: {
        getItem: (key) => (slow.has(key) ? new Promise(() => {}) : Promise.resolve(storage.has(key) ? storage.get(key) : null)),
        setItem: async (key, value) => { storage.set(key, value); writes.push([key, value]); },
      },
    },
    'expo-camera': { useCameraPermissions: () => [permission, async () => { permissionAsks.push(true); return permission; }] },
    'expo-haptics': {
      selectionAsync: async () => { haptics.push('selection'); },
      impactAsync: async (style) => { haptics.push(`impact:${style}`); },
      notificationAsync: async () => { haptics.push('notification'); },
      ImpactFeedbackStyle: { Light: 'light', Heavy: 'heavy' },
      NotificationFeedbackType: { Success: 'success' },
    },
    'expo-image': { Image: host('ExpoImage') },
    'expo-router': {
      router: Object.fromEntries(['back', 'push', 'replace', 'dismissTo'].map((name) => [name, (...args) => screen.calls.routes.push([name, ...args])])),
      useIsFocused: () => view.focused,
    },
    'react-native': {
      ...loadScreen('src/lib/mainCharacter/config.ts').modules['react-native'],
      Platform: { OS: 'ios' },
      Linking: { openSettings: async () => { settingsOpened.push(true); } },
      useWindowDimensions: () => ({ width: 390, height: 844 }),
    },
    'react-native-gesture-handler': { GestureDetector: host('GestureDetector'), usePanGesture: (options) => { pan.config = options; return { pan: true }; } },
    'react-native-reanimated': {
      __esModule: true,
      default: { View: host('AnimatedView') },
      useSharedValue: useShared,
      useAnimatedStyle: (callback) => callback(),
      withDelay: (_ms, value) => value,
      withSequence: (...values) => values[0],
      withSpring: (value) => value,
      withTiming: (value) => value,
    },
    'react-native-worklets': { scheduleOnRN: (fn, ...args) => fn(...args) },
    '@/components/Bouncy': { Bouncy: host('Bouncy') },
    '@/components/IconButton': { IconButton: host('IconButton') },
    '@/components/SafeEdge': safeEdge,
    '@/lib/lensDiagnostics': { updateChannel: () => channel },
    '@/lib/mainCharacter/config': { ...config, MISSION_INTRO_MS: 0, ...configChanges },
    '@/lib/mainCharacter/library': { useMainCharacterLibrary: (steps) => { library.steps = steps; return library.value; } },
    '@/lib/shareOut': {
      CAN_SHARE_FILES: true,
      shareOut: async (uri, kind) => { out.shared.push([uri, kind]); return out.shareAnswer; },
      saveOut: async (uri, kind) => { out.saved.push([uri, kind]); return out.saveAnswer; },
    },
    '@/theme': theme,
    './analyseArt': { analyseCharacter: async () => null, normaliseArt: async () => null },
    './MainCharacterCamera': { MainCharacterCamera },
    './MissionPassed': { MissionPassed: host('MissionPassed') },
    './ScreenWordmark': wordmarkFile,
  });
  return { screen, storage, writes, out, haptics, pan, library, cam, permissionAsks, settingsOpened, view, live: screen.modules['@/lib/liveAccess'] };
}

// Renders the screen and lets the remembered values come in.
async function openStudio(options) {
  const loaded = loadStudio(options);
  const tree = await renderScreen({ Component: loaded.screen.exports.MainCharacterStudio });
  await act(async () => {});
  return { ...loaded, tree };
}

const byLabel = (tree, type, label) => tree.root.findAll((node) => node.type === type && node.props.accessibilityLabel === label)[0];
const iconButton = (tree, label) => tree.root.findAll((node) => node.type === 'IconButton' && node.props.label === label)[0];
const shutter = (tree) => byLabel(tree, 'Bouncy', 'Make my poster');
const words = (tree) => tree.root.findAllByType('Text').map(textOf).join(' | ');
const banner = (tree) => tree.root.findByType('MissionPassed').props.playing;
const shown = (opened) => ({ character: opened.cam.props?.character?.slug ?? null, scene: opened.cam.props?.scene?.slug ?? null });
const swipe = (opened, translationX, more = {}) => act(async () => { opened.pan.config.onDeactivate({ translationX, translationY: 0, velocityX: 0, velocityY: 0, ...more }); });
const seeFace = (opened, seen = true) => act(async () => { opened.cam.props.onFaceSeen(seen); });
// Runs every timer the screen started and didn't stop (the face-missing wait, the storage wait, …).
const runTimers = (opened) => act(async () => {
  opened.screen.calls.timers.forEach((run, index) => { if (!opened.screen.calls.clearedTimers.has(index + 1)) run(); });
});
const lastSaved = (opened) => {
  const last = opened.writes.filter(([key]) => key === 'mc:last').at(-1);
  return last ? JSON.parse(last[1]) : null;
};
const NO_FACE_WORDS = "We can't see a face – look at the camera 👀";

// A capture the test finishes by hand.
function holdCapture(opened) {
  let finish;
  let fail;
  opened.cam.capture = () => new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  return { finish: (uri) => finish({ uri }), fail: (error) => fail(error) };
}

// Presses the shutter and hands back the press's own promise (in a box, so awaiting this doesn't wait for it).
async function pressShutter(opened) {
  let pressing;
  await act(async () => { pressing = shutter(opened.tree).props.onPress(); });
  return { done: pressing };
}

test('opens on the first character with its own scene, the selfie camera on, and hands the library its picture steps', async () => {
  const opened = await openStudio();
  try {
    assert.deepEqual(shown(opened), { character: 'street-boss', scene: 'neon-street' });
    assert.equal(opened.cam.props.facing, 'front');
    assert.equal(opened.cam.props.active, true);
    assert.equal(opened.cam.props.forceLite, false);
    // The next and previous characters are read early (a quick swipe).
    assert.deepEqual(Array.from(opened.cam.props.nearby, (art) => art.slug), ['getaway-driver', 'beach-hustler']);
    assert.equal(typeof opened.library.steps.normalise, 'function');
    assert.equal(typeof opened.library.steps.analyse, 'function');
    assert.equal(banner(opened.tree), false);
  } finally { await unmount(opened.tree); }
});

test('swiping left and right picks the next and previous character, round and round, each with its own scene', async () => {
  const opened = await openStudio();
  try {
    await swipe(opened, -120);
    assert.deepEqual(shown(opened), { character: 'getaway-driver', scene: 'coast-highway' });
    assert.match(words(opened.tree), /GETAWAY DRIVER/, 'the name pops up big');
    assert.ok(opened.haptics.includes('selection'));
    await swipe(opened, -120);
    assert.deepEqual(shown(opened), { character: 'beach-hustler', scene: 'beach-drive' });
    // Past the last one: back to the first.
    await swipe(opened, -120);
    assert.deepEqual(shown(opened), { character: 'street-boss', scene: 'neon-street' });
    // Right: the previous one, round to the last.
    await swipe(opened, 120);
    assert.deepEqual(shown(opened), { character: 'beach-hustler', scene: 'beach-drive' });
    // A fast flick counts too.
    await swipe(opened, 20, { velocityX: 900 });
    assert.deepEqual(shown(opened), { character: 'getaway-driver', scene: 'coast-highway' });
    // Up/down or too short: nothing.
    await swipe(opened, -120, { translationY: 300 });
    await swipe(opened, -30);
    assert.deepEqual(shown(opened), { character: 'getaway-driver', scene: 'coast-highway' });
  } finally { await unmount(opened.tree); }
});

test('🌴 goes through the scenes; a picked scene stays when you swipe; a character with no scene keeps the one showing', async () => {
  const ONLINE = character('night-owl', 'Night Owl', null, 'online');
  const opened = await openStudio({ characters: [ONLINE, BOSS, DRIVER] });
  try {
    // An online character has no scene of its own: the first scene shows.
    assert.deepEqual(shown(opened), { character: 'night-owl', scene: 'neon-street' });
    await swipe(opened, -120);
    assert.deepEqual(shown(opened), { character: 'street-boss', scene: 'neon-street' });
    await swipe(opened, -120);
    assert.deepEqual(shown(opened), { character: 'getaway-driver', scene: 'coast-highway' });
    // Back to the online one: it keeps the scene that was showing.
    await swipe(opened, -120);
    assert.deepEqual(shown(opened), { character: 'night-owl', scene: 'coast-highway' });

    const palm = () => byLabel(opened.tree, 'Bouncy', 'Next scene');
    await act(async () => palm().props.onPress());
    assert.deepEqual(shown(opened), { character: 'night-owl', scene: 'beach-drive' });
    assert.match(words(opened.tree), /Beach Drive/, 'the scene name pops up');
    await act(async () => palm().props.onPress());
    assert.deepEqual(shown(opened), { character: 'night-owl', scene: 'neon-street' }, 'round to the first scene');
    await act(async () => palm().props.onPress());
    assert.equal(shown(opened).scene, 'coast-highway');
    // Picked: swiping to characters with their own scenes keeps it.
    await swipe(opened, -120);
    assert.deepEqual(shown(opened), { character: 'street-boss', scene: 'coast-highway' });
    await swipe(opened, -120);
    assert.deepEqual(shown(opened), { character: 'getaway-driver', scene: 'coast-highway' });
  } finally { await unmount(opened.tree); }
});

test('flip switches between the selfie and the back camera', async () => {
  const opened = await openStudio();
  try {
    await act(async () => iconButton(opened.tree, 'Flip camera').props.onPress());
    assert.equal(opened.cam.props.facing, 'back');
    await act(async () => iconButton(opened.tree, 'Flip camera').props.onPress());
    assert.equal(opened.cam.props.facing, 'front');
  } finally { await unmount(opened.tree); }
});

test('the shutter: flash, banner, the camera stays on while the poster is made, swipes / 🌴 / flip do nothing, then the poster', async () => {
  const opened = await openStudio();
  try {
    await seeFace(opened);
    const capture = holdCapture(opened);
    const rendersBefore = opened.cam.renders.length;
    const { done: pressing } = await pressShutter(opened);
    assert.equal(opened.cam.captures.length, 1);
    assert.equal(opened.cam.captures[0].active, true, 'the camera is on at the press');
    assert.ok(opened.haptics.includes('impact:heavy'));
    assert.equal(banner(opened.tree), true, 'the banner plays from the press');
    const flash = opened.tree.root.findAll((node) => node.type === 'AnimatedView' && [].concat(node.props.style).some((part) => part && part.opacity === 1 && part.backgroundColor === undefined));
    assert.ok(flash.length >= 1, 'the white flash goes up');

    // While it is being made: nothing changes the poster, the camera or the facing.
    assert.equal(opened.pan.config.enabled, false);
    await swipe(opened, -120);
    await act(async () => byLabel(opened.tree, 'Bouncy', 'Next scene').props.onPress());
    await act(async () => iconButton(opened.tree, 'Flip camera').props.onPress());
    assert.equal(iconButton(opened.tree, 'Flip camera').props.disabled, true);
    assert.equal(byLabel(opened.tree, 'Bouncy', 'Next scene').props.disabled, true);
    assert.equal(shutter(opened.tree).props.disabled, true);
    assert.deepEqual(shown(opened), { character: 'street-boss', scene: 'neon-street' });
    assert.equal(opened.cam.props.facing, 'front');
    // A second press does nothing either.
    await act(async () => { shutter(opened.tree).props.onPress(); });
    assert.equal(opened.cam.captures.length, 1);
    // The camera stayed on for every drawing while the poster was being made.
    assert.ok(opened.cam.renders.slice(rendersBefore).every((render) => render.active === true));

    await act(async () => { capture.finish('file:///poster.jpg'); await pressing; });
    // The finished poster: the camera stops, the result shows the clean poster.
    assert.equal(opened.cam.props.active, false);
    const pictures = opened.tree.root.findAllByType('ExpoImage');
    assert.ok(pictures.some((node) => node.props.contentFit === 'contain' && node.props.source.uri === 'file:///poster.jpg'));
    assert.ok(pictures.some((node) => node.props.blurRadius > 0 && node.props.source.uri === 'file:///poster.jpg'), 'on a blurred copy of itself');
    assert.equal(banner(opened.tree), true, 'the banner finishes over the poster');
    // On the finished poster swipes do nothing, and flip and 🌴 are gone.
    assert.equal(opened.pan.config.enabled, false);
    await swipe(opened, -120);
    assert.deepEqual(shown(opened), { character: 'street-boss', scene: 'neon-street' });
    assert.equal(iconButton(opened.tree, 'Flip camera'), undefined);
    assert.equal(byLabel(opened.tree, 'Bouncy', 'Next scene'), undefined);
    assert.equal(shutter(opened.tree), undefined);
    assert.deepEqual(opened.screen.calls.toasts, []);
  } finally { await unmount(opened.tree); }
});

test('the poster shows only once the banner had MISSION_INTRO_MS', async () => {
  const opened = await openStudio({ configChanges: { MISSION_INTRO_MS: config.MISSION_INTRO_MS } });
  try {
    await seeFace(opened);
    const capture = holdCapture(opened);
    const { done: pressing } = await pressShutter(opened);
    const timersBefore = opened.screen.calls.timers.length;
    await act(async () => { capture.finish('file:///poster.jpg'); await Promise.resolve(); await Promise.resolve(); });
    assert.equal(opened.tree.root.findAllByType('ExpoImage').length, 0, 'not yet: the banner is still on its way in');
    assert.equal(opened.cam.props.active, true);
    const waits = opened.screen.calls.timers.slice(timersBefore);
    assert.ok(waits.length >= 1);
    await act(async () => { waits.forEach((run) => run()); await pressing; });
    assert.ok(opened.tree.root.findAllByType('ExpoImage').length > 0);
  } finally { await unmount(opened.tree); }
});

test('no face: the shutter says to look at the camera and makes nothing; the camera saying "no-face" does the same', async () => {
  const opened = await openStudio();
  try {
    await pressShutter(opened);
    assert.equal(opened.cam.captures.length, 0);
    assert.deepEqual(opened.screen.calls.toasts, [["We can't see a face – look at the camera 👀"]]);
    assert.equal(banner(opened.tree), false);

    await seeFace(opened);
    opened.cam.capture = async () => { throw new Error('no-face'); };
    const { done: pressing } = await pressShutter(opened);
    await act(async () => { await pressing; });
    assert.equal(opened.screen.calls.toasts.length, 2);
    assert.deepEqual(opened.screen.calls.toasts[1], ["We can't see a face – look at the camera 👀"]);
    assert.equal(banner(opened.tree), false);
    assert.equal(opened.pan.config.enabled, true, 'back to live');

    // The face was seen a moment ago but is gone by the time of the photo: the photo bake says NO_FACE
    // (config.ts, the same words – tests/unit/main-character-paint.test.mjs checks the bake). Same message, not
    // "Couldn't make your poster".
    assert.equal(config.NO_FACE, 'no-face');
    const bake = holdCapture(opened);
    const { done: baking } = await pressShutter(opened);
    assert.equal(banner(opened.tree), true);
    await act(async () => { bake.fail(new Error(config.NO_FACE)); await baking; });
    assert.deepEqual(opened.screen.calls.toasts.at(-1), [NO_FACE_WORDS]);
    assert.equal(opened.screen.calls.toasts.filter(([text]) => /Couldn't make your poster/.test(text)).length, 0);
    assert.equal(banner(opened.tree), false);
    assert.equal(opened.pan.config.enabled, true, 'back to live');
  } finally { await unmount(opened.tree); }
});

test('after a moment with no face: "Point the camera at a face"', async () => {
  const opened = await openStudio();
  try {
    assert.doesNotMatch(words(opened.tree), /Point the camera at a face/);
    await act(async () => { opened.screen.calls.timers.forEach((run, index) => { if (!opened.screen.calls.clearedTimers.has(index + 1)) run(); }); });
    assert.match(words(opened.tree), /Point the camera at a face 👀/);
    await seeFace(opened);
    assert.doesNotMatch(words(opened.tree), /Point the camera at a face/);
  } finally { await unmount(opened.tree); }
});

test('a poster that fails: banner off, "Couldn\'t make your poster", back to live and everything works again', async () => {
  const opened = await openStudio();
  try {
    await seeFace(opened);
    const capture = holdCapture(opened);
    const { done: pressing } = await pressShutter(opened);
    await act(async () => { capture.fail(new Error('Could not read the photo')); await pressing; });
    assert.deepEqual(opened.screen.calls.toasts, [["Couldn't make your poster. Try again."]]);
    assert.equal(banner(opened.tree), false);
    assert.equal(opened.cam.props.active, true);
    assert.equal(opened.pan.config.enabled, true);
    await swipe(opened, -120);
    assert.equal(shown(opened).character, 'getaway-driver');
    assert.equal(iconButton(opened.tree, 'Flip camera').props.disabled, false);
  } finally { await unmount(opened.tree); }
});

test('holding the shutter says videos are coming and takes nothing', async () => {
  const opened = await openStudio();
  try {
    await seeFace(opened);
    await act(async () => shutter(opened.tree).props.onLongPress());
    assert.deepEqual(opened.screen.calls.toasts, [['Main Character videos are coming soon 🎬']]);
    assert.equal(opened.cam.captures.length, 0);
  } finally { await unmount(opened.tree); }
});

test('the finished poster: Share and Save hand over the clean poster; My story and Send open Send to…; Take another', async () => {
  const opened = await openStudio();
  try {
    await seeFace(opened);
    const { done: pressing } = await pressShutter(opened);
    await act(async () => { await pressing; });
    const share = byLabel(opened.tree, 'Bouncy', 'Share your poster');
    await act(async () => share.props.onPress());
    assert.deepEqual(opened.out.shared, [['file:///poster.jpg', 'photo']], 'lib/shareOut.ts adds the logo, never this screen');

    await act(async () => byLabel(opened.tree, 'Bouncy', 'Save to Photos').props.onPress());
    assert.deepEqual(opened.out.saved, [['file:///poster.jpg', 'photo']]);
    assert.deepEqual(opened.screen.calls.toasts.at(-1), ['Saved to Photos ✅']);
    opened.out.saveAnswer = 'no-permission';
    await act(async () => byLabel(opened.tree, 'Bouncy', 'Save to Photos').props.onPress());
    assert.deepEqual(opened.screen.calls.toasts.at(-1), ['Peekaboo needs permission to save to Photos']);

    await act(async () => byLabel(opened.tree, 'Bouncy', 'Post to my story').props.onPress());
    await act(async () => byLabel(opened.tree, 'Bouncy', 'Send to a friend').props.onPress());
    assert.deepEqual(JSON.parse(JSON.stringify(opened.screen.calls.routes)), [
      ['push', { pathname: '/share', params: { uri: 'file:///poster.jpg' } }],
      ['push', { pathname: '/share', params: { uri: 'file:///poster.jpg', pick: 'friends' } }],
    ]);

    await act(async () => byLabel(opened.tree, 'Pressable', 'Take another poster').props.onPress());
    assert.equal(opened.tree.root.findAllByType('ExpoImage').length, 0);
    assert.equal(banner(opened.tree), false);
    assert.equal(opened.cam.props.active, true);
    assert.equal(opened.pan.config.enabled, true);
    await swipe(opened, -120);
    assert.equal(shown(opened).character, 'getaway-driver');
  } finally { await unmount(opened.tree); }
});

test('a share sheet that fails leaves the button usable; sharing that is not possible says so', async () => {
  const opened = await openStudio();
  try {
    await seeFace(opened);
    const { done: pressing } = await pressShutter(opened);
    await act(async () => { await pressing; });
    opened.out.shareAnswer = 'not-possible';
    await act(async () => byLabel(opened.tree, 'Bouncy', 'Share your poster').props.onPress());
    assert.match(opened.screen.calls.toasts.at(-1)[0], /Couldn't open sharing/);
    assert.equal(byLabel(opened.tree, 'Bouncy', 'Share your poster').props.disabled, false);
  } finally { await unmount(opened.tree); }
});

test('the small Peekaboo logo is on the live poster and on the finished one, at lib/watermark.ts\'s spot', async () => {
  const opened = await openStudio();
  const logo = () => opened.tree.root.findAll((node) => node.type === 'View' && node.props.pointerEvents === 'none' && node.findAllByType('Image').length === 1);
  try {
    const live = logo();
    assert.equal(live.length, 1);
    const spot = watermark.watermarkRect(390, 844);
    const style = Object.assign({}, ...[].concat(live[0].props.style));
    assert.equal(style.left, spot.x);
    assert.equal(style.top, spot.y);
    assert.equal(style.width, spot.width);
    assert.equal(style.opacity, watermark.WATERMARK.opacity);
    assert.equal(live[0].props.accessible, false);

    await seeFace(opened);
    const { done: pressing } = await pressShutter(opened);
    await act(async () => { await pressing; });
    // The finished poster's box: the logo goes on once its size is known, on the poster's own corner.
    const box = opened.tree.root.findAll((node) => node.type === 'View' && typeof node.props.onLayout === 'function')[0];
    await act(async () => box.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 358, height: 600 } } }));
    const done = logo();
    assert.equal(done.length, 1);
    const scale = Math.min(358 / 1080, 600 / 1920);
    const shownW = 1080 * scale;
    const shownH = 1920 * scale;
    const onPoster = watermark.watermarkRect(shownW, shownH);
    const finished = Object.assign({}, ...[].concat(done[0].props.style));
    assert.ok(Math.abs(finished.left - ((358 - shownW) / 2 + onPoster.x)) < 1e-9);
    assert.ok(Math.abs(finished.top - ((600 - shownH) / 2 + onPoster.y)) < 1e-9);
  } finally { await unmount(opened.tree); }
});

test('while a live 🔴 has the camera: no camera at all, the screen lets go of it, and gets it back after', async () => {
  const opened = await openStudio();
  try {
    assert.equal(opened.tree.root.findAllByType('MainCharacterCamera').length, 1);
    await act(async () => { opened.live.holdCameraForLive(); });
    assert.equal(opened.tree.root.findAllByType('MainCharacterCamera').length, 0);
    assert.equal(opened.cam.mounted, 0);
    assert.equal(opened.live.calls.released, 1, 'markCameraReleased once the camera has gone');
    assert.match(words(opened.tree), /busy with a live/);
    assert.equal(shutter(opened.tree).props.disabled, true);
    await act(async () => { opened.live.releaseCameraFromLive(); });
    assert.equal(opened.tree.root.findAllByType('MainCharacterCamera').length, 1);
  } finally { await unmount(opened.tree); }
});

test('another screen on top (Send to…) stops the camera', async () => {
  const opened = await openStudio({ focused: false });
  try {
    assert.equal(opened.cam.props.active, false);
    assert.equal(shutter(opened.tree).props.disabled, true);
  } finally { await unmount(opened.tree); }
});

test('closing while the poster is made throws it away', async () => {
  const opened = await openStudio();
  try {
    await seeFace(opened);
    const capture = holdCapture(opened);
    const { done: pressing } = await pressShutter(opened);
    await act(async () => iconButton(opened.tree, 'Close Main Character Mode').props.onPress());
    assert.deepEqual(opened.screen.calls.routes, [['back']]);
    await act(async () => { capture.finish('file:///poster.jpg'); await pressing; });
    assert.equal(opened.tree.root.findAllByType('ExpoImage').length, 0);
  } finally { await unmount(opened.tree); }
});

test('the last character and scene are remembered and used next time; nothing is read before that', async () => {
  const opened = await openStudio({ stored: { 'mc:last': JSON.stringify({ character: 'getaway-driver', scene: 'neon-street', picked: true }) } });
  try {
    assert.deepEqual(shown(opened), { character: 'getaway-driver', scene: 'neon-street' }, 'last time\'s character and picked scene');
    // Before the remembered one was known, the camera was given no character (so the wrong one isn't read first).
    assert.equal(opened.cam.renders[0].character, null);
    // A scene picked last time only holds until the first swipe: then each character brings its own again.
    await swipe(opened, -120);
    assert.deepEqual(shown(opened), { character: 'beach-hustler', scene: 'beach-drive' });
    assert.deepEqual(lastSaved(opened), { character: 'beach-hustler', scene: 'beach-drive', picked: false });
  } finally { await unmount(opened.tree); }
  // Something odd remembered: start on the first character.
  const odd = await openStudio({ stored: { 'mc:last': '{not json' } });
  try {
    assert.deepEqual(shown(odd), { character: 'street-boss', scene: 'neon-street' });
  } finally { await unmount(odd.tree); }
  // A character that is gone now: the first one.
  const gone = await openStudio({ stored: { 'mc:last': JSON.stringify({ character: 'old-one', scene: 'old-scene', picked: false }) } });
  try {
    assert.deepEqual(shown(gone), { character: 'street-boss', scene: 'neon-street' });
  } finally { await unmount(gone.tree); }
});

test('one 🌴 tap is not for ever: next visit the picked scene shows first, then each character brings its own scene again', async () => {
  const first = await openStudio();
  let saved;
  try {
    const palm = () => byLabel(first.tree, 'Bouncy', 'Next scene');
    await act(async () => palm().props.onPress());
    await act(async () => palm().props.onPress());
    assert.deepEqual(shown(first), { character: 'street-boss', scene: 'beach-drive' });
    // This visit: the picked scene stays on every swipe.
    await swipe(first, -120);
    assert.deepEqual(shown(first), { character: 'getaway-driver', scene: 'beach-drive' });
    await swipe(first, 120);
    saved = lastSaved(first);
    assert.deepEqual(saved, { character: 'street-boss', scene: 'beach-drive', picked: true });
  } finally { await unmount(first.tree); }

  const next = await openStudio({ stored: { 'mc:last': JSON.stringify(saved) } });
  try {
    assert.deepEqual(shown(next), { character: 'street-boss', scene: 'beach-drive' }, 'opens on last time\'s scene');
    await swipe(next, -120);
    assert.deepEqual(shown(next), { character: 'getaway-driver', scene: 'coast-highway' }, 'its own scene again');
    await swipe(next, -120);
    assert.deepEqual(shown(next), { character: 'beach-hustler', scene: 'beach-drive' });
    await swipe(next, -120);
    assert.deepEqual(shown(next), { character: 'street-boss', scene: 'neon-street' });
    assert.deepEqual(lastSaved(next), { character: 'street-boss', scene: 'neon-street', picked: false });
    // A new 🌴 tap on this visit stays again.
    await act(async () => byLabel(next.tree, 'Bouncy', 'Next scene').props.onPress());
    await swipe(next, -120);
    assert.deepEqual(shown(next), { character: 'getaway-driver', scene: 'coast-highway' });
    await swipe(next, -120);
    assert.deepEqual(shown(next), { character: 'beach-hustler', scene: 'coast-highway' });
  } finally { await unmount(next.tree); }
});

test('nothing remembered yet: the first character stays when online art arrives in front of it a moment later', async () => {
  const opened = await openStudio();
  try {
    assert.deepEqual(shown(opened), { character: 'street-boss', scene: 'neon-street' });
    // The library finishes an online character: it goes first in the list.
    const ONLINE = character('disco-queen', 'Disco Queen', null, 'online');
    opened.library.value = { characters: [ONLINE, BOSS, DRIVER, HUSTLER], scenes: [NEON, COAST, BEACH], checking: false };
    await seeFace(opened);                                            // anything that draws the screen again
    assert.deepEqual(shown(opened), { character: 'street-boss', scene: 'neon-street' }, 'the poster does not swap by itself');
    assert.equal(lastSaved(opened).character, 'street-boss');
    // The new one is right before it: one swipe right.
    await swipe(opened, 120);
    assert.deepEqual(shown(opened), { character: 'disco-queen', scene: 'neon-street' });
  } finally { await unmount(opened.tree); }
});

test('a phone storage that doesn\'t answer in time: start on the first character, and never write over what is saved', async () => {
  const opened = await openStudio({ slowKeys: ['mc:last', 'mc:hints'] });
  try {
    assert.equal(shutter(opened.tree).props.disabled, true, 'not ready before the wait is over');
    await runTimers(opened);
    assert.deepEqual(shown(opened), { character: 'street-boss', scene: 'neon-street' });
    assert.equal(shutter(opened.tree).props.disabled, false);
    await swipe(opened, -120);
    assert.deepEqual(shown(opened), { character: 'getaway-driver', scene: 'coast-highway' });
    // Nothing was written: not the pick, and not the hint count (it would start again from 0).
    assert.deepEqual(opened.writes, []);
    assert.doesNotMatch(words(opened.tree), /Swipe ← →/);
  } finally { await unmount(opened.tree); }
});

test('after a live hands the camera back, the face counts as gone until the new camera sees one', async () => {
  const opened = await openStudio();
  try {
    await seeFace(opened);
    await act(async () => { opened.live.holdCameraForLive(); });
    await act(async () => { opened.live.releaseCameraFromLive(); });
    assert.equal(opened.tree.root.findAllByType('MainCharacterCamera').length, 1);
    // The new camera hasn't seen a face: no flash, no buzz, no banner, nothing made – the "look at the camera" words.
    await pressShutter(opened);
    assert.equal(opened.cam.captures.length, 0);
    assert.equal(banner(opened.tree), false);
    assert.equal(opened.haptics.includes('impact:heavy'), false);
    assert.deepEqual(opened.screen.calls.toasts, [[NO_FACE_WORDS]]);
    // After a moment: "Point the camera at a face".
    await runTimers(opened);
    assert.match(words(opened.tree), /Point the camera at a face 👀/);
    // The new camera sees a face: the shutter works again.
    await seeFace(opened);
    const { done: pressing } = await pressShutter(opened);
    await act(async () => { await pressing; });
    assert.equal(opened.cam.captures.length, 1);
  } finally { await unmount(opened.tree); }
});

test('VoiceOver: the screen is an adjustable "Character" element; swiping up or down on it changes the character', async () => {
  const opened = await openStudio();
  const adjustable = () => opened.tree.root.findAll((node) => node.type === 'View' && node.props.accessibilityRole === 'adjustable')[0];
  const act11y = (actionName) => act(async () => adjustable().props.onAccessibilityAction({ nativeEvent: { actionName } }));
  try {
    assert.equal(adjustable().props.accessible, true);
    assert.equal(adjustable().props.accessibilityLabel, 'Character');
    assert.equal(adjustable().props.accessibilityValue.text, 'Street Boss');
    assert.match(adjustable().props.accessibilityHint, /Swipe up or down/);
    assert.deepEqual(Array.from(adjustable().props.accessibilityActions, (action) => action.name), ['increment', 'decrement']);
    await act11y('increment');
    assert.deepEqual(shown(opened), { character: 'getaway-driver', scene: 'coast-highway' });
    assert.equal(adjustable().props.accessibilityValue.text, 'Getaway Driver', 'VoiceOver reads the new name');
    await act11y('decrement');
    await act11y('decrement');
    assert.deepEqual(shown(opened), { character: 'beach-hustler', scene: 'beach-drive' }, 'round and round');
    await act11y('activate');
    assert.equal(shown(opened).character, 'beach-hustler', 'other actions do nothing');
    // While the poster is made: not there for VoiceOver, and it changes nothing.
    await seeFace(opened);
    holdCapture(opened);
    await pressShutter(opened);
    assert.equal(adjustable().props.accessible, false);
    await act11y('increment');
    assert.equal(shown(opened).character, 'beach-hustler');
  } finally { await unmount(opened.tree); }
});

test('the finished poster: the close button has room of its own above the poster (the phone\'s top edge + 52)', async () => {
  const insets = { top: 59, bottom: 34, left: 0, right: 0 };
  const flatten = (style) => Object.assign({}, ...[].concat(style).flat(Infinity).filter(Boolean));
  const realSafeEdge = loadScreen('src/components/SafeEdge.tsx', {
    'react-native': { View: host('View'), StyleSheet: { create: (value) => value, absoluteFill: {}, flatten } },
    'react-native-safe-area-context': { useSafeAreaInsets: () => insets },
  }).exports;
  const opened = await openStudio({ safeEdge: realSafeEdge });
  try {
    await seeFace(opened);
    const { done: pressing } = await pressShutter(opened);
    await act(async () => { await pressing; });
    const tops = opened.tree.root.findAll((node) => node.type === 'View' && typeof flatten(node.props.style).paddingTop === 'number'
      && node.findAll((child) => child.type === 'IconButton' && child.props.label === 'Close Main Character Mode').length === 0
      && node.props.children === undefined);
    const room = tops.map((node) => flatten(node.props.style)).find((style) => style.paddingTop > insets.top);
    assert.ok(room, 'the space above the poster');
    assert.equal(room.paddingTop, insets.top + 52);
    assert.equal(room.height, undefined, 'no fixed height that the top edge would swallow');
    // The close button sits from the top edge down 38 points: all of it above the poster.
    const close = iconButton(opened.tree, 'Close Main Character Mode');
    assert.ok(insets.top + close.props.size <= room.paddingTop);
  } finally { await unmount(opened.tree); }
});

test('the swipe hint shows on the first 3 visits only', async () => {
  const hint = /Swipe ← → for a new character · 🌴 for a new scene/;
  const first = await openStudio();
  try {
    assert.match(words(first.tree), hint);
    assert.deepEqual(first.writes.filter(([key]) => key === 'mc:hints'), [['mc:hints', '1']]);
    await swipe(first, -120);
    assert.doesNotMatch(words(first.tree), hint, 'gone after the first swipe');
  } finally { await unmount(first.tree); }
  const third = await openStudio({ stored: { 'mc:hints': '2' } });
  try {
    assert.match(words(third.tree), hint);
    assert.deepEqual(third.writes.filter(([key]) => key === 'mc:hints'), [['mc:hints', '3']]);
  } finally { await unmount(third.tree); }
  const fourth = await openStudio({ stored: { 'mc:hints': '3' } });
  try {
    assert.doesNotMatch(words(fourth.tree), hint);
    assert.deepEqual(fourth.writes.filter(([key]) => key === 'mc:hints'), []);
  } finally { await unmount(fourth.tree); }
});

test('the FULL/LITE pill is only on the testing channel and switches the camera to the lite look', async () => {
  const store = await openStudio({ channel: 'production' });
  try {
    assert.doesNotMatch(words(store.tree), /FULL|LITE/);
  } finally { await unmount(store.tree); }
  const testing = await openStudio({ channel: 'testing' });
  try {
    assert.match(words(testing.tree), /FULL/);
    const pill = testing.tree.root.findAll((node) => node.type === 'Pressable' && /look/.test(node.props.accessibilityLabel ?? ''))[0];
    await act(async () => pill.props.onPress());
    assert.equal(testing.cam.props.forceLite, true);
    assert.match(words(testing.tree), /LITE/);
  } finally { await unmount(testing.tree); }
});

test('no camera permission: no camera, and a button to allow it (or open Settings)', async () => {
  const ask = await openStudio({ permission: { granted: false, canAskAgain: true } });
  try {
    assert.equal(ask.tree.root.findAllByType('MainCharacterCamera').length, 0);
    const allow = ask.tree.root.findAll((node) => node.type === 'Button' && node.props.title === 'Allow camera')[0];
    await act(async () => allow.props.onPress());
    assert.equal(ask.permissionAsks.length, 1);
  } finally { await unmount(ask.tree); }
  const settings = await openStudio({ permission: { granted: false, canAskAgain: false } });
  try {
    const open = settings.tree.root.findAll((node) => node.type === 'Button' && node.props.title === 'Open Settings')[0];
    await act(async () => open.props.onPress());
    assert.equal(settings.settingsOpened.length, 1);
  } finally { await unmount(settings.tree); }
});

test('a spinner while the first pictures are read, and a message when there are no characters at all', async () => {
  const opened = await openStudio();
  try {
    await act(async () => { opened.cam.props.onLoading(true); });
    assert.equal(opened.tree.root.findAllByType('ActivityIndicator').length, 1);
    assert.equal(shutter(opened.tree).props.disabled, true);
    await act(async () => { opened.cam.props.onLoading(false); });
    assert.equal(opened.tree.root.findAllByType('ActivityIndicator').length, 0);
  } finally { await unmount(opened.tree); }
  const empty = await openStudio({ characters: [], scenes: [] });
  try {
    assert.match(words(empty.tree), /No characters yet/);
    assert.equal(empty.cam.props.character, null);
  } finally { await unmount(empty.tree); }
});

test('the logo piece places itself on the shown area and stays out of the way', () => {
  const { ScreenWordmark } = wordmarkFile;
  let tree;
  const renderer = require('react-test-renderer');
  renderer.act(() => { tree = renderer.create(React.createElement(ScreenWordmark, { area: { x: 10, y: 20, width: 300, height: 600 } })); });
  const spot = watermark.watermarkRect(300, 600);
  const holder = tree.root.findByType('View');
  const style = Object.assign({}, ...[].concat(holder.props.style));
  assert.deepEqual([style.left, style.top, style.width, style.height], [10 + spot.x, 20 + spot.y, spot.width, spot.height]);
  assert.equal(holder.props.pointerEvents, 'none');
  assert.equal(tree.root.findByType('Image').props.source, 7);
  // No size yet (or a broken one): nothing at all.
  renderer.act(() => { tree.update(React.createElement(ScreenWordmark, { area: { x: 0, y: 0, width: 0, height: 600 } })); });
  assert.equal(tree.toJSON(), null);
  renderer.act(() => { tree.update(React.createElement(ScreenWordmark, { area: { x: NaN, y: 0, width: 300, height: 600 } })); });
  assert.equal(tree.toJSON(), null);
  renderer.act(() => tree.unmount());
});

// The banner (src/components/mainCharacter/MissionPassed.tsx): only the words from config.ts, the Bungee letters
// once they're in (the phone's own heavy letters until then), nothing to tap, a happy buzz as the reward pops,
// and it fades by itself at MISSION_SHOW_MS.
test('the banner shows the words from config.ts, can\'t be tapped, buzzes once, and fades by itself', async () => {
  const fonts = { loaded: false, asked: [] };
  const buzzes = [];
  const fades = [];
  const useShared = (initial) => React.useRef({ value: initial, get() { return this.value; }, set(next) { this.value = next; } }).current;
  const file = loadScreen('src/components/mainCharacter/MissionPassed.tsx', {
    '@expo-google-fonts/bungee/400Regular': { Bungee_400Regular: 'bungee-file' },
    'expo-font': { useFonts: (map) => { fonts.asked.push(Object.keys(map)); return [fonts.loaded]; } },
    'expo-haptics': { notificationAsync: async (kind) => { buzzes.push(kind); }, NotificationFeedbackType: { Success: 'success' } },
    'expo-linear-gradient': { LinearGradient: host('LinearGradient') },
    'react-native': { ...loadScreen('src/lib/mainCharacter/config.ts').modules['react-native'], useWindowDimensions: () => ({ width: 390, height: 844 }) },
    'react-native-reanimated': {
      __esModule: true,
      default: { View: host('AnimatedView') },
      Easing: { out: (curve) => curve, cubic: 'cubic' },
      useSharedValue: useShared,
      useAnimatedStyle: (callback) => callback(),
      withDelay: (ms, value) => { if (value && value.fadeTo === 0) fades.push(ms); return value; },
      withSequence: (...values) => values.at(-1),
      withSpring: (value) => value,
      withTiming: (value) => (value === 0 ? { fadeTo: 0 } : value),
    },
    '@/lib/mainCharacter/config': { ...config, MISSION_TITLE: 'QA TITLE', MISSION_REWARD: '+QA' },
    '@/theme': theme,
  });
  const { MissionPassed } = file.exports;
  const renderer = require('react-test-renderer');
  let tree;
  await act(async () => { tree = renderer.create(React.createElement(MissionPassed, { playing: false })); });
  try {
    assert.equal(tree.toJSON(), null, 'nothing until the press');
    assert.deepEqual(fonts.asked[0], ['Bungee_400Regular'], 'the letters load before the first press');
    await act(async () => { tree.update(React.createElement(MissionPassed, { playing: true })); });
    const texts = tree.root.findAllByType('Text');
    const lines = [...new Set(texts.map(textOf))];
    assert.deepEqual(lines, ['QA TITLE', '+QA'], 'only the words from config.ts');
    // Each line: 4 dark copies for the outline, then the coloured words on top.
    assert.equal(texts.length, 10);
    const style = (node) => Object.assign({}, ...[].concat(node.props.style).flat(Infinity).filter(Boolean));
    assert.equal(style(texts[4]).color, theme.colors.white);
    assert.equal(style(texts[9]).color, theme.colors.yellow);
    assert.equal(style(texts[0]).color, '#1E1437');
    assert.equal(style(texts[4]).fontWeight, '900', "the phone's own heavy letters until Bungee is in");
    assert.ok(texts.every((node) => node.props.numberOfLines === 1 && node.props.adjustsFontSizeToFit === true));
    const whole = tree.root.findAllByType('AnimatedView')[0];
    assert.equal(whole.props.pointerEvents, 'none');
    assert.deepEqual(Array.from(tree.root.findByType('LinearGradient').props.colors), [theme.colors.pink, theme.colors.purple]);
    assert.deepEqual(fades, [config.MISSION_SHOW_MS], 'fades out by itself at MISSION_SHOW_MS');
    // The happy buzz as the reward pops (a timer at 420 ms).
    assert.deepEqual(buzzes, []);
    await act(async () => { file.calls.timers.forEach((run) => run()); });
    assert.deepEqual(buzzes, ['success']);

    fonts.loaded = true;
    await act(async () => { tree.update(React.createElement(MissionPassed, { playing: true })); });
    assert.equal(style(tree.root.findAllByType('Text')[4]).fontFamily, 'Bungee_400Regular');
    // Off again (Take another): gone at once.
    await act(async () => { tree.update(React.createElement(MissionPassed, { playing: false })); });
    assert.equal(tree.toJSON(), null);
  } finally { await act(async () => tree.unmount()); }
});
