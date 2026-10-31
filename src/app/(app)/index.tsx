import * as Haptics from 'expo-haptics';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import PagerView from 'react-native-pager-view';

import { CameraPage } from '@/components/home/CameraPage';
import { ChatPage } from '@/components/home/ChatPage';
import { HomePage } from '@/components/home/HomePage';
import { HomeTabBar } from '@/components/home/HomeTabBar';
import { useMe } from '@/lib/auth';
import { fetchMyBirthday, markAskedForBirthday, wasAskedForBirthday } from '@/lib/birthday';
import { useUnreadCount } from '@/lib/chat';
import { useHitUps } from '@/lib/hitups';
import { colors, isDark } from '@/theme';

const CHAT = 0;
const CAMERA = 1;
const HOME = 2;
const PAGES = [CHAT, CAMERA, HOME];

const AnimatedPagerView = Animated.createAnimatedComponent(PagerView);

// Swipe left/right between Chat ← Camera → Home, like Snapchat, or tap the tabs at the bottom.
export default function Home() {
  const { userId } = useMe();
  const pager = useRef<PagerView>(null);
  const [page, setPage] = useState(CAMERA);
  // True while your finger is swiping (or the page is still gliding into place).
  const [swiping, setSwiping] = useState(false);
  const focused = useIsFocused();
  const unread = useUnreadCount(userId, focused);
  // Hit ups waiting for you (shown at the top of Chat, and counted on the Chat tab).
  const { hitUps, reload: reloadHitUps } = useHitUps(userId, focused);
  // Other screens can send you back here with ?page=camera (or chat / home) to land on that page.
  const { page: wantedPage } = useLocalSearchParams<{ page?: string }>();

  // No birthday saved yet → ask once (you can also add it later in Settings).
  useEffect(() => {
    if (!focused) return;
    let cancelled = false;
    wasAskedForBirthday(userId)
      .then(async (asked) => {
        if (asked || cancelled || (await fetchMyBirthday(userId)) !== null || cancelled) return;
        markAskedForBirthday(userId);
        router.push('/birthday');
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [focused, userId]);

  // How far you've swiped: 0 = Chat, 1 = Camera, 2 = Home (1.5 = halfway to Home).
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
      // The tab bar is see-through over the camera (and over Home in dark mode), solid elsewhere.
      tabBarSolid: progress.interpolate({ inputRange: PAGES, outputRange: [1, 0, isDark ? 0 : 1], extrapolate: 'clamp' }),
      onPageScroll: Animated.event([{ nativeEvent: { position, offset } }], { useNativeDriver: true }),
    };
  });

  const goTo = (index: number) => pager.current?.setPage(index);

  useEffect(() => {
    const wanted = wantedPage === 'camera' ? CAMERA : wantedPage === 'home' ? HOME : wantedPage === 'chat' ? CHAT : null;
    if (wanted === null) return;
    pager.current?.setPage(wanted);
    router.setParams({ page: undefined });
    if (wanted === CHAT) reloadHitUps();
  }, [wantedPage, reloadHitUps]);

  // The pager needs real pages only (an empty slot makes it crash).
  const pages = [
    <Animated.View key="chat" style={swipe.pageStyles[CHAT].page}>
      <ChatPage
        visible={focused && page === CHAT}
        onCamera={() => goTo(CAMERA)}
        hitUps={hitUps}
        onHitUpsChanged={reloadHitUps}
      />
      <Animated.View style={swipe.pageStyles[CHAT].dim} pointerEvents="none" />
    </Animated.View>,
    <Animated.View key="camera" style={swipe.pageStyles[CAMERA].page}>
      <CameraPage active={focused && page === CAMERA} warm={focused && swiping} />
      <Animated.View style={swipe.pageStyles[CAMERA].dim} pointerEvents="none" />
    </Animated.View>,
    <Animated.View key="home" style={swipe.pageStyles[HOME].page}>
      <HomePage visible={focused && page === HOME} onCamera={() => goTo(CAMERA)} />
      <Animated.View style={swipe.pageStyles[HOME].dim} pointerEvents="none" />
    </Animated.View>,
  ];

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
        {pages}
      </AnimatedPagerView>

      <HomeTabBar
        page={page}
        onSelect={goTo}
        unread={unread + hitUps.length}
        solid={swipe.tabBarSolid}
      />
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
