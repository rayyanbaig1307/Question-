import { useEffect, useRef, useState } from 'react';
import { Dimensions, Keyboard, LayoutAnimation, Platform, type KeyboardEvent } from 'react-native';

// How much of the screen the keyboard covers, from the bottom up.
// It's the keyboard's height. We don't trust where iOS says the keyboard starts (screenY) on its own: with
// "Prefer Cross-Fade Transitions" (Settings → Accessibility → Motion) it reports 0, and React Native's own
// KeyboardAvoidingView then decides the keyboard covers nothing – the message box stayed hidden.
// The one time screenY helps: with a hardware keyboard only a small bar is on screen, so when screenY really is
// on the screen and leaves less than the keyboard's height below it, only that part counts.
export function keyboardOverlap(end: { height: number; screenY: number } | undefined, windowHeight: number): number {
  if (!end) return 0;
  const height = end.height > 0 ? end.height : 0;
  const onScreen = end.screenY > 0 && end.screenY < windowHeight;
  if (!onScreen) return Math.round(height);
  const covered = windowHeight - end.screenY;
  return Math.round(height > 0 ? Math.min(height, covered) : covered);
}

// The keyboard's height while it's open on an iPhone (0 when it's closed, and always 0 on other phones – they
// keep using KeyboardAvoidingView, see components/KeyboardSafeView.tsx). The change is animated together with
// the keyboard.
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  const current = useRef(0);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const move = (next: number, event?: KeyboardEvent) => {
      if (current.current === next) return;
      current.current = next;
      if (event?.duration) {
        try {
          LayoutAnimation.configureNext({ duration: event.duration, update: { type: LayoutAnimation.Types.keyboard } });
        } catch {
          // No animation then – the box still moves.
        }
      }
      setHeight(next);
    };
    const shown = (event: KeyboardEvent) => move(keyboardOverlap(event.endCoordinates, Dimensions.get('window').height), event);
    const hidden = (event?: KeyboardEvent) => move(0, event);
    const subscriptions = [
      Keyboard.addListener('keyboardWillShow', shown),
      Keyboard.addListener('keyboardWillHide', hidden),
      // A second chance in case the "will" message was missed (the "did" one comes when the keyboard has moved).
      Keyboard.addListener('keyboardDidShow', shown),
      Keyboard.addListener('keyboardDidHide', hidden),
    ];
    return () => subscriptions.forEach((subscription) => subscription.remove());
  }, []);
  return height;
}
