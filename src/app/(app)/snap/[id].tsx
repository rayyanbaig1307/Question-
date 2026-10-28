import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { Avatar } from '@/components/Avatar';
import { Bouncy } from '@/components/Bouncy';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { useOverlays } from '@/components/Overlays';
import { SafeEdge, SafeScreen } from '@/components/SafeEdge';
import { useMe } from '@/lib/auth';
import { canReplay, fetchMessage, getSnapUrl, openSnap, replaySnap, setSnapSaved } from '@/lib/chat';
import { friendlyError } from '@/lib/errors';
import { fetchProfile } from '@/lib/profiles';
import { useScreenshotNotice } from '@/lib/screenshots';
import type { Profile } from '@/lib/types';
import { colors, font, space } from '@/theme';

const SECONDS = 10;

// first = opening it for the first time, replay = your one replay, saved = saved in the chat (no time limit).
type Mode = 'first' | 'replay' | 'saved';

type State =
  | { kind: 'loading' }
  | { kind: 'gone' }
  | { kind: 'error' }
  // `other` = the other person in the chat (who gets told about screenshots).
  | { kind: 'showing'; url: string; sender: Profile | null; mode: Mode; other: string };

// Shows a peek (a photo sent in chat) for 10 seconds. You get one replay afterwards,
// and a peek that's saved in the chat can be opened any time.
export default function SnapViewer() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId } = useMe();
  const { showToast } = useOverlays();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const progress = useSharedValue(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const message = await fetchMessage(id);
        if (!message || message.kind !== 'snap' || !message.media_path) {
          if (!cancelled) setState({ kind: 'gone' });
          return;
        }
        const inChat = message.sender_id === userId || message.recipient_id === userId;
        const mode: Mode | null =
          message.saved_at && inChat
            ? 'saved'
            : message.recipient_id === userId && !message.opened_at
              ? 'first'
              : canReplay(message, userId)
                ? 'replay'
                : null;
        if (!mode) {
          if (!cancelled) setState({ kind: 'gone' });
          return;
        }
        // Get the one-minute link and download the photo BEFORE using up the view or replay,
        // so a bad connection doesn't waste it.
        const url = await getSnapUrl(message.media_path);
        if (!url || !(await Image.prefetch(url, 'memory'))) {
          if (!cancelled) setState({ kind: 'error' });
          return;
        }
        // (A peek saved before you opened it still counts as opened now.)
        if (mode === 'first' || (message.recipient_id === userId && !message.opened_at)) await openSnap(message.id);
        if (mode === 'replay' && !(await replaySnap(message.id))) {
          if (!cancelled) setState({ kind: 'gone' });
          return;
        }
        const sender = await fetchProfile(message.sender_id).catch(() => null);
        if (!cancelled) {
          setSaved(mode === 'saved');
          const other = message.sender_id === userId ? message.recipient_id : message.sender_id;
          setState({ kind: 'showing', url, sender, mode, other });
        }
      } catch {
        if (!cancelled) setState({ kind: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, userId]);

  // The 10-second timer runs unless the peek is saved (saving it stops the timer).
  const timed = state.kind === 'showing' && !saved;
  useEffect(() => {
    if (!timed) return;
    progress.set(
      withTiming(1, { duration: SECONDS * 1000, easing: Easing.linear }, (finished) => {
        'worklet';
        if (finished) scheduleOnRN(close);
      }),
    );
    // Leaving early stops the timer, so it can't close some other screen later.
    return () => cancelAnimation(progress);
  }, [timed, progress]);

  // Screenshot it → they'll know.
  useScreenshotNotice(userId, state.kind === 'showing' ? state.other : null, 'peek', state.kind === 'showing', () =>
    showToast('📸 They’ll see you took a screenshot'),
  );

  const barStyle = useAnimatedStyle(() => ({ width: `${(1 - progress.get()) * 100}%` }));

  async function toggleSaved() {
    setSaving(true);
    try {
      const done = await setSnapSaved(id, !saved);
      if (!done) {
        Alert.alert("Can't save this one", 'Peeks can only be saved up to a day after they were opened.');
        return;
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showToast(saved ? 'Unsaved – it will disappear' : 'Saved in chat 📌');
      setSaved(!saved);
    } catch (error) {
      Alert.alert('Something went wrong', friendlyError(error));
    } finally {
      setSaving(false);
    }
  }

  if (state.kind !== 'showing') {
    return (
      <SafeScreen style={[styles.fill, styles.center]}>
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
                  ? 'Peeks disappear after you open and replay them. Tip: press and hold a peek in the chat to save it.'
                  : "Check your connection and try again – it hasn't been used up."
              }
            />
            <Button title="Back" variant="secondary" onPress={close} />
          </>
        )}
      </SafeScreen>
    );
  }

  const name = state.sender ? state.sender.display_name || state.sender.username : '';
  const label = saved ? 'Saved in chat 📌' : state.mode === 'replay' ? 'Replay 🔁' : null;

  return (
    <Pressable style={styles.fill} onPress={close} accessibilityLabel="Close peek">
      <Image source={{ uri: state.url }} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="memory" />
      <SafeEdge edge="top" style={styles.top}>
        <View style={[styles.track, !timed && styles.hidden]}>
          <Animated.View style={[styles.bar, barStyle]} />
        </View>
        <View style={styles.row}>
          <View style={styles.sender}>
            <Avatar path={state.sender?.avatar_path} name={name} size={32} />
            <View>
              <Text style={styles.senderName}>{name}</Text>
              {label ? <Text style={styles.label}>{label}</Text> : null}
            </View>
          </View>
          <Bouncy
            style={[styles.save, saved && styles.saveOn]}
            pressScale={0.85}
            disabled={saving}
            onPress={toggleSaved}
            accessibilityRole="button"
            accessibilityLabel={saved ? 'Unsave' : 'Save in chat'}>
            <Ionicons name={saved ? 'bookmark' : 'bookmark-outline'} size={18} color={colors.white} />
            <Text style={styles.saveText}>{saved ? 'Saved' : 'Save'}</Text>
          </Bouncy>
        </View>
      </SafeEdge>
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
  hidden: {
    opacity: 0,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sender: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  label: {
    color: colors.white,
    fontSize: 12,
    fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 6,
  },
  save: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: space.md,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  saveOn: {
    backgroundColor: colors.accent,
  },
  saveText: {
    color: colors.white,
    fontWeight: '800',
    fontSize: 14,
  },
  senderName: {
    ...font.body,
    fontWeight: '800',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 6,
  },
});
