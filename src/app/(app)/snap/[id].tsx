import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { useMe } from '@/lib/auth';
import { fetchMessage, getSnapUrl, openSnap } from '@/lib/chat';
import { fetchProfile } from '@/lib/profiles';
import type { Profile } from '@/lib/types';
import { colors, font, space } from '@/theme';

const SECONDS = 10;

type State =
  | { kind: 'loading' }
  | { kind: 'gone' }
  | { kind: 'error' }
  | { kind: 'showing'; url: string; sender: Profile | null };

// Shows a peek (a photo sent to you) once, for 10 seconds. After that it can never be opened again.
export default function SnapViewer() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId } = useMe();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const progress = useSharedValue(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const message = await fetchMessage(id);
        if (!message || message.kind !== 'snap' || message.recipient_id !== userId || message.opened_at || !message.media_path) {
          if (!cancelled) setState({ kind: 'gone' });
          return;
        }
        // Get the one-minute link and download the photo BEFORE marking it opened,
        // so a bad connection doesn't waste the peek.
        const url = await getSnapUrl(message.media_path);
        if (!url || !(await Image.prefetch(url, 'memory'))) {
          if (!cancelled) setState({ kind: 'error' });
          return;
        }
        await openSnap(message.id);
        const sender = await fetchProfile(message.sender_id).catch(() => null);
        if (!cancelled) setState({ kind: 'showing', url, sender });
      } catch {
        if (!cancelled) setState({ kind: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, userId]);

  // Start the 10-second timer once the peek is on screen.
  const showing = state.kind === 'showing';
  useEffect(() => {
    if (!showing) return;
    progress.set(
      withTiming(1, { duration: SECONDS * 1000, easing: Easing.linear }, (finished) => {
        'worklet';
        if (finished) scheduleOnRN(close);
      }),
    );
    // Leaving early stops the timer, so it can't close some other screen later.
    return () => cancelAnimation(progress);
  }, [showing, progress]);

  const barStyle = useAnimatedStyle(() => ({ width: `${(1 - progress.get()) * 100}%` }));

  if (state.kind !== 'showing') {
    return (
      <SafeAreaView style={[styles.fill, styles.center]}>
        {state.kind === 'loading' ? (
          <>
            <ActivityIndicator color={colors.accent} size="large" />
            <Text style={styles.loadingText}>Opening peek…</Text>
          </>
        ) : (
          <>
            <EmptyState
              emoji={state.kind === 'gone' ? '💨' : '📶'}
              title={state.kind === 'gone' ? 'This peek is gone' : "Couldn't load the peek"}
              message={
                state.kind === 'gone'
                  ? 'Peeks disappear once they have been opened.'
                  : "Check your connection and try again – it hasn't been opened yet."
              }
            />
            <Button title="Back" variant="secondary" onPress={close} />
          </>
        )}
      </SafeAreaView>
    );
  }

  const name = state.sender ? state.sender.display_name || state.sender.username : '';

  return (
    <Pressable style={styles.fill} onPress={close} accessibilityLabel="Close peek">
      <Image source={{ uri: state.url }} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="memory" />
      <SafeAreaView edges={['top']} style={styles.top}>
        <View style={styles.track}>
          <Animated.View style={[styles.bar, barStyle]} />
        </View>
        <View style={styles.sender}>
          <Avatar path={state.sender?.avatar_path} name={name} size={32} />
          <Text style={styles.senderName}>{name}</Text>
        </View>
      </SafeAreaView>
    </Pressable>
  );
}

function close() {
  if (router.canGoBack()) router.back();
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: colors.black,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.lg,
    padding: space.xl,
  },
  loadingText: {
    ...font.body,
    color: colors.textMuted,
  },
  top: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: space.md,
    gap: space.md,
  },
  track: {
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.3)',
    overflow: 'hidden',
    marginTop: space.sm,
  },
  bar: {
    height: 4,
    backgroundColor: colors.white,
  },
  sender: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  senderName: {
    ...font.body,
    fontWeight: '800',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 6,
  },
});
