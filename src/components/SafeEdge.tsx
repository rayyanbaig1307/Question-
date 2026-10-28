import { StyleSheet, View, type ViewProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// A bar that keeps clear of the clock/notch (top) or the home bar (bottom).
// Used for buttons floating over full-screen photos, the camera and the map.
// Any padding in `style` is added on top of the phone's safe area.
export function SafeEdge({ edge, style, ...rest }: ViewProps & { edge: 'top' | 'bottom' }) {
  const insets = useSafeAreaInsets();
  const flat = StyleSheet.flatten(style) ?? {};
  const key = edge === 'top' ? 'paddingTop' : 'paddingBottom';
  const extra = typeof flat[key] === 'number' ? flat[key] : 0;
  return <View {...rest} style={[style, { [key]: insets[edge] + extra }]} />;
}

// A full screen that keeps clear of both the clock/notch and the home bar.
export function SafeScreen({ style, ...rest }: ViewProps) {
  const insets = useSafeAreaInsets();
  return <View {...rest} style={[style, { paddingTop: insets.top, paddingBottom: insets.bottom }]} />;
}
