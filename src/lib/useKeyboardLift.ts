import { useEffect, useRef, useState, type ComponentRef, type RefObject } from 'react';
import { Dimensions, Keyboard, LayoutAnimation, Platform, type KeyboardEvent, type View } from 'react-native';

// What a <View ref={…}> gives you.
export type KeyboardBox = ComponentRef<typeof View>;

// ---------------------------------------------------------------------------
// Keeps the bottom of a box (the chat's message box) above the keyboard.
//
// React Native's own KeyboardAvoidingView works out the overlap from where the box sits inside its parent,
// which goes wrong as soon as the box is inside another box, and on iPhones with "Prefer Cross-Fade
// Transitions" switched on. This asks the phone where the box really is on the screen instead.
//
//   const box = useRef<KeyboardBox>(null);
//   const lift = useKeyboardLift(box, insets.bottom);
//   <View ref={box} style={{ flex: 1, paddingBottom: lift }}>…</View>
//
// `bottomInset` is the space the box already keeps free at the bottom for the home bar; the keyboard covers
// that space too, so it's taken off (no gap between the message box and the keyboard).
// ---------------------------------------------------------------------------

// How much space the box needs at the bottom so its bottom edge (minus the home-bar space) sits on the keyboard.
export function keyboardOverlap(
  box: { y: number; height: number },
  keyboard: { screenY: number; height: number },
  screenHeight: number,
  bottomInset: number,
): number {
  // Where the keyboard's top edge is on the screen (some iPhone settings report 0 here).
  const keyboardTop = keyboard.screenY > 0 ? keyboard.screenY : screenHeight - keyboard.height;
  // The lift is padding inside the box, so the box's outer edge doesn't move with it.
  return Math.max(0, box.y + box.height - keyboardTop - bottomInset);
}

export function useKeyboardLift(box: RefObject<KeyboardBox | null>, bottomInset = 0): number {
  const [lift, setLift] = useState(0);
  const inset = useRef(bottomInset);
  useEffect(() => {
    inset.current = bottomInset;
  }, [bottomInset]);

  useEffect(() => {
    const ios = Platform.OS === 'ios';
    const animate = (event?: KeyboardEvent) => {
      if (!ios) return;
      LayoutAnimation.configureNext({
        duration: event?.duration || 250,
        update: { type: LayoutAnimation.Types.keyboard, duration: event?.duration || 250 },
      });
    };

    const onShow = (event: KeyboardEvent) => {
      const node = box.current;
      if (!node) return;
      node.measureInWindow((_x, y, _width, height) => {
        animate(event);
        setLift(keyboardOverlap({ y, height }, event.endCoordinates, Dimensions.get('window').height, inset.current));
      });
    };
    const onHide = (event: KeyboardEvent) => {
      animate(event);
      setLift(0);
    };

    // iPhones say before the keyboard moves (so the box moves with it); Android only says afterwards. When
    // Android already made the screen smaller for the keyboard, the overlap is 0 and nothing changes.
    const subscriptions = ios
      ? [
          Keyboard.addListener('keyboardWillShow', onShow),
          Keyboard.addListener('keyboardWillChangeFrame', onShow),
          Keyboard.addListener('keyboardWillHide', onHide),
        ]
      : [Keyboard.addListener('keyboardDidShow', onShow), Keyboard.addListener('keyboardDidHide', onHide)];
    return () => subscriptions.forEach((subscription) => subscription.remove());
  }, [box]);

  return lift;
}
