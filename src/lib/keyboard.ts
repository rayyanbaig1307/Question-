import { useEffect, useRef, useState } from 'react';
import { Dimensions, Keyboard, LayoutAnimation, Platform, type KeyboardEvent } from 'react-native';

// How much of the screen the keyboard covers, from the bottom up.
// An iPhone keyboard always sits at the bottom, so its height is the answer. Only when the phone reports no
// height do we work it out from where the keyboard starts (screenY). We never rely on screenY alone: with
// "Prefer Cross-Fade Transitions" (Settings → Accessibility → Motion) iOS reports it as 0, and then React
// Native's own KeyboardAvoidingView decides the keyboard covers nothing – the message box stays hidden.
export function keyboardOverlap(end: { height: number; screenY: number } | undefined, windowHeight: number): number {
  if (!end) return 0;
  if (end.height > 0) return Math.round(end.height);
  if (end.screenY > 0 && end.screenY < windowHeight) return Math.round(windowHeight - end.screenY);
  return 0;
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
