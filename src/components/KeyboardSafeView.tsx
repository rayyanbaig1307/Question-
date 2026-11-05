import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';

import { useKeyboardHeight } from '@/lib/keyboard';

type Props = {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  // Space the content already keeps free at the bottom (like the phone's home-bar area under a message box).
  // It's taken off the keyboard's height, so there's no gap between the box and the keyboard.
  bottomInset?: number;
  // What other phones (Android) use, unchanged from before: KeyboardAvoidingView with this behaviour.
  androidBehavior?: 'padding' | 'height' | 'position';
  pointerEvents?: ViewProps['pointerEvents'];
};

// Keeps a message box (or a form at the bottom) above the keyboard.
// On an iPhone it moves the content up by the keyboard's own height. React Native's KeyboardAvoidingView
// works it out from where the keyboard starts on screen instead, and some iPhones report that as 0 (for
// example with "Prefer Cross-Fade Transitions" on) – then the message box stayed hidden behind the keyboard.
export function KeyboardSafeView({ children, style, bottomInset = 0, androidBehavior, pointerEvents }: Props) {
  if (Platform.OS !== 'ios') {
    return (
      <KeyboardAvoidingView style={style} behavior={androidBehavior} keyboardVerticalOffset={-bottomInset} pointerEvents={pointerEvents}>
        {children}
      </KeyboardAvoidingView>
    );
  }
  return (
    <IPhoneKeyboardView style={style} bottomInset={bottomInset} pointerEvents={pointerEvents}>
      {children}
    </IPhoneKeyboardView>
  );
}

function IPhoneKeyboardView({
  children,
  style,
  bottomInset,
  pointerEvents,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  bottomInset: number;
  pointerEvents?: ViewProps['pointerEvents'];
}) {
  const keyboard = useKeyboardHeight();
  const lift = keyboard > 0 ? Math.max(0, keyboard - bottomInset) : 0;
  return (
    <View style={[style, { paddingBottom: lift }]} pointerEvents={pointerEvents}>
      {children}
    </View>
  );
}
