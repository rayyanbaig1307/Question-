import { Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { OverlayProvider } from '@/components/Overlays';
import { SetupNeeded } from '@/components/SetupNeeded';
import { AuthProvider, useAuth } from '@/lib/auth';
import { isSupabaseConfigured } from '@/lib/supabase';
import { colors, navigationTheme } from '@/theme';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <ThemeProvider value={navigationTheme}>
        <OverlayProvider>
          <StatusBar style="light" />
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
