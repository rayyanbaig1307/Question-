import { StyleSheet, View } from 'react-native';

import { ChatBackground } from '@/components/chat/ChatBackground';
import { themeScene } from '@/theme';

// ---------------------------------------------------------------------------
// ⭐ The moving picture behind the Home and Chat pages for the Peekaboo+ themes, so they look and feel
// like their own place, not just Dark or Light in other colours:
//   Black & Gold → gold dust sparkling in the dark
//   Midnight     → night sky with shooting stars and a drifting moon
//   Sunset       → a dusk sky with twinkling stars and glitter
// It reuses the moving chat backgrounds, stops when the screen isn't showing, and stays still with
// "Reduce Motion" on. Nothing at all on Dark, Light and Match phone.
// ---------------------------------------------------------------------------

// `paused`: keep it still while nobody can see it (the camera page covers it).
export function ThemeScene({ paused = false }: { paused?: boolean }) {
  if (!themeScene) return null;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <ChatBackground id={themeScene} paused={paused} />
    </View>
  );
}
