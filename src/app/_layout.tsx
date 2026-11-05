import { reloadAppAsync } from 'expo';
import { Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Appearance } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { OverlayProvider } from '@/components/Overlays';
import { SetupNeeded } from '@/components/SetupNeeded';
import { useStayUpToDate } from '@/lib/appUpdates';
import { AuthProvider, useAuth } from '@/lib/auth';
import { isSupabaseConfigured } from '@/lib/supabase';
import { colors, isDark, navigationTheme, phoneScheme, themeChoice } from '@/theme';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  // Switch to a new version as soon as one is out (see lib/appUpdates.ts).
  useStayUpToDate();
  // "Match phone": when the phone switches between light and dark, restart in the new colors.
  useEffect(() => {
    if (themeChoice !== 'system') return;
    const subscription = Appearance.addChangeListener(({ colorScheme }) => {
      if ((colorScheme === 'light' ? 'light' : 'dark') !== phoneScheme) reloadAppAsync().catch(() => {});
    });
    return () => subscription.remove();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <ThemeProvider value={navigationTheme}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        {isSupabaseConfigured ? (
          <AuthProvider>
            <AccountRoot />
          </AuthProvider>
        ) : (
          <OverlayProvider>
            <SetupScreen />
          </OverlayProvider>
        )}
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

function AccountRoot() {
  const { session } = useAuth();
  // Changing accounts also throws away old menus, toasts and their pending actions.
  return (
    <OverlayProvider key={session?.user.id ?? 'signed-out'}>
      <RootNavigator />
    </OverlayProvider>
  );
}

function SetupScreen() {
  useEffect(() => {
    SplashScreen.hideAsync();
  }, []);
  return <SetupNeeded />;
}

// Logged out → welcome / sign up / log in screens.
// Logged in  → the real app (everything inside the "(app)" folder).
function RootNavigator() {
  const { session, initializing } = useAuth();
  const loggedIn = session !== null;

  useEffect(() => {
    if (!initializing) SplashScreen.hideAsync();
  }, [initializing]);

  // Wait for the saved login before showing any screen. Otherwise a link opened at start-up (like /settings,
  // or a tapped notification) is sent to /welcome for a moment and then lands on home. (The splash screen
  // stays up meanwhile.)
  if (initializing) return null;

  return (
    <Stack key={session?.user.id ?? 'signed-out'} screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Protected guard={loggedIn} redirectTo="/welcome">
        <Stack.Screen name="(app)" />
      </Stack.Protected>
      <Stack.Protected guard={!loggedIn} redirectTo="/">
        <Stack.Screen name="welcome" />
        <Stack.Screen name="sign-up" />
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
    </Stack>
  );
}
