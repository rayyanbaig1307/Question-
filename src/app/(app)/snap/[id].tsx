import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { StatusBar } from 'expo-status-bar';

import { Avatar } from '@/components/Avatar';
import { Bouncy } from '@/components/Bouncy';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { useOverlays } from '@/components/Overlays';
import { SafeEdge, SafeScreen } from '@/components/SafeEdge';
import { VideoClip } from '@/components/VideoClipSafe';
import { ZoomableImage } from '@/components/ZoomableImage';
import { useMe } from '@/lib/auth';
import { canReplay, fetchMessage, getSnapUrl, openSnap, replaySnap, setSnapSaved } from '@/lib/chat';
import { friendlyError } from '@/lib/errors';
import { fetchProfile } from '@/lib/profiles';
import { useScreenshotNotice } from '@/lib/screenshots';
import type { Profile } from '@/lib/types';
import { useSafetyActions } from '@/lib/useSafetyActions';
import { colors, font, space } from '@/theme';

const SECONDS = 10;
// A video peek plays to its end (videos can be up to 30 seconds, or 60 with Peekaboo+).
const MAX_VIDEO_SECONDS = 60;
// After a pause the timer gives you at least this long, so a report picked from the ⋯ menu (which starts a
// moment after the menu closes) isn't cut off by the peek closing. You get this extra time only once per peek,
// so opening and closing the menu again and again can't keep the peek on screen.
const MIN_LEFT_MS = 1000;

// first = opening it for the first time, replay = your one replay, saved = saved in the chat (no time limit).
type Mode = 'first' | 'replay' | 'saved';

type State =
  | { kind: 'loading' }
  | { kind: 'gone' }
  | { kind: 'error' }
  // `other` = the other person in the chat (who gets told about screenshots).
  | {
      kind: 'showing';
      url: string;
      // Video peeks: their still picture and text/sticker layer.
      video: { posterUrl: string | null; overlayUrl: string | null } | null;
      sender: Profile | null;
      mode: Mode;
      other: string;
    };

