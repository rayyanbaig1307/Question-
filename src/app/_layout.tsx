import { Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { OverlayProvider } from '@/components/Overlays';
import { SetupNeeded } from '@/components/SetupNeeded';
import { isSupabaseConfigured } from '@/lib/supabase';
import { colors, navigationTheme } from '@/theme';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  useEffect(() => {
    SplashScreen.hideAsync();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <ThemeProvider value={navigationTheme}>
        <OverlayProvider>
          <StatusBar style="light" />
          {isSupabaseConfigured ? (
            <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
          ) : (
            <SetupNeeded />
          )}
        </OverlayProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
