// The Peekaboo+ screen (src/app/(app)/plus.tsx): what it shows for each buy and restore result, the price
// button, and the "a few seconds" note right after buying. The buying itself is tested in
// tests/unit/plus-purchases.test.mjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScreen, renderScreen, act, textOf, unmount, host } = require('./harness.cjs');

const WAITING = "Waiting for a parent to approve. You'll get Peekaboo+ as soon as it's approved.";

function plusScreen({ buy = async () => 'bought', restore = async () => 'restored', price = async () => '$6.99', plus = false, store = false, server = false } = {}) {
  const state = { plus, store, server, priceCalls: 0, opened: [], managed: 0 };
  const screen = loadScreen('src/app/(app)/plus.tsx', {
    'expo-image': { Image: host('Image') },
    'expo-linear-gradient': { LinearGradient: host('LinearGradient') },
    'react-native-reanimated': {
      __esModule: true,
      default: { View: host('AnimatedView') },
      useAnimatedStyle: () => ({}),
      useSharedValue: () => ({ set() {}, get: () => 0 }),
      withRepeat: (value) => value,
      withSequence: (...values) => values,
      withTiming: (value) => value,
    },
    '../../../assets/images/logo-eyes.png': { __esModule: true, default: 1 },
    '@/components/Bouncy': { Bouncy: host('Bouncy') },
    '@/components/Wordmark': { Wordmark: host('Wordmark') },
    '@/lib/plus': {
      CAN_BUY_PLUS: true,
      MANAGE_SUBSCRIPTION_URL: 'https://apps.apple.com/account/subscriptions',
      WAITING_FOR_PARENT: WAITING,
      buyPlus: buy,
      restorePurchases: restore,
      getPlusPrice: async () => { state.priceCalls++; return price(); },
      usePlus: () => state.plus,
      useStorePlus: () => state.store,
      useServerPlus: () => state.server,
      openManageSubscription: async () => { state.managed++; },
    },
  });
  screen.modules['react-native'].Platform = { OS: 'ios' };
  screen.modules['react-native'].Linking = { openURL: async (url) => { state.opened.push(url); } };
  return { screen, state };
}

const bigButton = (tree) => tree.root.findAllByType('Bouncy')[0];
const restoreLink = (tree) => tree.root.findAllByType('Pressable').find((node) => textOf(node) === 'Restore purchases');
const texts = (tree) => tree.root.findAllByType('Text').map(textOf);
const toasts = (screen) => screen.calls.toasts.map((args) => args[0]);

test('Subscribe shows the App Store price "/month", and a cancelled purchase says nothing', async () => {
  const { screen } = plusScreen({ buy: async () => 'cancelled' });
  const tree = await renderScreen(screen);
  try {
    assert.equal(bigButton(tree).props.accessibilityLabel, 'Subscribe · $6.99/month');
    await act(() => bigButton(tree).props.onPress());
    assert.deepEqual(toasts(screen), []);
    assert.ok(!texts(tree).includes(WAITING));
  } finally { await unmount(tree); }
});

test('a real purchase says welcome', async () => {
  const { screen } = plusScreen({ buy: async () => 'bought' });
  const tree = await renderScreen(screen);
  try {
    await act(() => bigButton(tree).props.onPress());
    assert.deepEqual(toasts(screen), ['Welcome to Peekaboo+ ⭐']);
  } finally { await unmount(tree); }
});

test('Ask to Buy: the screen says it waits for a parent, and never says welcome', async () => {
  const { screen } = plusScreen({ buy: async () => 'pending' });
  const tree = await renderScreen(screen);
  try {
    await act(() => bigButton(tree).props.onPress());
    assert.ok(texts(tree).includes(WAITING), 'the waiting note stays on the screen');
    assert.ok(!toasts(screen).some((text) => text.includes('Welcome')));
  } finally { await unmount(tree); }
});

test('Plus that did not switch on points to Restore purchases, and never says welcome', async () => {
  const { screen } = plusScreen({ buy: async () => 'not-active' });
  const tree = await renderScreen(screen);
  try {
    await act(() => bigButton(tree).props.onPress());
    assert.ok(texts(tree).some((text) => text.includes("hasn't switched on yet") && text.includes('Restore purchases')));
    assert.ok(!toasts(screen).some((text) => text.includes('Welcome')));
  } finally { await unmount(tree); }
});

test('a store problem shows its plain message', async () => {
  const { screen } = plusScreen({ buy: async () => { throw new Error('Purchases are turned off on this iPhone (Screen Time).'); } });
  const tree = await renderScreen(screen);
  try {
    await act(() => bigButton(tree).props.onPress());
    assert.deepEqual(toasts(screen), ['Purchases are turned off on this iPhone (Screen Time).']);
  } finally { await unmount(tree); }
});

test('no monthly price: "Couldn\'t load the price · Retry" asks again', async () => {
  const { screen, state } = plusScreen({ price: async () => null });
  const tree = await renderScreen(screen);
  try {
    assert.equal(bigButton(tree).props.accessibilityLabel, "Couldn't load the price · Retry");
    await act(() => bigButton(tree).props.onPress());
    assert.equal(state.priceCalls, 2);
  } finally { await unmount(tree); }
});

test('Restore purchases: found, not found, or closed', async () => {
  for (const [result, expected] of [
    ['restored', ['Peekaboo+ is back ⭐']],
    ['not-found', ["We didn't find a Peekaboo+ subscription on this Apple Account."]],
    ['cancelled', []],
  ]) {
    const { screen } = plusScreen({ restore: async () => result });
    const tree = await renderScreen(screen);
    try {
      await act(() => restoreLink(tree).props.onPress());
      assert.deepEqual(toasts(screen), expected, result);
    } finally { await unmount(tree); }
  }
});

test('a new member is told a few extras can take a few seconds, until the server knows', async () => {
  const waitNote = (tree) => texts(tree).some((text) => text.includes('can take a few seconds'));
  let fixture = plusScreen({ plus: true, store: true, server: false });
  let tree = await renderScreen(fixture.screen);
  try {
    assert.ok(texts(tree).includes("You're a member ⭐"));
    assert.ok(waitNote(tree));
    assert.equal(bigButton(tree).props.accessibilityLabel, 'Manage subscription');
    await act(() => bigButton(tree).props.onPress());
    assert.equal(fixture.state.managed, 1, "Manage subscription opens Apple's subscriptions (the sheet, or the page)");
  } finally { await unmount(tree); }

  fixture = plusScreen({ plus: true, store: true, server: true });
  tree = await renderScreen(fixture.screen);
  try {
    assert.ok(!waitNote(tree));
  } finally { await unmount(tree); }
});

test('the small print names the Apple Account and where to cancel', async () => {
  const { screen } = plusScreen();
  const tree = await renderScreen(screen);
  try {
    const print = texts(tree).find((text) => text.startsWith('Peekaboo+ is $6.99 per month'));
    assert.ok(print, 'the price is in the small print');
    assert.match(print, /charged to your Apple Account/);
    assert.match(print, /Settings → your name → Subscriptions, at least 24 hours before it renews/);
  } finally { await unmount(tree); }
});
