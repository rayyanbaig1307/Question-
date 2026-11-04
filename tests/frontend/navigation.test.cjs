const test = require('node:test');
const assert = require('node:assert/strict');
const { React, renderer, loadScreen, renderScreen, act, unmount } = require('./harness.cjs');

test('switching directly between two signed-in users discards the previous navigation and private screen state', async () => {
  let user = 'alice', nextInstance = 0;
  function Stack(props) {
    const [instance] = React.useState(() => ++nextInstance);
    return React.createElement('Stack', { instance }, props.children);
  }
  Stack.Protected = props => props.guard ? props.children : null;
  Stack.Screen = () => null;
  const screen = loadScreen('src/app/_layout.tsx', {
    expo: { reloadAppAsync: async () => {} },
    'expo-router': { Stack, ThemeProvider: props => props.children },
    'expo-splash-screen': { preventAutoHideAsync() {}, hideAsync() {} },
    'expo-status-bar': { StatusBar: () => null },
    'react-native-gesture-handler': { GestureHandlerRootView: props => props.children },
    '@/components/Overlays': { OverlayProvider: props => props.children },
    '@/components/SetupNeeded': { SetupNeeded: () => null },
    '@/lib/appUpdates': { useStayUpToDate() {} },
    '@/lib/auth': { useAuth: () => ({ session: { user: { id: user } }, initializing: false }) },
    '@/lib/supabase': { isSupabaseConfigured: true },
  });
  screen.Component = screen.getBinding('RootNavigator');
  const tree = await renderScreen(screen);
  try {
    const aliceStack = tree.root.findByType('Stack').props.instance;
    user = 'bob';
    await act(() => tree.update(React.createElement(screen.Component)));
    assert.notEqual(tree.root.findByType('Stack').props.instance, aliceStack,
      'a new account must not inherit the previous account’s open chats, forms, or cached component state');
  } finally { await unmount(tree); }
});

test('account changes also discard open menus and their pending actions', async () => {
  let user = 'alice', nextOverlay = 0;
  function Stack(props) { return React.createElement('Stack', null, props.children); }
  Stack.Protected = props => props.guard ? props.children : null;
  Stack.Screen = () => null;
  function OverlayProvider(props) { const [instance] = React.useState(() => ++nextOverlay); return React.createElement('AccountOverlay', { instance }, props.children); }
  const screen = loadScreen('src/app/_layout.tsx', {
    expo: { reloadAppAsync: async () => {} },
    'expo-router': { Stack, ThemeProvider: props => props.children },
    'expo-splash-screen': { preventAutoHideAsync() {}, hideAsync() {} },
    'expo-status-bar': { StatusBar: () => null },
    'react-native-gesture-handler': { GestureHandlerRootView: props => props.children },
    '@/components/Overlays': { OverlayProvider }, '@/components/SetupNeeded': { SetupNeeded: () => null },
    '@/lib/appUpdates': { useStayUpToDate() {} },
    '@/lib/auth': { AuthProvider: props => props.children, useAuth: () => ({ session: { user: { id: user } }, userId: user, initializing: false }) },
    '@/lib/supabase': { isSupabaseConfigured: true },
  });
  const tree = await renderScreen(screen);
  try {
    const old = tree.root.findByType('AccountOverlay').props.instance;
    user = 'bob'; await act(() => tree.update(React.createElement(screen.Component)));
    assert.notEqual(tree.root.findByType('AccountOverlay').props.instance, old, 'menus must not carry actions from the previous login into another account');
  } finally { await unmount(tree); }
});

test('no screen is shown (and the splash screen stays up) until the saved login has loaded', async () => {
  // While the saved login loads, the app doesn't know yet whether you are logged in. Showing the screens
  // then would send a link like /settings to /welcome and the app would land on home instead.
  let initializing = true;
  let hidden = 0;
  function Stack(props) { return React.createElement('Stack', null, props.children); }
  Stack.Protected = props => props.guard ? React.createElement('Protected', { guard: props.guard }, props.children) : null;
  Stack.Screen = () => null;
  const screen = loadScreen('src/app/_layout.tsx', {
    expo: { reloadAppAsync: async () => {} },
    'expo-router': { Stack, ThemeProvider: props => props.children },
    'expo-splash-screen': { preventAutoHideAsync() {}, hideAsync: async () => { hidden++; } },
    'expo-status-bar': { StatusBar: () => null },
    'react-native-gesture-handler': { GestureHandlerRootView: props => props.children },
    '@/components/Overlays': { OverlayProvider: props => props.children },
    '@/components/SetupNeeded': { SetupNeeded: () => null },
    '@/lib/appUpdates': { useStayUpToDate() {} },
    '@/lib/auth': { useAuth: () => ({ session: initializing ? null : { user: { id: 'alice' } }, initializing }) },
    '@/lib/supabase': { isSupabaseConfigured: true },
  });
  screen.Component = screen.getBinding('RootNavigator');
  const tree = await renderScreen(screen);
  try {
    assert.equal(tree.root.findAllByType('Stack').length, 0, 'no screens (and no redirect to /welcome) while the login loads');
    assert.equal(hidden, 0, 'the splash screen stays up meanwhile');
    initializing = false;
    await act(() => tree.update(React.createElement(screen.Component)));
    assert.equal(tree.root.findAllByType('Stack').length, 1, 'the screens appear once the login has loaded');
    assert.equal(hidden, 1, 'and the splash screen goes away');
  } finally { await unmount(tree); }
});
