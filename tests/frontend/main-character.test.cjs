const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScreen, loadPure, renderScreen, act, button, host, textOf, unmount } = require('./harness.cjs');

// Main Character Mode 🌆, the route (src/app/(app)/main-character.tsx). It only checks the phone can do it:
// - Android, no face tracking (Expo Go, older downloads, the website), or an iPhone on the App Store channel while
//   the mode is still only for the owner's test channel → the "needs the newest Peekaboo app on an iPhone" page
//   with a Back button, and the real screen is never loaded;
// - an iPhone with face tracking on the `testing` channel → the real screen (MainCharacterStudio);
// - if it ever becomes Peekaboo+ only: people we're sure don't have Plus go to the Peekaboo+ page; while Plus is
//   still being checked the screen shows.

const config = loadPure('src/lib/mainCharacter/config.ts');
// The harness's own react-native stand-in (host views, StyleSheet, …), so only Platform changes here.
const harnessReactNative = loadScreen('src/lib/mainCharacter/config.ts').modules['react-native'];

// `os`: Platform.OS. `faceMesh`: this download has face tracking. `channel`: the update channel. `plus`: what the
// Peekaboo+ check says. `configChanges`: switches changed for this test.
function loadRoute({ os = 'ios', faceMesh = true, channel = 'testing', plus = 'no', configChanges = {} } = {}) {
  const loads = { studio: 0 };
  const screen = loadScreen('src/app/(app)/main-character.tsx', {
    'react-native': { ...harnessReactNative, Platform: { OS: os } },
    '@/components/SafeEdge': { SafeScreen: host('SafeScreen'), SafeEdge: host('SafeEdge') },
    '@/lib/faceMesh': { FACE_MESH_AVAILABLE: faceMesh },
    '@/lib/lensDiagnostics': { updateChannel: () => channel },
    '@/lib/mainCharacter/config': { ...config, ...configChanges },
    '@/lib/plus': { usePlusAnswer: () => plus },
    // Counts how often the route takes the screen out of its file (only on downloads with face tracking).
    '@/components/mainCharacter/MainCharacterStudio': {
      get MainCharacterStudio() {
        loads.studio += 1;
        return host('MainCharacterStudio');
      },
    },
  });
  return { screen, loads };
}

async function show(options) {
  const { screen, loads } = loadRoute(options);
  const tree = await renderScreen(screen);
  return { tree, screen, loads };
}

test('an iPhone with face tracking on the testing channel gets the Main Character screen', async () => {
  const { tree, screen, loads } = await show();
  try {
    assert.equal(tree.root.findAllByType('MainCharacterStudio').length, 1);
    assert.equal(loads.studio, 1, 'the screen is loaded once, when the route file loads');
    assert.deepEqual(screen.calls.routes, []);
  } finally { await unmount(tree); }
});

for (const [name, options] of [
  ['Android (even with face tracking and the testing channel)', { os: 'android' }],
  ['the website', { os: 'web' }],
  ['an iPhone download without face tracking (Expo Go, older builds)', { faceMesh: false }],
  ['an iPhone on the App Store channel while the mode is still only for testing', { channel: 'production' }],
  ['an iPhone with no update channel (Expo Go, developing)', { channel: null }],
]) {
  test(`${name} gets the "needs the iPhone app" page with a Back button`, async () => {
    const { tree, screen, loads } = await show(options);
    try {
      assert.equal(tree.root.findAllByType('MainCharacterStudio').length, 0);
      if (options.faceMesh === false) assert.equal(loads.studio, 0, 'without face tracking the screen (Skia, camera) is never loaded');
      const words = tree.root.findAllByType('Text').map(textOf).join(' ');
      assert.match(words, /Main Character Mode needs the newest Peekaboo app on an iPhone\./);
      await act(() => button(tree, 'Back').props.onPress());
      assert.deepEqual(screen.calls.routes, [['back']]);
    } finally { await unmount(tree); }
  });
}

test('Peekaboo+ only (MAIN_CHARACTER_PLUS): without Plus it goes to the Peekaboo+ page; with Plus or still checking, the screen shows', async (t) => {
  await t.test('no Plus', async () => {
    const { tree, screen } = await show({ plus: 'no', configChanges: { MAIN_CHARACTER_PLUS: true } });
    try {
      assert.equal(tree.root.findAllByType('MainCharacterStudio').length, 0);
      assert.deepEqual(screen.calls.routes, [['replace', '/plus']]);
    } finally { await unmount(tree); }
  });
  for (const plus of ['yes', 'checking']) {
    await t.test(plus, async () => {
      const { tree, screen } = await show({ plus, configChanges: { MAIN_CHARACTER_PLUS: true } });
      try {
        assert.equal(tree.root.findAllByType('MainCharacterStudio').length, 1);
        assert.deepEqual(screen.calls.routes, []);
      } finally { await unmount(tree); }
    });
  }
  await t.test('free (the plan): no Plus is fine', async () => {
    const { tree, screen } = await show({ plus: 'no' });
    try {
      assert.equal(tree.root.findAllByType('MainCharacterStudio').length, 1);
      assert.deepEqual(screen.calls.routes, []);
    } finally { await unmount(tree); }
  });
  await t.test('not on this phone: no trip to the Peekaboo+ page either', async () => {
    const { tree, screen } = await show({ os: 'android', plus: 'no', configChanges: { MAIN_CHARACTER_PLUS: true } });
    try {
      assert.deepEqual(screen.calls.routes, []);
    } finally { await unmount(tree); }
  });
});

test('the route file loads nothing that needs the camera or Skia at the top', () => {
  const { readSource } = require('./harness.cjs');
  const source = readSource('src/app/(app)/main-character.tsx');
  const imports = [...source.matchAll(/^import[^;]*from\s+'([^']+)'/gm)].map((match) => match[1]);
  assert.deepEqual(imports.sort(), [
    '@/components/Button', '@/components/SafeEdge', '@/lib/faceMesh', '@/lib/lensDiagnostics',
    '@/lib/mainCharacter/config', '@/lib/plus', '@/theme', 'expo-router', 'react', 'react-native',
  ].sort());
  // The screen itself only through the face-tracking check.
  assert.match(source, /FACE_MESH_AVAILABLE\s*\?\s*\/\/[^\n]*\n\s*require\('@\/components\/mainCharacter\/MainCharacterStudio'\)/);
});
