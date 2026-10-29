import * as Haptics from 'expo-haptics';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import PagerView from 'react-native-pager-view';

import { CameraPage } from '@/components/home/CameraPage';
import { ChatPage } from '@/components/home/ChatPage';
import { DiscoverPage } from '@/components/home/DiscoverPage';
import { HomeTabBar } from '@/components/home/HomeTabBar';
import { StoriesPage } from '@/components/home/StoriesPage';
import { useMe } from '@/lib/auth';
import { useUnreadCount } from '@/lib/chat';
import { colors, isDark } from '@/theme';

const CHAT = 0;
const CAMERA = 1;
const STORIES = 2;
const DISCOVER = 3;
const PAGES = [CHAT, CAMERA, STORIES, DISCOVER];

const AnimatedPagerView = Animated.createAnimatedComponent(PagerView);

// Swipe left/right between Chat ← Camera → Stories → Discover, or tap the tabs at the bottom.
export default function Home() {
  const { userId } = useMe();
  const pager = useRef<PagerView>(null);
  const [page, setPage] = useState(CAMERA);
  // True while your finger is swiping (or the page is still gliding into place).
  const [swiping, setSwiping] = useState(false);
  const focused = useIsFocused();
  const unread = useUnreadCount(userId, focused);
  // Other screens can send you back here with ?page=camera (or ?page=discover) to land on that page.
  const { page: wantedPage } = useLocalSearchParams<{ page?: string }>();

  // How far you've swiped: 0 = Chat, 1 = Camera, 2 = Stories, 3 = Discover (1.5 = halfway to Stories).
  // Tracked on the phone's animation thread, so the pages move smoothly with your finger.
  const [swipe] = useState(() => {
    const position = new Animated.Value(CAMERA);
    const offset = new Animated.Value(0);
    const progress = Animated.add(position, offset);
    // The page you're leaving shrinks back a little and darkens, the new one grows into place.
    const around = (index: number, outputRange: number[]) =>
      progress.interpolate({ inputRange: [index - 1, index, index + 1], outputRange, extrapolate: 'clamp' });
    const pageStyles = PAGES.map((index) => ({
      page: [styles.fill, { transform: [{ scale: around(index, [0.92, 1, 0.92]) }] }],
      dim: [styles.dim, { opacity: around(index, [0.6, 0, 0.6]) }],
    }));
    return {
      pageStyles,
      // The tab bar is see-through over the camera (and over Discover in dark mode), solid elsewhere.
      tabBarSolid: progress.interpolate({ inputRange: PAGES, outputRange: [1, 0, 1, isDark ? 0 : 1], extrapolate: 'clamp' }),
      onPageScroll: Animated.event([{ nativeEvent: { position, offset } }], { useNativeDriver: true }),
    };
  });

  const goTo = (index: number) => pager.current?.setPage(index);

  useEffect(() => {
    if (wantedPage !== 'camera' && wantedPage !== 'discover') return;
    pager.current?.setPage(wantedPage === 'camera' ? CAMERA : DISCOVER);
    router.setParams({ page: undefined });
  }, [wantedPage]);

  return (
    <View style={styles.fill}>
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
          <CameraPage active={focused && page === CAMERA} warm={focused && swiping} />
          <Animated.View style={swipe.pageStyles[CAMERA].dim} pointerEvents="none" />
        </Animated.View>
        <Animated.View key="stories" style={swipe.pageStyles[STORIES].page}>
          <StoriesPage visible={focused && page === STORIES} onCamera={() => goTo(CAMERA)} />
          <Animated.View style={swipe.pageStyles[STORIES].dim} pointerEvents="none" />
        </Animated.View>
        <Animated.View key="discover" style={swipe.pageStyles[DISCOVER].page}>
          <DiscoverPage visible={focused && page === DISCOVER} onCamera={() => goTo(CAMERA)} />
          <Animated.View style={swipe.pageStyles[DISCOVER].dim} pointerEvents="none" />
        </Animated.View>
      </AnimatedPagerView>

      <HomeTabBar page={page} onSelect={goTo} unread={unread} solid={swipe.tabBarSolid} />
      {/* Light status bar over the camera; elsewhere it follows the app's colors. */}
      {focused ? <StatusBar style={page === CAMERA || isDark ? 'light' : 'dark'} /> : null}
    </View>
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
