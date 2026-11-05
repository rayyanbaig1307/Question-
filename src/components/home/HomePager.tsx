import type { ComponentType, ReactNode, RefAttributes } from 'react';
import { Animated, type StyleProp, type ViewStyle } from 'react-native';
import PagerView from 'react-native-pager-view';

// The settings the home screen gives the pager. The phone pager (here) and the web pager (HomePager.web.tsx)
// both take exactly this list, so the type check notices if the home screen starts sending something new.
export type HomePagerProps = {
  style?: StyleProp<ViewStyle>;
  initialPage?: number;
  children?: ReactNode;
  // Usually Animated.event(…) from the home screen (on the phone it runs on the animation thread).
  onPageScroll?: (event: { nativeEvent: { position: number; offset: number } }) => void;
  onPageSelected?: (event: { nativeEvent: { position: number } }) => void;
  onPageScrollStateChanged?: (event: { nativeEvent: { pageScrollState: 'idle' | 'dragging' | 'settling' } }) => void;
};

// What the home screen can ask the pager to do (for example: setPage to jump to a page).
export type HomePagerRef = Pick<PagerView, 'setPage' | 'setPageWithoutAnimation'>;

// The swipeable Chat ← Camera → Home pages on the phone.
// This is the real native pager, wrapped so the swipe can drive animations on the phone's animation thread.
// The web version lives in HomePager.web.tsx (the native pager has no web version and crashes a browser).
// (The type here checks that the native pager takes every setting in HomePagerProps.)
const phonePager: ComponentType<HomePagerProps & RefAttributes<PagerView>> = Animated.createAnimatedComponent(PagerView);
// The same pager. Only its type is narrowed: the home screen sees only HomePagerProps and the two jump
// commands (the real pager has both, so a HomePagerRef can hold it).
export const HomePager = phonePager as ComponentType<HomePagerProps & RefAttributes<HomePagerRef>>;
