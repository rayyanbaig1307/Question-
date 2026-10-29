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
import { MatchPage } from '@/components/home/MatchPage';
import { StoriesPage } from '@/components/home/StoriesPage';
import { useMe } from '@/lib/auth';
import { useUnreadCount } from '@/lib/chat';
import {
  canSeePeekMatch,
  markAskedForBirthday,
  rememberedMatchTab,
  usePeekMatchStatus,
  wasAskedForBirthday,
} from '@/lib/peekMatch';
import { colors, isDark } from '@/theme';

const CHAT = 0;
const CAMERA = 1;
const STORIES = 2;
const DISCOVER = 3;
// Peek Match – only there for people whose saved birthday says they're 18 or older.
const MATCH = 4;
const PAGES = [CHAT, CAMERA, STORIES, DISCOVER, MATCH];

const AnimatedPagerView = Animated.createAnimatedComponent(PagerView);

// Swipe left/right between Chat ← Camera → Stories → Discover (→ Match), or tap the tabs at the bottom.
export default function Home() {
  const { userId } = useMe();
  const pager = useRef<PagerView>(null);
  const [page, setPage] = useState(CAMERA);
  // True while your finger is swiping (or the page is still gliding into place).
  const [swiping, setSwiping] = useState(false);
  const focused = useIsFocused();
  const unread = useUnreadCount(userId, focused);
  // Other screens can send you back here with ?page=camera (or discover / match) to land on that page.
  const { page: wantedPage } = useLocalSearchParams<{ page?: string }>();

  // The Match tab: shown straight away if this phone remembers you can see it, then checked again.
  const match = usePeekMatchStatus(userId, focused);
  const [rememberedMatch] = useState(() => rememberedMatchTab(userId));
  const showMatch = match.status ? canSeePeekMatch(match.status) : rememberedMatch;

  // No birthday saved yet → ask once (you can also add it later in Settings).
  const noBirthday = match.status !== null && match.status.ageCheck === null;
  useEffect(() => {
    if (!focused || !noBirthday) return;
    let cancelled = false;
    wasAskedForBirthday(userId).then((asked) => {
      if (asked || cancelled) return;
      markAskedForBirthday(userId);
      router.push('/birthday');
    });
    return () => {
      cancelled = true;
    };
  }, [focused, noBirthday, userId]);

  // How far you've swiped: 0 = Chat, 1 = Camera, 2 = Stories, 3 = Discover, 4 = Match (1.5 = halfway to Stories).
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
      tabBarSolid: progress.interpolate({ inputRange: PAGES, outputRange: [1, 0, 1, isDark ? 0 : 1, 1], extrapolate: 'clamp' }),
      onPageScroll: Animated.event([{ nativeEvent: { position, offset } }], { useNativeDriver: true }),
    };
  });

  const goTo = (index: number) => pager.current?.setPage(index);

  useEffect(() => {
    const wanted = wantedPage === 'camera' ? CAMERA : wantedPage === 'discover' ? DISCOVER : wantedPage === 'match' ? MATCH : null;
    if (wanted === null || (wanted === MATCH && !showMatch)) return;
    pager.current?.setPage(wanted);
    router.setParams({ page: undefined });
  }, [wantedPage, showMatch]);

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
        {showMatch ? (
          <Animated.View key="match" style={swipe.pageStyles[MATCH].page}>
            <MatchPage
              visible={focused && page === MATCH}
              status={match.status}
              news={match.news}
              onChanged={match.reload}
            />
            <Animated.View style={swipe.pageStyles[MATCH].dim} pointerEvents="none" />
          </Animated.View>
        ) : null}
      </AnimatedPagerView>

      <HomeTabBar
        page={page}
        onSelect={goTo}
        unread={unread}
        showMatch={showMatch}
        matchNews={match.news}
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
