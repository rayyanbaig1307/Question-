import { useIsFocused } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import PagerView from 'react-native-pager-view';

import { CameraPage } from '@/components/home/CameraPage';
import { ChatPage } from '@/components/home/ChatPage';
import { StoriesPage } from '@/components/home/StoriesPage';
import { colors } from '@/theme';

const CHAT = 0;
const CAMERA = 1;
const STORIES = 2;

// Swipe left/right between Chat ← Camera → Stories, just like Snapchat.
export default function Home() {
  const pager = useRef<PagerView>(null);
  const [page, setPage] = useState(CAMERA);
  const focused = useIsFocused();

  const goTo = (index: number) => pager.current?.setPage(index);

  return (
    <PagerView
      ref={pager}
      style={styles.fill}
      initialPage={CAMERA}
      onPageSelected={(event) => setPage(event.nativeEvent.position)}>
      <View key="chat" style={styles.fill}>
        <ChatPage visible={focused && page === CHAT} onCamera={() => goTo(CAMERA)} />
      </View>
      <View key="camera" style={styles.fill}>
        <CameraPage
          active={focused && page === CAMERA}
          onOpenChat={() => goTo(CHAT)}
          onOpenStories={() => goTo(STORIES)}
        />
      </View>
      <View key="stories" style={styles.fill}>
        <StoriesPage visible={focused && page === STORIES} onCamera={() => goTo(CAMERA)} />
      </View>
    </PagerView>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.black,
  },
});