// Shows a peek (a photo sent in chat) for 10 seconds. You get one replay afterwards,
// and a peek that's saved in the chat can be opened any time.
export default function SnapViewer() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId } = useMe();
  const { showToast, showOptions } = useOverlays();
  const { report } = useSafetyActions();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  // paused = the ⋯ menu is open: the timer waits and the peek is covered.
  // reporting = you're reporting it: the timer stops for good and the peek stays covered.
  const [paused, setPaused] = useState(false);
  const [reporting, setReporting] = useState(false);
  const progress = useSharedValue(0);
  // Whether this peek already got its one bit of extra time after a pause (see MIN_LEFT_MS).
  const extraGiven = useRef(false);
  // Pinch-zoom on the photo: whether it's zoomed in, and when that last changed.
  const zoomRef = useRef({ zoomed: false, at: 0 });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const message = await fetchMessage(id);
        if (cancelled) return;
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
        const isVideo = message.media_type === 'video';
        const posterUrl = isVideo && message.poster_path ? await getSnapUrl(message.poster_path) : null;
        const overlayUrl = isVideo && message.overlay_path ? await getSnapUrl(message.overlay_path) : null;
        const ready = isVideo ? !!url && (!posterUrl || (await Image.prefetch(posterUrl, 'memory'))) : !!url && (await Image.prefetch(url, 'memory'));
        // You may have gone back while the file was downloading. Keep its view for next time.
        if (cancelled) return;
        if (!url || !ready) {
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
          setState({ kind: 'showing', url, video: isVideo ? { posterUrl, overlayUrl } : null, sender, mode, other });
        }
      } catch {
        if (!cancelled) setState({ kind: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, userId]);

  // The timer runs unless the peek is saved (saving it stops the timer): 10 seconds for a photo, the video's
  // length for a video (it starts once the video has loaded). It waits while the ⋯ menu is open (the peek is
  // covered then), and stops for good once you report the peek.
  const [videoSeconds, setVideoSeconds] = useState<number | null>(null);
  const isVideo = state.kind === 'showing' && state.video !== null;
  const seconds = isVideo ? Math.min(MAX_VIDEO_SECONDS, Math.max(1, videoSeconds ?? SECONDS)) : SECONDS;
  const counting = state.kind === 'showing' && !saved && !reporting && (!isVideo || videoSeconds !== null);
  const timed = counting && !paused;
  useEffect(() => {
    if (!timed) return;
    // Carry on from where the bar stopped (it starts empty, so the first run gets the full time).
    let left = Math.max(0, (1 - progress.get()) * seconds * 1000);
    // Almost out of time after a pause: you get 1 second – but only the first time.
    if (left < MIN_LEFT_MS && !extraGiven.current) {
      extraGiven.current = true;
      left = MIN_LEFT_MS;
    }
    progress.set(
      withTiming(1, { duration: left, easing: Easing.linear }, (finished) => {
        'worklet';
        if (finished) scheduleOnRN(close);
      }),
    );
    // Leaving early stops the timer, so it can't close some other screen later.
    return () => cancelAnimation(progress);
  }, [timed, progress, seconds]);

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
  // Peeks from someone else can be reported (then you're offered to block them), like a message in the chat.
  const sender = state.sender && state.sender.id !== userId ? state.sender : null;
  // A tap closes the peek – but not while you're zoomed in, or right after pinching.
  function noteZoom(zoomed: boolean) {
    zoomRef.current = { zoomed, at: Date.now() };
  }
  function tapToClose() {
    if (!reporting && (zoomRef.current.zoomed || Date.now() - zoomRef.current.at < 400)) return;
    close();
  }
  function openMenu() {
    if (!sender) return;
    setPaused(true);
    showOptions({
      onClose: () => setPaused(false),
      options: [
        {
          label: 'Report peek',
          onPress: () => {
            setReporting(true);
            report({ user: sender, contentType: 'message', contentId: id });
          },
        },
      ],
    });
  }
  const label = saved ? 'Saved in chat 📌' : state.mode === 'replay' ? 'Replay 🔁' : null;

  return (
    <Pressable style={styles.fill} onPress={tapToClose} accessibilityLabel="Close peek">
      <StatusBar style="light" />
      {reporting ? null : state.video ? (
        <VideoClip
          uri={state.url}
          posterUri={state.video.posterUrl}
          overlayUri={state.video.overlayUrl}
          playing={!paused}
          loop={saved}
          onDuration={setVideoSeconds}
          style={StyleSheet.absoluteFill}
        />
      ) : (
        // Pinch to zoom in (it springs back when you let go far enough out).
        <ZoomableImage
          uri={state.url}
          contentFit="cover"
          doubleTapZoom={false}
          onZoomChange={noteZoom}
          style={StyleSheet.absoluteFill}
        />
      )}
      {paused || reporting ? (
        // While the ⋯ menu is open or you report it, the peek is covered, so the menu can't be used to keep it on
        // screen. (While the menu is open the photo or video stays underneath, paused, so it carries on after.)
        <View style={[StyleSheet.absoluteFill, styles.center, styles.cover]}>
          <Text style={styles.coverTitle}>
            {reporting ? 'Peek hidden while you report it 🚩' : 'Peek hidden while the menu is open 🙈'}
          </Text>
          {reporting ? <Text style={styles.loadingText}>Tap anywhere to close.</Text> : null}
        </View>
      ) : null}
      <SafeEdge edge="top" style={styles.top}>
        <View style={[styles.track, !counting && styles.hidden]}>
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
          <View style={styles.actions}>
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
            {sender && !reporting ? (
              <Bouncy style={styles.more} pressScale={0.85} onPress={openMenu} accessibilityRole="button" accessibilityLabel="More options">
                <Ionicons name="ellipsis-horizontal" size={18} color={colors.white} />
              </Bouncy>
            ) : null}
          </View>
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
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  more: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  cover: {
    backgroundColor: colors.black,
  },
  coverTitle: {
    ...font.body,
    color: colors.white,
    fontWeight: '800',
    textAlign: 'center',
  },
  saveText: {
    color: colors.onAccent,
    fontWeight: '800',
    fontSize: 14,
  },
  senderName: {
    ...font.body,
    color: colors.white,
    fontWeight: '800',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 6,
  },
});
