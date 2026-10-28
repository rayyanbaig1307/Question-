import * as Haptics from 'expo-haptics';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet } from 'react-native';
import PagerView from 'react-native-pager-view';

import { CameraPage } from '@/components/home/CameraPage';
import { ChatPage } from '@/components/home/ChatPage';
import { StoriesPage } from '@/components/home/StoriesPage';
import { colors } from '@/theme';

const CHAT = 0;
const CAMERA = 1;
const STORIES = 2;

const AnimatedPagerView = Animated.createAnimatedComponent(PagerView);

// Swipe left/right between Chat ← Camera → Stories.
export default function Home() {
  const pager = useRef<PagerView>(null);
  const [page, setPage] = useState(CAMERA);
  // True while your finger is swiping (or the page is still gliding into place).
  const [swiping, setSwiping] = useState(false);
  const focused = useIsFocused();
  // Other screens can send you back here with ?page=camera to land on the camera.
  const { page: wantedPage } = useLocalSearchParams<{ page?: string }>();

  // How far you've swiped: 0 = Chat, 1 = Camera, 2 = Stories (1.5 = halfway to Stories).
  // Tracked on the phone's animation thread, so the pages move smoothly with your finger.
  const [swipe] = useState(() => {
    const position = new Animated.Value(CAMERA);
    const offset = new Animated.Value(0);
    const progress = Animated.add(position, offset);
    // The page you're leaving shrinks back a little and darkens, the new one grows into place.
    const around = (index: number, outputRange: number[]) =>
      progress.interpolate({ inputRange: [index - 1, index, index + 1], outputRange, extrapolate: 'clamp' });
    const pageStyles = [CHAT, CAMERA, STORIES].map((index) => ({
      page: [styles.fill, { transform: [{ scale: around(index, [0.92, 1, 0.92]) }] }],
      dim: [styles.dim, { opacity: around(index, [0.6, 0, 0.6]) }],
    }));
    return {
      pageStyles,
      onPageScroll: Animated.event([{ nativeEvent: { position, offset } }], { useNativeDriver: true }),
    };
  });

  const goTo = (index: number) => pager.current?.setPage(index);

  useEffect(() => {
    if (wantedPage !== 'camera') return;
    pager.current?.setPage(CAMERA);
    router.setParams({ page: undefined });
  }, [wantedPage]);

  return (
    <AnimatedPagerView
      ref={pager}
      style={styles.fill}
      initialPage={CAMERA}
      onPageScroll={swipe.onPageScroll}
      onPageScrollStateChanged={(event) => setSwiping(event.nativeEvent.pageScrollState !== 'idle')}
      onPageSelected={(event) => {
        if (event.nativeEvent.position !== page) Haptics.selectionAsync();
        setPage(event.nativeEvent.position);
      }}>
      <Animated.View key="chat" style={swipe.pageStyles[CHAT].page}>
        <ChatPage visible={focused && page === CHAT} onCamera={() => goTo(CAMERA)} />
        <Animated.View style={swipe.pageStyles[CHAT].dim} pointerEvents="none" />
      </Animated.View>
      <Animated.View key="camera" style={swipe.pageStyles[CAMERA].page}>
        <CameraPage
          active={focused && page === CAMERA}
          warm={focused && swiping}
          onOpenChat={() => goTo(CHAT)}
          onOpenStories={() => goTo(STORIES)}
        />
        <Animated.View style={swipe.pageStyles[CAMERA].dim} pointerEvents="none" />
      </Animated.View>
      <Animated.View key="stories" style={swipe.pageStyles[STORIES].page}>
        <StoriesPage visible={focused && page === STORIES} onCamera={() => goTo(CAMERA)} />
        <Animated.View style={swipe.pageStyles[STORIES].dim} pointerEvents="none" />
      </Animated.View>
    </AnimatedPagerView>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.black,
  },
  dim: {
    ...StyleSheet.absoluteFill,
    backgroundColor: colors.black,
  },
});
