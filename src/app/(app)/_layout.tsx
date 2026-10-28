import { Stack } from 'expo-router';

import { colors } from '@/theme';

// Every screen you can reach once you're logged in.
export default function AppLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.bg },
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: '800' },
        headerShadowVisible: false,
        headerBackButtonDisplayMode: 'minimal',
      }}>
      <Stack.Screen name="editor" options={{ animation: 'fade', gestureEnabled: false }} />
      <Stack.Screen name="post/[id]" options={{ presentation: 'fullScreenModal', animation: 'fade' }} />
      <Stack.Screen name="snap/[id]" options={{ presentation: 'fullScreenModal', animation: 'fade' }} />
      <Stack.Screen name="camera" options={{ animation: 'slide_from_bottom' }} />
    </Stack>
  );
}
