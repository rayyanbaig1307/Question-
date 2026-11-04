import {
  Children,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
  type ViewStyle,
} from 'react-native';

// The same list of settings as the phone pager (only the type is shared: nothing is loaded from that file).
import type { HomePagerProps, HomePagerRef } from './HomePager';

// ---------------------------------------------------------------------------
// The swipeable Chat ← Camera → Home pages, for the web version of the app.
// The phone app uses the real native pager (HomePager.tsx). That pager has no web version: loading it in a
// browser crashes the whole app. This small stand-in does the same job with a sideways scroll that snaps to
// each page, and tells the home screen the same things the native pager does:
//   - setPage(n) through the ref, initialPage, onPageSelected, onPageScroll { position, offset },
//     and onPageScrollStateChanged ('idle' / 'dragging' / 'settling').
// ---------------------------------------------------------------------------

type PageScrollState = 'idle' | 'dragging' | 'settling';

export type { HomePagerProps, HomePagerRef };

type ScrollReport = (event: { nativeEvent: { position: number; offset: number } }) => void;

// The home screen hands over its swipe tracker. In a browser it is a plain function; just in case it is
// the phone-style event object, use the function inside it.
function asReport(handler: unknown): ScrollReport | null {
  if (typeof handler === 'function') return handler as ScrollReport;
  const inner = (handler as { __getHandler?: () => unknown } | null | undefined)?.__getHandler?.();
  return typeof inner === 'function' ? (inner as ScrollReport) : null;
}

// How long the scroll must be still before we call it "stopped".
const STILL_MS = 120;

export const HomePager = forwardRef<HomePagerRef, HomePagerProps>(function HomePager(
  { style, initialPage = 0, children, onPageScroll, onPageSelected, onPageScrollStateChanged },
  ref,
) {
  const pages = Children.toArray(children);
  const count = pages.length;
  const scroller = useRef<ScrollViewInstance>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  // The page that is picked right now (or the one we are gliding to).
  const selected = useRef(initialPage);
  const scrollState = useRef<PageScrollState>('idle');
  // Where the pages are scrolled to right now, in pixels.
  const scrolledTo = useRef(0);
  // Set while we move the pages ourselves without animation (for example after the window changes size):
  // the place we jumped to, so that scroll isn't mistaken for a swipe.
  const jumpedTo = useRef<number | null>(null);
  const stillTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the newest handlers without re-making the functions below.
  const handlers = useRef({ onPageScroll, onPageSelected, onPageScrollStateChanged });
  handlers.current = { onPageScroll, onPageSelected, onPageScrollStateChanged };

  const setScrollState = useCallback((next: PageScrollState) => {
    if (scrollState.current === next) return;
    scrollState.current = next;
    handlers.current.onPageScrollStateChanged?.({ nativeEvent: { pageScrollState: next } });
  }, []);

  const pick = useCallback((page: number) => {
    if (page === selected.current) return;
    selected.current = page;
    handlers.current.onPageSelected?.({ nativeEvent: { position: page } });
  }, []);

  const clampPage = useCallback((page: number) => Math.max(0, Math.min(count - 1, Math.round(page))), [count]);

  // Move the pages to x (in pixels). Nothing happens if they are already there.
  const scrollTo = useCallback(
    (x: number, animated: boolean) => {
      if (Math.abs(scrolledTo.current - x) < 1) return;
      if (animated) setScrollState('settling');
      else jumpedTo.current = x;
      scroller.current?.scrollTo({ x, y: 0, animated });
    },
    [setScrollState],
  );

  const goTo = useCallback(
    (page: number, animated: boolean) => {
      const target = clampPage(page);
      pick(target);
      // Not on screen yet: the page is shown as soon as it is.
      if (size) scrollTo(target * size.width, animated);
    },
    [clampPage, pick, scrollTo, size],
  );

  useImperativeHandle(
    ref,
    () => ({
      setPage: (page: number) => goTo(page, true),
      setPageWithoutAnimation: (page: number) => goTo(page, false),
    }),
    [goTo],
  );

  // Once we know how big the pager is (and whenever that changes), show the picked page.
  useEffect(() => {
    if (size) scrollTo(selected.current * size.width, false);
  }, [size, scrollTo]);

  useEffect(
    () => () => {
      if (stillTimer.current) clearTimeout(stillTimer.current);
    },
    [],
  );

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width <= 0 || height <= 0) return;
    setSize((old) => (old && old.width === width && old.height === height ? old : { width, height }));
  };

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!size || count === 0) return;
    const x = event.nativeEvent.contentOffset.x;
    scrolledTo.current = x;
    const progress = Math.max(0, Math.min(count - 1, x / size.width));
    const position = Math.min(Math.floor(progress), count - 1);
    const offset = progress - position;
    asReport(handlers.current.onPageScroll)?.({ nativeEvent: { position, offset } });

    const jumped = jumpedTo.current;
    jumpedTo.current = null;
    // Our own jump into place: nothing was swiped.
    if (jumped !== null && Math.abs(jumped - x) < 1) return;
    if (scrollState.current === 'idle') setScrollState('dragging');
    if (stillTimer.current) clearTimeout(stillTimer.current);
    stillTimer.current = setTimeout(() => {
      stillTimer.current = null;
      pick(clampPage(progress));
      setScrollState('idle');
    }, STILL_MS);
  };

  return (
    <View style={[styles.fill, style]} onLayout={onLayout}>
      {size ? (
        <ScrollView
          ref={scroller}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={onScroll}
          style={[styles.fill, styles.stayInside]}>
          {pages.map((page, index) => (
            <View key={index} style={{ width: size.width, height: size.height }}>
              {page}
            </View>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  // On a touch screen, a sideways swipe past the first page (Chat) would otherwise turn into the browser's
  // "swipe back" gesture and leave the app. "contain" keeps that swipe inside the pages. (Web-only setting,
  // so it isn't in React Native's style list.)
  stayInside: { overscrollBehaviorX: 'contain' } as ViewStyle,
});
