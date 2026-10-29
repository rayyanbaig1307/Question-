import { reloadAppAsync } from 'expo';
import { Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Appearance } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { OverlayProvider } from '@/components/Overlays';
import { SetupNeeded } from '@/components/SetupNeeded';
import { AuthProvider, useAuth } from '@/lib/auth';
import { isSupabaseConfigured } from '@/lib/supabase';
import { colors, isDark, navigationTheme, phoneScheme, themeChoice } from '@/theme';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
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
        <OverlayProvider>
          <StatusBar style={isDark ? 'light' : 'dark'} />
          {isSupabaseConfigured ? (
            <AuthProvider>
              <RootNavigator />
            </AuthProvider>
          ) : (
            <SetupScreen />
          )}
        </OverlayProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
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

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
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
